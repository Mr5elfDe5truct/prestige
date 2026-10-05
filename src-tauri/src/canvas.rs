// The Canvas: HTML a chat model wrote, served from memory on its own origin (canvas://, http://canvas.localhost on
// Windows) so it runs in a sandboxed iframe beside the chat. Its own CSP lets it load libraries from https CDNs, but not
// reach Prestige, the local AI services or anything else on 127.0.0.1.

use std::collections::VecDeque;
use std::sync::Mutex;
use tauri::http::{Request, Response};
use tauri::{Manager, Runtime, UriSchemeContext};

/// The most recent runs (a rerun or a fix adds one); older ones are dropped.
#[derive(Default)]
pub struct Canvases(Mutex<VecDeque<(String, String)>>);

const KEEP: usize = 12;

const CSP: &str = "default-src 'none'; \
    script-src 'unsafe-inline' 'unsafe-eval' https: blob: data:; \
    style-src 'unsafe-inline' https:; \
    img-src https: data: blob:; font-src https: data:; media-src https: data: blob:; \
    connect-src https: data: blob:; worker-src blob: data:; \
    frame-src 'none'; form-action 'none'; base-uri 'none'";

/// Stores a page and returns the id it's served under.
#[tauri::command]
pub fn canvas_put(state: tauri::State<Canvases>, html: String) -> String {
    let id = format!(
        "{:x}{:04x}",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0),
        rand_u16()
    );
    let mut list = state.0.lock().unwrap();
    list.push_back((id.clone(), html));
    while list.len() > KEEP {
        list.pop_front();
    }
    id
}

fn rand_u16() -> u16 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u8(0);
    h.finish() as u16
}

pub fn serve<R: Runtime>(ctx: UriSchemeContext<'_, R>, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let id = req.uri().path().trim_matches('/').split('/').next().unwrap_or("").to_string();
    let page = ctx.app_handle().state::<Canvases>().0.lock().unwrap().iter().find(|(k, _)| *k == id).map(|(_, v)| v.clone());
    let builder = Response::builder().header("Cache-Control", "no-store");
    match page {
        Some(html) => builder
            .status(200)
            .header("Content-Type", "text/html; charset=utf-8")
            .header("Content-Security-Policy", CSP)
            .body(html.into_bytes()),
        None => builder.status(404).header("Content-Type", "text/plain").body(b"This canvas is gone. Press Rerun.".to_vec()),
    }
    .unwrap()
}
