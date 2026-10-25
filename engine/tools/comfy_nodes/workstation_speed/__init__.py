"""SageAttention for one model, with a safe way out: Workstation Sage Attention.

Prestige puts this node after the video models (Wan 2.2, LTX-2.5) when Faster video is on. It routes the model's
attention through ComfyUI's own SageAttention function (comfy.ldm.modules.attention.attention_sage, which itself falls
back to PyTorch attention on an error or a mask it can't take), the same override KJNodes' Patch Sage Attention uses.

The model goes through unchanged when SageAttention can't run: the sageattention package (and triton-windows, which
its kernels need) isn't installed, or the model's card is older than Ampere (SageAttention 2 needs compute capability
8.0; an RTX 2060 is 7.5). So a workflow with this node works on any install.
"""
import logging

import torch

import comfy.ldm.modules.attention as attention
import comfy.model_management as mm

log = logging.getLogger("workstation_speed")


def _why_not(model) -> str:
    """Why SageAttention can't run for this model, or "" when it can."""
    if not attention.SAGE_ATTENTION_IS_AVAILABLE or not hasattr(attention, "attention_sage"):
        return "the sageattention package isn't installed"
    dev = getattr(model, "load_device", None) or mm.get_torch_device()
    if getattr(dev, "type", "") != "cuda":
        return "the model isn't on an NVIDIA card"
    major, minor = torch.cuda.get_device_capability(dev)
    if major < 8:
        return f"{torch.cuda.get_device_name(dev)} is compute {major}.{minor}; SageAttention 2 needs 8.0 (Ampere) or newer"
    return ""


class WorkstationSageAttention:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",), "enabled": ("BOOLEAN", {"default": True})}}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "patch"
    CATEGORY = "Workstation"
    DESCRIPTION = "SageAttention for this model when it can run (sageattention installed, an Ampere or newer card); otherwise the model unchanged."

    def patch(self, model, enabled):
        if not enabled:
            return (model,)
        why = _why_not(model)
        if why:
            log.info("Workstation Sage Attention: off, %s", why)
            return (model,)
        sage = getattr(attention.attention_sage, "__wrapped__", attention.attention_sage)

        def override(func, *args, **kwargs):
            return sage(*args, **kwargs)

        clone = model.clone()
        clone.model_options.setdefault("transformer_options", {})["optimized_attention_override"] = override
        return (clone,)


NODE_CLASS_MAPPINGS = {"WorkstationSageAttention": WorkstationSageAttention}
NODE_DISPLAY_NAME_MAPPINGS = {"WorkstationSageAttention": "Workstation Sage Attention"}
