// Phone access: Prestige on your phone, over your own network (or Tailscale). Off until it's switched on in Settings.
// A small web server serves a phone-sized chat page (phone/index.html). A phone pairs once with the 6-digit code shown
// on the PC and keeps a token; everything else needs that token. The phone is a remote for the desktop app: a message
// from it is handed to the app's own chat (so models, characters, Knowledge, Deep Research and /image all work), and
// the reply streams back to the phone as server-sent events. Only private addresses are answered (home networks,
// Tailscale's 100.64.0.0/10, this PC); anything else gets 403.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

const PAGE: &str = include_str!("../phone/index.html");
const ICON: &[u8] = include_bytes!("../icons/128x128@2x.png");
pub const DEFAULT_PORT: u16 = 8765;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Device {
    id: String,
    token: String,
    name: String,
    added: u64,
    #[serde(default)]
    last_seen: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    code: String,
    devices: Vec<Device>,
}

struct Running {
    server: Arc<Server>,
    port: u16,
    stop: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct Phone {
    running: Mutex<Option<Running>>,
    clients: Mutex<Vec<Sender<String>>>,
    fails: Mutex<Vec<Instant>>, // wrong pairing codes in the last few minutes
    state: Mutex<serde_json::Value>, // what the desktop app last said about itself (models, character, busy)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    getrandom::getrandom(&mut b).expect("the OS random number generator");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn new_code() -> String {
    let mut b = [0u8; 4];
    getrandom::getrandom(&mut b).expect("the OS random number generator");
    format!("{:06}", u32::from_le_bytes(b) % 1_000_000)
}

fn file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::data_dir(app, "")?.join("phone.json"))
}

fn load(app: &AppHandle) -> Saved {
    let mut s: Saved = file(app).ok().and_then(|p| fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    if s.code.len() != 6 {
        s.code = new_code();
        save(app, &s);
    }
    s
}

fn save(app: &AppHandle, s: &Saved) {
    if let (Ok(p), Ok(t)) = (file(app), serde_json::to_string_pretty(s)) {
        let _ = fs::write(p, t);
    }
}

/// Home networks, Tailscale (100.64.0.0/10), link-local and this PC.
fn private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            v.is_loopback() || v.is_private() || v.is_link_local() || (o[0] == 100 && (64..128).contains(&o[1]))
        }
        IpAddr::V6(v) => {
            if let Some(m) = v.to_ipv4_mapped() {
                return private(IpAddr::V4(m));
            }
            let s = v.segments();
            v.is_loopback() || (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80 // unique local, link-local
        }
    }
}

/// This PC's address on the network (the one its default route uses), without sending anything.
fn lan_ip() -> Option<IpAddr> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:80").ok()?;
    s.local_addr().ok().map(|a| a.ip()).filter(|ip| !ip.is_loopback() && !ip.is_unspecified())
}

/// The Tailscale address, when Tailscale is installed and connected.
fn tailscale_ip() -> Option<String> {
    let out = crate::hidden(&mut std::process::Command::new("tailscale")).args(["ip", "-4"]).output().ok()?;
    let ip = String::from_utf8_lossy(&out.stdout).lines().next()?.trim().to_string();
    ip.parse::<IpAddr>().ok().map(|_| ip)
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
}

fn json(code: u16, v: serde_json::Value) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(v.to_string())
        .with_status_code(StatusCode(code))
        .with_header(header("Content-Type", "application/json"))
        .with_header(header("Cache-Control", "no-store"))
}

fn body_json(req: &mut Request) -> serde_json::Value {
    let mut s = String::new();
    let _ = req.as_reader().take(1 << 20).read_to_string(&mut s);
    serde_json::from_str(&s).unwrap_or(serde_json::Value::Null)
}

fn query(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then(|| decode(v))
    })
}

fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
                out.push(b'%');
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The paired device a request comes from (a Bearer token, or ?t= for images and the event stream).
fn device(app: &AppHandle, req: &Request) -> Option<Device> {
    let token = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Authorization"))
        .and_then(|h| h.value.as_str().strip_prefix("Bearer ").map(String::from))
        .or_else(|| query(req.url(), "t"))?;
    if token.len() < 32 {
        return None;
    }
    let mut s = load(app);
    let d = s.devices.iter_mut().find(|d| d.token == token)?;
    // Seen times are written at most once a minute.
    if now_ms() - d.last_seen > 60_000 {
        d.last_seen = now_ms();
        let out = d.clone();
        save(app, &s);
        return Some(out);
    }
    Some(d.clone())
}

fn handle(app: &AppHandle, mut req: Request) {
    let ok_ip = req.remote_addr().map(|a: &SocketAddr| private(a.ip())).unwrap_or(false);
    if !ok_ip {
        let _ = req.respond(Response::from_string("Prestige only answers devices on your own network.").with_status_code(StatusCode(403)));
        return;
    }
    let path = req.url().split('?').next().unwrap_or("/").to_string();
    let method = req.method().clone();
    match (method, path.as_str()) {
        (Method::Get, "/") | (Method::Get, "/index.html") => {
            let _ = req.respond(
                Response::from_string(PAGE)
                    .with_header(header("Content-Type", "text/html; charset=utf-8"))
                    .with_header(header("Cache-Control", "no-store"))
                    .with_header(header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'"))
                    .with_header(header("X-Content-Type-Options", "nosniff")),
            );
        }
        (Method::Get, "/icon.png") => {
            let _ = req.respond(Response::from_data(ICON).with_header(header("Content-Type", "image/png")));
        }
        (Method::Get, "/manifest.json") => {
            let m = serde_json::json!({
                "name": "Prestige", "short_name": "Prestige", "start_url": "/", "display": "standalone",
                "background_color": "#0a0707", "theme_color": "#0a0707",
                "icons": [{ "src": "/icon.png", "sizes": "256x256", "type": "image/png" }]
            });
            let _ = req.respond(json(200, m));
        }
        (Method::Post, "/api/pair") => {
            let v = body_json(&mut req);
            let phone = app.state::<Phone>();
            {
                let mut fails = phone.fails.lock().unwrap();
                fails.retain(|t| t.elapsed() < Duration::from_secs(300));
                if fails.len() >= 5 {
                    let _ = req.respond(json(429, serde_json::json!({ "error": "Too many wrong codes. Wait a few minutes." })));
                    return;
                }
            }
            let mut s = load(app);
            let code = v["code"].as_str().unwrap_or("").trim().to_string();
            if code != s.code {
                phone.fails.lock().unwrap().push(Instant::now());
                let _ = req.respond(json(401, serde_json::json!({ "error": "That isn't the code shown in Prestige's Settings." })));
                return;
            }
            let name: String = v["name"].as_str().unwrap_or("Phone").chars().filter(|c| !c.is_control()).take(40).collect();
            let d = Device { id: random_hex(4), token: random_hex(24), name, added: now_ms(), last_seen: now_ms() };
            let token = d.token.clone();
            s.devices.push(d);
            save(app, &s);
            let _ = app.emit("phone-paired", ());
            let _ = req.respond(json(200, serde_json::json!({ "token": token })));
        }
        _ => {
            let Some(dev) = device(app, &req) else {
                let _ = req.respond(json(401, serde_json::json!({ "error": "Pair this phone again (Settings → Phone access on the PC)." })));
                return;
            };
            api(app, req, &path, &dev);
        }
    }
}

fn api(app: &AppHandle, mut req: Request, path: &str, dev: &Device) {
    let method = req.method().clone();
    match (method, path) {
        (Method::Get, "/api/state") => {
            let mut v = app.state::<Phone>().state.lock().unwrap().clone();
            if !v.is_object() {
                v = serde_json::json!({});
            }
            v["device"] = serde_json::json!(dev.name);
            let _ = req.respond(json(200, v));
        }
        (Method::Get, "/api/chats") => {
            let r = crate::chat_list(app).map(|c| serde_json::json!(c)).unwrap_or(serde_json::json!([]));
            let _ = req.respond(json(200, r));
        }
        (Method::Get, "/api/chat") => {
            let id = query(req.url(), "id").unwrap_or_default();
            match crate::chat_load(app, id) {
                Ok(c) => {
                    let _ = req.respond(json(200, c));
                }
                Err(e) => {
                    let _ = req.respond(json(404, serde_json::json!({ "error": e })));
                }
            }
        }
        (Method::Post, "/api/send") => {
            let v = body_json(&mut req);
            let text = v["text"].as_str().unwrap_or("").trim().to_string();
            if text.is_empty() {
                let _ = req.respond(json(400, serde_json::json!({ "error": "empty message" })));
                return;
            }
            let _ = app.emit("phone-send", serde_json::json!({ "chatId": v["chatId"], "text": text, "model": v["model"], "from": dev.name }));
            let _ = req.respond(json(200, serde_json::json!({ "ok": true })));
        }
        (Method::Post, "/api/stop") => {
            let _ = app.emit("phone-stop", ());
            let _ = req.respond(json(200, serde_json::json!({ "ok": true })));
        }
        (Method::Post, "/api/forget") => {
            let mut s = load(app);
            s.devices.retain(|d| d.id != dev.id);
            save(app, &s);
            let _ = req.respond(json(200, serde_json::json!({ "ok": true })));
        }
        (Method::Get, "/api/events") => events(app, req),
        (Method::Get, "/api/file") => serve_file(app, req),
        _ => {
            let _ = req.respond(json(404, serde_json::json!({ "error": "not found" })));
        }
    }
}

/// The event stream: replies as they're written, and "saved" when a chat changes. A comment every 15 s keeps
/// phones and Wi-Fi from closing an idle connection.
fn events(app: &AppHandle, req: Request) {
    let (tx, rx) = channel::<String>();
    app.state::<Phone>().clients.lock().unwrap().push(tx);
    let mut w = req.into_writer();
    // Chunked, so phone browsers treat it as a stream rather than a body that ends when the connection closes.
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-cache, no-store, no-transform\r\nConnection: keep-alive\r\nX-Accel-Buffering: no\r\nTransfer-Encoding: chunked\r\n\r\n";
    // A 2 KB comment first: some mobile browsers hold a stream back until that much has arrived. `retry` makes a
    // dropped connection (the phone slept, Wi-Fi changed) come back within 3 s.
    let open = format!(":{}\nretry: 3000\n\n", " ".repeat(2048));
    if w.write_all(head.as_bytes()).and_then(|_| send_chunk(&mut w, &open)).is_err() {
        return;
    }
    loop {
        let event = match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(s) => format!("data: {}\n\n", s.replace('\n', "\ndata: ")),
            // A real event (comments never reach the page), so the page can tell a quiet stream from a dead one.
            Err(RecvTimeoutError::Timeout) => "data: {\"type\":\"ping\"}\n\n".to_string(),
            Err(RecvTimeoutError::Disconnected) => break,
        };
        if send_chunk(&mut w, &event).is_err() {
            break;
        }
    }
    let _ = w.write_all(b"0\r\n\r\n").and_then(|_| w.flush());
}

/// One HTTP chunk, flushed straight away.
fn send_chunk(w: &mut impl Write, s: &str) -> std::io::Result<()> {
    write!(w, "{:x}\r\n", s.len())?;
    w.write_all(s.as_bytes())?;
    w.write_all(b"\r\n")?;
    w.flush()
}

/// A render from ComfyUI's output folder (only there), with byte ranges so videos play and seek on phones.
fn serve_file(app: &AppHandle, req: Request) {
    let root = crate::read_settings(app)["stackRoot"].as_str().map(String::from);
    let path = query(req.url(), "path").unwrap_or_default();
    let p = match crate::studio::render_path(root, &path) {
        Ok(p) => p,
        Err(e) => {
            let _ = req.respond(json(404, serde_json::json!({ "error": e })));
            return;
        }
    };
    let Ok(mut f) = fs::File::open(&p) else {
        let _ = req.respond(json(404, serde_json::json!({ "error": "missing" })));
        return;
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    };
    let range = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .and_then(|h| h.value.as_str().strip_prefix("bytes=").map(String::from))
        .and_then(|r| {
            let (a, b) = r.split_once('-')?;
            let start: u64 = if a.is_empty() { len.saturating_sub(b.parse().ok()?) } else { a.parse().ok()? };
            let end: u64 = if a.is_empty() || b.is_empty() { len.saturating_sub(1) } else { b.parse::<u64>().ok()?.min(len.saturating_sub(1)) };
            (start <= end && start < len).then_some((start, end))
        });
    let common = |r: Response<std::io::Take<fs::File>>| {
        r.with_header(header("Content-Type", mime)).with_header(header("Accept-Ranges", "bytes")).with_header(header("Cache-Control", "private, max-age=3600"))
    };
    match range {
        Some((start, end)) => {
            if f.seek(SeekFrom::Start(start)).is_err() {
                return;
            }
            let n = end - start + 1;
            let r = Response::new(StatusCode(206), vec![], f.take(n), Some(n as usize), None);
            let _ = req.respond(common(r).with_header(header("Content-Range", &format!("bytes {start}-{end}/{len}"))));
        }
        None => {
            let r = Response::new(StatusCode(200), vec![], f.take(len), Some(len as usize), None);
            let _ = req.respond(common(r));
        }
    }
}

// ---------- commands ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    running: bool,
    port: u16,
    code: String,
    urls: Vec<String>,
    qr: String, // an SVG of the first address, with the code in it
    devices: Vec<serde_json::Value>,
    error: Option<String>,
}

fn status(app: &AppHandle, error: Option<String>) -> Status {
    let s = load(app);
    let phone = app.state::<Phone>();
    let port = phone.running.lock().unwrap().as_ref().map(|r| r.port);
    let mut urls = Vec::new();
    if let Some(port) = port {
        if let Some(ip) = lan_ip() {
            urls.push(format!("http://{ip}:{port}"));
        }
        if let Some(ip) = tailscale_ip() {
            urls.push(format!("http://{ip}:{port}"));
        }
    }
    let qr = urls
        .first()
        .and_then(|u| qrcode::QrCode::new(format!("{u}/#code={}", s.code)).ok())
        .map(|q| q.render::<qrcode::render::svg::Color>().min_dimensions(180, 180).dark_color(qrcode::render::svg::Color("#000")).light_color(qrcode::render::svg::Color("#fff")).build())
        .unwrap_or_default();
    Status {
        running: port.is_some(),
        port: port.unwrap_or(DEFAULT_PORT),
        code: s.code,
        urls,
        qr,
        devices: s.devices.iter().map(|d| serde_json::json!({ "id": d.id, "name": d.name, "added": d.added, "lastSeen": d.last_seen })).collect(),
        error,
    }
}

/// Starts serving the phone page on every network address (Windows may ask to allow Prestige through the firewall).
#[tauri::command]
pub fn phone_start(app: AppHandle, port: Option<u16>) -> Status {
    let phone = app.state::<Phone>();
    let port = port.filter(|p| *p >= 1024).unwrap_or(DEFAULT_PORT);
    {
        let mut running = phone.running.lock().unwrap();
        if running.as_ref().is_some_and(|r| r.port == port) {
            drop(running);
            return status(&app, None);
        }
        if let Some(r) = running.take() {
            r.stop.store(true, Ordering::SeqCst);
            r.server.unblock();
        }
        let server = match Server::http(("0.0.0.0", port)) {
            Ok(s) => Arc::new(s),
            Err(e) => {
                drop(running);
                return status(&app, Some(format!("couldn't use port {port}: {e}")));
            }
        };
        let stop = Arc::new(AtomicBool::new(false));
        let (srv, flag, a) = (server.clone(), stop.clone(), app.clone());
        std::thread::spawn(move || {
            for req in srv.incoming_requests() {
                if flag.load(Ordering::SeqCst) {
                    break;
                }
                let a = a.clone();
                std::thread::spawn(move || handle(&a, req));
            }
        });
        *running = Some(Running { server, port, stop });
    }
    status(&app, None)
}

#[tauri::command]
pub fn phone_stop(app: AppHandle) -> Status {
    let phone = app.state::<Phone>();
    if let Some(r) = phone.running.lock().unwrap().take() {
        r.stop.store(true, Ordering::SeqCst);
        r.server.unblock();
    }
    // Open event streams end when their channel closes.
    phone.clients.lock().unwrap().clear();
    status(&app, None)
}

#[tauri::command]
pub fn phone_status(app: AppHandle) -> Status {
    status(&app, None)
}

/// A new pairing code (phones already paired stay paired).
#[tauri::command]
pub fn phone_new_code(app: AppHandle) -> Status {
    let mut s = load(&app);
    s.code = new_code();
    save(&app, &s);
    status(&app, None)
}

/// Unpairs one phone, or every phone when `id` is empty.
#[tauri::command]
pub fn phone_forget(app: AppHandle, id: Option<String>) -> Status {
    let mut s = load(&app);
    match id {
        Some(id) if !id.is_empty() => s.devices.retain(|d| d.id != id),
        _ => s.devices.clear(),
    }
    save(&app, &s);
    status(&app, None)
}

/// Sends an event to every connected phone (reply text as it streams, "saved" when a chat changes).
#[tauri::command]
pub fn phone_push(app: AppHandle, event: serde_json::Value) {
    let phone = app.state::<Phone>();
    let text = event.to_string();
    phone.clients.lock().unwrap().retain(|tx| tx.send(text.clone()).is_ok());
}

/// What the phone page shows about the desktop app: models, the current model and character, whether it's busy.
#[tauri::command]
pub fn phone_set_state(app: AppHandle, state: serde_json::Value) {
    *app.state::<Phone>().state.lock().unwrap() = state;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_private_addresses() {
        for ok in ["192.168.1.20", "10.0.0.5", "172.20.1.1", "100.101.102.103", "127.0.0.1", "::1", "fd00::1", "fe80::1", "::ffff:192.168.0.2"] {
            assert!(private(ok.parse().unwrap()), "{ok}");
        }
        for no in ["8.8.8.8", "100.200.1.1", "172.32.0.1", "2001:4860::8888", "::ffff:1.1.1.1"] {
            assert!(!private(no.parse().unwrap()), "{no}");
        }
    }

    #[test]
    fn reads_query_strings() {
        assert_eq!(query("/api/file?path=C%3A%5Cx%20y.png&t=abc", "path").as_deref(), Some("C:\\x y.png"));
        assert_eq!(query("/api/file?t=abc", "t").as_deref(), Some("abc"));
        assert_eq!(query("/api/file", "t"), None);
    }

    #[test]
    fn codes_are_six_digits() {
        for _ in 0..50 {
            let c = new_code();
            assert!(c.len() == 6 && c.chars().all(|d| d.is_ascii_digit()));
        }
        assert_eq!(random_hex(24).len(), 48);
    }
}
