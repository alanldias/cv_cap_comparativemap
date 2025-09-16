sap.ui.define([], function () {
  "use strict";
  function n(n) {
    const e = new Set();
    const o = JSON.parse(
      JSON.stringify(n, (n, o) => {
        if (typeof o === "function") return undefined;
        if (typeof o === "object" && o !== null) {
          if (e.has(o)) return;
          e.add(o);
        }
        return o;
      }),
    );
    e.clear();
    return o;
  }
  function e(e, o) {
    console.groupCollapsed("🔎 " + e);
    try {
      console.log(n(o));
    } catch (n) {
      console.log(o);
    }
    console.groupEnd();
  }
  return { dbg: e, safe: n };
});
//# sourceMappingURL=Debug.js.map
