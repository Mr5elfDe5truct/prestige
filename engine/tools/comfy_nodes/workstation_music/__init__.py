"""Editing an ACE-Step 1.5 song in ComfyUI: redo a part, extend it, or cover it in a new style.

ComfyUI's own ACE-Step 1.5 nodes only make a song from nothing (or from a timbre reference). ACE-Step itself can also
work on a song that exists, the way its own pipeline does it (acestep/core/generation/handler/conditioning_masks.py):

* repaint: the part between two times is made again, the rest kept. The model is shown the song with that part
  silenced and a mask of where it is, and the kept part is put back at every step, so the new part joins up.
* extend: the same, with silence added before and/or after the song and those parts made new.
* cover: a new song that follows the source's melody and structure. The source is turned into the model's 5 Hz
  hints, for the first `strength` of the steps; after that it's a plain new song, so the style can take over.
* extract (the base model only, acestep_v1.5_base): the model hears the whole song and makes one track of it, a stem
  such as the vocals or the drums; the text encoder names the track. lego and complete (a new track to play along,
  or the rest of the band around one) are wired the same way, but in tests on a 60 s song they came out wordless and
  out of key with the source, so Prestige doesn't offer them.

One node, "ACE-Step 1.5 Song Edit", takes the model and the source song's latent (VAE Encode Audio) and gives back the
model to sample with and the latent to start from. Use it with TextEncodeAceStepAudio1.5 (generate_audio_codes off,
duration set to the whole new length), a KSampler at denoise 1, and the VAE decode as usual.
"""
import torch

import comfy.model_management as mm

FPS = 48000 / 1920  # ACE-Step 1.5 latent frames per second (25)


def _silence(length, device, dtype):
    from comfy.ldm.ace.ace_step15 import get_silence_latent

    return get_silence_latent(length, device).to(dtype)  # [1, 64, length]


def _ramp(mask, frames):
    """Soften a 0/1 mask's edges over `frames` frames on each side of every edge, inside the new part."""
    if frames <= 0:
        return mask
    out = mask.clone()
    n = mask.shape[0]
    for i in range(n):
        if mask[i] <= 0:
            continue
        # distance to the nearest kept frame
        d = frames
        for k in range(1, frames):
            if (i - k >= 0 and mask[i - k] <= 0) or (i + k < n and mask[i + k] <= 0):
                d = k
                break
        out[i] = min(1.0, d / frames)
    return out


class AceStep15SongEdit:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "source": ("LATENT", {"tooltip": "The song to work on, from VAE Encode Audio with the ACE-Step 1.5 VAE."}),
                "task": (["repaint", "extend", "cover", "extract", "lego", "complete"],),
                "start": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 2000.0, "step": 0.01, "tooltip": "repaint: where the part to redo starts (seconds)."}),
                "end": ("FLOAT", {"default": 10.0, "min": 0.0, "max": 2000.0, "step": 0.01, "tooltip": "repaint: where it ends (seconds)."}),
                "extend_before": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 600.0, "step": 0.01, "tooltip": "extend: seconds of new music before the song."}),
                "extend_after": ("FLOAT", {"default": 30.0, "min": 0.0, "max": 600.0, "step": 0.01, "tooltip": "extend: seconds of new music after it."}),
                "keep_until": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 2000.0, "step": 0.01, "tooltip": "extend: carry on from this time, leaving out the rest (its ending); 0 keeps the whole song."}),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "cover: how much of the steps follow the source (1 = all of them)."}),
                "crossfade": ("FLOAT", {"default": 0.4, "min": 0.0, "max": 5.0, "step": 0.01, "tooltip": "repaint: seconds over which the new part blends into the kept one."}),
            },
            "optional": {
                "song_lyrics": ("STRING", {"multiline": True, "default": "", "tooltip": "Not used: the whole new song's lyrics, kept in the file's workflow (an extension is sung from its new part's alone)."}),
            },
        }

    RETURN_TYPES = ("MODEL", "LATENT")
    RETURN_NAMES = ("model", "latent")
    FUNCTION = "edit"
    CATEGORY = "model/latent/ace"
    DESCRIPTION = "Repaint part of an ACE-Step 1.5 song, extend it, cover it in a new style, or (base model) take a stem out of it or add a track to it."

    def edit(self, model, source, task, start, end, extend_before, extend_after, keep_until, strength, crossfade, song_lyrics=""):
        src = source["samples"]
        if src.is_nested:
            src = src.unbind()[-1]
        src = src[:1].float().cpu()  # [1, 64, T]
        T = src.shape[-1]

        if task == "extend":
            if keep_until > 0:
                src = src[:, :, :max(1, min(T, round(keep_until * FPS)))]
                T = src.shape[-1]
            before, after = round(extend_before * FPS), round(extend_after * FPS)
            if before + after <= 0:
                raise ValueError("ACE-Step 1.5 Song Edit: extend needs some seconds before or after the song.")
            total = before + T + after
            sil = _silence(total, "cpu", src.dtype)
            target = torch.cat([sil[:, :, :before], src, sil[:, :, before + T:]], dim=2)
            gen = torch.zeros(total)
            gen[:before] = 1
            gen[before + T:] = 1
        elif task == "repaint":
            a = max(0, min(T - 1, int(start * FPS)))
            b = max(a + 1, min(T, int(end * FPS)))
            total, target = T, src
            gen = torch.zeros(T)
            gen[a:b] = 1
        else:
            # cover, extract, lego, complete: the whole song as the context, everything made new.
            total, target, gen = T, src, None

        if gen is not None:
            # What the model is shown: the song with the new parts silenced, and where they are.
            sil = _silence(total, "cpu", src.dtype)
            context = torch.where(gen[None, None, :] > 0, sil, target)
            noise_mask = _ramp(gen, round(crossfade * FPS))
            latent = {"samples": target.clone(), "type": "audio", "noise_mask": noise_mask[None, None, :]}
        else:
            context = target
            latent = {"samples": torch.zeros_like(target), "type": "audio"}

        m = model.clone()
        dm = m.get_model_object("diffusion_model")
        state = {"context": context, "chunk": gen, "task": task, "strength": strength}

        def forward(x, timestep, context=None, lyric_embed=None, refer_audio=None, audio_codes=None, is_covers=None,
                    replace_with_null_embeds=False, **kwargs):
            return _forward(dm, state, x, timestep, context, lyric_embed, refer_audio, replace_with_null_embeds)

        m.add_object_patch("diffusion_model.forward", forward)
        return (m, latent)


def _forward(dm, state, x, timestep, text_hidden_states, lyric_hidden_states, refer_audio, replace_with_null_embeds):
    """AceStepConditionGenerationModel.forward, with the source song as the context in place of silence."""
    B = x.shape[0]
    x = x.movedim(-1, -2)  # [B, T, 64]
    T = x.shape[1]
    dtype, device = x.dtype, x.device
    refer = refer_audio.movedim(-1, -2)  # timbre reference (silence unless one was set)
    order = torch.zeros((B,), device=device, dtype=torch.long)

    enc_hidden, enc_mask = dm.encoder(text_hidden_states, None, lyric_hidden_states, None, refer, order)

    src = state["context"].to(device=device, dtype=dtype)[:, :, :T].movedim(-1, -2).expand(B, -1, -1)  # [B, T, 64]
    t = float(timestep.flatten()[0]) if torch.is_tensor(timestep) else float(timestep)
    if state["task"] == "cover":
        if t >= 1.0 - state["strength"] - 1e-6:
            hints5, _ = dm.tokenizer.tokenize(src)
            src = dm.detokenizer(hints5)[:, :T, :]
        else:
            src = _silence(T, device, dtype).movedim(-1, -2).expand(B, -1, -1)
        chunk = torch.ones_like(x)
    elif state["chunk"] is None:  # extract, lego, complete: the whole song is the context
        # ACE-Step's "auto" chunk mask (2.0) let more of the mix bleed into an extracted stem; 1.0 kept it clean.
        chunk = torch.ones_like(x)
    else:
        chunk = state["chunk"].to(device=device, dtype=dtype)[:T][None, :, None].expand(B, T, x.shape[2])

    context_latents = torch.cat([src, chunk], dim=-1)
    if replace_with_null_embeds:
        enc_hidden[:] = dm.null_condition_emb.to(enc_hidden)
    out = dm.decoder(hidden_states=x, timestep=timestep, timestep_r=timestep, attention_mask=None,
                     encoder_hidden_states=enc_hidden, encoder_attention_mask=enc_mask, context_latents=context_latents)
    return out.movedim(-1, -2)


# ACE-Step 1.5 tells its DiT what the job is in the first line of the text it reads (acestep/constants.py
# TASK_INSTRUCTIONS). ComfyUI's encoder always writes the cover one; a repaint reads its own.
INSTRUCTIONS = {
    "repaint": "Repaint the mask area based on the given conditions:",
    "extend": "Repaint the mask area based on the given conditions:",
    "cover": "Generate audio semantic tokens based on the given conditions:",
    "text2music": "Fill the audio semantic mask based on the given conditions:",
    "extract": "Extract the {TRACK} track from the audio:",
    "lego": "Generate the {TRACK} track based on the audio context:",
    "complete": "Complete the input track with {TRACK}:",
}
# The tracks ACE-Step knows (acestep/constants.py TRACK_NAMES).
TRACKS = ["vocals", "backing_vocals", "drums", "bass", "guitar", "keyboard", "strings", "synth", "percussion", "brass", "woodwinds", "fx"]


def instruction(task, track):
    names = [t.strip().upper() for t in track.replace("|", ",").split(",") if t.strip()]
    if "{TRACK}" not in INSTRUCTIONS[task]:
        return INSTRUCTIONS[task]
    if not names:  # ACE-Step's wording without a track
        return {"extract": "Extract the track from the audio:", "lego": "Generate the track based on the audio context:",
                "complete": "Complete the input track:"}[task]
    return INSTRUCTIONS[task].format(TRACK=" | ".join(names) if task == "complete" else names[0])


class TextEncodeAceStep15Task:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "task": (list(INSTRUCTIONS),),
                "tags": ("STRING", {"multiline": True, "dynamicPrompts": True}),
                "lyrics": ("STRING", {"multiline": True, "dynamicPrompts": True}),
                "bpm": ("INT", {"default": 120, "min": 10, "max": 300}),
                "duration": ("FLOAT", {"default": 120.0, "min": 0.0, "max": 2000.0, "step": 0.1, "tooltip": "The whole song's length, new parts included."}),
                "timesignature": (["2", "3", "4", "6"], {"default": "4"}),
                "language": ("STRING", {"default": "en"}),
                "keyscale": ("STRING", {"default": "C major"}),
            },
            "optional": {
                "track": ("STRING", {"default": "", "tooltip": "extract and lego: the track (" + ", ".join(TRACKS) + "); complete: the tracks to add, comma-separated."}),
            },
        }

    RETURN_TYPES = ("CONDITIONING",)
    FUNCTION = "encode"
    CATEGORY = "model/conditioning/ace"
    DESCRIPTION = "TextEncodeAceStepAudio1.5 without the audio codes, telling the model which job it's doing."

    def encode(self, clip, task, tags, lyrics, bpm, duration, timesignature, language, keyscale, track=""):
        tok = clip.tokenizer
        metas = dict(bpm=bpm, duration=duration, timesignature=int(timesignature), language=language, keyscale=keyscale)
        tokens = clip.tokenize(tags, lyrics=lyrics, seed=0, generate_audio_codes=False, **metas)
        cap = tok._metas_to_cap(bpm=bpm, timesignature=int(timesignature), keyscale=keyscale, duration=duration)
        prompt = f"# Instruction\n{instruction(task, track)}\n\n# Caption\n{tags.strip()}\n\n# Metas\n{cap}\n<|endoftext|>\n<|endoftext|>"
        tokens["qwen3_06b"] = tok.qwen3_06b.tokenize_with_weights(prompt, False, disable_weights=True)
        return (clip.encode_from_tokens_scheduled(tokens),)


NODE_CLASS_MAPPINGS = {"AceStep15SongEdit": AceStep15SongEdit, "TextEncodeAceStep15Task": TextEncodeAceStep15Task}
NODE_DISPLAY_NAME_MAPPINGS = {"AceStep15SongEdit": "ACE-Step 1.5 Song Edit", "TextEncodeAceStep15Task": "TextEncode ACE-Step 1.5 (task)"}
