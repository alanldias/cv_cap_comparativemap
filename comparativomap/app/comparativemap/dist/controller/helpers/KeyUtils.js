sap.ui.define([], function () {
  "use strict";
  function t(t) {
    return String(t || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }
  function n(t, n) {
    const e = String(t || "");
    return e.length >= n ? e : "0".repeat(n - e.length) + e;
  }
  function e(t) {
    const n = String(t || "").replace(/\D/g, "");
    return n ? n.padStart(10, "0") : null;
  }
  function r(t) {
    return String(t?.MaterialCode || t?.materialCode || t?.ItemId || "");
  }
  function o(n) {
    const e = String(n || "");
    const r = e.replace(/\D/g, "");
    const o = r.replace(/^0+/, "");
    return t(o || r || e);
  }
  function i(t) {
    const n = (t || "").toUpperCase();
    const e = {
      UN: "PC",
      PC: "PC",
      PÇ: "PC",
      KG: "KG",
      G: "G",
      L: "L",
      M: "M",
      CX: "CX",
    };
    return e[n] || n.slice(0, 3);
  }
  function a(t) {
    const n = String(t || "")
      .split(/[ -]/)[0]
      .trim();
    return n.slice(0, 4);
  }
  function c(t) {
    const n = (t || "").trim().toUpperCase();
    const e = {
      "": "0",
      STD: "0",
      STANDARD: "0",
      MATERIAL: "0",
      K: "2",
      CONSIGNMENT: "2",
      CONSIGNADO: "2",
      L: "3",
      SUBCONTRACTING: "3",
      SUBCONTRATACAO: "3",
      SUBCONTRATAÇÃO: "3",
      S: "5",
      "THIRD-PARTY": "5",
      "THIRD PARTY": "5",
      TERCEIROS: "5",
      U: "7",
      "STOCK TRANSFER": "7",
      TRANSFERENCIA: "7",
      TRANSFERÊNCIA: "7",
      E: "A",
      "ENHANCED LIMITS": "A",
      LIMITS: "A",
    };
    return e[n] || "0";
  }
  return {
    normKey: t,
    zpad: n,
    pad10: e,
    getItemKey: r,
    matKeyFromBapiMaterial: o,
    mapUoM: i,
    mapPlant: a,
    mapItemCategory: c,
  };
});
//# sourceMappingURL=KeyUtils.js.map
