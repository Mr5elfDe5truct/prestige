#!/usr/bin/env bash
# Downloads the Wan 2.2 and LTX-2.5 video models (GGUF) into the workstation's models\comfy folder.
# Resumable: re-run to continue interrupted downloads.
set -u
D="$(cd "$(dirname "$0")/.." && pwd)/models/comfy"
HF=https://huggingface.co
mkdir -p "$D"/{unet,text_encoders,vae,loras,latent_upscale_models}

get() { # repo path dest
  local out="$D/$3/$(basename "$2")"
  echo "$(date +%T) $out"
  curl -sfL -C - -o "$out" "$HF/$1/resolve/main/$2" || echo "FAILED $1/$2"
}

# Wan 2.2 image-to-video, LightX2V 4-step distilled (fast), 720p April 2026 build
get jayn7/WAN2.2-I2V_A14B-DISTILL-LIGHTX2V-4STEP-GGUF high_noise_260412/wan2.2_i2v_A14b_high_noise_lightx2v_4step_720p_260412-Q4_K_M.gguf unet
get jayn7/WAN2.2-I2V_A14B-DISTILL-LIGHTX2V-4STEP-GGUF low_noise_260412/wan2.2_i2v_A14b_low_noise_lightx2v_4step_720p_260412-Q4_K_M.gguf unet
# Wan 2.2 text-to-video
get QuantStack/Wan2.2-T2V-A14B-GGUF HighNoise/Wan2.2-T2V-A14B-HighNoise-Q4_K_M.gguf unet
get QuantStack/Wan2.2-T2V-A14B-GGUF LowNoise/Wan2.2-T2V-A14B-LowNoise-Q4_K_M.gguf unet
# Wan shared text encoder + VAE
get Comfy-Org/Wan_2.1_ComfyUI_repackaged split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors text_encoders
get Comfy-Org/Wan_2.1_ComfyUI_repackaged split_files/vae/wan_2.1_vae.safetensors vae

# LTX-2.5 distilled (video + audio, 8 + 3 steps). Text encoder, VAEs and upscaler from comfyicu's ungated
# copy of Lightricks/LTX-2.5 (the original needs a Hugging Face login).
get Abiray/LTX-2.5-Distilled-GGUF LTX-2.5-Distilled-Q4_K_M.gguf unet
get comfyicu/LTX-2.5 text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors text_encoders
get comfyicu/LTX-2.5 vae/ltx-2.5-video-vae-bf16.safetensors vae
get comfyicu/LTX-2.5 vae/ltx-2.5-audio-vae-bf16.safetensors vae
get comfyicu/LTX-2.5 latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors latent_upscale_models

echo "$(date +%T) all done"
