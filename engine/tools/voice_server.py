"""Voice server: speech-to-text with Whisper large-v3-turbo and expressive text-to-speech with VoxCPM2.

OpenAI-compatible, so Open WebUI and Prestige use it like any speech API:
  POST /v1/audio/transcriptions   multipart file (+ language)       -> {"text": ...}
                                  response_format=verbose_json        -> {"text", "duration", "segments": [{start, end, text,
                                                                         words: [{start, end, word}]}]} (no voice filter,
                                                                         so sung lyrics over music are kept)
  POST /v1/audio/speech           {"input", "voice", "response_format"} -> audio (wav, or mp3 with ffmpeg)
                                  {"stream": true} -> raw 16-bit mono PCM as it is made (rate in X-Sample-Rate)
  GET  /v1/audio/voices           VoxCPM2 voices: the built-in designed voices plus any clips in data\\voices
  POST /v1/audio/voices           multipart name + file (+ transcript, description): add a voice to clone
  POST /v1/audio/design           {"description", "text", "takes"}: 1-3 takes of a voice made from words (base64 WAVs)
  POST /v1/audio/unload           frees the GPU (both models); Prestige calls it before a chat reply
  POST /v1/audio/load             {"models": ["stt", "tts"], "voice"}: loads them now and keeps them warm (Live mode)
  WS   /v1/turns                  a Live call's turn-taking with TYGER: when the user has finished, or cuts in

Both models load on first use and unload after a few idle minutes. Whisper runs on the GPU (~1 GB, 0.1-0.3 s a
sentence; ~25 s on the CPU) and falls back to the CPU base model when the GPU is full. VoxCPM2 needs ~6 GB of GPU
memory, so it only fits next to the small chat models; when a chat model is in the way it is unloaded first.

Run: envs\\voice\\Scripts\\python.exe tools\\voice_server.py   (port 8890; start-all.ps1 does this)
"""
import asyncio
import io
import json
import os
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import httpx
import numpy as np
import soundfile as sf
import torch
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse

ROOT = Path(__file__).resolve().parent.parent
WHISPER_DIR = ROOT / "models" / "whisper"
VOXCPM_DIR = ROOT / "models" / "tts" / "VoxCPM2"
VOICES = ROOT / "data" / "voices"
WHISPER_MODEL = os.getenv("VOICE_WHISPER_MODEL", "large-v3-turbo")
WHISPER_IDLE = int(os.getenv("VOICE_WHISPER_IDLE", "300"))  # seconds before Whisper leaves the GPU
VOXCPM_IDLE = int(os.getenv("VOICE_TTS_IDLE", "180"))
VOXCPM_STEPS = int(os.getenv("VOICE_TTS_STEPS", "10"))  # VoxCPM's default; fewer let a cloned voice's pace and level wander
VOXCPM_CFG = float(os.getenv("VOICE_TTS_CFG", "2.0"))
LEVEL_DB = -20.0  # loudness (dBFS, over the voiced part) every voice clip and every spoken sentence is brought to
CLIP_MAX = 20.0  # seconds of a cloned voice clip kept: VoxCPM2 averages a longer one into a flatter, wandering voice
VOXCPM_VRAM = 6.2e9  # what VoxCPM2 needs free on the GPU (5.7 GB peak plus headroom)

# Designed voices: VoxCPM2 makes a voice from a description. Each one is rendered once into data\voices and cloned
# from then on, so every sentence of a reply uses the same voice.
DESIGNED = {
    "aria": "A warm, clear young woman's voice, friendly and relaxed, natural American accent",
    "sterling": "A calm, deep male voice with a refined British accent, measured and confident",
    "nova": "A bright, energetic young woman's voice, upbeat and expressive",
    "atlas": "A rich, steady middle-aged male narrator, warm and authoritative",
    "ember": "A soft, husky female voice, intimate and slow-paced",
}
WARMUP = ("Sure, I can see it now: there's a mug of coffee on the left, a keyboard in front of you and a lamp behind the "
          "monitor, and it all looks pretty tidy to me, honestly.")
SAMPLE = "Hello there. It's good to hear from you, and I'm ready whenever you are. What should we make today?"

app = FastAPI(title="Workstation voice")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
gpu_lock = threading.Lock()  # one GPU job at a time
state = {"whisper": None, "whisper_device": None, "whisper_used": 0.0, "tts": None, "tts_used": 0.0}
prompt_cache: dict = {}  # voice -> (clip mtime, VoxCPM2 prompt cache): a clip is encoded once, not every sentence
no_transcript: set = set()  # cloned voices Whisper found no words in (cloned from the sound alone)


def _shares_card(other: str) -> bool:
    # data/runtime/gpu.json (start-all.ps1) says which cards each service runs on. With one card, or no plan, everything
    # shares it; with several, a chat model on another card doesn't need to make room for the voices.
    try:
        s = json.loads((ROOT / "data" / "runtime" / "gpu.json").read_text(encoding="utf-8")).get("services") or {}
    except (OSError, ValueError):
        return True
    mine, theirs = set(s.get("voice") or []), set(s.get(other) or [])
    return not mine or not theirs or bool(mine & theirs)


def _free_vram() -> int:
    # nvidia-smi, not torch.cuda.mem_get_info(): on Windows the driver lets CUDA spill into system RAM, so torch can
    # report gigabytes free on a full card, and a model loaded there runs several times slower.
    # start-all.ps1 pins this server to a card by UUID when the PC has several; ask nvidia-smi about that one.
    gpu = os.environ.get("CUDA_VISIBLE_DEVICES", "").split(",")[0].strip()
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.total,memory.used", "--format=csv,noheader,nounits"]
                             + (["-i", gpu] if gpu.startswith("GPU-") else []),
                             capture_output=True, text=True, timeout=10).stdout.splitlines()[0]
        total, used = (int(x) for x in out.split(","))
        return (total - used) * 1024 * 1024
    except Exception:
        return torch.cuda.mem_get_info()[0] if torch.cuda.is_available() else 0


def _free_chat_models():
    # Same as the tool server does for renders: unload Ollama's and llama.cpp's models (they reload on the next reply).
    try:
        for m in httpx.get("http://127.0.0.1:11434/api/ps", timeout=5).json().get("models", []) if _shares_card("ollama") else []:
            httpx.post("http://127.0.0.1:11434/api/generate", json={"model": m["name"], "keep_alive": 0}, timeout=30)
    except httpx.HTTPError:
        pass
    try:
        for m in httpx.get("http://127.0.0.1:8081/models", timeout=5).json().get("data", []) if _shares_card("llama") else []:
            if m.get("status", {}).get("value") in ("loaded", "loading"):
                httpx.post("http://127.0.0.1:8081/models/unload", json={"model": m["id"]}, timeout=30)
    except httpx.HTTPError:
        pass
    for _ in range(20):  # wait for the memory to come back
        if _free_vram() >= VOXCPM_VRAM:
            return
        time.sleep(0.5)


def _unload(which: str):
    if state[which] is not None:
        state[which] = None
        if which == "whisper":
            state["whisper_device"] = None
        else:
            prompt_cache.clear()
        import gc

        gc.collect()
        torch.cuda.empty_cache()


# ---------- speech to text ----------
def _whisper():
    from faster_whisper import WhisperModel

    if state["whisper"] is None:
        try:
            state["whisper"] = WhisperModel(WHISPER_MODEL, device="cuda", compute_type="int8_float16",
                                            download_root=str(WHISPER_DIR))
            state["whisper_device"] = "cuda"
        except Exception as e:  # GPU full or no CUDA: the small model on the CPU stays quick enough to talk to
            print(f"Whisper on the GPU failed ({e}); using the CPU base model", flush=True)
            state["whisper"] = WhisperModel("base", device="cpu", compute_type="int8", download_root=str(WHISPER_DIR))
            state["whisper_device"] = "cpu"
    state["whisper_used"] = time.time()
    return state["whisper"]


def _transcribe(path: str, language: str | None, beam: int = 5, words: bool = False):
    # Greedy (beam 1) is Live mode: its clips are already cut to the speech, so Whisper's own voice filter and
    # timestamps are skipped too. With words (verbose_json, e.g. a song's lyrics for Prestige's Director) every word
    # gets its time, and the voice filter is off: it drops singing over music.
    kw = {"vad_filter": True} if beam > 1 else {"vad_filter": False, "without_timestamps": True}
    if words:
        kw = {"vad_filter": False, "word_timestamps": True}
    out = []
    with gpu_lock:
        model = _whisper()
        try:
            segs, _ = model.transcribe(path, language=language or None, beam_size=beam, **kw)
            out = list(segs)
            text = " ".join(s.text.strip() for s in out)
        except RuntimeError as e:  # out of GPU memory mid-run: retry once on the CPU
            if state["whisper_device"] != "cuda":
                raise
            print(f"Whisper GPU run failed ({e}); retrying on the CPU", flush=True)
            _unload("whisper")
            from faster_whisper import WhisperModel

            state["whisper"] = WhisperModel("base", device="cpu", compute_type="int8", download_root=str(WHISPER_DIR))
            state["whisper_device"] = "cpu"
            segs, _ = state["whisper"].transcribe(path, language=language or None, beam_size=beam, **kw)
            out = list(segs)
            text = " ".join(s.text.strip() for s in out)
        state["whisper_used"] = time.time()
    if not words:
        return text.strip()
    return {
        "text": text.strip(),
        "segments": [
            {"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip(),
             "words": [{"start": round(w.start, 2), "end": round(w.end, 2), "word": w.word.strip()} for w in (s.words or [])]}
            for s in out
        ],
    }


@app.post("/v1/audio/transcriptions")
async def transcriptions(file: UploadFile = File(...), model: str = Form(""), language: str = Form(""),
                         response_format: str = Form("json"), beam_size: int = Form(5)):
    # Live mode sends beam_size 1: greedy decoding is quicker on a short utterance and as accurate for plain speech.
    suffix = Path(file.filename or "audio.webm").suffix or ".webm"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as f:
        f.write(await file.read())
    try:
        verbose = response_format == "verbose_json"
        text = await asyncio.to_thread(_transcribe, f.name, language.strip().lower() or None, max(1, min(beam_size, 5)), verbose)
    finally:
        os.unlink(f.name)
    if verbose:
        return text
    if response_format == "text":
        return Response(text, media_type="text/plain")
    return {"text": text}


# ---------- text to speech ----------
def _voxcpm():
    if state["tts"] is None:
        if _free_vram() < VOXCPM_VRAM:
            _unload("whisper")  # it reloads in a few seconds when it's needed
        if _free_vram() < VOXCPM_VRAM:
            _free_chat_models()
        if _free_vram() < VOXCPM_VRAM:
            raise HTTPException(503, "VoxCPM2 needs about 6 GB of free GPU memory; something else is using the GPU")
        from voxcpm import VoxCPM

        state["tts"] = VoxCPM.from_pretrained(str(VOXCPM_DIR), load_denoiser=False)
    state["tts_used"] = time.time()
    return state["tts"]


def _voice_files(name: str):
    wav = VOICES / f"{name}.wav"
    txt = VOICES / f"{name}.txt"
    return wav, (txt.read_text(encoding="utf-8").strip() if txt.exists() else None)


def _voice_list():
    names = set(DESIGNED)
    if VOICES.exists():
        names |= {p.stem for p in VOICES.glob("*.wav")}
    return sorted(names, key=lambda n: (n not in DESIGNED, n))


def _frame_rms(audio: np.ndarray, sr: int, ms: int = 20) -> tuple[np.ndarray, int]:
    hop = max(1, sr * ms // 1000)
    n = len(audio) // hop
    frames = audio[: n * hop].reshape(n, hop) if n else np.zeros((1, max(1, len(audio))))
    return np.sqrt((frames ** 2).mean(axis=1) + 1e-12), hop


def _voiced(rms: np.ndarray) -> np.ndarray:
    # Speech, as opposed to room noise and breaths: within 35 dB of the clip's loud parts.
    return rms > max(np.percentile(rms, 95) * 10 ** (-35 / 20), 1e-4)


def _level(audio: np.ndarray, sr: int) -> np.ndarray:
    """`audio` brought to LEVEL_DB over its voiced part, without clipping."""
    rms, _ = _frame_rms(audio, sr)
    voiced = rms[_voiced(rms)]
    if not len(voiced):
        return audio
    gain = 10 ** (LEVEL_DB / 20) / np.sqrt((voiced ** 2).mean())
    peak = np.abs(audio).max() * gain
    if peak > 0.95:
        gain *= 0.95 / peak
    return (audio * gain).astype(np.float32)


def _clean_clip(audio: np.ndarray, sr: int) -> np.ndarray:
    """A voice clip as VoxCPM2 clones best from it: no silence at the ends, no long pauses, one steady level.
    The quiet stretches of a mic recording otherwise come back as a voice that drops to a whisper now and then."""
    rms, hop = _frame_rms(audio, sr)
    on = np.flatnonzero(_voiced(rms))
    if not len(on):
        return audio
    keep, gap, pause = [], int(0.7 * sr / hop), int(0.35 * sr / hop)
    start = prev = on[0]
    for i in on[1:]:
        if i - prev > gap:  # a long pause: keep 0.35 s of it
            keep.append((start, prev + pause // 2))
            start = i - pause // 2
        prev = i
    keep.append((start, prev + 1))
    pad = int(0.1 * sr)
    pieces = [audio[max(0, a * hop - (pad if k == 0 else 0)): b * hop + (pad if k == len(keep) - 1 else 0)]
              for k, (a, b) in enumerate(keep)]
    return _level(np.concatenate(pieces).astype(np.float32), sr)


def _clip_and_transcript(audio: np.ndarray, sr: int) -> tuple[np.ndarray, str]:
    """Up to CLIP_MAX seconds of a cleaned clip, ending where a sentence ends, and what it says (Whisper, which the
    caller holds gpu_lock for). VoxCPM2 clones from the clip alone without the words, and that is when a voice's
    speed and volume drift from sentence to sentence; with them it continues the clip and stays steady."""
    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as f:
        sf.write(f.name, audio, sr, subtype="PCM_16")
    try:
        segs, _ = _whisper().transcribe(f.name, beam_size=5, word_timestamps=True, vad_filter=False)
        words = [w for s in segs for w in (s.words or [])]
        state["whisper_used"] = time.time()
    finally:
        os.unlink(f.name)
    fits = [i for i, w in enumerate(words) if w.end <= CLIP_MAX]
    if not fits:
        return audio, ""
    last = fits[-1]
    ends = [i for i in fits if words[i].word.strip().endswith((".", "!", "?")) and words[i].end >= 6]
    if ends and len(audio) / sr > CLIP_MAX:
        last = ends[-1]
    cut = len(audio) if last == len(words) - 1 else min(len(audio), int((words[last].end + 0.15) * sr))
    return audio[:cut], "".join(w.word for w in words[: last + 1]).strip()


def _ready_clip(voice: str):
    """A cloned voice saved without a transcript gets a cleaned clip and its words, once. The original stays beside
    it as <name>.original.flac. Called with gpu_lock held, before VoxCPM2 loads (Whisper needs the room)."""
    wav, transcript = _voice_files(voice)
    if transcript is not None or not wav.exists() or voice in DESIGNED or voice in no_transcript:
        return
    try:
        audio, sr = sf.read(str(wav), dtype="float32")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        clip, text = _clip_and_transcript(_clean_clip(audio, sr), sr)
    except Exception as e:  # noqa: BLE001 - the voice still works from the clip alone
        print(f"couldn't transcribe the {voice} clip ({e}); cloning from the sound alone", flush=True)
        no_transcript.add(voice)
        return
    if not text:
        no_transcript.add(voice)
        return
    original = wav.with_name(f"{voice}.original.flac")
    if not original.exists():
        sf.write(str(original), audio, sr)
    sf.write(str(wav), clip, sr, subtype="PCM_16")
    wav.with_suffix(".txt").write_text(text, encoding="utf-8")
    print(f"{voice}: cleaned the clip to {len(clip) / sr:.1f} s and saved what it says", flush=True)


class _Leveler:
    """Keeps one sentence at LEVEL_DB as it streams: the gain follows the sentence's voiced loudness so far, so a
    take that comes out quiet (or loud) is evened out, and changes smoothly within a piece so it doesn't pump."""

    def __init__(self, sr: int):
        self.sr, self.energy, self.frames, self.gain = sr, 0.0, 0, None

    def __call__(self, chunk: np.ndarray) -> np.ndarray:
        rms, _ = _frame_rms(chunk, self.sr)
        voiced = rms[rms > 10 ** (-45 / 20)]
        self.energy += float((voiced ** 2).sum())
        self.frames += len(voiced)
        if not self.frames:
            return chunk
        target = float(np.clip(10 ** (LEVEL_DB / 20) / np.sqrt(self.energy / self.frames), 0.5, 4.0))
        start = target if self.gain is None else self.gain
        self.gain = target
        out = chunk * np.linspace(start, target, len(chunk), dtype=np.float32)
        mag = np.abs(out)  # a soft ceiling for the loud bits of a sentence that started quiet
        return np.where(mag > 0.9, np.sign(out) * (0.9 + 0.09 * np.tanh((mag - 0.9) / 0.09)), out).astype(np.float32)


def _voice_kw(model, voice: str) -> dict:
    """The cloning arguments for a voice (rendering a designed voice the first time it is used)."""
    sr = model.tts_model.sample_rate
    wav_path, transcript = _voice_files(voice)
    if not wav_path.exists() and voice in DESIGNED:
        # First use of a designed voice: render it from its description, then clone it from now on.
        VOICES.mkdir(parents=True, exist_ok=True)
        sample = model.generate(text=f"({DESIGNED[voice]}){SAMPLE}", cfg_value=VOXCPM_CFG, inference_timesteps=10)
        sf.write(wav_path, sample, sr)
        wav_path.with_suffix(".txt").write_text(SAMPLE, encoding="utf-8")
        transcript = SAMPLE
    kw = {}
    if wav_path.exists() and sf.info(str(wav_path)).duration < 1:
        raise HTTPException(400, f"the voice clip for {voice} is empty; add it again with Clone a voice")
    if wav_path.exists():
        kw["reference_wav_path"] = str(wav_path)
        if transcript:  # "ultimate cloning": the clip plus what it says keeps the voice closest
            kw["prompt_wav_path"] = str(wav_path)
            kw["prompt_text"] = transcript
    return kw


def _style(voice: str) -> str:
    # A voice that isn't a file is a description: "(a cheerful old man)" style prompts.
    return "" if _voice_files(voice)[0].exists() or not voice or voice == "default" else f"({voice})"


def _cached_prompt(model, voice: str, kw: dict):
    """VoxCPM2's encoding of a voice clip, made once per clip instead of once per sentence."""
    if not kw or not hasattr(model.tts_model, "build_prompt_cache"):
        return None
    mtime = Path(kw["reference_wav_path"]).stat().st_mtime
    hit = prompt_cache.get(voice)
    if hit and hit[0] == mtime:
        return hit[1]
    cache = model.tts_model.build_prompt_cache(prompt_text=kw.get("prompt_text"), prompt_wav_path=kw.get("prompt_wav_path"),
                                               reference_wav_path=kw.get("reference_wav_path"))
    prompt_cache[voice] = (mtime, cache)
    # Encoding the clip briefly needs ~0.5 GB more than speaking does; hand that back rather than keep it reserved.
    torch.cuda.empty_cache()
    return cache


def _chunks(model, text: str, voice: str, steps: int, streaming: bool):
    """Audio for `text` in `voice`, at the same loudness as every other sentence: one array, or (streaming) a piece
    at a time as it is made."""
    level = _Leveler(model.tts_model.sample_rate)
    gen = _raw_chunks(model, text, voice, steps, streaming)
    try:
        for piece in gen:
            yield level(np.asarray(piece, dtype=np.float32))
    finally:
        gen.close()


def _raw_chunks(model, text: str, voice: str, steps: int, streaming: bool):
    kw = _voice_kw(model, voice)
    text = _style(voice) + text
    cache = _cached_prompt(model, voice, kw)
    if cache is not None or not kw:
        gen = model.tts_model._generate_with_prompt_cache(target_text=text, prompt_cache=cache, inference_timesteps=steps,
                                                          cfg_value=VOXCPM_CFG, retry_badcase=not streaming, streaming=streaming)
        try:
            for wav, _, _ in gen:
                yield wav.squeeze(0).float().cpu().numpy()
        finally:
            gen.close()
    elif streaming:
        yield from model.generate_streaming(text=text, cfg_value=VOXCPM_CFG, inference_timesteps=steps, **kw)
    else:
        yield model.generate(text=text, cfg_value=VOXCPM_CFG, inference_timesteps=steps, **kw)


def _speak(text: str, voice: str, steps: int) -> tuple[np.ndarray, int]:
    with gpu_lock:
        _ready_clip(voice)
        model = _voxcpm()
        audio = np.concatenate(list(_chunks(model, text, voice, steps, False)))
        state["tts_used"] = time.time()
        return audio, model.tts_model.sample_rate


def _encode(audio: np.ndarray, sr: int, fmt: str) -> tuple[bytes, str]:
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
    data = buf.getvalue()
    if fmt in ("mp3", "opus", "aac") and shutil.which("ffmpeg"):
        codec = {"mp3": ["-f", "mp3", "-b:a", "160k"], "opus": ["-f", "ogg", "-c:a", "libopus"], "aac": ["-f", "adts"]}
        out = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", "pipe:0", *codec[fmt], "pipe:1"],
                             input=data, capture_output=True)
        if out.returncode == 0:
            return out.stdout, {"mp3": "audio/mpeg", "opus": "audio/ogg", "aac": "audio/aac"}[fmt]
    return data, "audio/wav"


@app.post("/v1/audio/speech")
async def speech(body: dict):
    text = re.sub(r"\s+", " ", str(body.get("input", ""))).strip()
    if not text:
        raise HTTPException(400, "input is empty")
    voice = str(body.get("voice") or "aria").strip()
    steps = int(body.get("steps") or VOXCPM_STEPS)
    if body.get("stream"):
        return await _stream_speech(text, voice, steps)
    audio, sr = await asyncio.to_thread(_speak, text, voice, steps)
    # No "speed": VoxCPM2 takes pace from the text, or from a style note like "(slightly faster)".
    data, mime = _encode(audio, sr, body.get("response_format", "wav"))
    return Response(data, media_type=mime)


async def _stream_speech(text: str, voice: str, steps: int):
    """Raw PCM as VoxCPM2 makes it, so playback starts after the first piece instead of the whole sentence.
    The model runs in its own thread; when the client hangs up (Live mode's barge-in) it stops after the current piece."""
    out: queue.Queue = queue.Queue()
    cancel = threading.Event()

    def work():
        try:
            with gpu_lock:
                _ready_clip(voice)
                model = _voxcpm()
                out.put(("sr", model.tts_model.sample_rate))
                gen = _chunks(model, text, voice, steps, True)
                try:
                    for chunk in gen:
                        if cancel.is_set():
                            break
                        out.put(("pcm", (np.clip(chunk, -1, 1) * 32767).astype("<i2").tobytes()))
                finally:
                    gen.close()
                state["tts_used"] = time.time()
        except HTTPException as e:
            out.put(("error", e))
        except Exception as e:  # noqa: BLE001 - reported to the client
            out.put(("error", HTTPException(500, f"VoxCPM2 failed: {e}")))
        finally:
            out.put(("end", None))

    threading.Thread(target=work, daemon=True).start()
    kind, val = await asyncio.to_thread(out.get)  # the sample rate, or why it couldn't start
    if kind == "error":
        raise val
    if kind != "sr":
        raise HTTPException(500, "VoxCPM2 stopped before speaking")
    rate = val

    async def body():
        try:
            while True:
                kind, val = await asyncio.to_thread(out.get)
                if kind != "pcm":
                    break
                yield val
        finally:
            cancel.set()

    return StreamingResponse(body(), media_type="audio/L16", headers={
        "X-Sample-Rate": str(rate), "Cache-Control": "no-store", "Access-Control-Expose-Headers": "X-Sample-Rate"})


@app.post("/v1/audio/load")
def load(body: dict | None = None):
    """Loads the models now and keeps them from idling out, so a Live call's first turn doesn't wait for them."""
    body = body or {}
    which = body.get("models") or ["stt", "tts"]
    voice = str(body.get("voice") or "").strip()
    with gpu_lock:
        # A new model's first run is slow (CUDA kernels warming up), so do one now rather than on the first question.
        if "stt" in which:
            fresh = state["whisper"] is None
            model = _whisper()
            if fresh:
                list(model.transcribe(np.zeros(16000, dtype=np.float32), language="en", beam_size=1)[0])
        if "tts" in which:
            if voice:
                _ready_clip(voice)
            fresh = state["tts"] is None
            model = _voxcpm()
            if voice:
                _cached_prompt(model, voice, _voice_kw(model, voice))
            if fresh:
                # As long a sentence as Live sends: PyTorch keeps the working memory it reserves here, so a model
                # loaded next to VoxCPM2 (the Live chat model) can't take it, and a long sentence later doesn't
                # spill into system RAM (on Windows that makes it many times slower instead of failing).
                for _ in _chunks(model, WARMUP, voice or "aria", 4, True):
                    pass
            state["tts_used"] = time.time()
    return {"ok": True, "whisper": state["whisper_device"], "voxcpm2": state["tts"] is not None,
            "free_vram_gb": round(_free_vram() / 1e9, 1)}


# ---------- turn-taking (TYGER) ----------
# TYGER (NineNineSix; the turns pack, models\speech\tyger) hears both sides of a Live call: the user's mic and what
# Prestige is playing, 16 kHz, a 320 ms hop at a time, and says when the user has finished (ENDPOINT) and when they
# cut in while Prestige talks (BARGE). Its runtime is tools\tyger (tyger-s2s's, unchanged). It runs outside gpu_lock:
# a hop takes ~55 ms on an RTX 3060 and must not wait for a sentence of VoxCPM2. One call at a time; ~2.6 GB of VRAM,
# loaded when a call opens /v1/turns and unloaded after TURNS_IDLE seconds without one.
TYGER_DIR = ROOT / "models" / "speech" / "tyger"
TURNS_IDLE = int(os.getenv("VOICE_TURNS_IDLE", "120"))
# Barge-in at the threshold TYGER was evaluated at (its default 0.5 also fires on "mm-hm"); endpoint at its default.
BARGE_THR = 0.93
turns = {"engine": None, "lock": threading.Lock(), "used": 0.0, "calls": 0}


def _tyger():
    with turns["lock"]:
        if turns["engine"] is None:
            import sys

            sys.path.insert(0, str(Path(__file__).resolve().parent))
            from tyger.engine import EarsEngine

            turns["engine"] = EarsEngine(str(TYGER_DIR), slots=1, device="cuda", cuda_graph=False)
        turns["used"] = time.time()
        return turns["engine"]


@app.websocket("/v1/turns")
async def turns_ws(ws: WebSocket):
    """A Live call's turn-taking. Each binary message is one hop: a mode byte (0 listening, 1 Prestige speaking), then
    5120 int16 samples of the mic and 5120 of Prestige's voice, 16 kHz. Each answer is {"ev": [events]}: BARGE
    {yield_prob, onset_s} while speaking, ENDPOINT {p_end} and BACKCHANNEL {bc_prob} while listening."""
    await ws.accept()
    if not (TYGER_DIR / "model.safetensors").exists():
        await ws.send_json({"error": "the Turn-taking pack isn't installed"})
        await ws.close()
        return
    if turns["calls"]:
        await ws.send_json({"error": "another call is using turn-taking"})
        await ws.close()
        return
    turns["calls"] += 1
    try:
        engine = await asyncio.to_thread(_tyger)
        from tyger.constants import HOP_N
        from tyger.session import EarsSession

        # No partial transcripts: Whisper transcribes the turn, and they cost GPU memory and time.
        sess = EarsSession(0, barge_thr=BARGE_THR, partial_refresh_s=1e9)
        await ws.send_json({"ready": True})
        while True:
            msg = await ws.receive_bytes()
            if len(msg) != 1 + 4 * HOP_N:
                continue
            mode = "speaking" if msg[0] == 1 else "listen"
            pcm = np.frombuffer(msg, dtype=np.int16, offset=1).astype(np.float32) / 32768
            res = await asyncio.to_thread(engine.process, [(sess, pcm[:HOP_N], pcm[HOP_N:], mode)])
            turns["used"] = time.time()
            events, _ = res[sess]
            out = [{k: v for k, v in e.items() if k in ("kind", "yield_prob", "onset_s", "p_end", "bc_prob")}
                   for e in events if e.get("kind") in ("BARGE", "ENDPOINT", "BACKCHANNEL")]
            await ws.send_json({"ev": out})
    except WebSocketDisconnect:
        pass
    finally:
        turns["calls"] -= 1


def _unload_turns():
    with turns["lock"]:
        if turns["engine"] is not None and not turns["calls"]:
            turns["engine"].close()  # its ASR thread holds it otherwise
            turns["engine"] = None
            import gc

            gc.collect()
            torch.cuda.empty_cache()
            print("unloaded TYGER", flush=True)


@app.get("/v1/audio/voices")
def voices():
    return {"voices": _voice_list(), "designed": DESIGNED}


def _design(description: str, text: str, takes: int) -> tuple[list[np.ndarray], int]:
    # No reference clip: VoxCPM2 makes the voice up from the description, differently every time.
    with gpu_lock:
        model = _voxcpm()
        out = [model.generate(text=f"({description}){text}", cfg_value=VOXCPM_CFG, inference_timesteps=10) for _ in range(takes)]
        state["tts_used"] = time.time()
        return out, model.tts_model.sample_rate


@app.post("/v1/audio/design")
async def design(body: dict):
    """{"description", "text"?, "takes"?: 1-3} -> {"text", "takes": [base64 WAV]}: voices made from words, to pick one
    and keep it with POST /v1/audio/voices (the take is the clip, `text` its transcript)."""
    import base64

    description = re.sub(r"\s+", " ", str(body.get("description", ""))).strip().replace("(", "").replace(")", "")[:300]
    if not description:
        raise HTTPException(400, "describe the voice, e.g. a gravelly old pirate, slow and amused")
    text = re.sub(r"\s+", " ", str(body.get("text") or SAMPLE)).strip()[:400] or SAMPLE
    takes = max(1, min(int(body.get("takes") or 3), 3))
    clips, sr = await asyncio.to_thread(_design, description, text, takes)
    return {"text": text, "takes": [base64.b64encode(_encode(c, sr, "wav")[0]).decode() for c in clips]}


@app.post("/v1/audio/voices")
async def add_voice(name: str = Form(...), file: UploadFile = File(...), transcript: str = Form(""),
                    description: str = Form("")):
    name = re.sub(r"[^a-z0-9_-]+", "-", name.strip().lower()).strip("-")
    if not name:
        raise HTTPException(400, "give the voice a name")
    VOICES.mkdir(parents=True, exist_ok=True)
    raw = await file.read()
    try:  # store as 16-bit WAV; ffmpeg handles webm/mp3/m4a recordings
        audio, sr = sf.read(io.BytesIO(raw))
    except Exception:
        if not shutil.which("ffmpeg"):
            raise HTTPException(400, "use a WAV or FLAC file (ffmpeg isn't installed for other formats)")
        # From a temp file (an .m4a keeps its index at the end, which ffmpeg can't reach on a pipe) to raw samples
        # (a WAV written to a pipe has no length in its header and reads back as zero samples).
        sr = 16000
        with tempfile.NamedTemporaryFile(delete=False, suffix=Path(file.filename or "clip").suffix or ".bin") as f:
            f.write(raw)
        try:
            out = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", f.name, "-ac", "1", "-ar", str(sr), "-f", "f32le",
                                  "pipe:1"], capture_output=True)
        finally:
            os.unlink(f.name)
        if out.returncode:
            raise HTTPException(400, "couldn't read that audio file")
        audio = np.frombuffer(out.stdout, dtype=np.float32)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if len(audio) < sr * 3:
        raise HTTPException(400, f"that clip has {len(audio) / sr:.1f} s of audio; use 5-30 s of one person speaking")
    audio = audio[: sr * 60].astype(np.float32)
    if not description.strip():  # a recording (a designed voice's take is already clean)
        audio = _clean_clip(audio, sr)
    if transcript.strip():
        audio = audio[: sr * 30]  # a 5-30 s clip is plenty
    else:  # Whisper writes down what it says, and the clip is cut to CLIP_MAX seconds at the end of a sentence
        def words():
            with gpu_lock:
                return _clip_and_transcript(audio, sr)
        try:
            audio, transcript = await asyncio.to_thread(words)
        except Exception as e:  # noqa: BLE001 - it still clones from the sound alone
            print(f"couldn't transcribe the {name} clip ({e})", flush=True)
            audio = audio[: sr * 30]
    sf.write(VOICES / f"{name}.wav", audio, sr, subtype="PCM_16")
    VOICES.joinpath(f"{name}.original.flac").unlink(missing_ok=True)
    prompt_cache.pop(name, None)
    txt = VOICES / f"{name}.txt"
    if transcript.strip():
        txt.write_text(transcript.strip(), encoding="utf-8")
        no_transcript.discard(name)
    else:
        txt.unlink(missing_ok=True)
        no_transcript.add(name)
    # A designed voice keeps the words it was made from, so it can be made again.
    note = VOICES / f"{name}.design.txt"
    if description.strip():
        note.write_text(description.strip(), encoding="utf-8")
    elif note.exists():
        note.unlink()
    return {"voice": name, "seconds": round(len(audio) / sr, 1)}


@app.post("/v1/audio/unload")
def unload(body: dict | None = None):
    which = (body or {}).get("model", "all")
    with gpu_lock:
        if which in ("all", "tts", "voxcpm2"):
            _unload("tts")
        if which in ("all", "stt", "whisper"):
            _unload("whisper")
    if which in ("all", "turns", "tyger"):
        _unload_turns()
    return {"ok": True}


@app.get("/health")
def health():
    return {"status": "ok", "whisper": state["whisper_device"], "voxcpm2": state["tts"] is not None,
            "turns": (TYGER_DIR / "model.safetensors").exists(), "turns_loaded": turns["engine"] is not None,
            "free_vram_gb": round(_free_vram() / 1e9, 1),
            "torch_reserved_gb": round(torch.cuda.memory_reserved() / 1e9, 2) if torch.cuda.is_available() else 0}


@app.get("/v1/models")
def models():
    return {"data": [{"id": "whisper-large-v3-turbo", "object": "model"}, {"id": "voxcpm2", "object": "model"}]}


def _janitor():
    while True:
        time.sleep(15)
        now = time.time()
        for which, idle in (("tts", VOXCPM_IDLE), ("whisper", WHISPER_IDLE)):
            if state[which] is not None and now - state[f"{which}_used"] > idle and gpu_lock.acquire(blocking=False):
                try:
                    _unload(which)
                    print(f"unloaded {which} after {idle} s idle", flush=True)
                finally:
                    gpu_lock.release()
        if turns["engine"] is not None and not turns["calls"] and now - turns["used"] > TURNS_IDLE:
            _unload_turns()


if __name__ == "__main__":
    threading.Thread(target=_janitor, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("VOICE_PORT", "8890")), log_level="warning")
