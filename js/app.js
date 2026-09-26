/* Vani — on-device voice typing. UI controller. */
'use strict';
(() => {
const $ = (id) => document.getElementById(id);
const els = {
  setup: $('setupPanel'), editorWrap: $('editorWrap'), editor: $('editor'), partial: $('partial'),
  micDock: $('micDock'), micBtn: $('micBtn'), levelFill: $('levelFill'),
  modelPill: $('modelPill'), netdot: $('netdot'),
  dlProgress: $('dlProgress'), dlFill: $('dlFill'), dlText: $('dlText'),
  copyBtn: $('copyBtn'), shareBtn: $('shareBtn'), clearBtn: $('clearBtn'),
  recList: $('recList'), recEmpty: $('recEmpty'),
  pickFileBtn: $('pickFileBtn'), fileInput: $('fileInput'),
  fileProgress: $('fileProgress'), fileFill: $('fileFill'), fileText: $('fileText'),
  fileResult: $('fileResult'), fileEditor: $('fileEditor'), fileCopyBtn: $('fileCopyBtn'),
  dictFrom: $('dictFrom'), dictTo: $('dictTo'), dictAddBtn: $('dictAddBtn'), dictList: $('dictList'),
  fillerToggle: $('fillerToggle'), denoiseToggle: $('denoiseToggle'),
  benchBtn: $('benchBtn'), benchOut: $('benchOut'),
  settingsSheet: $('settingsSheet'), settingsBtn: $('settingsBtn'), closeSettings: $('closeSettings'),
  engineInfo: $('engineInfo'), switchModelBtn: $('switchModelBtn'), wipeBtn: $('wipeBtn'),
  toast: $('toast'),
};

let worker = null;
let modelId = localStorage.getItem('vani-model') || null;
let engineReady = false;
let capturing = false;
let sessionSegments = [];  // {text, t}
let fileSeq = 0;

function toast(msg, ms = 2600) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.add('hidden'), ms);
}
function updateNet() {
  els.netdot.className = 'netdot ' + (navigator.onLine ? 'online' : 'offline');
  els.netdot.title = navigator.onLine ? 'Online (only for model downloads)' : 'Offline — everything still works';
}
window.addEventListener('online', updateNet);
window.addEventListener('offline', updateNet);
updateNet();

/* hosted build ships the tiny model in the bundle: hide the base card */
if (self.VANI_CFG && self.VANI_CFG.singleModel === 'tiny') {
  const bc = document.querySelector('.modelcard[data-model="base"]');
  if (bc) bc.classList.add('hidden');
}

/* ---- tabs ---- */
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  $(b.dataset.view).classList.remove('hidden');
  if (b.dataset.view === 'recordingsView') renderRecordings();
  if (b.dataset.view === 'dictionaryView') renderDict();
}));

/* ---- engine assets: hosted build transfers them from the parent frame;
   local server build fetches them from relative paths ---- */
let workerAssets = null;
let assetsResolve = null;
const assetsReady = new Promise(r => { assetsResolve = r; });
window.addEventListener('message', (ev) => {
  if (ev.data && ev.data.type === 'vani-assets' && ev.data.assets) {
    workerAssets = ev.data.assets;
    assetsResolve();
  }
});
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
async function fetchChecked(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' for ' + url);
  return resp.arrayBuffer();
}
async function fetchModelFile(dir, f) {
  if (SPLIT_PARTS[f]) {
    try {
      const parts = [];
      for (let i = 1; i <= SPLIT_PARTS[f]; i++) {
        parts.push(new Uint8Array(await fetchChecked(dir + f + '.part' + i)));
      }
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const part of parts) { out.set(part, o); o += part.length; }
      return out.buffer;
    } catch (e) {
      return fetchChecked(dir + f); // host serves the unsplit asset instead
    }
  }
  return fetchChecked(dir + f);
}
async function ensureAssets(model) {
  if (workerAssets) return workerAssets;
  if (self.__VANI_ASSETS) { workerAssets = self.__VANI_ASSETS; return workerAssets; }
  if (self.VANI_CFG) { await assetsReady; return workerAssets; }
  const out = {};
  for (const [k, p] of Object.entries(LOCAL_ASSET_PATHS)) {
    out[k] = await fetchChecked(p);
  }
  const which = model === 'base' ? 'base' : 'tiny';
  const dir = 'assets/model/' + which + '/';
  try {
    for (const f of LOCAL_MODEL_FILES) out['model/' + which + '/' + f] = await fetchModelFile(dir, f);
  } catch (e) {
    // not served from this host (the 141MB base model is not on the static
    // host): the engine downloads it once from Hugging Face and caches it
    for (const f of LOCAL_MODEL_FILES) delete out['model/' + which + '/' + f];
  }
  workerAssets = out;
  return out;
}

/* ---- worker ---- */
function ensureWorker() {
  if (worker) return worker;
  if (self.__VANI_ENGINE_CHAN) {
    // inline engine: hosted Files block real workers (CSP); the engine bundle
    // runs on this page and exposes an EventTarget channel.
    const chan = self.__VANI_ENGINE_CHAN;
    const fw = {
      _h: null,
      postMessage(m) { chan.dispatchEvent(new MessageEvent('message', { data: m })); },
      set onmessage(fn) {
        if (fw._h) chan.removeEventListener('message', fw._h);
        fw._h = (ev) => fn({ data: ev.data });
        chan.addEventListener('message', fw._h);
      },
      set onerror(fn) { /* inline engine reports via 'error' messages */ },
    };
    worker = fw;
    wireWorkerMessages();
    return worker;
  }
  const cfg = self.VANI_CFG || null;
  worker = new Worker((cfg && cfg.worker) || 'js/engine-worker.js');
  worker.onerror = (e) => {
    els.dlText.textContent = 'Engine failed to start: ' + (e.message || 'unknown error');
    toast('Engine failed to start — ' + (e.message || 'unknown'), 5000);
  };
  wireWorkerMessages();
  return worker;
}

function wireWorkerMessages() {
  worker.onmessage = (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'model-progress': {
        els.dlProgress.classList.remove('hidden');
        els.dlFill.style.width = Math.round(m.pct * 100) + '%';
        els.dlText.textContent = `Loading speech model — ${m.file} ${Math.round(m.pct * 100)}%`;
        break;
      }
      case 'ready': {
        engineReady = true;
        els.dlText.textContent = 'Model ready.';
        setTimeout(() => els.dlProgress.classList.add('hidden'), 600);
        els.setup.classList.add('hidden');
        els.editorWrap.classList.remove('hidden');
        els.micDock.classList.remove('hidden');
        [els.copyBtn, els.shareBtn, els.clearBtn].forEach(b => b.classList.remove('hidden'));
        els.modelPill.textContent = m.modelId === 'base' ? 'accurate' : 'fast';
        updateEngineInfo();
        break;
      }
      case 'partial': {
        els.partial.textContent = m.text;
        break;
      }
      case 'final': {
        els.partial.textContent = '';
        appendToEditor(m.text);
        sessionSegments.push({ text: m.text, t: m.t });
        break;
      }
      case 'live-stopped': {
        capturing = false;
        els.micBtn.classList.remove('active');
        els.levelFill.style.width = '0%';
        onCaptureDone(m.buffer, m.timing);
        break;
      }
      case 'file-progress': {
        const el = fileJobs[m.id];
        if (!el) break;
        els.fileFill.style.width = Math.round(m.pct * 100) + '%';
        els.fileText.textContent = m.partial ? m.partial.slice(-90) : 'Working…';
        break;
      }
      case 'file-done': {
        const job = fileJobs[m.id];
        if (!job) break;
        delete fileJobs[m.id];
        els.fileProgress.classList.add('hidden');
        els.fileResult.classList.remove('hidden');
        const text = postProcess(m.pieces.map(p => p.text).join(' '));
        els.fileEditor.textContent = text;
        saveFileRecording(job.name, job.buffer, text, m.pieces);
        break;
      }
      case 'bench-done': {
        const rtf = m.ms / 1000 / m.dur;
        const exact = m.text.toLowerCase().replace(/[^\w\s']/g, '').trim() ===
          'then he sat down in his chair and gazed without seeing contemplating the result of his work';
        els.benchOut.textContent =
          `Reference clip: ${m.dur.toFixed(1)}s of speech\n` +
          `Decode time: ${(m.ms / 1000).toFixed(2)}s  (real-time factor ${rtf.toFixed(2)} — lower is faster)\n` +
          `Transcript matches reference: ${exact ? 'yes, word for word' : 'no'}\n` +
          `Heard: “${m.text}”`;
        els.benchBtn.disabled = false;
        els.benchBtn.textContent = 'Run bench';
        break;
      }
      case 'denoise-unavailable':
        toast('Noise reduction unavailable on this device');
        break;
      case 'error': {
        toast('Engine error: ' + m.message, 4200);
        els.dlText.textContent = 'Something went wrong. ' + m.message;
        break;
      }
    }
  };
}

function postProcess(text) {
  let t = VaniDict.apply(text);
  if (els.fillerToggle.checked) t = VaniDict.cleanup(t);
  return t;
}

function appendToEditor(text) {
  const t = postProcess(text);
  if (!t) return;
  const cur = els.editor.textContent;
  els.editor.textContent = cur ? cur.replace(/\s+$/, '') + ' ' + t : t;
}

function updateEngineInfo() {
  els.engineInfo.textContent =
    `Model: Moonshine v2 ${modelId} (English)\n` +
    `Pipeline: Silero VAD → ${els.denoiseToggle.checked ? 'GTCRN denoise → ' : ''}Moonshine ASR, all WebAssembly, all local.\n` +
    (VaniStore.persistent ? 'Stored: recordings & corrections in this browser only.' : 'Storage unavailable here: recordings & corrections last for this session only.');
}

/* ---- model choice ---- */
document.querySelectorAll('.modelcard').forEach(c => c.addEventListener('click', () => {
  modelId = c.dataset.model;
  try { localStorage.setItem('vani-model', modelId); } catch (e) {}
  startEngine();
}));
els.modelPill.addEventListener('click', () => { openSettings(); });
els.switchModelBtn.addEventListener('click', () => {
  closeSettings();
  els.setup.classList.remove('hidden');
  els.editorWrap.classList.add('hidden');
  els.micDock.classList.add('hidden');
});

async function startEngine() {
  if (!modelId) return;
  els.setup.classList.remove('hidden');
  els.dlProgress.classList.remove('hidden');
  els.dlText.textContent = 'Preparing engine…';
  try {
    const assets = await ensureAssets(modelId);
    ensureWorker().postMessage(
      { type: 'init', modelId, denoise: els.denoiseToggle.checked, assets },
      Object.values(assets),
    );
  } catch (e) {
    els.dlText.textContent = 'Engine failed to start: ' + ((e && e.message) || e);
  }
}

/* ---- mic capture ---- */
let audioCtx = null, mediaStream = null, workletNode = null, downsample = null;

async function startCapture() {
  if (!engineReady || capturing) return;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: true },
    });
  } catch (e) {
    toast('Microphone permission needed — check the browser prompt / address bar');
    return;
  }
  capturing = true;
  sessionSegments = [];
  els.micBtn.classList.add('active');
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const srcRate = audioCtx.sampleRate;
  const src = audioCtx.createMediaStreamSource(mediaStream);
  const ratio = srcRate / 16000;
  const handleChunk = (chunk) => {
    if (!capturing) return;
    // downsample to 16k here (linear interp is plenty for speech)
    const out = new Float32Array(Math.floor(chunk.length / ratio));
    for (let i = 0; i < out.length; i++) out[i] = chunk[Math.floor(i * ratio)];
    worker.postMessage({ type: 'live-chunk', buffer: out.buffer }, [out.buffer]);
    let peak = 0;
    for (let i = 0; i < chunk.length; i += 8) peak = Math.max(peak, Math.abs(chunk[i]));
    els.levelFill.style.width = Math.min(100, Math.round(peak * 220)) + '%';
  };
  try {
    await audioCtx.audioWorklet.addModule((self.VANI_CFG && self.VANI_CFG.worklet) || 'js/capture-worklet.js');
    workletNode = new AudioWorkletNode(audioCtx, 'vani-capture');
    workletNode.port.onmessage = (ev) => handleChunk(ev.data);
    src.connect(workletNode);
  } catch (e) {
    // hosted Files block worklet module loads: fall back to ScriptProcessor
    const sp = audioCtx.createScriptProcessor(4096, 1, 1);
    sp.onaudioprocess = (ev) => handleChunk(ev.inputBuffer.getChannelData(0));
    src.connect(sp);
    sp.connect(audioCtx.destination);
    workletNode = sp;
  }
  worker.postMessage({ type: 'live-start' });
}

function stopCapture() {
  if (!capturing) return;
  capturing = false;
  if (workletNode) { workletNode.disconnect(); workletNode = null; }
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  worker.postMessage({ type: 'live-stop' });
}

els.micBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); startCapture(); });
['pointerup', 'pointercancel', 'pointerleave'].forEach(ev =>
  els.micBtn.addEventListener(ev, () => stopCapture()));
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && document.activeElement !== els.editor && engineReady) { e.preventDefault(); startCapture(); }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && capturing) { e.preventDefault(); stopCapture(); }
});

async function onCaptureDone(wavBuffer16k, timing) {
  const text = els.editor.textContent.trim();
  if (!text && !wavBuffer16k.byteLength) return;
  const samples = new Float32Array(wavBuffer16k);
  const wav = floatToWav(samples, 16000);
  const name = 'Dictation ' + new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  await VaniStore.saveRecording({
    name, created: Date.now(), duration: samples.length / 16000,
    audio: wav, transcript: text, segments: sessionSegments,
  });
  if (timing && timing.audioMs > 0) {
    const rtf = timing.decodeMs / timing.audioMs;
    toast(`Saved. Engine ran at ${rtf.toFixed(2)}× real time on this device.`);
  } else {
    toast('Saved to Recordings');
  }
}

/* ---- editor actions ---- */
els.copyBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(els.editor.textContent);
  toast('Copied');
});
els.shareBtn.addEventListener('click', async () => {
  const t = els.editor.textContent;
  if (navigator.share) { try { await navigator.share({ text: t }); } catch (e) {} }
  else { await navigator.clipboard.writeText(t); toast('Copied (sharing not available)'); }
});
els.clearBtn.addEventListener('click', () => { els.editor.textContent = ''; els.partial.textContent = ''; });

/* ---- file transcription ---- */
const fileJobs = {};
els.pickFileBtn.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', async () => {
  const f = els.fileInput.files[0];
  if (!f) return;
  els.fileProgress.classList.remove('hidden');
  els.fileResult.classList.add('hidden');
  els.fileFill.style.width = '2%';
  els.fileText.textContent = 'Decoding audio…';
  try {
    const ab = await f.arrayBuffer();
    const ctx = new OfflineAudioContext(1, 1, 16000);
    const decoded = await ctx.decodeAudioData(ab);
    // resample to 16k via offline context
    const dur = decoded.duration;
    const off = new OfflineAudioContext(1, Math.ceil(dur * 16000), 16000);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    const pcm = rendered.getChannelData(0);
    const id = ++fileSeq;
    fileJobs[id] = { name: f.name, buffer: floatToWav(pcm, 16000) };
    ensureWorker().postMessage(
      { type: 'transcribe-buffer', id, buffer: pcm.buffer, denoise: els.denoiseToggle.checked },
      [pcm.buffer]);
    els.fileText.textContent = 'Transcribing…';
  } catch (e) {
    els.fileText.textContent = 'Could not decode that file (' + (e.message || e) + ').';
  }
  els.fileInput.value = '';
});
els.fileCopyBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(els.fileEditor.textContent);
  toast('Copied');
});

async function saveFileRecording(name, wavBuffer, transcript, pieces) {
  await VaniStore.saveRecording({
    name: 'File: ' + name, created: Date.now(),
    duration: (() => { const d = pieces.length ? pieces[pieces.length - 1].t1 : NaN; return isFinite(d) ? d : (wavBuffer.byteLength - 44) / 2 / 16000; })(),
    audio: wavBuffer, transcript, segments: pieces,
  });
  toast('Saved to Recordings');
}

/* ---- recordings view ---- */
let playingAudio = null;
async function renderRecordings() {
  const list = await VaniStore.listRecordings();
  els.recList.innerHTML = '';
  els.recEmpty.classList.toggle('hidden', list.length > 0);
  for (const r of list) {
    const div = document.createElement('div');
    div.className = 'recitem';
    const play = document.createElement('button');
    play.className = 'rec-play'; play.textContent = '▶'; play.title = 'Play';
    play.addEventListener('click', () => {
      if (playingAudio) { playingAudio.pause(); playingAudio = null; play.textContent = '▶'; return; }
      const blob = new Blob([r.audio], { type: 'audio/wav' });
      playingAudio = new Audio(URL.createObjectURL(blob));
      playingAudio.onended = () => { play.textContent = '▶'; playingAudio = null; };
      playingAudio.play(); play.textContent = '⏸';
    });
    const meta = document.createElement('div');
    meta.className = 'rec-meta';
    const nm = document.createElement('div'); nm.className = 'rec-name'; nm.textContent = r.name;
    const sub = document.createElement('div'); sub.className = 'rec-sub';
    sub.textContent = `${(r.duration || 0).toFixed(1)}s · ${new Date(r.created).toLocaleDateString()}`;
    meta.appendChild(nm); meta.appendChild(sub);
    meta.style.cursor = 'pointer';
    meta.title = 'Open transcript';
    meta.addEventListener('click', () => openRecording(r));
    const del = document.createElement('button');
    del.className = 'textbtn'; del.textContent = 'Delete';
    del.addEventListener('click', async () => { await VaniStore.deleteRecording(r.id); renderRecordings(); });
    div.appendChild(play); div.appendChild(meta); div.appendChild(del);
    els.recList.appendChild(div);
  }
}
function openRecording(r) {
  document.querySelector('.tab[data-view="transcriptView"]').click();
  els.editor.textContent = r.transcript || '';
  els.editorWrap.classList.remove('hidden');
  els.micDock.classList.remove('hidden');
  els.setup.classList.add('hidden');
  toast('Loaded transcript — audio stays in Recordings');
}

/* ---- dictionary view ---- */
function renderDict() {
  const list = VaniDict.load();
  els.dictList.innerHTML = '';
  for (const { from, to } of list) {
    const div = document.createElement('div');
    div.className = 'dictitem';
    const f = document.createElement('span'); f.className = 'd-from'; f.textContent = from;
    const ar = document.createElement('span'); ar.textContent = '→'; ar.style.color = 'var(--ink-soft)';
    const t = document.createElement('span'); t.className = 'd-to'; t.textContent = to;
    const del = document.createElement('button'); del.className = 'textbtn'; del.textContent = 'Remove';
    del.addEventListener('click', () => { VaniDict.remove(from); renderDict(); });
    div.appendChild(f); div.appendChild(ar); div.appendChild(t); div.appendChild(del);
    els.dictList.appendChild(div);
  }
}
els.dictAddBtn.addEventListener('click', () => {
  const f = els.dictFrom.value.trim(), t = els.dictTo.value.trim();
  if (!f || !t) return;
  VaniDict.add(f, t);
  els.dictFrom.value = ''; els.dictTo.value = '';
  renderDict();
  toast(`Will always write “${t}” for “${f}”`);
});
els.denoiseToggle.checked = localStorage.getItem('vani-denoise') !== 'off';
els.denoiseToggle.addEventListener('change', () => {
  localStorage.setItem('vani-denoise', els.denoiseToggle.checked ? 'on' : 'off');
  if (worker) worker.postMessage({ type: 'set-denoise', on: els.denoiseToggle.checked });
  updateEngineInfo();
});
els.fillerToggle.checked = localStorage.getItem('vani-filler') === 'on';
els.fillerToggle.addEventListener('change', () => {
  localStorage.setItem('vani-filler', els.fillerToggle.checked ? 'on' : 'off');
});

/* ---- bench ---- */
els.benchBtn.addEventListener('click', async () => {
  if (!engineReady) { toast('Load a model first'); return; }
  els.benchBtn.disabled = true;
  els.benchBtn.textContent = 'Running…';
  const injected = self.__VANI_ASSETS && self.__VANI_ASSETS['bench.wav'];
  const resp = injected ? new Response(injected.slice(0)) : await fetch('assets/bench.wav');
  const ab = await resp.arrayBuffer();
  // 44-byte canonical wav header, 16-bit PCM after it (we generated it ourselves)
  const i16 = new Int16Array(ab, 44);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
  worker.postMessage({ type: 'bench', buffer: f32.buffer }, [f32.buffer]);
});

/* ---- settings ---- */
function openSettings() { updateEngineInfo(); els.settingsSheet.classList.remove('hidden'); }
function closeSettings() { els.settingsSheet.classList.add('hidden'); }
els.settingsBtn.addEventListener('click', openSettings);
els.closeSettings.addEventListener('click', closeSettings);
els.settingsSheet.addEventListener('click', (e) => { if (e.target === els.settingsSheet) closeSettings(); });
els.wipeBtn.addEventListener('click', async () => {
  await VaniStore.clearAll();
  localStorage.clear();
  if (navigator.storage && navigator.storage.getDirectory) {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('models', { recursive: true });
    } catch (e) {}
  }
  toast('All local data deleted. Reloading…');
  setTimeout(() => location.reload(), 900);
});

/* ---- boot ---- */
if (modelId) startEngine();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
})();
