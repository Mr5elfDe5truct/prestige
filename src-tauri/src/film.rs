// Film: the files a film keeps (its cast's pictures, the dialogue lines spoken in each voice, title cards drawn in the
// UI) in a .frames folder of ComfyUI's output folder that the gallery leaves out, and the export: ffmpeg cuts each
// clip to its in and out points, joins them with a cut or a crossfade, lays the dialogue and a music bed over the
// clips' own sound, and fades out at the end. The film lands in the gallery's video folder, as a Director's video does.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Deserialize;
use tauri::AppHandle;

use crate::hidden;
use crate::studio::{output_dir, probe};

/// How long a crossfade between two clips lasts, in seconds (shorter when a clip is too short for it).
const FADE: f64 = 0.5;

/// A film's folder: data\comfy-output\film.frames\<id>.
fn film_dir(root: Option<String>, film: &str) -> Result<PathBuf, String> {
    if film.is_empty() || film.len() > 40 || !film.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err("invalid film".into());
    }
    Ok(output_dir(root).join("film.frames").join(film))
}

/// %41 → 'A' (the UI sends the folder percent-encoded, since headers are ASCII).
pub(crate) fn unpercent(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Saves a file of the film's (a cast picture, a spoken line, a title card). The body is the file; headers: "x-film"
/// (the film's id), "x-name" (its name: letters, digits and dashes, then .jpg, .png or .wav), "x-root" (the
/// Workstation folder, or empty). Returns the saved path.
#[tauri::command]
pub async fn film_write(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the file's bytes".into());
    };
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(unpercent).unwrap_or_default();
    let root = Some(header("x-root")).filter(|r| !r.is_empty());
    let dir = film_dir(root, &header("x-film"))?;
    let name = header("x-name");
    let (stem, ext) = name.rsplit_once('.').ok_or("the file needs a name")?;
    if stem.is_empty() || stem.len() > 60 || !stem.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') || !["jpg", "png", "wav"].contains(&ext) {
        return Err(format!("{name} isn't a film file's name"));
    }
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(&name);
        fs::write(&path, &bytes).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A deleted film's own files (its cast pictures, lines and title cards). Its takes and exports stay in the gallery.
#[tauri::command]
pub fn film_remove(root: Option<String>, film: String) -> Result<(), String> {
    let dir = film_dir(root, &film)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Picks a video (a clip of your own to swap a cast member into) or a song (the music bed) from the PC.
#[tauri::command]
pub async fn film_pick(app: AppHandle, kind: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (label, exts, title): (&str, &[&str], &str) = if kind == "audio" {
        ("Songs", &["mp3", "wav", "flac", "ogg", "opus", "m4a"], "A song for the music bed")
    } else {
        ("Videos", &["mp4", "webm", "mov", "mkv"], "Your clip to swap a cast member into")
    };
    let dialog = app.dialog().file().add_filter(label, exts).set_title(title);
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_file()).await.map_err(|e| e.to_string())?;
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()))
}

/// One piece of the timeline: a clip cut from `start` to `end` (seconds into its file), or a title card (a still
/// picture held for `end` seconds). `fade`: crossfades in from the piece before (else a cut). `volume`: the clip's own
/// sound (0 mutes it).
#[derive(Deserialize, Clone)]
pub struct Piece {
    path: String,
    start: f64,
    end: f64,
    #[serde(default)]
    fade: bool,
    #[serde(default)]
    volume: f64,
    #[serde(default)]
    still: bool,
}

/// A sound laid over the film: a spoken line `at` seconds into piece `piece` (after its in point).
#[derive(Deserialize, Clone)]
pub struct Overlay {
    piece: usize,
    at: f64,
    path: String,
    volume: f64,
}

/// The music bed under the whole film (looped if it's shorter, cut to the film's length).
#[derive(Deserialize, Clone)]
pub struct Bed {
    path: String,
    volume: f64,
}

/// What ffmpeg runs: its inputs (each a list of arguments ending with the file), the filter graph, and the film's
/// length.
#[derive(Debug)]
struct Cut {
    inputs: Vec<Vec<String>>,
    filter: String,
    seconds: f64,
}

/// Where each piece starts on the film, and how long the film is. A crossfade overlaps a piece with the one before.
fn layout(pieces: &[Piece]) -> (Vec<f64>, Vec<f64>, f64) {
    let lens: Vec<f64> = pieces.iter().map(|p| (p.end - p.start).max(0.2)).collect();
    let mut starts = Vec::with_capacity(lens.len());
    let mut fades = Vec::with_capacity(lens.len());
    let mut t = 0.0;
    for (i, p) in pieces.iter().enumerate() {
        let f = if i > 0 && p.fade { FADE.min(lens[i - 1] / 2.0).min(lens[i] / 2.0) } else { 0.0 };
        starts.push(t - f);
        fades.push(f);
        t += lens[i] - f;
    }
    (starts, fades, t)
}

/// The ffmpeg graph for a film. `sound[i]`: whether piece i's file has sound.
fn cut(pieces: &[Piece], sound: &[bool], overlays: &[Overlay], bed: Option<&Bed>, w: u32, h: u32, fps: u32) -> Cut {
    let (starts, fades, total) = layout(pieces);
    let mut inputs = Vec::new();
    let mut f = String::new();
    let fmt = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";
    for (i, p) in pieces.iter().enumerate() {
        let len = (p.end - p.start).max(0.2);
        if p.still {
            inputs.push(vec!["-loop".into(), "1".into(), "-framerate".into(), fps.to_string(), "-t".into(), format!("{len:.3}"), "-i".into(), p.path.clone()]);
        } else {
            inputs.push(vec!["-ss".into(), format!("{:.3}", p.start.max(0.0)), "-t".into(), format!("{len:.3}"), "-i".into(), p.path.clone()]);
        }
        f += &format!(
            "[{i}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps},format=yuv420p,trim=duration={len:.3},setpts=PTS-STARTPTS,settb=1/{fps}[v{i}];"
        );
        // A clip's own sound (padded to its length), or silence for a title card or a muted clip.
        if !p.still && p.volume > 0.0 && sound.get(i).copied().unwrap_or(false) {
            f += &format!("[{i}:a]{fmt},volume={:.2},atrim=duration={len:.3},apad=whole_dur={len:.3},asetpts=PTS-STARTPTS[a{i}];", p.volume);
        } else {
            f += &format!("anullsrc=r=48000:cl=stereo,atrim=duration={len:.3},aformat=sample_fmts=fltp:channel_layouts=stereo[a{i}];");
        }
    }
    // The pieces in order: a crossfade overlaps the end of what's joined so far with the next one. Each join keeps one
    // timebase (concat's own is 1/1000000), which xfade needs on both of its inputs.
    let (mut v, mut a) = ("v0".to_string(), "a0".to_string());
    let mut joined = (pieces[0].end - pieces[0].start).max(0.2);
    for i in 1..pieces.len() {
        let len = (pieces[i].end - pieces[i].start).max(0.2);
        if fades[i] > 0.0 {
            f += &format!("[{v}][v{i}]xfade=transition=fade:duration={:.3}:offset={:.3},settb=1/{fps}[vx{i}];", fades[i], joined - fades[i]);
            f += &format!("[{a}][a{i}]acrossfade=d={:.3}[ax{i}];", fades[i]);
        } else {
            f += &format!("[{v}][v{i}]concat=n=2:v=1:a=0,settb=1/{fps}[vx{i}];[{a}][a{i}]concat=n=2:v=0:a=1[ax{i}];");
        }
        joined += len - fades[i];
        v = format!("vx{i}");
        a = format!("ax{i}");
    }
    let out = (total - 1.0).max(0.0);
    f += &format!("[{v}]fade=t=out:st={out:.3}:d=1[v];");
    // The lines and the music bed over the clips' sound, at their own levels.
    let mut mix = vec![format!("[{a}]")];
    let mut n = pieces.len();
    for (k, o) in overlays.iter().enumerate() {
        let Some(&s) = starts.get(o.piece) else { continue };
        let ms = ((s + o.at).max(0.0) * 1000.0).round() as u64;
        inputs.push(vec!["-i".into(), o.path.clone()]);
        f += &format!("[{n}:a]{fmt},volume={:.2},adelay={ms}:all=1[o{k}];", o.volume);
        mix.push(format!("[o{k}]"));
        n += 1;
    }
    if let Some(b) = bed {
        inputs.push(vec!["-stream_loop".into(), "-1".into(), "-i".into(), b.path.clone()]);
        f += &format!("[{n}:a]{fmt},volume={:.2},atrim=duration={total:.3}[bed];", b.volume);
        mix.push("[bed]".into());
    }
    let afade = (total - 1.5).max(0.0);
    if mix.len() > 1 {
        f += &format!("{}amix=inputs={}:duration=first:dropout_transition=0:normalize=0,afade=t=out:st={afade:.3}:d=1.5[a]", mix.join(""), mix.len());
    } else {
        f += &format!("[{a}]afade=t=out:st={afade:.3}:d=1.5[a]");
    }
    Cut { inputs, filter: f, seconds: total }
}

/// The next free film_00001.mp4 in the gallery's video folder.
fn next_name(dir: &Path) -> String {
    (1..100_000)
        .map(|n| format!("film_{n:05}"))
        .find(|n| !dir.join(format!("{n}.mp4")).exists())
        .unwrap_or_else(|| "film".into())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn film_export(
    root: Option<String>,
    pieces: Vec<Piece>,
    overlays: Vec<Overlay>,
    bed: Option<Bed>,
    width: u32,
    height: u32,
    fps: u32,
    title: String,
) -> Result<String, String> {
    if pieces.is_empty() {
        return Err("the timeline is empty".into());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        for p in pieces.iter().map(|p| &p.path).chain(overlays.iter().map(|o| &o.path)).chain(bed.iter().map(|b| &b.path)) {
            if !Path::new(p).is_file() {
                return Err(format!("{p} isn't there any more"));
            }
        }
        let sound: Vec<bool> = pieces.iter().map(|p| !p.still && !probe(&["-select_streams", "a:0", "-show_entries", "stream=index"], Path::new(&p.path)).is_empty()).collect();
        let c = cut(&pieces, &sound, &overlays, bed.as_ref(), width, height, fps);
        let dir = output_dir(root).join("video");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let out = dir.join(format!("{}.mp4", next_name(&dir)));
        // The gallery shows the title, as it shows a render's prompt.
        let tag = serde_json::json!({
            "1": { "class_type": "CLIPTextEncode", "inputs": { "text": title } },
            "2": { "class_type": "Film", "inputs": { "ckpt_name": "Film" } }
        })
        .to_string();
        // A long graph goes in a file, past Windows' command-line limit: "-/filter_complex" reads an option's value from
        // a file (ffmpeg 7 and newer; 9 dropped -filter_complex_script). A short one stays on the line for older ffmpeg.
        let script = std::env::temp_dir().join(format!("prestige-film-{}.txt", std::process::id()));
        let mut cmd = Command::new("ffmpeg");
        cmd.args(["-hide_banner", "-v", "error", "-y"]);
        for i in &c.inputs {
            cmd.args(i);
        }
        if c.filter.len() < 20_000 {
            cmd.arg("-filter_complex").arg(&c.filter);
        } else {
            fs::write(&script, &c.filter).map_err(|e| e.to_string())?;
            cmd.arg("-/filter_complex").arg(&script);
        }
        cmd.args(["-map", "[v]", "-map", "[a]", "-t", &format!("{:.3}", c.seconds)])
            .args(["-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"])
            .args(["-metadata", &format!("prompt={tag}"), "-metadata", &format!("title={title}")])
            .arg(&out);
        let res = hidden(&mut cmd).output().map_err(|e| format!("couldn't run ffmpeg ({e}); is it installed?"));
        let _ = fs::remove_file(&script);
        let res = res?;
        if !res.status.success() {
            // ffmpeg made the file before it failed: an empty one shouldn't sit in the gallery.
            let _ = fs::remove_file(&out);
            let err = String::from_utf8_lossy(&res.stderr);
            return Err(format!("ffmpeg failed: {}", err.lines().last().unwrap_or("no message")));
        }
        Ok(out.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clip(start: f64, end: f64, fade: bool) -> Piece {
        Piece { path: "c.mp4".into(), start, end, fade, volume: 1.0, still: false }
    }

    #[test]
    fn crossfades_overlap_and_cuts_follow_on() {
        let p = [clip(0.0, 5.0, false), clip(1.0, 4.0, true), clip(0.0, 2.0, false)];
        let (starts, fades, total) = layout(&p);
        assert_eq!(fades, vec![0.0, 0.5, 0.0]);
        assert_eq!(starts, vec![0.0, 4.5, 7.5]);
        assert!((total - 9.5).abs() < 1e-9);
    }

    #[test]
    fn a_crossfade_is_never_longer_than_half_a_short_clip() {
        let (_, fades, _) = layout(&[clip(0.0, 0.6, false), clip(0.0, 5.0, true)]);
        assert!((fades[1] - 0.3).abs() < 1e-9);
    }

    #[test]
    fn graph_has_each_piece_lines_and_the_bed() {
        let mut card = clip(0.0, 2.0, true);
        card.still = true;
        card.path = "title.png".into();
        let pieces = [card, clip(0.5, 3.5, true), clip(0.0, 4.0, false)];
        let lines = [Overlay { piece: 2, at: 0.25, path: "line.wav".into(), volume: 1.0 }];
        let bed = Bed { path: "song.mp3".into(), volume: 0.3 };
        let c = cut(&pieces, &[false, true, false], &lines, Some(&bed), 768, 512, 24);
        assert_eq!(c.inputs.len(), 5);
        assert_eq!(c.inputs[0][..2], ["-loop".to_string(), "1".to_string()]);
        assert_eq!(c.inputs[1][..4], ["-ss".to_string(), "0.500".to_string(), "-t".to_string(), "3.000".to_string()]);
        assert_eq!(c.inputs[4][..2], ["-stream_loop".to_string(), "-1".to_string()]);
        // The card has no sound, the second clip does, the third is silent in the file.
        assert!(c.filter.contains("[1:a]") && !c.filter.contains("[0:a]") && !c.filter.contains("[2:a]"));
        assert!(c.filter.contains("xfade=transition=fade:duration=0.500:offset=1.500,settb=1/24[vx1]"));
        assert!(c.filter.contains("[vx1][v2]concat=n=2:v=1:a=0,settb=1/24[vx2]"));
        // The line starts 0.25 s into the third piece, which starts at 2 + 3 - 0.5 = 4.5 s.
        assert!(c.filter.contains("adelay=4750:all=1[o0]"));
        assert!(c.filter.contains("amix=inputs=3"));
        assert!((c.seconds - 8.5).abs() < 1e-9);
    }

    #[test]
    fn one_clip_needs_no_mix() {
        let c = cut(&[clip(0.0, 3.0, false)], &[true], &[], None, 768, 512, 24);
        assert!(c.filter.ends_with("[a0]afade=t=out:st=1.500:d=1.5[a]"));
        assert!(c.filter.contains("[v0]fade=t=out:st=2.000:d=1[v]"));
    }

    #[test]
    fn film_folders_are_checked() {
        assert!(film_dir(None, "abc-123").is_ok());
        assert!(film_dir(None, "..").is_err());
        assert!(film_dir(None, "A").is_err());
    }
}
