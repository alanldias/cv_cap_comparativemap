const _escapeOData = (v = "") => String(v).replace(/'/g, "''").trim();
const _makeKey = (Supplier, Material, PurchasingOrganization, Plant) =>
  [Supplier, Material, PurchasingOrganization, Plant]
    .map((v) => (v ?? "").trim())
    .join("|");

module.exports = { _escapeOData, _makeKey };
