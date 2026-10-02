/* Vani engine-asset loading. Extracted from app.js so the fallback rules are
   testable in node. The rules that matter:
   - split-part fallback (parts -> unsplit file) is for hosts that serve the
     unsplit asset: it triggers on HTTP 404 ONLY. Any other failure is real
     and must surface with the file named.
   - "model not on this host" degrade is legitimate ONLY for the base model
     (141MB is not on the static host by design). A missing tiny model is a
     broken deploy and must fail loud, not vanish into a slow HF fallback. */
'use strict';
const VaniAssets = (() => {
  const LOCAL_ASSET_PATHS = {
    'sherpa-onnx-wasm-main-asr.wasm': 'vendor/asr/sherpa-onnx-wasm-main-asr.wasm',
    'sherpa-onnx-wasm-main-vad.wasm': 'vendor/vad/sherpa-onnx-wasm-main-vad.wasm',
    'sherpa-onnx-wasm-main-speech-enhancement.wasm': 'vendor/se/sherpa-onnx-wasm-main-speech-enhancement.wasm',
    'sherpa-onnx-wasm-main-asr.data': 'vendor/asr/sherpa-onnx-wasm-main-asr.data',
    'sherpa-onnx-wasm-main-vad.data': 'vendor/vad/sherpa-onnx-wasm-main-vad.data',
    'sherpa-onnx-wasm-main-speech-enhancement.data': 'vendor/se/sherpa-onnx-wasm-main-speech-enhancement.data',
  };
  const LOCAL_MODEL_FILES = ['encoder_model.ort', 'decoder_model_merged.ort', 'tokens.txt'];
  // GitHub's web upload caps files at 25MB: the tiny decoder ships in parts.
  const SPLIT_PARTS = { 'decoder_model_merged.ort': 2 };

  class HttpError extends Error {
    constructor(status, url) { super('HTTP ' + status + ' for ' + url); this.status = status; this.url = url; }
  }

  async function fetchChecked(url, fetchImpl) {
    const f = fetchImpl || fetch;
    const resp = await f(url);
    if (!resp.ok) throw new HttpError(resp.status, url);
    return resp.arrayBuffer();
  }

  async function fetchModelFile(dir, file, fetchImpl) {
    if (!SPLIT_PARTS[file]) return fetchChecked(dir + file, fetchImpl);
    // Probe the first part first. If it is absent, hosts that ship the
    // unsplit file may still work. Once part1 exists, every later part is
    // required: never re-download the full model after a partial transfer.
    let first;
    try { first = new Uint8Array(await fetchChecked(dir + file + '.part1', fetchImpl)); }
    catch (e) {
      if (e && e.status === 404) return fetchChecked(dir + file, fetchImpl);
      throw new Error('failed to load ' + dir + file + '.part1: ' + ((e && e.message) || e));
    }
    const rest = await Promise.all(
      Array.from({ length: SPLIT_PARTS[file] - 1 }, (_, i) =>
        fetchChecked(dir + file + '.part' + (i + 2), fetchImpl).then(b => new Uint8Array(b))
      )
    ).catch(e => { throw new Error('failed to load ' + dir + file + ' (part fetch): ' + ((e && e.message) || e)); });
    const parts = [first, ...rest];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const part of parts) { out.set(part, o); o += part.length; }
    return out.buffer;
  }

  /* modelIsOptional: true only for 'base' — see header comment. */
  async function ensureAssets(model, opts) {
    opts = opts || {};
    const injected = opts.injectedAssets || null; // hosted-build transfer / test seam
    if (injected) return injected;
    const fetchImpl = opts.fetch;
    const out = {};
    // parallel: sequential awaits here were the cold-boot tax (H1)
    await Promise.all(Object.entries(LOCAL_ASSET_PATHS).map(async ([k, p]) => {
      out[k] = opts.shellAssets && opts.shellAssets[k] || await fetchChecked(p, fetchImpl);
    }));
    const which = model === 'base' ? 'base' : 'tiny';
    const dir = 'assets/model/' + which + '/';
    const modelIsOptional = which === 'base'; // 141MB base is intentionally not on the static host
    try {
      // Probe encoder first; it tells us whether the optional base model is
      // hosted. Do not race three doomed 404s on first use.
      if (modelIsOptional) out['model/' + which + '/encoder_model.ort'] = await fetchModelFile(dir, 'encoder_model.ort', fetchImpl);
      await Promise.all(LOCAL_MODEL_FILES.filter(f => !modelIsOptional || f !== 'encoder_model.ort').map(async (f) => {
        out['model/' + which + '/' + f] = await fetchModelFile(dir, f, fetchImpl);
      }));
    } catch (e) {
      // Base is intentionally absent from this static host. Only a genuine
      // 404 on its first file means "not hosted". Timeout, 500 or a missing
      // later split part means broken transfer, not permission to silently
      // spend bandwidth fetching another 141 MB from elsewhere.
      const baseNotHosted = modelIsOptional && e && e.status === 404 &&
        String(e.url || '').endsWith('/encoder_model.ort');
      if (!baseNotHosted) {
        throw new Error('model assets failed to load (' + which + '): broken deploy or transfer: ' + ((e && e.message) || e));
      }
      for (const f of LOCAL_MODEL_FILES) delete out['model/' + which + '/' + f];
    }
    return out;
  }

  return { LOCAL_ASSET_PATHS, LOCAL_MODEL_FILES, SPLIT_PARTS, HttpError, fetchChecked, fetchModelFile, ensureAssets };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = VaniAssets;
