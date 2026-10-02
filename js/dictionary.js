/* Vani corrections dictionary + rule-based cleanup. Local only. */
'use strict';
const VaniDict = (() => {
  const KEY = 'vani-dictionary';
  function diagWarn(what, err) {
    if (typeof VaniDiag !== 'undefined') VaniDiag.warn(what, err);
    else (console.warn || console.log).call(console, '[vani] ' + what + ' — ' + ((err && err.message) || err));
  }
  function load() {
    let raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { diagWarn('corrections dictionary is unreadable (storage blocked)', e); return []; }
    if (raw == null) return [];
    try { return JSON.parse(raw) || []; }
    catch (e) {
      // corrupt stored JSON: keep the app running, but make the data loss visible
      diagWarn('corrections dictionary was corrupt and has been reset (' + raw.length + ' chars lost)', e);
      return [];
    }
  }
  function save(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); }
    catch (e) { diagWarn('corrections dictionary could not be saved', e); }
  }
  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function apply(text) {
    let out = text;
    for (const { from, to } of load()) {
      if (!from) continue;
      out = out.replace(new RegExp(`\\b${esc(from)}\\b`, 'gi'), (m) =>
        m[0] === m[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to);
    }
    return out;
  }
  function add(from, to) {
    const list = load().filter(x => x.from.toLowerCase() !== from.toLowerCase());
    list.push({ from, to }); save(list);
  }
  function remove(from) { save(load().filter(x => x.from !== from)); }
  function cleanup(text) {
    return text
      .replace(/\b(um+|uh+|er+|erm|hmm+)\b[,\s]*/gi, '')
      .replace(/\b(\w+)(\s+\1\b)+/gi, '$1')
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([,.!?;:])/g, '$1')
      .trim();
  }
  return { load, add, remove, apply, cleanup };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = VaniDict;
