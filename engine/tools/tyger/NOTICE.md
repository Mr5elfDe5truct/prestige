# TYGER runtime

From [nineninesix-ai/tyger-s2s](https://github.com/nineninesix-ai/tyger-s2s) (Apache-2.0, LICENSE here), commit
97d011d, `app/plugins/ears/tyger/`: `asr.py`, `bundle.py`, `constants.py`, `controller.py`, `engine.py`,
`gru_batch.py`, `rnnt.py`, `rules.py` and `session.py`, unchanged. Changed: `__init__.py` no longer imports the
tyger-s2s plugin class (`plugin.py`, `service.py` and the rest of that app aren't used), and `engine.py`'s
`EarsEngine` has a `close()` that ends its ASR thread and moves the weights off the GPU (otherwise the thread, and
a worker thread's traceback from the layer-15 hook, keep the engine and its ~2.4 GB alive).

The model is [nineninesix/tyger](https://huggingface.co/nineninesix/tyger) (OpenMDW-1.1), with NVIDIA's
nemotron-3.5-asr-streaming-0.6b inside; Prestige's Turn-taking pack puts it in `models\speech\tyger`.
