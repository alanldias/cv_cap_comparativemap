sap.ui.define(["sap/ui/core/format/NumberFormat"], function (NumberFormat) {
  "use strict";

  function formatNumberOrDash(sValue) {
    if (sValue === null || sValue === undefined || sValue === "") return "-";

    var fValue = parseFloat(sValue);
    if (isNaN(fValue)) return "-";

    var oFloatFormat = NumberFormat.getFloatInstance({
      minFractionDigits: 2,
      maxFractionDigits: 2,
      groupingEnabled: true,
      groupingSeparator: ".",
      decimalSeparator: ","
    });

    return oFloatFormat.format(fValue);
  }

  function formatIntegerOrDash(sValue) {
    if (sValue === null || sValue === undefined || sValue === "") return "-";

    var fValue = parseFloat(sValue);
    if (isNaN(fValue)) return "-";

    var oIntegerFormat = NumberFormat.getFloatInstance({
      minFractionDigits: 0,
      maxFractionDigits: 0,
      groupingEnabled: true,
      groupingSeparator: "."
    });

    return oIntegerFormat.format(fValue);
  }

  function formatCleanMaterial(sValue) {
    if (!sValue) return "-";

    const match = String(sValue).match(/^(\d+)\s+(.+)/);
    if (match) {
      const sCodigo = match[1];
      const sDescricao = match[2];
      return `${sDescricao} (${sCodigo})`;
    }
    return sValue;
  }

  return {
    formatNumberOrDash,
    formatIntegerOrDash,
    formatCleanMaterial
  };
});
