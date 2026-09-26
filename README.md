# Vani — on-device voice typing

Real-time speech transcription that runs entirely in your browser. No account,
no backend, no analytics. Audio never leaves the device.

## Pipeline (all local, WebAssembly)

Mic / file → Silero VAD (segmentation) → GTCRN denoise (optional, for loud
environments) → Moonshine v2 ASR (English, quantized) → transcript.

- ASR: Moonshine v2 (moonshine-ai), via sherpa-onnx WASM (self-built, v1.13.8).
  tiny = 43 MB, base = 141 MB, downloaded once from Hugging Face, cached in OPFS.
- VAD: Silero VAD via official sherpa-onnx WASM prebuilt.
- Denoise: GTCRN (535 KB) via official sherpa-onnx WASM prebuilt.
- Corrections dictionary + filler cleanup run as local post-processing.

## Measured (LibriSpeech validation, 10 clips, WER, sandbox CPU)

| Condition | base | base + denoise | tiny |
|---|---|---|---|
| clean | 0.0% | 0.0% | 4.0% |
| babble 10dB | 29.4% | 3.2% | 5.6% |
| babble 5dB | 34.1% | 13.5% | 12.7% |
| engine 0dB | 5.6% | 5.6% | 11.9% |
| rain 10dB | 7.9% | 13.5% | 18.3% |

RTF 0.04 (base) / 0.026 (tiny) on a 2-core sandbox; the in-app Bench measures
your own device. Whisper-tiny int8 was benchmarked and eliminated (worse and
2x slower). Extreme noise (0 dB) remains hard for every on-device model.

## Status

Honest grade: engine PASS on clean + moderate noise, PARTIAL on extreme noise.
App: live dictation, saved recordings, file transcription, correction memory,
device bench, offline PWA. Public release pending owner ship-go.
