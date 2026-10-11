"""Qwen-Image-2.1 LoRAs on the Workstation's GGUF model (no nodes of its own).

Qwen-Image-2.1's MLP comes in two layouts: Comfy-Org's weights fuse it into one img_mlp.gate_up layer, while the
Workstation's GGUF (qwen-image-2.1-UC-Q4_K_M) keeps it as gate_layer and proj. ComfyUI loads a split LoRA onto the
fused model, but not the other way: a LoRA trained on the fused weights (Multiple-Angles, Outfit Swap) loses its
img_mlp.gate_up part on the GGUF, 64 of its layers ("lora key not loaded").

This splits those layers before ComfyUI loads them, when the model is the split kind: the fused output is the gate
half then the proj half (as comfy/lora.py maps them), so lora_B (up) is cut in two along its rows and lora_A (down)
and alpha go to both. The result is the same weight change.
"""
import logging

import comfy.model_base
import comfy.sd

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

log = logging.getLogger("workstation_lora")
FUSED = ".img_mlp.gate_up."
# Rows of the fused layer: cut in half. Everything else about the layer is shared.
UP = ("lora_B.weight", "lora_up.weight")


def _split_mlp(model) -> bool:
    """True for a Qwen-Image-2.1 model whose MLP is gate_layer + proj rather than one gate_up."""
    try:
        if not isinstance(model.model, comfy.model_base.QwenImage):
            return False
        mlp = model.model.diffusion_model.transformer_blocks[0].img_mlp
        return hasattr(mlp, "gate_layer") and not hasattr(mlp, "gate_up")
    except Exception:
        return False


def split_fused(lora: dict) -> dict:
    """The LoRA with each img_mlp.gate_up layer as gate_layer and proj layers (a new dict; the input is cached by
    ComfyUI's loader and left as it is)."""
    out = {}
    for k, v in lora.items():
        if FUSED not in k:
            out[k] = v
            continue
        head, tail = k.split(FUSED, 1)
        gate, proj = f"{head}.img_mlp.gate_layer.{tail}", f"{head}.img_mlp.proj.{tail}"
        if tail in UP:
            half = v.shape[0] // 2
            out[gate], out[proj] = v[:half], v[half:]
        else:
            out[gate] = out[proj] = v
    return out


_original = comfy.sd.load_lora_for_models


def load_lora_for_models(model, clip, lora, strength_model, strength_clip, *args, **kwargs):
    if model is not None and any(FUSED in k for k in lora) and _split_mlp(model):
        lora = split_fused(lora)
        log.info("workstation_lora: split the LoRA's fused img_mlp.gate_up layers for this Qwen-Image-2.1 model")
    return _original(model, clip, lora, strength_model, strength_clip, *args, **kwargs)


comfy.sd.load_lora_for_models = load_lora_for_models
