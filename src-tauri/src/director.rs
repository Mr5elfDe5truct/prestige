// Director: a music video's last step. ffmpeg joins its shots (scaled to one size, one frame rate), lays the song under
// them, cuts the picture to the song's length with a fade at the end, and burns in the lyrics when there are subtitles.
// The video lands in the gallery's video folder with its title in the "prompt" tag, where the gallery reads it.

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use crate::hidden;
use crate::studio::output_dir;

/// The next free director_00001.mp4 in the gallery's video folder.
fn next_name(dir: &PathBuf) -> String {
    (1..100_000)
        .map(|n| format!("director_{n:05}"))
        .find(|n| !dir.join(format!("{n}.mp4")).exists())
        .unwrap_or_else(|| "director".into())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn director_assemble(
    root: Option<String>,
    shots: Vec<String>,
    song: String,
    seconds: f64,
    width: u32,
    height: u32,
    fps: u32,
    srt: Option<String>,
    title: String,
) -> Result<String, String> {
    if shots.is_empty() {
        return Err("there are no shots to join".into());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let dir = output_dir(root).join("video");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let name = next_name(&dir);
        let out = dir.join(format!("{name}.mp4"));

        // Each shot to the same size (letterboxed if its shape differs) and frame rate, then all of them in order.
        let n = shots.len();
        let mut filter = String::new();
        for i in 0..n {
            filter += &format!(
                "[{i}:v]scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps},format=yuv420p[v{i}];"
            );
        }
        for i in 0..n {
            filter += &format!("[v{i}]");
        }
        let fade = (seconds - 1.0).max(0.0);
        filter += &format!("concat=n={n}:v=1:a=0[cat];[cat]trim=duration={seconds:.2},setpts=PTS-STARTPTS,fade=t=out:st={fade:.2}:d=1");
        // The lyrics, burned in. The .srt sits next to the video and ffmpeg runs in that folder, so the filter gets a
        // bare file name (a Windows path's drive colon would need escaping inside the filter).
        if let Some(text) = srt.as_deref().filter(|t| !t.trim().is_empty()) {
            fs::write(dir.join(format!("{name}.srt")), text).map_err(|e| e.to_string())?;
            filter += &format!(
                ",subtitles={name}.srt:force_style='FontName=Arial,FontSize=20,Bold=1,Outline=2,Shadow=0,BorderStyle=1,MarginV=24'"
            );
        }
        filter += "[v];";
        let afade = (seconds - 1.5).max(0.0);
        filter += &format!("[{n}:a]atrim=duration={seconds:.2},afade=t=out:st={afade:.2}:d=1.5[a]");

        // The gallery shows the title, as it shows a render's prompt.
        let tag = serde_json::json!({
            "1": { "class_type": "CLIPTextEncode", "inputs": { "text": title } },
            "2": { "class_type": "Director", "inputs": { "ckpt_name": "Director" } }
        })
        .to_string();

        let mut cmd = Command::new("ffmpeg");
        cmd.current_dir(&dir).args(["-hide_banner", "-v", "error", "-y"]);
        for s in &shots {
            cmd.arg("-i").arg(s);
        }
        cmd.arg("-i").arg(&song);
        cmd.args(["-filter_complex", &filter, "-map", "[v]", "-map", "[a]"])
            .args(["-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"])
            .args(["-metadata", &format!("prompt={tag}"), "-metadata", &format!("title={title}")])
            .arg(&out);
        let res = hidden(&mut cmd).output().map_err(|e| format!("couldn't run ffmpeg ({e}); is it installed?"))?;
        if !res.status.success() {
            let err = String::from_utf8_lossy(&res.stderr);
            return Err(format!("ffmpeg failed: {}", err.lines().last().unwrap_or("no message")));
        }
        Ok(out.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}
