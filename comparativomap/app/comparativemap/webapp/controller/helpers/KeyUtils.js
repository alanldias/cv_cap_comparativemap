sap.ui.define([], function() {
  "use strict";
  function normKey(s) {
    return String(s || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ").trim().toLowerCase();
  }
  function zpad(val, len) {
    const s = String(val || "");
    return s.length >= len ? s : "0".repeat(len - s.length) + s;
  }
  function pad10(v) {
    const d = String(v || "").replace(/\D/g, "");
    return d ? d.padStart(10, "0") : null;
  }
  function getItemKey(row) {
    return String(row?.MaterialCode || row?.materialCode || row?.ItemId || "");
  }
  function matKeyFromBapiMaterial(mat) {
    const s = String(mat || "");
    const only = s.replace(/\D/g, "");
    const no0 = only.replace(/^0+/, "");
    return normKey(no0 || only || s);
  }
  function mapUoM(u) {
    const x = (u || "").toUpperCase();
    const map = { "UN": "PC", "PC": "PC", "PÇ": "PC", "KG": "KG", "G": "G", "L": "L", "M": "M", "CX": "CX" };
    return map[x] || x.slice(0, 3);
  }
  function mapPlant(p) {
    const code = String(p || "").split(/[ -]/)[0].trim();
    return code.slice(0, 4);
  }
  function mapItemCategory(ext) {
    const x = (ext || "").trim().toUpperCase();
    const dict = {
      "": "0","STD": "0","STANDARD": "0","MATERIAL": "0",
      "K": "2","CONSIGNMENT": "2","CONSIGNADO": "2",
      "L": "3","SUBCONTRACTING": "3","SUBCONTRATACAO": "3","SUBCONTRATAÇÃO": "3",
      "S": "5","THIRD-PARTY": "5","THIRD PARTY": "5","TERCEIROS": "5",
      "U": "7","STOCK TRANSFER": "7","TRANSFERENCIA": "7","TRANSFERÊNCIA": "7",
      "E": "A","ENHANCED LIMITS": "A","LIMITS": "A"
    };
    return dict[x] || "0";
  }
  return { normKey, zpad, pad10, getItemKey, matKeyFromBapiMaterial, mapUoM, mapPlant, mapItemCategory };
});
