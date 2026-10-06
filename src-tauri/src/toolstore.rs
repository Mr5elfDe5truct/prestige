// The tool store: MCP servers added from Prestige are kept in the workstation's data\mcpo-extra.json (on this PC only,
// since it holds their keys). The workstation's update-tools.ps1 merges them into the tool server's config, which
// reloads while it runs. A tool that needs a one-time sign-in (Google) gets a console window to do it in.

use std::collections::HashMap;
use std::fs;
use std::process::Command;

fn extra_file(root: Option<String>) -> std::path::PathBuf {
    crate::stack_root(root).join("data").join("mcpo-extra.json")
}

/// The added tool servers: {"mcpServers": {name: config}}.
#[tauri::command]
pub fn tools_extra_get(root: Option<String>) -> serde_json::Value {
    fs::read_to_string(extra_file(root))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(t.trim_start_matches('\u{feff}')).ok())
        .filter(|v| v["mcpServers"].is_object())
        .unwrap_or_else(|| serde_json::json!({ "mcpServers": {} }))
}

/// Saves the added tool servers and applies them to the running tool server (update-tools.ps1).
#[tauri::command]
pub fn tools_extra_set(root: Option<String>, value: serde_json::Value) -> Result<(), String> {
    if !value["mcpServers"].is_object() {
        return Err("expected {\"mcpServers\": {…}}".into());
    }
    let stack = crate::stack_root(root.clone());
    if !stack.join("update-tools.ps1").exists() {
        return Err("this Workstation is older than the tool store: update it (git pull in the Workstation folder) first".into());
    }
    let path = extra_file(root);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&path, serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let out = crate::hidden(&mut Command::new("powershell.exe"))
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(stack.join("update-tools.ps1"))
        .current_dir(&stack)
        .output()
        .map_err(|e| format!("couldn't run update-tools.ps1: {e}"))?;
    if !out.status.success() {
        return Err(format!("update-tools.ps1 failed: {}", String::from_utf8_lossy(&out.stderr).chars().take(300).collect::<String>()));
    }
    Ok(())
}

/// Opens a PowerShell window for a tool's one-time sign-in (it opens the browser). The values go in as environment
/// variables, never into the script text.
#[tauri::command]
pub fn tools_setup(script: String, env: HashMap<String, String>) -> Result<(), String> {
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script]).envs(env);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NEW_CONSOLE);
    cmd.spawn().map_err(|e| format!("couldn't open PowerShell: {e}"))?;
    Ok(())
}

/// True for a plain https:// web address: the only kind of link a tool card opens.
fn is_web_link(url: &str) -> bool {
    url.strip_prefix("https://").is_some_and(|rest| {
        !rest.is_empty() && !rest.starts_with('/') && url.chars().all(|c| c.is_ascii_graphic() && !matches!(c, '"' | '\'' | '`' | '^' | '<' | '>' | '|' | '\\'))
    })
}

/// Opens a tool's setup page (where its key comes from) in the default browser. The app window won't follow a
/// target="_blank" link itself, so the card's Open link comes here.
#[tauri::command]
pub fn tools_open_link(url: String) -> Result<(), String> {
    if !is_web_link(&url) {
        return Err("that isn't a web address".into());
    }
    crate::hidden(&mut Command::new("explorer.exe")).arg(&url).spawn().map_err(|e| format!("couldn't open the browser: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_only_web_links() {
        assert!(is_web_link("https://github.com/settings/personal-access-tokens"));
        assert!(is_web_link("https://app.todoist.com/app/settings/integrations/developer"));
        assert!(is_web_link("https://api-dashboard.search.brave.com/"));
        assert!(!is_web_link("http://example.com/"));
        assert!(!is_web_link("https://"));
        assert!(!is_web_link("https:///etc"));
        assert!(!is_web_link("file:///C:/Windows/System32/calc.exe"));
        assert!(!is_web_link(r"C:\Windows\System32\calc.exe"));
        assert!(!is_web_link(r#"https://example.com/" & calc"#));
        assert!(!is_web_link("https://example.com/ calc"));
        assert!(!is_web_link(r"https://example.com\..\calc.exe"));
    }

    #[test]
    fn every_card_link_opens() {
        // Each card's Open link in the tool store (src/toolstore.ts) must be one tools_open_link will open.
        let ts = include_str!("../../src/toolstore.ts");
        let links: Vec<&str> = ts.lines().filter_map(|l| l.trim().strip_prefix("link: \"")?.split('"').next()).collect();
        assert!(links.len() >= 8, "found only {} links", links.len());
        for l in links {
            assert!(is_web_link(l), "{l}");
        }
    }
}
