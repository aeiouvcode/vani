/* Vani diagnostics: one loud channel for every degraded path. A catch that
   swallows an error is a lie the app tells its user; every degraded path in
   Vani calls VaniDiag.warn so the failure is at least visible in the console
   and (for user-impactful ones) toasted by the UI via VaniDiag.onEvent. */
'use strict';
const VaniDiag = (() => {
  const log = [];
  let onEvent = null; // (entry) => void; app.js sets this to toast user-impactful events
  function warn(what, err, opts) {
    const detail = err == null ? '' : (err && err.message) ? err.message : String(err);
    const entry = { what, detail, userVisible: !!(opts && opts.userVisible), t: Date.now() };
    log.push(entry);
    if (log.length > 50) log.shift();
    (console.warn || console.log).call(console, '[vani] ' + what + (detail ? ' — ' + detail : ''));
    if (onEvent) {
      try { onEvent(entry); } catch (hookErr) {
        // a broken UI hook must not take the app down with it
        (console.error || console.log).call(console, '[vani] diag hook failed — ' + ((hookErr && hookErr.message) || hookErr));
      }
    }
    return entry;
  }
  return {
    warn,
    get log() { return log.slice(); },
    set onEvent(fn) { onEvent = fn; },
    get onEvent() { return onEvent; },
  };
})();
// node test harness imports via module.exports when present
if (typeof module !== 'undefined' && module.exports) module.exports = VaniDiag;
