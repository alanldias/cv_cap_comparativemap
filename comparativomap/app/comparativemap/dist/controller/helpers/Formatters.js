sap.ui.define([], function () {
  "use strict";
  function t(t) {
    const n = Number(t);
    return isNaN(n) ? "" : n.toFixed(2);
  }
  return { fmt2: t };
});
//# sourceMappingURL=Formatters.js.map
