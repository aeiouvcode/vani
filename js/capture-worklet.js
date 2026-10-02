/* Vani mic capture worklet: batches input frames and forwards them to the
   page (~2048 samples per message, so the main thread is not pinged every
   128-frame quantum). Falls back to ScriptProcessor where worklets are
   blocked. */
'use strict';
class VaniCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._chunks = [];
    this._len = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      this._chunks.push(ch.slice(0));
      this._len += ch.length;
    }
    if (this._len >= 2048) {
      const out = new Float32Array(this._len);
      let o = 0;
      for (const c of this._chunks) { out.set(c, o); o += c.length; }
      this.port.postMessage(out);
      this._chunks = [];
      this._len = 0;
    }
    return true;
  }
}
registerProcessor('vani-capture', VaniCapture);
