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
  engineInfo: $('engineInfo'), switchModelBtn: $('switchModelBtn'), wipeBtn: $('wipeBtn'), refineToggle: $('refineToggle'),
  toast: $('toast'),
};

let worker = null;
let modelId = null;
try { modelId = localStorage.getItem('vani-model') || 'tiny'; }
catch (e) { modelId = 'tiny'; VaniDiag.warn('model choice unreadable (storage blocked)', e); }

/* Latency self-measurement. The two numbers Naksh grades: open -> ready and
   mic tap -> first word. Measured in-app so his phone reports its own truth;
   the lab harness (control-vani latency) reads the same object. */
const latency = {
  openToReadyMs: null,        // navigation start -> engine ready
  tapToFirstWordMs: null,     // mic press -> first live partial this session
  tapToFirstFinalMs: null,
  _tapAt: null, _firstPartialSeen: false, _firstFinalSeen: false,
};
self.__VANI_LATENCY = latency;
function latencyPersist() {
  try {
    localStorage.setItem('vani-latency', JSON.stringify({
      openToReadyMs: latency.openToReadyMs, tapToFirstWordMs: latency.tapToFirstWordMs,
      tapToFirstFinalMs: latency.tapToFirstFinalMs, at: Date.now(),
    }));
  } catch (e) { VaniDiag.warn('latency numbers could not be stored', e); }
  renderLatency();
}
function renderLatency() {
  const el = $('latencyOut'); if (!el) return;
  const fmt = (ms) => ms == null ? 'not measured yet' : (ms / 1000).toFixed(2) + 's';
  el.textContent =
    'On this device:\n' +
    'open → ready: ' + fmt(latency.openToReadyMs) + '\n' +
    'mic tap → first word: ' + fmt(latency.tapToFirstWordMs) + '\n' +
    'mic tap → first saved sentence: ' + fmt(latency.tapToFirstFinalMs);
}
try {
  const saved = JSON.parse(localStorage.getItem('vani-latency') || 'null');
  if (saved) {
    latency.openToReadyMs = saved.openToReadyMs;
    latency.tapToFirstWordMs = saved.tapToFirstWordMs;
    latency.tapToFirstFinalMs = saved.tapToFirstFinalMs;
  }
} catch (e) { VaniDiag.warn('stored latency numbers unreadable', e); }
let engineReady = false;
let denoiseWarm = false;
let capturing = false;
let sessionSegments = [];  // {text, t}
let fileSeq = 0;

function toast(msg, ms = 2600) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.add('hidden'), ms);
}
VaniDiag.onEvent = (entry) => {
  if (entry.userVisible) toast(entry.what, 4200);
};
/* engine-side degraded signals arrive as worker messages */
function handleEngineDegraded(kind, detail) {
  if (kind === 'storage-degraded') {
    toast('Local model cache unavailable — the big model will re-download each launch.', 5200);
  } else if (kind === 'denoise-degraded') {
    toast('Noise reduction is failing on this device — using raw audio.', 4200);
  }
  VaniDiag.warn('engine: ' + kind, detail || null);
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
  if (b.dataset.view === 'benchView') renderLatency();
}));

/* ---- engine assets: hosted build transfers them from the parent frame;
   local server build fetches them from relative paths ---- */
let workerAssets = null;
let shellAssets = null;
let starting = false;
let readyHideTimer = null;
let assetsResolve = null;
const assetsReady = new Promise(r => { assetsResolve = r; });
window.addEventListener('message', (ev) => {
  if (ev.data && ev.data.type === 'vani-assets' && ev.data.assets) {
    workerAssets = ev.data.assets;
    assetsResolve();
  }
});
async function ensureAssets(model) {
  if (workerAssets) return workerAssets;
  if (self.__VANI_ASSETS) { workerAssets = self.__VANI_ASSETS; return workerAssets; }
  if (self.VANI_CFG) { await assetsReady; return workerAssets; }
  const assets = await VaniAssets.ensureAssets(model, { shellAssets });
  shellAssets = Object.fromEntries(Object.entries(assets).filter(([k]) => !k.startsWith('model/')));
  return assets;
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
  /* No Worker fallback: the standalone worker entry was never shipped —
     the hosted build always runs the engine inline. A missing channel is a
     broken deploy; say so instead of 404ing on a phantom file. */
  throw new Error('engine bundle not loaded (js/engine-bundle.js missing or blocked)');
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
        setStarting(false);
        engineReady = true;
        latency.openToReadyMs = Math.round(performance.now()); latencyPersist();
        els.dlText.textContent = 'Model ready.';
        readyHideTimer = setTimeout(() => els.dlProgress.classList.add('hidden'), 600);
        els.setup.classList.add('hidden');
        els.editorWrap.classList.remove('hidden');
        els.micDock.classList.remove('hidden');
        [els.copyBtn, els.shareBtn, els.clearBtn].forEach(b => b.classList.remove('hidden'));
        els.modelPill.textContent = m.modelId === 'base' ? 'accurate' : 'fast';
        if (els.refineToggle.checked) worker.postMessage({ type: 'set-refine', on: true });
        updateEngineInfo();
        break;
      }
      case 'partial': {
        if (capturing && !latency._firstPartialSeen && latency._tapAt != null) {
          latency._firstPartialSeen = true;
          latency.tapToFirstWordMs = Math.round(performance.now() - latency._tapAt);
          latencyPersist();
        }
        els.partial.textContent = m.text;
        break;
      }
      case 'final': {
        if (capturing && !latency._firstFinalSeen && latency._tapAt != null) {
          latency._firstFinalSeen = true;
          latency.tapToFirstFinalMs = Math.round(performance.now() - latency._tapAt);
          latencyPersist();
        }
        els.partial.textContent = '';
        appendToEditor(m.text, m.segId);
        sessionSegments.push({ text: m.text, t: m.t, segId: m.segId });
        break;
      }
      case 'final-refined':
        applyRefined(m.segId, m.text);
        break;
      case 'refine-state':
        refineState = m;
        if (m.status === 'unavailable' || m.status === 'error') {
          els.refineToggle.checked = false;
          try { localStorage.setItem('vani-refine', 'off'); }
          catch (e) { VaniDiag.warn('refine choice could not be saved', e); }
          toast('Refine unavailable: ' + (m.message || m.status), 4200);
        } else if (m.status === 'ready') toast('Accurate refine ready');
        updateEngineInfo();
        break;
      case 'refine-status':
        refinePending = m.pending || 0;
        updateEngineInfo();
        break;
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
        els.denoiseToggle.checked = false;
        denoiseWarm = false;
        try { localStorage.setItem('vani-denoise', 'off'); } catch (e) { VaniDiag.warn('denoise choice could not be saved', e); }
        updateEngineInfo();
        toast('Noise reduction unavailable on this device' + (m.message ? ' (' + m.message + ')' : ''));
        break;
      case 'denoise-state':
        denoiseWarm = m.status === 'ready';
        if (m.status === 'unavailable') els.denoiseToggle.checked = false;
        updateEngineInfo();
        break;
      case 'denoise-ready':
        denoiseWarm = true;
        updateEngineInfo();
        break;
      case 'storage-degraded':
        handleEngineDegraded('storage-degraded', m.message);
        break;
      case 'denoise-degraded':
        handleEngineDegraded('denoise-degraded', m.message);
        break;
      case 'error': {
        if (m.during === 'init') { showStartFailure(m.message); break; }
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

/* segId -> {start, end} offsets in the editor text, so a refined final can
   swap its draft in place. */
const refineSpans = new Map();
let refineState = null, refinePending = 0;
function appendToEditor(text, segId) {
  const t = postProcess(text);
  if (!t) return;
  const cur = els.editor.textContent;
  const start = cur ? cur.replace(/\s+$/, '').length + 1 : 0;
  els.editor.textContent = cur ? cur.replace(/\s+$/, '') + ' ' + t : t;
  if (segId != null) refineSpans.set(segId, { start, end: start + t.length });
}
function applyRefined(segId, rawText) {
  const span = refineSpans.get(segId);
  if (!span) return;  // editor was cleared or the draft was never tracked
  const t = postProcess(rawText);
  const cur = els.editor.textContent;
  els.editor.textContent = cur.slice(0, span.start) + t + cur.slice(span.end);
  const delta = t.length - (span.end - span.start);
  span.end += delta;
  for (const s of refineSpans.values()) {
    if (s.start > span.start) { s.start += delta; s.end += delta; }
  }
  const seg = sessionSegments.find(sg => sg.segId === segId);
  if (seg) seg.text = rawText;
}

function updateEngineInfo() {
  els.engineInfo.textContent =
    `Model: Moonshine v2 ${modelId} (English)\n` +
    `Pipeline: Silero VAD → ${els.denoiseToggle.checked ? (denoiseWarm ? 'GTCRN denoise → ' : 'GTCRN denoise (warming up) → ') : ''}Moonshine ASR, all WebAssembly, all local.\n` +
    (refineState && refineState.on ? 'Refine: ' + (refineState.status === 'ready' ? 'accurate model verifying finals' + (refinePending ? ' (' + refinePending + ' queued)' : '') : refineState.status === 'loading' ? 'accurate model downloading…' : (refineState.status || 'on')) + '\n' : '') +
    (VaniStore.persistent ? 'Stored: recordings & corrections in this browser only.' : 'Storage unavailable here: recordings & corrections last for this session only.');
}

/* This is guidance, not an unsupported benchmark claim. Browser hints are
   optional and coarse; they do not measure device performance. Never auto-
   select a model or override the person's saved choice. */
function deviceAdvice(nav = navigator) {
  const ram = nav.deviceMemory == null ? NaN : Number(nav.deviceMemory);
  const cores = nav.hardwareConcurrency == null ? NaN : Number(nav.hardwareConcurrency);
  if (Number.isFinite(ram) && ram > 0 && ram <= 4) {
    return 'Fast is the safer starting point here (' + ram + ' GB browser memory hint). Accurate needs about 141 MB plus engine files and may use more memory. Bench checks decode speed after loading.';
  }
  if (Number.isFinite(ram) && ram >= 8 && Number.isFinite(cores) && cores >= 4) {
    return 'Browser hints report ' + ram + ' GB and ' + cores + ' logical cores. Accurate may fit, but its ~141 MB model plus engine files and speed still need a device test.';
  }
  return 'Start with Fast (~43 MB model). Accurate needs a ~141 MB model plus engine files and may be slower; browser device hints are unavailable or inconclusive. Bench checks speed after loading.';
}
const advice = $('deviceAdvice');
if (advice) advice.textContent = deviceAdvice();

/* ---- model choice ---- */
document.querySelectorAll('.modelcard').forEach(c => c.addEventListener('click', () => {
  if (starting) return;
  modelId = c.dataset.model;
  try { localStorage.setItem('vani-model', modelId); }
  catch (e) { VaniDiag.warn('could not remember model choice (storage blocked)', e); }
  startEngine();
}));
els.modelPill.addEventListener('click', () => { openSettings(); });
els.switchModelBtn.addEventListener('click', () => {
  closeSettings();
  els.setup.classList.remove('hidden');
  els.editorWrap.classList.add('hidden');
  els.micDock.classList.add('hidden');
});

function setStarting(on) {
  starting = on;
  document.querySelectorAll('.modelcard').forEach(c => { c.disabled = on; });
  els.setup.setAttribute('aria-busy', String(on));
}
function showStartFailure(message) {
  setStarting(false);
  engineReady = false;
  els.setup.classList.remove('hidden');
  els.dlProgress.classList.remove('hidden');
  els.dlFill.style.width = '0%';
  els.dlText.textContent = 'Engine failed to start: ' + message +
    ' Tap Fast or Accurate again to retry.';
}
async function startEngine() {
  if (!modelId || starting) return;
  const requestedModel = modelId;
  clearTimeout(readyHideTimer);
  setStarting(true);
  engineReady = false;
  els.setup.classList.remove('hidden');
  els.dlProgress.classList.remove('hidden');
  els.dlFill.style.width = '0%';
  els.dlText.textContent = 'Preparing engine…';
  try {
    const assets = await ensureAssets(requestedModel);
    ensureWorker().postMessage(
      { type: 'init', modelId: requestedModel, denoise: els.denoiseToggle.checked, assets },
      Object.values(assets),
    );
  } catch (e) {
    showStartFailure((e && e.message) || e);
  }
}

/* ---- mic capture ---- */
let audioCtx = null, mediaStream = null, workletNode = null, downsample = null;

function showMicPanel(errName) {
  const p = $('micPanel'); if (!p) return;
  p.classList.remove('hidden');
  const help = $('micHelp');
  if (errName === 'NotAllowedError' || errName === 'SecurityError') {
    help.textContent = 'Chrome blocked the mic for this site. Tap the lock/tune icon left of the address bar, open Permissions, set Microphone to Allow, then tap Enable microphone.';
  } else if (errName === 'NotFoundError' || errName === 'DevicesNotFoundError') {
    help.textContent = 'No microphone was found on this device.';
  } else if (errName === 'NotReadableError' || errName === 'TrackStartError') {
    help.textContent = 'The mic is busy - close other apps that might be using it (calls, camera, voice recorder), then tap Enable microphone.';
  } else {
    help.textContent = 'The microphone did not start (' + (errName || 'unknown error') + '). Tap Enable microphone to try again.';
  }
}
function hideMicPanel() { const p = $('micPanel'); if (p) p.classList.add('hidden'); }

async function startCapture() {
  if (!engineReady || capturing) return;
  latency._tapAt = performance.now();
  latency._firstPartialSeen = false;
  latency._firstFinalSeen = false;
  if (worker) worker.postMessage({ type: 'live-intent' }); // hold the denoiser warm-up during audio setup
  // getUserMedia must be reached directly from the press gesture - no awaits first.
  // Plain audio:true first: some Androids reject channelCount/noise-suppression picks.
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e1) {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: true },
      });
    } catch (e2) {
      showMicPanel((e2 && e2.name) || (e1 && e1.name));
      return;
    }
  }
  hideMicPanel();
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
    VaniDiag.warn('audio worklet unavailable, using ScriptProcessor (higher latency)', e);
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
  try {
    await VaniStore.saveRecording({
      name, created: Date.now(), duration: samples.length / 16000,
      audio: wav, transcript: text, segments: sessionSegments,
    });
  } catch (e) {
    VaniDiag.warn('recording could not be saved', e, { userVisible: true });
    toast('Could not save the recording — copy your transcript now, it is not stored.', 5000);
    return;
  }
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
  if (navigator.share) {
    try { await navigator.share({ text: t }); return; }
    catch (e) {
      if (e && e.name === 'AbortError') return; // user cancelled the share sheet: nothing went wrong
      VaniDiag.warn('native share failed, copied instead', e);
    }
  }
  await navigator.clipboard.writeText(t);
  toast('Copied (sharing not available)');
});
const micEnableBtn = $('micEnableBtn');
if (micEnableBtn) micEnableBtn.addEventListener('click', () => startCapture());
els.clearBtn.addEventListener('click', () => { els.editor.textContent = ''; els.partial.textContent = ''; refineSpans.clear(); });

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
  try {
    await VaniStore.saveRecording({
    name: 'File: ' + name, created: Date.now(),
    duration: (() => { const d = pieces.length ? pieces[pieces.length - 1].t1 : NaN; return isFinite(d) ? d : (wavBuffer.byteLength - 44) / 2 / 16000; })(),
      audio: wavBuffer, transcript, segments: pieces,
    });
  } catch (e) {
    VaniDiag.warn('file transcription could not be saved', e, { userVisible: true });
    toast('Transcribed, but could not save it — copy it now, it is not stored.', 5000);
    return;
  }
  toast('Saved to Recordings');
}

/* ---- recordings view ---- */
let playingAudio = null;
async function renderRecordings() {
  let list;
  try {
    list = await VaniStore.listRecordings();
  } catch (e) {
    VaniDiag.warn('recordings could not be listed', e, { userVisible: true });
    return;
  }
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
els.refineToggle.checked = localStorage.getItem('vani-refine') === 'on';
els.refineToggle.addEventListener('change', () => {
  try { localStorage.setItem('vani-refine', els.refineToggle.checked ? 'on' : 'off'); }
  catch (e) { VaniDiag.warn('refine choice could not be saved', e); }
  if (worker) worker.postMessage({ type: 'set-refine', on: els.refineToggle.checked });
});
els.denoiseToggle.checked = localStorage.getItem('vani-denoise') === 'on';
els.denoiseToggle.addEventListener('change', () => {
  try { localStorage.setItem('vani-denoise', els.denoiseToggle.checked ? 'on' : 'off'); }
  catch (e) { VaniDiag.warn('denoise choice could not be saved', e); }
  denoiseWarm = els.denoiseToggle.checked && denoiseWarm;
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
  let modelCacheGone = true;
  if (navigator.storage && navigator.storage.getDirectory) {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('models', { recursive: true });
    } catch (e) {
      modelCacheGone = false;
      VaniDiag.warn('model cache could not be deleted', e);
    }
  }
  toast(modelCacheGone ? 'All local data deleted. Reloading…'
                       : 'Data deleted, but the downloaded model may remain (browser blocked its removal). Reloading…', 4000);
  setTimeout(() => location.reload(), 900);
});

/* ---- store degradation: tell the user their recordings are session-only ---- */
VaniStore.onDegraded = (why) => {
  VaniDiag.warn('persistent storage unavailable: ' + why, VaniStore.lastError, { userVisible: true });
};

/* ---- boot ---- */
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch((e) => VaniDiag.warn('persistent-storage request failed; the browser may evict local data', e));
startEngine();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => VaniDiag.warn('offline support failed to install (service worker)', e, { userVisible: true }));
}
})();
