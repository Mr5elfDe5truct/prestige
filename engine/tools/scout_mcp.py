"""Workstation MCP server: research scouting (Reddit, Hugging Face, GitHub), webcam snapshots, video jobs.

Run through mcpo (see tools/mcpo-config.json); each function becomes a tool in Open WebUI.
"""
import base64
import datetime as dt
import json
from pathlib import Path

import httpx
from mcp.server.fastmcp import FastMCP

ROOT = Path(__file__).resolve().parent.parent
REPORTS = ROOT / "reports"
SNAPSHOTS = ROOT / "data" / "webcam"
UA = {"User-Agent": "custom-ai-workstation-scout/1.0"}

mcp = FastMCP("workstation")


def _get(url: str, params: dict | None = None):
    r = httpx.get(url, params=params, headers=UA, timeout=30, follow_redirects=True)
    r.raise_for_status()
    return r.json()


def _reddit_rss(url: str, params: dict) -> str:
    # Reddit blocks anonymous .json requests, but the Atom feeds stay open.
    import xml.etree.ElementTree as ET

    import time

    for attempt in range(4):  # Reddit rate-limits bursts with 429
        r = httpx.get(url, params=params, headers=UA, timeout=30, follow_redirects=True)
        if r.status_code != 429:
            break
        time.sleep(10 * (attempt + 1))
    r.raise_for_status()
    ns ={"a": "http://www.w3.org/2005/Atom"}
    entries = ET.fromstring(r.content).findall("a:entry", ns)
    return "\n".join(f"- {e.findtext('a:title', '', ns)} {e.find('a:link', ns).get('href')}" for e in entries)


@mcp.tool()
def reddit_top(subreddit: str = "LocalLLaMA", period: str = "week", limit: int = 15) -> str:
    """Top posts from a subreddit. period: day, week, month, year, all."""
    return _reddit_rss(f"https://www.reddit.com/r/{subreddit}/top/.rss", {"t": period, "limit": limit})


@mcp.tool()
def reddit_search(query: str, subreddit: str = "LocalLLaMA", limit: int = 15) -> str:
    """Search a subreddit for posts from the past year."""
    return _reddit_rss(f"https://www.reddit.com/r/{subreddit}/search.rss",
                       {"q": query, "restrict_sr": 1, "sort": "relevance", "t": "year", "limit": limit})


@mcp.tool()
def hf_models(search: str = "", sort: str = "trendingScore", limit: int = 20, gguf_only: bool = True) -> str:
    """Hugging Face models. sort: trendingScore, downloads, likes, lastModified."""
    params = {"sort": sort, "direction": -1, "limit": limit}
    if search:
        params["search"] = search
    if gguf_only:
        params["filter"] = "gguf"
    data = _get("https://huggingface.co/api/models", params)
    return "\n".join(f"- {m['id']} (likes {m.get('likes', 0)}, downloads {m.get('downloads', 0)}) "
                     f"https://huggingface.co/{m['id']}" for m in data)


@mcp.tool()
def github_search(query: str, days: int = 30, limit: int = 15) -> str:
    """GitHub repos matching query, created or pushed in the last N days, sorted by stars."""
    since = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    data = _get("https://api.github.com/search/repositories",
                {"q": f"{query} pushed:>{since}", "sort": "stars", "order": "desc", "per_page": limit})
    return "\n".join(f"- {r['full_name']} ★{r['stargazers_count']}: {r.get('description') or ''} {r['html_url']}"
                     for r in data["items"])


@mcp.tool()
def scout_report() -> str:
    """Build a dated report of new local-AI models and projects and save it under reports/."""
    sections = [
        ("r/LocalLLaMA this week", lambda: reddit_top("LocalLLaMA")),
        ("r/StableDiffusion this week", lambda: reddit_top("StableDiffusion")),
        ("r/comfyui this week", lambda: reddit_top("comfyui")),
        ("Trending GGUF models on Hugging Face", lambda: hf_models()),
        ("Trending diffusion models on Hugging Face", lambda: hf_models("video", gguf_only=False)),
        ("GitHub: local LLM agents", lambda: github_search("local llm agent")),
        ("GitHub: ComfyUI", lambda: github_search("comfyui")),
    ]
    out = [f"# Scout report {dt.date.today()}\n"]
    for title, fn in sections:
        try:
            body = fn()
        except Exception as e:  # keep the report going if one source fails
            body = f"(failed: {e})"
        out.append(f"## {title}\n{body}\n")
    text = "\n".join(out)
    REPORTS.mkdir(exist_ok=True)
    path = REPORTS / f"scout-{dt.date.today()}.md"
    path.write_text(text, encoding="utf-8")
    return f"Saved to {path}\n\n{text}"


@mcp.tool()
def webcam_snapshot(camera_index: int = 0) -> str:
    """Take one photo from the webcam. Returns the saved file path and a base64 JPEG."""
    import subprocess
    import sys

    SNAPSHOTS.mkdir(parents=True, exist_ok=True)
    path = SNAPSHOTS / f"snap-{dt.datetime.now():%Y%m%d-%H%M%S}.jpg"
    # DirectShow hangs when opened from the MCP server's worker thread, so capture in a fresh process.
    code = (
        "import cv2,sys\n"
        f"cap=cv2.VideoCapture({int(camera_index)},cv2.CAP_DSHOW)\n"
        "ok=False\n"
        "for _ in range(5): ok,f=cap.read()\n"
        "cap.release()\n"
        "sys.exit(0 if ok and cv2.imwrite(sys.argv[1],cv2.resize(f,(1280,720))) else 1)\n"
    )
    try:
        r = subprocess.run([sys.executable, "-c", code, str(path)], timeout=30, capture_output=True,
                           stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return "The webcam did not respond within 30 seconds."
    if r.returncode != 0:
        return "Could not read from the webcam."
    return f"Saved {path}\ndata:image/jpeg;base64,{base64.b64encode(path.read_bytes()).decode()}"


COMFY = "http://127.0.0.1:8188"
WORKFLOWS = ROOT / "workflows"
OUTPUT = ROOT / "data" / "comfy-output"


def _pick(*names: str) -> tuple[str, dict]:
    """The first of these workflows whose model files ComfyUI has, else the last one (its error names the file)."""
    import json

    for name in names:
        wf = json.loads((WORKFLOWS / name).read_text(encoding="utf-8"))
        if name == names[-1] or _installed(wf):
            return name, wf


def _installed(wf: dict) -> bool:
    # ComfyUI's object_info lists the files each loader node can see.
    specs = {}
    for node in wf.values():
        for key in ("unet_name", "clip_name", "vae_name"):
            value = node["inputs"].get(key)
            if not isinstance(value, str):
                continue
            cls = node["class_type"]
            if cls not in specs:
                spec = httpx.get(f"{COMFY}/object_info/{cls}", timeout=30).json()[cls]["input"]
                specs[cls] = {**spec.get("required", {}), **spec.get("optional", {})}
            if value not in specs[cls][key][0]:
                return False
    return True


def _upload(image_path: str) -> str:
    p = Path(image_path)
    up = httpx.post(f"{COMFY}/upload/image", files={"image": (p.name, p.read_bytes())}, timeout=60)
    up.raise_for_status()
    return up.json()["name"]


def _shares_comfy_card(other: str) -> bool:
    # data/runtime/gpu.json (start-all.ps1) says which cards each service runs on; with one card everything shares it.
    try:
        s = json.loads((ROOT / "data" / "runtime" / "gpu.json").read_text(encoding="utf-8")).get("services") or {}
    except (OSError, ValueError):
        return True
    mine, theirs = set(s.get("comfyui") or []), set(s.get(other) or [])
    return not mine or not theirs or bool(mine & theirs)


def _free_gpu():
    # ComfyUI needs its card to itself; sharing it with a chat model makes renders ~3x slower.
    # Unload Ollama's and llama.cpp's models (the chat model reloads for its next reply), and the voice server's,
    # when they're on ComfyUI's card (with several GPUs they may be on another).
    try:
        if _shares_comfy_card("voice"):
            httpx.post("http://127.0.0.1:8890/v1/audio/unload", json={}, timeout=30)
    except httpx.HTTPError:
        pass
    try:
        for m in httpx.get("http://127.0.0.1:11434/api/ps", timeout=10).json().get("models", []) if _shares_comfy_card("ollama") else []:
            httpx.post("http://127.0.0.1:11434/api/generate", json={"model": m["name"], "keep_alive": 0}, timeout=30)
    except httpx.HTTPError:
        pass
    try:
        for m in httpx.get("http://127.0.0.1:8081/models", timeout=10).json().get("data", []) if _shares_comfy_card("llama") else []:
            if m.get("status", {}).get("value") in ("loaded", "loading"):
                httpx.post("http://127.0.0.1:8081/models/unload", json={"model": m["id"]}, timeout=30)
    except httpx.HTTPError:
        pass


def _queue(wf: dict, free_gpu: bool = True) -> str:
    for node in wf.values():  # new seed each time
        for key in ("seed", "noise_seed"):
            if key in node["inputs"]:
                node["inputs"][key] = int(dt.datetime.now().timestamp())
    if free_gpu:
        _free_gpu()
    r = httpx.post(f"{COMFY}/prompt", json={"prompt": wf}, timeout=30)
    r.raise_for_status()
    return r.json()["prompt_id"]


def _wait(job_id: str, timeout: int = 240) -> str:
    # Open WebUI gives up on a tool call after 5 minutes, so hand back the job id before that.
    import time

    end = time.time() + timeout
    while time.time() < end:
        status = job_status(job_id)
        if not status.startswith(("Rendering", "Waiting")):
            return status
        # Open WebUI reloads the chat model for background tasks (chat titles) while the tool waits,
        # so keep the card clear until the render is done; the model reloads for its reply.
        _free_gpu()
        time.sleep(3)
    return f"Still rendering after {timeout} s; check later with job_status (job id {job_id})."


@mcp.tool()
def make_image(prompt: str, fast: bool = False, width: int = 1024, height: int = 1024) -> str:
    """Make a picture with Qwen-Image-2.1 (good with text, signs and posters; ~1.5 min).
    fast=True uses its 4-step turbo (~25 s). Waits for the render and returns the saved file path."""
    first = "qwen-image-21-turbo.api.json" if fast else "qwen-image-21.api.json"
    name, wf = _pick(first, "z-image-turbo.api.json")  # Z-Image-Turbo when Qwen isn't installed
    if name.startswith("qwen"):
        wf["4"]["inputs"]["prompt"] = prompt
        size = wf["5"]["inputs"]
    else:
        wf["4"]["inputs"]["text"] = prompt
        size = wf["6"]["inputs"]
    size["width"], size["height"] = max(256, width // 16 * 16), max(256, height // 16 * 16)
    return _wait(_queue(wf))


@mcp.tool()
def edit_image(prompt: str, image_path: str, reference_path: str = "") -> str:
    """Edit a picture by instruction with Qwen-Image-2.1, e.g. "make it night", "replace the red car with a
    blue bicycle", "remove the person on the left". reference_path: an optional second picture (a face,
    product or outfit to use, or a black-and-white mask of the area to change). Waits (~1-2 min) and
    returns the new file path."""
    wf = _pick("qwen-image-21-edit.api.json")[1]
    wf["4"]["inputs"]["prompt"] = prompt
    wf["9"]["inputs"]["image"] = _upload(image_path)
    if reference_path:
        wf["10"] = {"class_type": "LoadImage", "inputs": {"image": _upload(reference_path)}}
        wf["4"]["inputs"]["images.image_2"] = ["10", 0]
    return _wait(_queue(wf))


@mcp.tool()
def make_video(prompt: str, image_path: str = "") -> str:
    """Queue a video in ComfyUI. With image_path: animates that image (Wan 2.2, ~10 min, 5 s, no sound).
    Without: text-to-video with sound (LTX-2.5, ~4 min, 4 s). Chat models are unloaded while it renders,
    so tell the user to wait for it before chatting more. Returns a job id for job_status."""
    import threading

    if image_path:
        wf = _pick("wan22-i2v-4step.api.json")[1]
        wf["6"]["inputs"]["text"] = prompt
        wf["9"]["inputs"]["image"] = _upload(image_path)
    else:
        # Falls back to LTX-2.3 on installs that haven't downloaded LTX-2.5.
        wf = _pick("ltx25-t2v-distilled.api.json", "ltx23-t2v-distilled.api.json")[1]
        wf["5"]["inputs"]["text"] = prompt
    job_id = _queue(wf, free_gpu=False)  # the chat model is still needed for its reply
    threading.Thread(target=_guard_gpu, args=(job_id,), daemon=True).start()
    return f"Queued video job {job_id}. It will be saved in {OUTPUT / 'video'}."


def _guard_gpu(job_id: str):
    # A chat model reloaded next to a video render fills the card and RAM, and the render crawls
    # (20+ min instead of ~4). Once the chat has replied (it's still loaded, ~30 s), keep chat models
    # unloaded until the render is done.
    import time

    time.sleep(60)
    end = time.time() + 30 * 60
    while time.time() < end and job_status(job_id).startswith(("Rendering", "Waiting")):
        _free_gpu()
        time.sleep(5)


@mcp.tool()
def job_status(job_id: str) -> str:
    """Check a make_video job (or an image that took too long). Returns the output file path when finished."""
    h = httpx.get(f"{COMFY}/history/{job_id}", timeout=30).json()
    if job_id not in h:
        q = httpx.get(f"{COMFY}/queue", timeout=30).json()
        running = any(job_id == item[1] for item in q.get("queue_running", []))
        return "Rendering now." if running else "Waiting in the queue."
    job = h[job_id]
    if job["status"].get("status_str") != "success":
        return f"Failed: {job['status'].get('messages', [])[-1:]}"
    files = [f"{OUTPUT / o['subfolder'] / o['filename']}"
             for out in job["outputs"].values() for o in out.get("images", []) if o.get("type", "output") == "output"]
    return "Done: " + ", ".join(files)


if __name__ == "__main__":
    mcp.run()
