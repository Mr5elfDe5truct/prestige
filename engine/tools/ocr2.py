"""Reads a whole document with Baidu's Unlimited-OCR-2 (MIT; the Read whole documents pack), all its pages in one go,
so a table or a sentence that runs over a page break is read as one. Prestige (ocr.rs) runs it with the page pictures
and reads the JSON it prints last: {"text": <the model's page-marked output>, "pages": n, "secs": s} or {"error": ...}.

    envs\\ocr2\\Scripts\\python.exe tools\\ocr2.py <model folder> <page picture>...

It picks the GPU with the most free memory (it needs ~7.3 GB) and runs transformers with the model's own code, from
the model folder the pack downloaded at a fixed revision. On an RTX 3060: ~15 s to load, then ~8 tokens a second
(about 20 s for a short page, 90 s for a full page of text)."""

import json
import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def fail(msg):
    print(json.dumps({"error": msg}), flush=True)
    sys.exit(1)


def main():
    if len(sys.argv) < 3:
        fail("usage: ocr2.py <model folder> <page picture>...")
    model_dir, pages = sys.argv[1], sys.argv[2:]
    import torch

    if not torch.cuda.is_available():
        fail("Unlimited-OCR-2 needs an NVIDIA GPU")
    free = [torch.cuda.mem_get_info(i)[0] for i in range(torch.cuda.device_count())]
    gpu = max(range(len(free)), key=lambda i: free[i])
    if free[gpu] < 7.0 * 2**30:
        fail(f"Unlimited-OCR-2 needs about 7.3 GB of free GPU memory; the most free on one card is {free[gpu] / 2**30:.1f} GB")
    torch.cuda.set_device(gpu)

    from transformers import AutoModel, AutoTokenizer

    t0 = time.time()
    tok = AutoTokenizer.from_pretrained(model_dir, trust_remote_code=True)
    model = AutoModel.from_pretrained(model_dir, trust_remote_code=True, use_safetensors=True, torch_dtype=torch.bfloat16).eval().cuda()
    # The model's own generate loop prints the text as it goes; that goes to stderr so stdout is only the result.
    real = sys.stdout
    sys.stdout = sys.stderr
    try:
        text, _ = model.infer_multi(tok, image_files=pages, output_path="", save_results=False)
    finally:
        sys.stdout = real
    print(json.dumps({"text": str(text), "pages": len(pages), "secs": round(time.time() - t0, 1)}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # anything else is reported to Prestige rather than as a traceback
        fail(f"{type(e).__name__}: {e}")
