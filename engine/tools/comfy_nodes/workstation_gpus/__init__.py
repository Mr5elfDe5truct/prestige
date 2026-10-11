"""Workstation GPU placement for ComfyUI (no nodes of its own).

When ComfyUI has two or more cards, start-all.ps1 sets WORKSTATION_COMFY_AUX_DEVICE to the CUDA index of the second
one. VAEs and the LTX latent upscaler then load there, through ComfyUI's own loaders, so every workflow (Prestige, the
tool server, ComfyUI's own UI) leaves the main card to the diffusion model and the latents it works on. Without the
variable, or with one card, nothing changes.

WORKSTATION_COMFY_AUX_PARTS picks the parts (comma-separated: text_encoder, vae, upscaler; default vae,upscaler). Text
encoders only make sense on a second card that holds them whole: ComfyUI's dynamic VRAM runs out of memory streaming a
15 GB encoder onto a 6 GB card, and they're unloaded before the diffusion model runs anyway.
"""
import logging
import os

import torch

import comfy.model_management as mm

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

log = logging.getLogger("workstation_gpus")
_aux = os.environ.get("WORKSTATION_COMFY_AUX_DEVICE", "").strip()
_parts = {p.strip() for p in os.environ.get("WORKSTATION_COMFY_AUX_PARTS", "upscaler").split(",") if p.strip()}


def _patch_upscaler(dev):
    # The LTX latent upscaler's loader puts the model on the main card; move its load device after loading.
    from comfy_extras import nodes_hunyuan

    loader = nodes_hunyuan.LatentUpscaleModelLoader
    original = loader.execute.__func__

    def execute(cls, *args, **kwargs):
        out = original(cls, *args, **kwargs)
        result = out.result if hasattr(out, "result") else out
        if result and hasattr(result[0], "load_device"):
            result[0].load_device = dev
        return out

    loader.execute = classmethod(execute)


if _aux.isdigit() and torch.cuda.is_available() and torch.cuda.device_count() > int(_aux) > 0:
    aux = torch.device("cuda", int(_aux))
    if "text_encoder" in _parts:
        mm.text_encoder_device = lambda: aux
    if "vae" in _parts:
        mm.vae_device = lambda: aux
    if "upscaler" in _parts:
        try:
            _patch_upscaler(aux)
        except Exception as e:  # a ComfyUI without the LTX upscaler, or a changed loader: leave it on the main card
            _parts.discard("upscaler")
            log.warning("workstation_gpus: couldn't move the latent upscaler: %s", e)
    log.info("workstation_gpus: %s on %s (%s); the main card %s keeps the diffusion model",
             ", ".join(sorted(_parts)), aux, torch.cuda.get_device_name(aux), torch.cuda.get_device_name(mm.get_torch_device()))
elif _aux:
    log.info("workstation_gpus: WORKSTATION_COMFY_AUX_DEVICE=%s but ComfyUI sees %d card(s); nothing moved",
             _aux, torch.cuda.device_count() if torch.cuda.is_available() else 0)
