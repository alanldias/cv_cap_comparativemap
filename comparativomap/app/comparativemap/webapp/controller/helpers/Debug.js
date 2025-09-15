sap.ui.define([], function() {
  "use strict";
  function safe(obj) {
    const cache = new Set();
    const out = JSON.parse(JSON.stringify(obj, (k, v) => {
      if (typeof v === "function") return undefined;
      if (typeof v === "object" && v !== null) { if (cache.has(v)) return; cache.add(v); }
      return v;
    }));
    cache.clear();
    return out;
  }
  function dbg(title, obj) {
    /* eslint-disable no-console */
    console.groupCollapsed("🔎 " + title);
    try { console.log(safe(obj)); } catch(e){ console.log(obj); }
    console.groupEnd();
  }
  return { dbg, safe };
});
