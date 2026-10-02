# Vani — on-device voice typing

Real-time speech transcription that runs entirely in your browser. No account,
no backend, no analytics. Audio never leaves the device.

## Pipeline (all local, WebAssembly)

Mic / file → Silero VAD (segmentation) → GTCRN denoise (optional, for loud
environments) → Moonshine v2 ASR (English, quantized) → transcript.

- ASR: Moonshine v2 (moonshine-ai), via sherpa-onnx WASM (self-built, v1.13.8).
  tiny model ~43 MB bundled on this host; base model ~141 MB downloads from Hugging Face on demand and is cached in IndexedDB where browser storage works. Engine WASM files add to the transfer. Browser caches can be cleared or evicted, so later visits may download again.
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

Honest grade: PARTIAL on clean read speech outside the original LibriSpeech set, FAIL on this small strong-noise pilot. See QA.md for measured clips and limits; real phone accuracy remains unverified.
App: live dictation, saved recordings, file transcription, correction memory,
device bench, offline PWA. Live at https://aeiouvcode.github.io/vani/

## Development

Spine: PLAN.md (current plan), STATE.md (where things stand), MISTAKES.md
(what bit us), QA.md (verification record), FEATURE-MAP.md (feature → code →
proof).

- Tests: `node tests/run.mjs` — unit + a real engine decode of
  assets/bench.wav through the actual WASM build in node.
- Control CLI: `node control-vani.mjs doctor|snapshot|screenshot|wait-settle|interact`
  (JSON out, `--dry-run` first). `interact` boots the app in headless Chrome,
  loads the tiny model and runs the bench. Requires system Chrome and
  `npm install` (puppeteer-core, dev-only).
- House rules: logic over surface; narrow catches, fail loud (the T5
  sentinel test rejects empty/comment-only catches); verification claims go
  through the CLI; bump the sw.js CACHE name with any SHELL change.
