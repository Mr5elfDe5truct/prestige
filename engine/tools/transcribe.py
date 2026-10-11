"""Transcribe a recording with speaker labels: Phonon-2 for the words, Nemotron 3 Diarization for who spoke when.

    envs\\transcribe\\Scripts\\python.exe tools\\transcribe.py meeting.mp4 [--speakers-off] [--out result.json]

Any audio or video ffmpeg can read goes in. Nemotron 3 Diarization (NVIDIA, up to 8 speakers) runs first, in
NeMo-Speech.cpp on a GPU (the small one when there are two, from data\\runtime\\gpu.json; ~1.5 s for a minute) or the
CPU. Each speaker's stretch is then cut at its pauses into clips of at most CLIP_S seconds, and Phonon-2 (FermionResearch,
English, on the CPU) writes down each clip through the Phonon server on :8891 (started for this run when start-all.ps1
hasn't). Short clips matter: given 20-30 s at once, Phonon-2 sometimes skipped ten seconds of speech in the middle (seen
on an MP3 of a meeting), and never did on clips.

Prints one JSON object on stdout:
    {"duration": s, "speakers": n, "turns": [{"speaker": 1, "start": s, "end": s, "text": "..."}], "text": "...",
     "seconds": {...}, "engines": {...}}
and progress on stderr as lines "PROGRESS <percent> <what>", which Prestige shows.
"""
import argparse
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PHONON_PORT = 8891
DIAR_MODEL = ROOT / "models" / "speech" / "Nemotron-3-Diarization.q8_0.gguf"
NOWINDOW = 0x08000000 if os.name == "nt" else 0
CLIP_S = 18.0  # longest clip sent to Phonon-2 in one go
MIN_CLIP_S = 0.3


def progress(pct, what):
    print(f"PROGRESS {pct} {what}", file=sys.stderr, flush=True)


def nemo_speech():
    # bin\nemo-speech\<release>\bin\nemo-speech.exe (install.ps1 unpacks the release there).
    for exe in sorted((ROOT / "bin" / "nemo-speech").glob("*/bin/nemo-speech.exe"), reverse=True):
        return exe
    return None


def small_gpu_uuid():
    """The card for diarization: Ollama's (the small one) with two or more cards, else none (CUDA picks)."""
    try:
        plan = json.loads((ROOT / "data" / "runtime" / "gpu.json").read_text(encoding="utf-8-sig"))
        gpus = {g["index"]: g["uuid"] for g in (plan.get("gpus") or [])}
        if len(gpus) < 2:
            return None
        small = plan.get("services", {}).get("ollama")
        small = small[0] if isinstance(small, list) else small
        return gpus.get(small)
    except Exception:
        return None


def to_wav(src, dst):
    # 16 kHz mono 16-bit: what both models take.
    r = subprocess.run(["ffmpeg", "-hide_banner", "-v", "error", "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000",
                        "-c:a", "pcm_s16le", str(dst)], capture_output=True, text=True, creationflags=NOWINDOW)
    if r.returncode or not Path(dst).exists():
        raise RuntimeError(f"ffmpeg couldn't read the file: {r.stderr.strip()[:300]}")


def pauses(wav):
    """Mid-points of the pauses (quiet for 0.25 s or more), where a long stretch can be cut without splitting a word."""
    r = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(wav), "-af", "silencedetect=noise=-35dB:d=0.25", "-f", "null", "-"],
                       capture_output=True, text=True, creationflags=NOWINDOW)
    starts = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", r.stderr)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", r.stderr)]
    return [(s + e) / 2 for s, e in zip(starts, ends)]


def diarize(wav):
    exe = nemo_speech()
    if not exe or not DIAR_MODEL.exists():
        raise RuntimeError("NeMo-Speech.cpp or the Nemotron 3 Diarization model isn't installed (install.ps1 -Packs transcribe)")
    env = dict(os.environ)
    card = small_gpu_uuid()
    if card:
        env["CUDA_DEVICE_ORDER"] = "PCI_BUS_ID"
        env["CUDA_VISIBLE_DEVICES"] = card
    last = ""
    for dev in (["--device", "cuda:0"], ["--device", "cpu"]):
        r = subprocess.run([str(exe), "diarize", str(wav), "--model", str(DIAR_MODEL), "--format", "json", *dev],
                           capture_output=True, text=True, encoding="utf-8", env=env, creationflags=NOWINDOW)
        if r.returncode == 0 and r.stdout.strip().startswith("{"):
            segs = json.loads(r.stdout).get("segments", [])
            return [{"start": float(s["start"]), "end": float(s["end"]), "speaker": int(s["speaker"])} for s in segs], dev[1]
        last = (r.stderr or r.stdout).strip()[-300:]
    raise RuntimeError(f"diarization failed: {last}")


def clips(segs, cuts, total):
    """Each speaker stretch as clips of at most CLIP_S seconds, cut at pauses (or hard at CLIP_S when there's none)."""
    out = []
    for s in segs:
        a, end = max(0.0, s["start"] - 0.15), min(total, s["end"] + 0.15)
        while end - a > CLIP_S:
            inside = [c for c in cuts if a + 4 < c < a + CLIP_S]
            b = inside[-1] if inside else a + CLIP_S - 2
            out.append((a, b, s["speaker"]))
            a = b
        if end - a >= MIN_CLIP_S:
            out.append((a, end, s["speaker"]))
    return out


def phonon_up():
    try:
        with socket.create_connection(("127.0.0.1", PHONON_PORT), timeout=0.5):
            return True
    except OSError:
        return False


def start_phonon():
    """A Phonon server for this run when start-all.ps1 hasn't one up (it takes ~25 s to load)."""
    fermion = Path(sys.executable).parent / ("fermion.exe" if os.name == "nt" else "fermion")
    env = {**os.environ, "HF_HUB_DISABLE_SYMLINKS_WARNING": "1"}
    p = subprocess.Popen([str(fermion), "serve", "phonon-2", "--port", str(PHONON_PORT)], stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, env=env, creationflags=NOWINDOW)
    for _ in range(240):
        if phonon_up():
            return p
        if p.poll() is not None:
            raise RuntimeError("the Phonon-2 server didn't start")
        time.sleep(0.5)
    p.kill()
    raise RuntimeError("the Phonon-2 server didn't start in 2 minutes")


def transcribe_clip(frames, rate):
    boundary = uuid.uuid4().hex
    buf = __import__("io").BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(frames)
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nphonon-2\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="clip.wav"\r\n'
            f'Content-Type: audio/wav\r\n\r\n').encode() + buf.getvalue() + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"http://127.0.0.1:{PHONON_PORT}/v1/audio/transcriptions", body,
                                 {"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return str(json.load(r).get("text", "")).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--speakers-off", action="store_true", help="words only, no diarization")
    ap.add_argument("--out", help="also write the JSON here")
    a = ap.parse_args()
    t0 = time.time()
    progress(2, "Reading the file")
    server = None
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "audio.wav"
        to_wav(a.input, wav)
        with wave.open(str(wav), "rb") as w:
            rate, n = w.getframerate(), w.getnframes()
            audio = w.readframes(n)
        total = n / rate
        t_conv = time.time() - t0
        if not phonon_up():
            progress(5, "Loading Phonon-2")
            server = start_phonon()
        diar_err, diar_dev, t_d = None, None, time.time()
        segs = []
        if not a.speakers_off:
            progress(8, "Finding who speaks when")
            try:
                segs, diar_dev = diarize(wav)
            except Exception as e:
                diar_err = str(e)
        t_d = time.time() - t_d
        cuts = pauses(wav)
        if not segs:
            # No speakers: the whole recording as one speaker, still cut at its pauses.
            segs = [{"start": 0.0, "end": total, "speaker": 1}]
        parts = clips(segs, cuts, total)
        t_w = time.time()
        turns = []
        done_s = 0.0
        try:
            for i, (s, e, spk) in enumerate(parts):
                text = transcribe_clip(audio[int(s * rate) * 2:int(e * rate) * 2], rate)
                done_s += e - s
                progress(int(10 + 85 * done_s / max(1e-6, sum(p[1] - p[0] for p in parts))), f"Writing it down ({i + 1} of {len(parts)})")
                if not text:
                    continue
                if turns and turns[-1]["speaker"] == spk and s - turns[-1]["end"] < 1.5:
                    turns[-1]["text"] += " " + text
                    turns[-1]["end"] = round(e, 2)
                else:
                    turns.append({"speaker": spk, "start": round(s, 2), "end": round(e, 2), "text": text})
        finally:
            if server:
                server.kill()
        t_w = time.time() - t_w
        # Speakers numbered 1, 2, 3… in order of first appearance.
        order = {}
        for t in turns:
            t["speaker"] = order.setdefault(t["speaker"], len(order) + 1)
        out = {
            "duration": round(total, 1),
            "speakers": len(order) if not diar_err and not a.speakers_off else 0,
            "turns": turns,
            "text": " ".join(t["text"] for t in turns),
            "seconds": {"convert": round(t_conv, 1), "speakers": round(t_d, 1), "words": round(t_w, 1), "total": round(time.time() - t0, 1)},
            "engines": {"words": "Phonon-2 (CPU)", "speakers": diar_dev, "speakers_error": diar_err, "clips": len(parts)},
        }
    s = json.dumps(out, ensure_ascii=False)
    if a.out:
        Path(a.out).write_text(s, encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    print(s)
    progress(100, "Done")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": str(e)}), flush=True)
        sys.exit(1)
