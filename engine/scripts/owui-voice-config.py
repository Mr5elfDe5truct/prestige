"""Points Open WebUI's speech-to-text at the workstation's voice server (Whisper large-v3-turbo on the GPU).

Open WebUI keeps its audio settings in its database once it has started, so the AUDIO_STT_* variables in
start-all.ps1 only reach a new install. This moves an existing install over, but only settings still at Open WebUI's
defaults: anything changed in Admin Settings > Audio is left alone. start-all.ps1 runs it before Open WebUI starts.

Usage: python owui-voice-config.py <path to webui.db>
"""
import json
import sqlite3
import sys
import time
from pathlib import Path

db = Path(sys.argv[1])
if not db.exists():
    sys.exit(0)  # first start: Open WebUI takes the values from start-all.ps1's environment

# key: (Open WebUI's default, the voice server's value)
WANT = {
    "audio.stt.engine": ("", "openai"),
    "audio.stt.openai.api_base_url": ("https://api.openai.com/v1", "http://127.0.0.1:8890/v1"),
    "audio.stt.openai.api_key": ("", "none"),
    "audio.stt.model": ("", "whisper-large-v3-turbo"),
}

con = sqlite3.connect(db)
try:
    if not con.execute("select 1 from sqlite_master where type='table' and name='config'").fetchone():
        sys.exit(0)
    stored = dict(con.execute("select key, value from config where key like 'audio.stt.%'").fetchall())
    # Only switch when the engine is still Open WebUI's built-in Whisper; otherwise someone chose it on purpose.
    if json.loads(stored.get("audio.stt.engine", '""')) != "":
        sys.exit(0)
    changed = []
    for key, (default, value) in WANT.items():
        current = json.loads(stored[key]) if key in stored else default
        if current == default:
            con.execute("insert into config (key, value, updated_at) values (?, ?, ?) "
                        "on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at",
                        (key, json.dumps(value), int(time.time())))
            changed.append(key)
    con.commit()
    if changed:
        print("  Open WebUI speech-to-text now uses Whisper large-v3-turbo (voice server)")
finally:
    con.close()
