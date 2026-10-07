// Computer use ("Do it for me"): what the agent loop in computer.ts needs from Windows. A screenshot of the primary
// screen (scaled down, JPEG), mouse and keyboard input through SendInput, and the compact panel Prestige turns into
// while it works: small, always on top, in a corner, and left out of screenshots (WDA_EXCLUDEFROMCAPTURE) so the model
// sees the screen underneath. A click that would land on the panel moves the panel to the other side first.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::thread::sleep;
use std::time::Duration;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

#[repr(C)]
#[derive(Clone, Copy)]
struct MouseInput {
    dx: i32,
    dy: i32,
    mouse_data: u32,
    flags: u32,
    time: u32,
    extra: usize,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct KeybdInput {
    vk: u16,
    scan: u16,
    flags: u32,
    time: u32,
    extra: usize,
}
#[repr(C)]
union InputData {
    mi: MouseInput,
    ki: KeybdInput,
}
#[repr(C)]
struct Input {
    kind: u32, // 0 mouse, 1 keyboard
    data: InputData,
}
#[repr(C)]
#[derive(Default)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}
#[repr(C)]
struct BitmapInfoHeader {
    size: u32,
    width: i32,
    height: i32,
    planes: u16,
    bit_count: u16,
    compression: u32,
    size_image: u32,
    x_ppm: i32,
    y_ppm: i32,
    clr_used: u32,
    clr_important: u32,
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn SendInput(n: u32, inputs: *const Input, size: i32) -> u32;
    fn SetCursorPos(x: i32, y: i32) -> i32;
    fn GetSystemMetrics(index: i32) -> i32;
    fn GetDC(hwnd: isize) -> isize;
    fn ReleaseDC(hwnd: isize, hdc: isize) -> i32;
    fn SetWindowDisplayAffinity(hwnd: isize, affinity: u32) -> i32;
    fn SystemParametersInfoW(action: u32, param: u32, out: *mut Rect, win_ini: u32) -> i32;
    fn GetForegroundWindow() -> isize;
    fn SetForegroundWindow(hwnd: isize) -> i32;
    fn IsWindow(hwnd: isize) -> i32;
}
#[cfg(windows)]
#[link(name = "gdi32")]
extern "system" {
    fn CreateCompatibleDC(hdc: isize) -> isize;
    fn CreateCompatibleBitmap(hdc: isize, w: i32, h: i32) -> isize;
    fn SelectObject(hdc: isize, obj: isize) -> isize;
    fn BitBlt(dst: isize, x: i32, y: i32, w: i32, h: i32, src: isize, sx: i32, sy: i32, rop: u32) -> i32;
    fn GetDIBits(hdc: isize, bmp: isize, start: u32, lines: u32, bits: *mut u8, info: *mut BitmapInfoHeader, usage: u32) -> i32;
    fn DeleteObject(obj: isize) -> i32;
    fn DeleteDC(hdc: isize) -> i32;
}

const MOUSE_MOVE: u32 = 0x0001;
const LEFT_DOWN: u32 = 0x0002;
const LEFT_UP: u32 = 0x0004;
const RIGHT_DOWN: u32 = 0x0008;
const RIGHT_UP: u32 = 0x0010;
const MIDDLE_DOWN: u32 = 0x0020;
const MIDDLE_UP: u32 = 0x0040;
const WHEEL: u32 = 0x0800;
const HWHEEL: u32 = 0x1000;
const KEY_EXTENDED: u32 = 0x0001;
const KEY_UP: u32 = 0x0002;
const KEY_UNICODE: u32 = 0x0004;
const WDA_NONE: u32 = 0;
const WDA_EXCLUDEFROMCAPTURE: u32 = 0x11;

fn send(inputs: &[Input]) -> Result<(), String> {
    #[cfg(windows)]
    {
        let n = unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<Input>() as i32) };
        if n as usize != inputs.len() {
            // Windows blocks input into windows of programs running as administrator (UIPI).
            return Err("Windows blocked the input (the window under it may be running as administrator)".into());
        }
    }
    Ok(())
}

fn mouse(flags: u32, data: i32) -> Input {
    Input { kind: 0, data: InputData { mi: MouseInput { dx: 0, dy: 0, mouse_data: data as u32, flags, time: 0, extra: 0 } } }
}

fn key(vk: u16, scan: u16, flags: u32) -> Input {
    Input { kind: 1, data: InputData { ki: KeybdInput { vk, scan, flags, time: 0, extra: 0 } } }
}

fn move_to(x: i32, y: i32) {
    #[cfg(windows)]
    unsafe {
        SetCursorPos(x, y);
    }
    // A zero move so apps that track the pointer see it arrive.
    let _ = send(&[mouse(MOUSE_MOVE, 0)]);
}

/// The primary screen's size in physical pixels (Prestige is per-monitor DPI aware, so these are real pixels).
fn screen_size() -> (i32, i32) {
    #[cfg(windows)]
    unsafe {
        return (GetSystemMetrics(0), GetSystemMetrics(1));
    }
    #[allow(unreachable_code)]
    (0, 0)
}

/// The primary screen's work area (without the taskbar).
fn work_area() -> Rect {
    let mut r = Rect::default();
    #[cfg(windows)]
    unsafe {
        SystemParametersInfoW(0x30, 0, &mut r, 0); // SPI_GETWORKAREA
    }
    if r.right <= r.left {
        let (w, h) = screen_size();
        r = Rect { left: 0, top: 0, right: w, bottom: h };
    }
    r
}

/// The primary screen as BGRA rows, top to bottom.
fn grab(w: i32, h: i32) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    unsafe {
        let screen = GetDC(0);
        let mem = CreateCompatibleDC(screen);
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp);
        let ok = BitBlt(mem, 0, 0, w, h, screen, 0, 0, 0x00CC_0020 | 0x4000_0000); // SRCCOPY | CAPTUREBLT
        let mut info = BitmapInfoHeader {
            size: 40,
            width: w,
            height: -h, // top-down
            planes: 1,
            bit_count: 32,
            compression: 0,
            size_image: 0,
            x_ppm: 0,
            y_ppm: 0,
            clr_used: 0,
            clr_important: 0,
        };
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let lines = GetDIBits(mem, bmp, 0, h as u32, buf.as_mut_ptr(), &mut info, 0);
        SelectObject(mem, old);
        DeleteObject(bmp);
        DeleteDC(mem);
        ReleaseDC(0, screen);
        if ok == 0 || lines == 0 {
            return Err("Windows didn't give a screenshot".into());
        }
        return Ok(buf);
    }
    #[allow(unreachable_code)]
    Err("screenshots need Windows".into())
}

/// The window that had the keyboard at the last screenshot (not Prestige's own). Pressing a button on the panel moves
/// the keyboard to Prestige, so it's handed back before acting, or typing would land in the panel.
static TARGET: Mutex<isize> = Mutex::new(0);

fn own_hwnd(app: &AppHandle) -> isize {
    #[cfg(windows)]
    if let Some(w) = app.get_webview_window("main") {
        if let Ok(h) = w.hwnd() {
            return h.0 as isize;
        }
    }
    0
}

fn remember_target(app: &AppHandle) {
    #[cfg(windows)]
    unsafe {
        let fg = GetForegroundWindow();
        if fg != 0 && fg != own_hwnd(app) {
            if let Ok(mut t) = TARGET.lock() {
                *t = fg;
            }
        }
    }
}

fn give_back_focus(app: &AppHandle) {
    #[cfg(windows)]
    unsafe {
        let own = own_hwnd(app);
        let t = TARGET.lock().map(|t| *t).unwrap_or(0);
        if t != 0 && GetForegroundWindow() == own && IsWindow(t) != 0 {
            SetForegroundWindow(t);
            sleep(Duration::from_millis(120));
        }
    }
}

#[derive(Serialize)]
pub struct Shot {
    image: String, // base64 JPEG
    width: i32,    // the screen, in pixels
    height: i32,
    w: u32, // the image
    h: u32,
}

/// A screenshot of the primary screen, scaled so its longer side is at most `max` pixels.
#[tauri::command]
pub async fn cu_screenshot(app: AppHandle, max: Option<u32>) -> Result<Shot, String> {
    remember_target(&app);
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        let (w, h) = screen_size();
        if w <= 0 || h <= 0 {
            return Err("couldn't read the screen size".into());
        }
        let bgra = grab(w, h)?;
        let mut rgb = Vec::with_capacity((w * h * 3) as usize);
        for p in bgra.chunks_exact(4) {
            rgb.extend_from_slice(&[p[2], p[1], p[0]]);
        }
        let img = image::RgbImage::from_raw(w as u32, h as u32, rgb).ok_or("bad screenshot buffer")?;
        let max = max.unwrap_or(1280).max(320);
        let k = (max as f32 / w.max(h) as f32).min(1.0);
        let (tw, th) = (((w as f32) * k).round() as u32, ((h as f32) * k).round() as u32);
        let small = if k < 1.0 { image::imageops::resize(&img, tw, th, image::imageops::FilterType::Triangle) } else { img };
        let mut jpg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg, 82).encode_image(&small).map_err(|e| e.to_string())?;
        Ok(Shot { image: base64::engine::general_purpose::STANDARD.encode(&jpg), width: w, height: h, w: tw, h: th })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One action, in screen pixels (computer.ts converts the model's 0-1000 grid).
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    Click { x: i32, y: i32, button: Option<String>, count: Option<u32> },
    Move { x: i32, y: i32 },
    Drag { x: i32, y: i32, to_x: i32, to_y: i32 },
    Scroll { x: i32, y: i32, dx: i32, dy: i32 }, // notches: dy > 0 scrolls down, dx > 0 right
    Type { text: String },
    Key { keys: String },
}

/// Moves the panel to the other side of the screen when (x, y) is under it, so the click reaches what's below.
fn keep_clear(win: &WebviewWindow, x: i32, y: i32) {
    let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else { return };
    let inside = x >= pos.x - 8 && x <= pos.x + size.width as i32 + 8 && y >= pos.y - 8 && y <= pos.y + size.height as i32 + 8;
    if !inside || !PANEL.lock().map(|p| p.is_some()).unwrap_or(false) {
        return;
    }
    let wa = work_area();
    let left = x > (wa.left + wa.right) / 2;
    let nx = if left { wa.left + 12 } else { wa.right - size.width as i32 - 12 };
    let _ = win.set_position(PhysicalPosition::new(nx, pos.y));
    sleep(Duration::from_millis(150));
}

#[tauri::command]
pub async fn cu_act(app: AppHandle, action: Action) -> Result<(), String> {
    let win = app.get_webview_window("main");
    tauri::async_runtime::spawn_blocking(move || {
        give_back_focus(&app);
        let at = match &action {
            Action::Click { x, y, .. } | Action::Move { x, y } | Action::Drag { x, y, .. } | Action::Scroll { x, y, .. } => Some((*x, *y)),
            _ => None,
        };
        if let (Some(w), Some((x, y))) = (&win, at) {
            keep_clear(w, x, y);
            if let Action::Drag { to_x, to_y, .. } = &action {
                keep_clear(w, *to_x, *to_y);
            }
        }
        match action {
            Action::Click { x, y, button, count } => {
                let (down, up) = match button.as_deref() {
                    Some("right") => (RIGHT_DOWN, RIGHT_UP),
                    Some("middle") => (MIDDLE_DOWN, MIDDLE_UP),
                    _ => (LEFT_DOWN, LEFT_UP),
                };
                move_to(x, y);
                sleep(Duration::from_millis(60));
                for i in 0..count.unwrap_or(1).clamp(1, 3) {
                    if i > 0 {
                        sleep(Duration::from_millis(70));
                    }
                    send(&[mouse(down, 0), mouse(up, 0)])?;
                }
            }
            Action::Move { x, y } => move_to(x, y),
            Action::Drag { x, y, to_x, to_y } => {
                move_to(x, y);
                sleep(Duration::from_millis(80));
                send(&[mouse(LEFT_DOWN, 0)])?;
                for i in 1..=16 {
                    sleep(Duration::from_millis(20));
                    move_to(x + (to_x - x) * i / 16, y + (to_y - y) * i / 16);
                }
                sleep(Duration::from_millis(80));
                send(&[mouse(LEFT_UP, 0)])?;
            }
            Action::Scroll { x, y, dx, dy } => {
                move_to(x, y);
                sleep(Duration::from_millis(60));
                for _ in 0..dy.abs().min(30) {
                    send(&[mouse(WHEEL, if dy > 0 { -120 } else { 120 })])?;
                    sleep(Duration::from_millis(30));
                }
                for _ in 0..dx.abs().min(30) {
                    send(&[mouse(HWHEEL, if dx > 0 { 120 } else { -120 })])?;
                    sleep(Duration::from_millis(30));
                }
            }
            Action::Type { text } => {
                for ch in text.chars() {
                    if ch == '\n' {
                        send(&[key(0x0D, 0, 0), key(0x0D, 0, KEY_UP)])?;
                    } else if ch != '\r' {
                        let mut units = [0u16; 2];
                        for u in ch.encode_utf16(&mut units).iter() {
                            send(&[key(0, *u, KEY_UNICODE), key(0, *u, KEY_UNICODE | KEY_UP)])?;
                        }
                    }
                    sleep(Duration::from_millis(8));
                }
            }
            Action::Key { keys } => press(&keys)?,
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A virtual-key code (and whether it's an extended key) for a key name.
fn vk(name: &str) -> Option<(u16, bool)> {
    let n = name.trim().to_ascii_lowercase();
    let k = match n.as_str() {
        "ctrl" | "control" => (0x11, false),
        "shift" => (0x10, false),
        "alt" => (0x12, false),
        "win" | "windows" | "super" | "meta" | "cmd" => (0x5B, true),
        "enter" | "return" => (0x0D, false),
        "tab" => (0x09, false),
        "esc" | "escape" => (0x1B, false),
        "backspace" => (0x08, false),
        "delete" | "del" => (0x2E, true),
        "insert" => (0x2D, true),
        "space" => (0x20, false),
        "up" => (0x26, true),
        "down" => (0x28, true),
        "left" => (0x25, true),
        "right" => (0x27, true),
        "home" => (0x24, true),
        "end" => (0x23, true),
        "pageup" | "pgup" => (0x21, true),
        "pagedown" | "pgdn" => (0x22, true),
        "printscreen" => (0x2C, true),
        "capslock" => (0x14, false),
        "menu" | "apps" => (0x5D, true),
        _ => {
            if let Some(f) = n.strip_prefix('f').and_then(|d| d.parse::<u16>().ok()).filter(|d| (1..=24).contains(d)) {
                (0x70 + f - 1, false)
            } else if n.len() == 1 {
                let c = n.as_bytes()[0];
                match c {
                    b'a'..=b'z' => (c.to_ascii_uppercase() as u16, false),
                    b'0'..=b'9' => (c as u16, false),
                    b'-' => (0xBD, false),
                    b'=' | b'+' => (0xBB, false),
                    b',' => (0xBC, false),
                    b'.' => (0xBE, false),
                    b'/' => (0xBF, false),
                    b';' => (0xBA, false),
                    b'\'' => (0xDE, false),
                    b'[' => (0xDB, false),
                    b']' => (0xDD, false),
                    b'\\' => (0xDC, false),
                    b'`' => (0xC0, false),
                    _ => return None,
                }
            } else {
                return None;
            }
        }
    };
    Some(k)
}

/// Presses a key or a combination like "ctrl+shift+s": the modifiers go down in order and come up in reverse. A lone
/// character that needs Shift on the keyboard ("*", "+", "?") is typed as that character.
fn press(keys: &str) -> Result<(), String> {
    let k = keys.trim();
    if k.chars().count() == 1 && vk(k).is_none() || matches!(k, "+" | "*") {
        let mut units = [0u16; 2];
        for u in k.chars().next().unwrap().encode_utf16(&mut units).iter() {
            send(&[key(0, *u, KEY_UNICODE), key(0, *u, KEY_UNICODE | KEY_UP)])?;
        }
        return Ok(());
    }
    // "ctrl++" means ctrl and the plus key.
    let parts: Vec<&str> = if keys.ends_with("++") { keys[..keys.len() - 2].split('+').chain(["+"]).collect() } else { keys.split('+').collect() };
    let mut codes = Vec::new();
    for p in parts.iter().filter(|p| !p.trim().is_empty()) {
        codes.push(vk(p).ok_or_else(|| format!("unknown key \"{}\"", p.trim()))?);
    }
    if codes.is_empty() {
        return Err("no key to press".into());
    }
    let ext = |e: bool| if e { KEY_EXTENDED } else { 0 };
    let mut down: Vec<Input> = codes.iter().map(|(c, e)| key(*c, 0, ext(*e))).collect();
    let up: Vec<Input> = codes.iter().rev().map(|(c, e)| key(*c, 0, ext(*e) | KEY_UP)).collect();
    down.extend(up);
    send(&down)
}

/// The main window's place and size before the panel, to go back to.
static PANEL: Mutex<Option<(PhysicalPosition<i32>, PhysicalSize<u32>, bool)>> = Mutex::new(None);

/// Turns Prestige into the small always-on-top panel (on = true) at the bottom right of the primary screen, left out
/// of screenshots, or back into its window as it was.
#[tauri::command]
pub fn cu_panel(app: AppHandle, on: bool) -> Result<(), String> {
    let win = app.get_webview_window("main").ok_or("no main window")?;
    #[cfg(windows)]
    let hwnd = win.hwnd().map_err(|e| e.to_string())?.0 as isize;
    let mut saved = PANEL.lock().map_err(|e| e.to_string())?;
    if on {
        if saved.is_none() {
            let maximized = win.is_maximized().unwrap_or(false);
            *saved = Some((win.outer_position().map_err(|e| e.to_string())?, win.outer_size().map_err(|e| e.to_string())?, maximized));
        }
        let scale = win.scale_factor().unwrap_or(1.0);
        let (w, h) = ((400.0 * scale) as u32, (640.0 * scale) as u32);
        let wa = work_area();
        let _ = win.unmaximize();
        let _ = win.set_min_size(None::<PhysicalSize<u32>>);
        win.set_size(PhysicalSize::new(w, h.min((wa.bottom - wa.top - 24) as u32))).map_err(|e| e.to_string())?;
        let h = win.outer_size().map(|s| s.height as i32).unwrap_or(h as i32);
        win.set_position(PhysicalPosition::new(wa.right - w as i32 - 12, wa.bottom - h - 12)).map_err(|e| e.to_string())?;
        win.set_always_on_top(true).map_err(|e| e.to_string())?;
        #[cfg(windows)]
        unsafe {
            SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
        }
    } else if let Some((pos, size, maximized)) = saved.take() {
        #[cfg(windows)]
        unsafe {
            SetWindowDisplayAffinity(hwnd, WDA_NONE);
        }
        let _ = win.set_always_on_top(false);
        let _ = win.set_min_size(Some(tauri::LogicalSize::new(720.0, 560.0)));
        let _ = win.set_size(size);
        let _ = win.set_position(pos);
        if maximized {
            let _ = win.maximize();
        }
        let _ = win.set_focus();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_names() {
        assert_eq!(vk("ctrl"), Some((0x11, false)));
        assert_eq!(vk("Enter"), Some((0x0D, false)));
        assert_eq!(vk("f5"), Some((0x74, false)));
        assert_eq!(vk("a"), Some((0x41, false)));
        assert_eq!(vk("7"), Some((0x37, false)));
        assert_eq!(vk("down"), Some((0x28, true)));
        assert_eq!(vk("win"), Some((0x5B, true)));
        assert_eq!(vk("nope"), None);
    }

    #[test]
    fn input_layout_matches_windows() {
        // SendInput rejects every input when cbSize is wrong: 40 bytes on 64-bit Windows.
        assert_eq!(std::mem::size_of::<Input>(), 40);
    }
}
