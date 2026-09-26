/* Vani corrections dictionary + rule-based cleanup. Local only. */
'use strict';
const VaniDict = (() => {
  const KEY = 'vani-dictionary';
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; }
  }
  function save(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) {} }
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
