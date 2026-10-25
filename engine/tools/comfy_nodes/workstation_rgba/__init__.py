"""Workstation RGBA VAE Loader: a 4-channel (RGBA) FLUX.2 VAE for Prestige's transparent pictures.

trmz/flux2-klein-alpha's VAE (Apache-2.0) decodes FLUX.2-family latents, MOSS-Image's included, to RGB plus an alpha
channel. ComfyUI's own VAE loader assumes 3 channels and fails on it, so this builds the VAE from the checkpoint's own
shapes (4 in and out). With paralaif's MOSS-Image Alpha LoRA, MOSS-Image draws latents whose alpha is real, and
ComfyUI's Save Image writes the 4-channel result as a transparent PNG.
"""
import comfy.ldm.modules.diffusionmodules.model as dmodel
import comfy.sd
import comfy.utils
import folder_paths


class WorkstationRGBAVAELoader:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"vae_name": (folder_paths.get_filename_list("vae"),)}}

    RETURN_TYPES = ("VAE",)
    FUNCTION = "load"
    CATEGORY = "Workstation"
    DESCRIPTION = "Loads a 4-channel (RGBA) FLUX.2 VAE such as trmz/flux2-klein-alpha; decoded pictures carry an alpha channel."

    def load(self, vae_name):
        sd = comfy.utils.load_torch_file(folder_paths.get_full_path_or_raise("vae", vae_name))
        z = sd["decoder.conv_in.weight"].shape[1]
        ddconfig = {
            "double_z": True, "z_channels": z, "resolution": 256,
            "in_channels": sd["encoder.conv_in.weight"].shape[1], "out_ch": sd["decoder.conv_out.weight"].shape[0],
            "ch": 128, "ch_mult": [1, 2, 4, 4], "num_res_blocks": 2, "attn_resolutions": [], "dropout": 0.0,
            "batch_norm_latent": True, "fused_norm": True,
        }
        vae = comfy.sd.VAE(sd=sd, config={"params": {"embed_dim": z, "ddconfig": ddconfig}})
        # FLUX.2 latents are the VAE's z patchified 2x2, 16 px per latent pixel.
        vae.latent_channels = z * 4
        vae.downscale_ratio = vae.upscale_ratio = 16
        vae.output_channels = ddconfig["out_ch"]
        vae.pad_channel_value = 1.0  # an RGB picture encodes as opaque
        served = getattr(dmodel, "fused_norm_served", None)
        if served:
            base = vae.memory_used_decode
            vae.memory_used_decode = lambda shape, dtype: base(shape, dtype) * (1.0 if served(vae.device, dtype) else 4.0)
        return (vae,)


NODE_CLASS_MAPPINGS = {"WorkstationRGBAVAELoader": WorkstationRGBAVAELoader}
NODE_DISPLAY_NAME_MAPPINGS = {"WorkstationRGBAVAELoader": "Workstation RGBA VAE Loader"}
