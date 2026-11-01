"""Picture to 3D as a splat: Speridlabs' Idol (Apache-2.0; the idol pack) turns one picture of an object into a 3D Gaussian
splat (.ply), sides it never saw included. Prestige (idol.rs) runs it and reads the JSON it prints last:
{"ply": <path>, "seconds": s, "gaussians": n} or {"error": ...}.

    envs\\idol\\Scripts\\python.exe tools\\splat3d.py <picture> <out.ply> <synthetic|real> [gaussians]

Its image encoders come from two gated Hugging Face repos (facebook/dinov3-vith16plus-pretrain-lvd1689m, and only the VAE
of black-forest-labs/FLUX.2-dev, under FLUX's non-commercial licence): the first run downloads ~6.4 GB with the token
Prestige passes in HF_TOKEN. On an RTX 3060: ~20 s to load, then ~105 s a picture (~145 s for the first, while PyTorch
compiles), ~6.2 GB of VRAM at most."""

import json
import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def fail(msg):
    print(json.dumps({"error": msg}), flush=True)
    sys.exit(1)


def main():
    if len(sys.argv) < 4:
        fail("usage: splat3d.py <picture> <out.ply> <synthetic|real> [gaussians]")
    picture, out, mode = sys.argv[1], sys.argv[2], sys.argv[3]
    gaussians = int(sys.argv[4]) if len(sys.argv) > 4 else 262_144
    if mode not in ("synthetic", "real"):
        fail(f"unknown mode {mode}")
    import torch

    if not torch.cuda.is_available():
        fail("Idol needs an NVIDIA GPU")
    free = [torch.cuda.mem_get_info(i)[0] for i in range(torch.cuda.device_count())]
    gpu = max(range(len(free)), key=lambda i: free[i])
    if free[gpu] < 6.5 * 2**30:
        fail(f"Idol needs about 6.5 GB of free GPU memory; the most free on one card is {free[gpu] / 2**30:.1f} GB")
    torch.cuda.set_device(gpu)

    from idol import IdolPipeline
    from idol.conditioning import EncoderAccessError

    t0 = time.time()
    try:
        pipe = IdolPipeline.from_pretrained("speridlabs/idol")
    except EncoderAccessError:
        fail("Idol's image encoders are gated on Hugging Face: accept the licences of facebook/dinov3-vith16plus-pretrain-lvd1689m "
             "and black-forest-labs/FLUX.2-dev with your account, and add its token in Packs")
    result = pipe(picture, mode=mode, seed=42, num_gaussians=gaussians)
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    result.gaussian.save_ply(out)
    print(json.dumps({"ply": out, "seconds": round(time.time() - t0, 1), "gaussians": gaussians}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # reported to Prestige rather than as a traceback
        fail(f"{type(e).__name__}: {e}")
