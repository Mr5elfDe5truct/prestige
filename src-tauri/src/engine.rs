// The Workstation's own files (its scripts, Python servers, ComfyUI workflows and nodes, theme, requirements), shipped
// inside Prestige since the two became one product. On a start, and when Setup makes a new Workstation, the folder gets
// the files of this Prestige version, so the two can't drift apart. Things the user owns are never overwritten:
// bin\llama-models.ini once it exists, and everything in data\, models\, envs\, apps\ and logs\ (none of it is shipped).
// A Prestige without the files (a dev build) leaves the folder as it is.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Where the shipped Workstation files are: Prestige's resources\engine (set when the app starts).
pub static BUNDLED: OnceLock<PathBuf> = OnceLock::new();

const VERSION_FILE: &str = "engine-version.txt";

/// Files that are the user's once they exist: copied only when missing.
fn user_owned(rel: &Path) -> bool {
    let r = rel.to_string_lossy().replace('/', "\\").to_lowercase();
    r == r"bin\llama-models.ini"
}

fn bundled() -> Option<&'static Path> {
    BUNDLED.get().map(PathBuf::as_path).filter(|p| p.join("start-all.ps1").exists())
}

fn walk(dir: &Path, base: &Path, out: &mut Vec<PathBuf>) {
    for e in fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, base, out);
        } else if let Ok(rel) = p.strip_prefix(base) {
            out.push(rel.to_path_buf());
        }
    }
}

/// Copies the shipped files into `root`. Returns how many changed.
pub fn sync(from: &Path, root: &Path) -> Result<usize, String> {
    let mut files = Vec::new();
    walk(from, from, &mut files);
    let mut changed = 0;
    for rel in files {
        let src = from.join(&rel);
        let dst = root.join(&rel);
        if dst.exists() && (user_owned(&rel) || fs::read(&src).ok() == fs::read(&dst).ok()) {
            continue;
        }
        if let Some(d) = dst.parent() {
            fs::create_dir_all(d).map_err(|e| format!("{}: {e}", d.display()))?;
        }
        fs::copy(&src, &dst).map_err(|e| format!("{}: {e}", dst.display()))?;
        changed += 1;
    }
    Ok(changed)
}

/// Brings the Workstation's files up to this Prestige's version, once per version (data\engine-version.txt).
pub fn sync_if_needed(root: &Path) -> Result<usize, String> {
    let Some(from) = bundled() else { return Ok(0) };
    let version = env!("CARGO_PKG_VERSION");
    let mark = root.join("data").join(VERSION_FILE);
    if fs::read_to_string(&mark).map(|v| v.trim() == version).unwrap_or(false) {
        return Ok(0);
    }
    let n = sync(from, root)?;
    let _ = fs::create_dir_all(root.join("data"));
    let _ = fs::write(&mark, version);
    Ok(n)
}

/// For Setup: the Workstation's files in a new folder, from Prestige itself. False when this Prestige has none.
pub fn install(root: &Path) -> Result<bool, String> {
    let Some(from) = bundled() else { return Ok(false) };
    fs::create_dir_all(root).map_err(|e| format!("{}: {e}", root.display()))?;
    sync(from, root)?;
    let _ = fs::create_dir_all(root.join("data"));
    let _ = fs::write(root.join("data").join(VERSION_FILE), env!("CARGO_PKG_VERSION"));
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_new_and_changed_files_but_keeps_the_users() {
        let t = std::env::temp_dir().join(format!("engine-sync-{}", std::process::id()));
        let (from, root) = (t.join("from"), t.join("root"));
        let _ = fs::remove_dir_all(&t);
        fs::create_dir_all(from.join("bin")).unwrap();
        fs::create_dir_all(from.join("tools")).unwrap();
        fs::write(from.join("start-all.ps1"), "new").unwrap();
        fs::write(from.join("tools").join("a.py"), "a").unwrap();
        fs::write(from.join("bin").join("llama-models.ini"), "shipped").unwrap();
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::write(root.join("start-all.ps1"), "old").unwrap();
        fs::write(root.join("bin").join("llama-models.ini"), "mine").unwrap();
        assert_eq!(sync(&from, &root).unwrap(), 2);
        assert_eq!(fs::read_to_string(root.join("start-all.ps1")).unwrap(), "new");
        assert_eq!(fs::read_to_string(root.join("bin").join("llama-models.ini")).unwrap(), "mine");
        assert_eq!(sync(&from, &root).unwrap(), 0);
        let fresh = t.join("fresh");
        fs::create_dir_all(&fresh).unwrap();
        assert_eq!(sync(&from, &fresh).unwrap(), 3);
        let _ = fs::remove_dir_all(&t);
    }
}
