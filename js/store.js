/* Vani local store: IndexedDB recordings + localStorage settings/dictionary.
   Falls back to in-memory storage where the sandbox denies IDB (hosted Files). */
'use strict';
const VaniStore = (() => {
  const DB = 'vani', STORE = 'recordings';
  let idb = null, idbFailed = false, mem = [], memNextId = 1;
  function useIdb() {
    if (idbFailed) return Promise.resolve(false);
    if (idb) return Promise.resolve(true);
    return new Promise((res) => {
      try {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        r.onsuccess = () => { idb = r.result; res(true); };
        r.onerror = () => { idbFailed = true; res(false); };
      } catch (e) { idbFailed = true; res(false); }
    });
  }
  return {
    get persistent() { return !idbFailed; },
    async saveRecording(rec) { // {name, created, duration, audio:ArrayBuffer(wav), transcript, segments}
      if (await useIdb()) {
        return new Promise((res, rej) => {
          const rq = idb.transaction(STORE, 'readwrite').objectStore(STORE).add(rec);
          rq.onsuccess = () => res(rq.result);
          rq.onerror = () => rej(rq.error);
        });
      }
      rec.id = memNextId++;
      mem.unshift(rec);
      return rec.id;
    },
    async listRecordings() {
      if (await useIdb()) {
        return new Promise((res, rej) => {
          const rq = idb.transaction(STORE).objectStore(STORE).getAll();
          rq.onsuccess = () => res(rq.result.sort((a, b) => b.created - a.created));
          rq.onerror = () => rej(rq.error);
        });
      }
      return mem.slice().sort((a, b) => b.created - a.created);
    },
    async getRecording(id) {
      if (await useIdb()) {
        return new Promise((res, rej) => {
          const rq = idb.transaction(STORE).objectStore(STORE).get(id);
          rq.onsuccess = () => res(rq.result);
          rq.onerror = () => rej(rq.error);
        });
      }
      return mem.find(r => r.id === id);
    },
    async updateRecording(id, patch) {
      const rec = await this.getRecording(id);
      if (!rec) return;
      if (await useIdb()) {
        return new Promise((res, rej) => {
          const rq = idb.transaction(STORE, 'readwrite').objectStore(STORE).put(Object.assign({}, rec, patch, { id }));
          rq.onsuccess = () => res();
          rq.onerror = () => rej(rq.error);
        });
      }
      Object.assign(rec, patch, { id });
    },
    async deleteRecording(id) {
      if (await useIdb()) {
        return new Promise((res, rej) => {
          const rq = idb.transaction(STORE, 'readwrite').objectStore(STORE).delete(id);
          rq.onsuccess = () => res();
          rq.onerror = () => rej(rq.error);
        });
      }
      mem = mem.filter(r => r.id !== id);
    },
    async clearAll() {
      if (await useIdb()) {
        return new Promise((res, rej) => {
          const rq = idb.transaction(STORE, 'readwrite').objectStore(STORE).clear();
          rq.onsuccess = () => res();
          rq.onerror = () => rej(rq.error);
        });
      }
      mem = [];
    },
  };
})();

function floatToWav(samples, sampleRate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); wstr(8, 'WAVE'); wstr(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); wstr(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s * 32767, true);
  }
  return buf;
}
