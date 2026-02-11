sap.ui.define([
  "sap/ui/core/format/NumberFormat"
], function (NumberFormat) {
  "use strict";

  function _isEmpty(v) { // trata null/undefined/string vazia
    return v === null || v === undefined || v === "";
  }

  function _toNumber(v) { // converte com segurança (aceita string/number)
    if (_isEmpty(v)) return NaN;
    const n = typeof v === "number" ? v : parseFloat(String(v));
    return Number.isFinite(n) ? n : NaN;
  }

  function _floatFmt2() { // formatter 2 casas (pt-BR style)
    return NumberFormat.getFloatInstance({
      minFractionDigits: 2,
      maxFractionDigits: 2,
      groupingEnabled: true,
      groupingSeparator: ".",
      decimalSeparator: ","
    });
  }

  function _intFmt() { // formatter inteiro (pt-BR grouping)
    return NumberFormat.getFloatInstance({
      minFractionDigits: 0,
      maxFractionDigits: 0,
      groupingEnabled: true,
      groupingSeparator: "."
    });
  }

  function formatNumberOrDash(v) { // número com 2 casas; "-" se inválido
    const n = _toNumber(v);
    if (!Number.isFinite(n)) return "-";
    return _floatFmt2().format(n);
  }

  function formatIntegerOrDash(v) { // inteiro; "-" se inválido
    const n = _toNumber(v);
    if (!Number.isFinite(n)) return "-";
    return _intFmt().format(n);
  }

  function formatCleanMaterial(v) { // "12345 Desc" -> "Desc (12345)"
    if (_isEmpty(v)) return "-";
    const s = String(v);
    const match = s.match(/^(\d+)\s+(.+)/);
    if (!match) return s;
    const codigo = match[1];
    const descricao = match[2];
    return `${descricao} (${codigo})`;
  }

  return {
    formatNumberOrDash: formatNumberOrDash,
    formatIntegerOrDash: formatIntegerOrDash,
    formatCleanMaterial: formatCleanMaterial
  };
});
