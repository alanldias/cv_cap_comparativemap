sap.ui.define([], function () {
  "use strict";
  function fmt2(v) {
    const n = Number(v);
    return isNaN(n) ? "" : n.toFixed(2);
  }
  return { fmt2 };
});
