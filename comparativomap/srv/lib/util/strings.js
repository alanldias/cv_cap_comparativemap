const _escapeOData = (v = "") => String(v).replace(/'/g, "''").trim(); // escape simples p/ strings em OData
const _makeKey = (Supplier, Material, PurchasingOrganization, Plant) => // chave estável p/ dedup/cache
  [Supplier, Material, PurchasingOrganization, Plant].map(v => (v ?? "").trim()).join("|");

module.exports = { _escapeOData, _makeKey };
