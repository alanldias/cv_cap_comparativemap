const { destGet } = require("../http/destination");
const { DEST, HTTP_TIMEOUT_MS } = require("../config");

// utils locais
const toArr = (d) =>
  Array.isArray(d?.payload) ? d.payload : Array.isArray(d) ? d : d ? [d] : [];
const termsFrom = (row) => row?.item?.terms || row?.terms || [];
const byFieldId = (row) =>
  Object.fromEntries(
    termsFrom(row)
      .filter((t) => t?.fieldId)
      .map((t) => [t.fieldId, t]),
  );
const moneyObj = (term) => {
  const mv = term?.value?.moneyValue || term?.value?.supplierValue;
  return mv
    ? { amount: mv.amount ?? null, currency: mv.currency ?? null }
    : { amount: null, currency: null };
};

function pickSupplierNameFromRows(rows) {
  if (!Array.isArray(rows)) return null;
  const hit = rows.find(
    (r) =>
      r?.organization?.name ||
      r?.supplier?.name ||
      r?.supplierName ||
      r?.organizationName ||
      r?.supplier?.organizationName,
  );
  return (
    hit?.organization?.name ||
    hit?.supplier?.name ||
    hit?.supplierName ||
    hit?.organizationName ||
    hit?.supplier?.organizationName ||
    null
  );
}
function pickSupplierNameByInvitation(rows, invId) {
  const hit = rows.find((r) => String(r?.invitationId) === String(invId));
  if (!hit) return null;
  return (
    hit?.organization?.name ||
    hit?.supplier?.name ||
    hit?.supplierName ||
    hit?.organizationName ||
    hit?.supplier?.organizationName ||
    null
  );
}
function extractSapVendorId(obj) {
  const org = obj?.organization ?? obj?.supplier ?? null;
  if (!org) return null;
  const arr =
    org.organizationIDs ||
    org.organizationIds ||
    obj.organizationIDs ||
    obj.organizationIds ||
    [];
  const hit = Array.isArray(arr)
    ? arr.find((x) => String(x?.domain).toLowerCase() === "sap")
    : null;
  return hit?.value ?? org?.erpVendorID ?? null;
}
function extractSapOrgEntry(obj) {
  const org = obj?.organization ?? obj?.supplier ?? null;
  if (!org) return null;
  const arr =
    org.organizationIDs ||
    org.organizationIds ||
    obj.organizationIDs ||
    obj.organizationIds ||
    [];
  if (!Array.isArray(arr)) return null;
  const entry =
    arr.find((x) => String(x?.domain).toLowerCase() === "sap") || null;
  return entry ? { domain: entry.domain, value: entry.value } : null;
}

async function fetchSupplierBids(docId) {
  const path = `/events/${encodeURIComponent(docId)}/supplierBids`;
  const data = await destGet(DEST.EVENTS, path, {
    params: {},
    headers: {},
    timeoutMs: HTTP_TIMEOUT_MS,
  });
  const rows = toArr(data);
  if (!rows.length) return { rows: [], results: [] };

  const results = [];
  for (const row of rows) {
    const invId = row?.invitationId ?? null;
    const itemIds = Array.isArray(row?.itemsWithBid)
      ? row.itemsWithBid.map(String)
      : [];
    if (!itemIds.length) continue;

    for (const itemId of itemIds) {
      let targetRow =
        rows.find(
          (r) =>
            String(r?.item?.itemId ?? r?.itemId) === String(itemId) &&
            String(r?.invitationId) === String(invId),
        ) ||
        rows.find(
          (r) => String(r?.item?.itemId ?? r?.itemId) === String(itemId),
        );
      if (!targetRow) continue;

      const byId = byFieldId(targetRow);
      const lifnrTerm =
        byId["LIFNR"]?.value?.simpleValue ||
        byId["VendorNumber"]?.value?.simpleValue ||
        byId["ERPVendor"]?.value?.simpleValue ||
        byId["ERPVENDOR"]?.value?.simpleValue ||
        byId["VENDOR"]?.value?.simpleValue ||
        byId["GITALIFNR"]?.value?.simpleValue ||
        null;

      const unit = moneyObj(byId["PRICE"]);
      const qv = byId["QUANTITY"]?.value?.quantityValue;
      const ext = moneyObj(byId["EXTENDEDPRICE"]);

      const mapped = {
        ItemId: itemId,
        itemDescription: targetRow?.item?.title ?? null,
        quantity: qv?.amount ?? null,
        unitOfMeasure: qv?.unitOfMeasureCode ?? null,
        price: unit.amount,
        currency: unit.currency,
        lifnr: lifnrTerm ? String(lifnrTerm).padStart(10, "0") : null,
        ncm: byId["GITASHORTSTRINGIFZ000050"]?.value?.simpleValue ?? null,
        mva: byId["GITABIGDECIFZ000003"]?.value?.bigDecimalValue ?? null,
        Extrinsic_Aliquota_ICMS:
          byId["GITABIGDECIFZ000004"]?.value?.bigDecimalValue ?? null,
        Extrinsic_ICMS_Apurado: moneyObj(byId["GITAMONEYIFZ000046"]).amount,
        Extrinsic_Aliquota_IPI:
          byId["GITABIGDECIFZ000005"]?.value?.bigDecimalValue ?? null,
        Extrinsic_IPI_Apurado: moneyObj(byId["GITAMONEYIFZ000047"]).amount,
        Extrinsic_Aliquota_PIS:
          byId["GITABIGDECIFZ000029"]?.value?.bigDecimalValue ?? null,
        Extrinsic_PIS_Apurado: moneyObj(byId["GITAMONEYIFZ000048"]).amount,
        Extrinsic_Aliquota_Cofins:
          byId["GITABIGDECIFZ000028"]?.value?.bigDecimalValue ?? null,
        Extrinsic_Cofins_apurado: moneyObj(byId["GITAMONEYIFZ000049"]).amount,
        Extrinsic_Aliquota_ICMS_Interna:
          byId["GITABIGDECIFZ000006"]?.value?.bigDecimalValue ?? null,
        Extrinsic_Origem_do_Material:
          byId["GITASHORTSTRINGIFZ000153"]?.value?.simpleValue ?? null,
        EXTENDEDPRICE: ext.amount,
        CodigoRequisicao: byId["RequisitionId"]?.value?.simpleValue ?? null,
        PLANT: byId["Plant"]?.value?.simpleValue ?? null,
        ItemCategory: byId["ItemCategory"]?.value?.simpleValue ?? null,
        MaterialCode: byId["MaterialCode"]?.value?.simpleValue ?? null,
        grupo_de_materias: byId["MaterialGroup"]?.value?.simpleValue ?? null,
        Incoterms: byId["Incoterms"]?.value.simpleValue ?? null,
        DELIVERY_DATE_RAW:
          byId["REQUESTDELIVERYDATE"]?.value ??
          byId["REQUESTDELIVERYDATE"] ??
          null,
      };
      results.push({ ...mapped, _invitationId: invId, _itemId: itemId });
    }
  }
  return { rows, results };
}

async function fetchParentProjectId(docId) {
  const pathEvent = `/events/${encodeURIComponent(docId)}`;
  try {
    const d = await destGet(DEST.EVENTS, pathEvent, {
      params: {},
      headers: {},
      timeoutMs: HTTP_TIMEOUT_MS,
    });
    const pid =
      d?.parentProjectId || d?.projectId || d?.parentProjectUniqueName || null;
    if (pid) return pid;
  } catch {}
  const pathIds = `/events/identifiers`;
  const data = await destGet(DEST.EVENTS, pathIds, {
    params: { $filter: `(internalId eq ${encodeURIComponent(docId)})` },
    headers: {},
    timeoutMs: HTTP_TIMEOUT_MS,
  });
  const arr = toArr(data);
  const hit = arr.find((x) => String(x?.internalId) === String(docId));
  return hit?.parentProjectId ?? null;
}

async function fetchSupplierInvitationsList(docId, round) {
  const path = `/events/${encodeURIComponent(docId)}/rounds/${encodeURIComponent(round)}/supplierInvitations`;
  const data = await destGet(DEST.EVENTS, path, {
    params: {},
    headers: {},
    timeoutMs: HTTP_TIMEOUT_MS,
  });
  return toArr(data);
}

module.exports = {
  fetchSupplierBids,
  fetchParentProjectId,
  fetchSupplierInvitationsList,
  pickSupplierNameFromRows,
  pickSupplierNameByInvitation,
  extractSapVendorId,
  extractSapOrgEntry,
};
