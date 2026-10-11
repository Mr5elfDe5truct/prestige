"""Queue a ComfyUI API workflow and wait for it.  python run_workflow.py workflow.json [--image start.png] [--prompt "..."]"""
import argparse, json, time, urllib.request, uuid
from pathlib import Path

API = "http://127.0.0.1:8188"

def upload(path):
    boundary = uuid.uuid4().hex
    data = Path(path).read_bytes()
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{Path(path).name}\"\r\n"
            f"Content-Type: application/octet-stream\r\n\r\n").encode() + data + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"{API}/upload/image", body, {"Content-Type": f"multipart/form-data; boundary={boundary}"})
    return json.load(urllib.request.urlopen(req))["name"]

ap = argparse.ArgumentParser()
ap.add_argument("workflow"); ap.add_argument("--image"); ap.add_argument("--prompt")
a = ap.parse_args()
wf = json.loads(Path(a.workflow).read_text())
for node in wf.values():
    if a.image and node["class_type"] == "LoadImage":
        node["inputs"]["image"] = upload(a.image)
if a.prompt:
    first = next(n for n in wf.values() if n["class_type"] in ("CLIPTextEncode", "LTXVTextEncode") or "text" in n["inputs"])
    first["inputs"]["text"] = a.prompt
req = urllib.request.Request(f"{API}/prompt", json.dumps({"prompt": wf}).encode(), {"Content-Type": "application/json"})
pid = json.load(urllib.request.urlopen(req))["prompt_id"]
t = time.time()
while True:
    h = json.load(urllib.request.urlopen(f"{API}/history/{pid}"))
    if pid in h:
        st = h[pid]["status"]
        print(st.get("status_str"), f"{time.time() - t:.0f}s")
        for o in h[pid]["outputs"].values():
            print(o)
        if st.get("status_str") != "success":
            print(json.dumps(st.get("messages"))[-2000:])
        break
    time.sleep(5)
