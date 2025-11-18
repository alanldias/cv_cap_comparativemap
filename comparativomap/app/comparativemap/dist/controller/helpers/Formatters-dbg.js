sap.ui.define([], function () {
  "use strict";

  function fmt2(v) {
    const n = Number(v);

    if (isNaN(n)) {
      return "0,00";
    }

    return n
      .toFixed(2)   // "16.00"
      .replace(".", ","); // "16,00"
  }

  return { fmt2 };
});
