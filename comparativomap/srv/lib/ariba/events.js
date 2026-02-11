const { destGet } = require("../http/destination");
const { DEST, HTTP_TIMEOUT_MS } = require("../config");

const toArr = (d) => Array.isArray(d?.payload) ? d.payload : Array.isArray(d) ? d : d ? [d] : []; // normaliza retorno (payload/array/item)
const termsFrom = (row) => row?.item?.terms || row?.terms || []; // pega terms tanto do row quanto do row.item
const byFieldId = (row) => Object.fromEntries(termsFrom(row).filter((t) => t?.fieldId).map((t) => [t.fieldId, t])); // indexa terms por fieldId
const moneyObj = (term) => { // extrai {amount,currency} de moneyValue/supplierValue
  const mv = term?.value?.moneyValue || term?.value?.supplierValue;
  return mv ? { amount: mv.amount ?? null, currency: mv.currency ?? null } : { amount: null, currency: null };
};

function addTzColon(s) { // normaliza timezone "-0300" -> "-03:00" pra Date() não pirar
  return typeof s === "string" ? s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2") : s;
}

function parseApiDate(raw) { // parse date string do Ariba (com TZ) -> Date
  if (!raw) return null;
  const norm = addTzColon(String(raw));
  const d = new Date(norm);
  return isNaN(d) ? null : d;
}

function toEdmDateFromApi(raw, tz = "America/Sao_Paulo") { // API date -> "YYYY-MM-DD" (no TZ definido)
  const d = parseApiDate(raw);
  if (!d) return null;
  const y = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric" }).format(d);
  const m = new Intl.DateTimeFormat("en-CA", { timeZone: tz, month: "2-digit" }).format(d);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz, day: "2-digit" }).format(d);
  return `${y}-${m}-${day}`;
}

function formatNiceDate(raw, tz = "America/Sao_Paulo") { // API date -> string pt-BR (pra UI)
  const d = parseApiDate(raw);
  if (!d) return null;
  const date = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(d);
  return `${date} \n ${time}`;
}

function pickSupplierNameFromRows(rows) { // fallback: tenta achar nome do fornecedor em qualquer linha
  if (!Array.isArray(rows)) return null;
  const hit = rows.find((r) => r?.organization?.name || r?.supplier?.name || r?.supplierName || r?.organizationName || r?.supplier?.organizationName);
  return hit?.organization?.name || hit?.supplier?.name || hit?.supplierName || hit?.organizationName || hit?.supplier?.organizationName || null;
}

function pickSupplierNameByInvitation(rows, invId) { // tenta achar nome pelo invitationId específico
  const hit = rows.find((r) => String(r?.invitationId) === String(invId));
  if (!hit) return null;
  return hit?.organization?.name || hit?.supplier?.name || hit?.supplierName || hit?.organizationName || hit?.supplier?.organizationName || null;
}

function extractSapVendorId(obj) { // pega Vendor SAP (domain=sap) do organizationIDs
  const org = obj?.organization ?? obj?.supplier ?? null;
  if (!org) return null;
  const arr = org.organizationIDs || org.organizationIds || obj.organizationIDs || obj.organizationIds || [];
  const hit = Array.isArray(arr) ? arr.find((x) => String(x?.domain).toLowerCase() === "sap") : null;
  return hit?.value ?? org?.erpVendorID ?? null;
}

function extractSapOrgEntry(obj) { // retorna {domain,value} quando domain=sap existir
  const org = obj?.organization ?? obj?.supplier ?? null;
  if (!org) return null;
  const arr = org.organizationIDs || org.organizationIds || obj.organizationIDs || obj.organizationIds || [];
  if (!Array.isArray(arr)) return null;
  const entry = arr.find((x) => String(x?.domain).toLowerCase() === "sap") || null;
  return entry ? { domain: entry.domain, value: entry.value } : null;
}

async function fetchEventItemsTermsMap(docId) { // busca /events/{id}/items e cria map[itemId][fieldId]=term
  const path = `/events/${encodeURIComponent(docId)}/items`;
  const data = await destGet(DEST.EVENTS, path, { params: {}, headers: {}, timeoutMs: HTTP_TIMEOUT_MS });
  const arr = toArr(data);
  const map = {};
  for (const it of arr) {
    const itemObj = it?.item || it;
    const itemId = String(itemObj?.itemId ?? it?.id ?? it?.ItemId ?? "");
    if (!itemId) continue;
    const terms = termsFrom(itemObj);
    map[itemId] = Object.fromEntries(terms.filter((t) => t?.fieldId).map((t) => [t.fieldId, t]));
  }
  return map;
}

function pickSimple(byMap, ...keys) { // pega term.value.simpleValue tentando variações de casing
  for (const k of keys) {
    const t = byMap[k] || byMap[k?.toUpperCase()] || byMap[k?.toLowerCase()];
    const v = t?.value?.simpleValue;
    if (v != null && v !== "") return v;
  }
  return null;
}

const keyOf = (invId, altId, itemId) => `${String(invId)}::${String(altId)}::${String(itemId)}`; // chave do agrupamento (bid)
function hasQty(b) { return !!(b?.QUANTITY?.value?.quantityValue?.amount); } // quick check: tem QUANTITY?
function hasPrice(b) { const mv = b?.PRICE?.value?.moneyValue || b?.PRICE?.value?.supplierValue; return !!(mv?.amount); } // quick check: tem PRICE?

function normCat(v) { // normaliza categoria "service/material" (templates variam)
  const s = String(v ?? "").trim().toLowerCase();
  if (s.startsWith("serv")) return "service";
  if (s.startsWith("mat")) return "material";
  return null;
}

function isRollupExt(byMap) { return !!byMap?.EXTENDEDPRICE?.rollup; } // linha de total/rollup (sem granularidade)
function isInfoTitle(t = "") { // detecta linha “informativa” (contato/total/resumo etc.)
  return /\b(contato|contact|inform[aã]?[cç][oõ]es?\s+adicionais|totais?|total|resumo|summary|informações do fornecedor|informacoes do fornecedor)\b/i.test(t.trim());
}

function hasAnyAmount(v) { return v != null && v !== "" && Number.isFinite(Number(v)); } // valida número “tem valor”
function pickMaterialCodeFromMap(byMap) { // tenta achar código de material por fieldId ou por title
  if (!byMap) return null;
  const direct = byMap["MaterialCode"]?.value?.simpleValue || byMap["MATERIAL"]?.value?.simpleValue || byMap["MaterialNumber"]?.value?.simpleValue || null;
  if (direct) return direct;
  const any = Object.values(byMap);
  const t = any.find((t) => /c[óo]digo.*material/i.test(String(t?.title || "")));
  return t?.value?.simpleValue || null;
}

async function fetchSupplierBids(docId) { // consolida bids por invitationId+alternativeId+itemId e retorna rows+results
  const itemTermsMap = await fetchEventItemsTermsMap(docId); // terms “do item” (além dos terms do bid)

  const path = `/events/${encodeURIComponent(docId)}/supplierBids`;
  const data = await destGet(DEST.EVENTS, path, { params: {}, headers: {}, timeoutMs: HTTP_TIMEOUT_MS });
  const rows = toArr(data);
  if (!rows.length) return { rows: [], results: [] };

  const groups = new Map(); // groupKey -> {invId, rows[], itemIds:Set, cat}
  for (const r of rows) {
    const invId = String(r?.invitationId ?? "");
    const itemId = String(r?.item?.itemId ?? r?.itemId ?? "");
    if (!itemId) continue;
    const altId = String(r?.alternativeId ?? r?.item?.alternativeId ?? "");

    const byIdBid = byFieldId(r); // terms do bid
    const byIdItem = itemTermsMap[String(itemId)] || {}; // terms do item

    const catDecl = normCat(pickSimple(byIdBid, "ItemCategory")) || normCat(pickSimple(byIdItem, "ItemCategory")); // categoria declarada
    const hasQtyLocal = !!(byIdBid?.QUANTITY?.value?.quantityValue?.amount); // nota: variável local (não confundir com helper)
    const hasMat = !!pickMaterialCodeFromMap(byIdBid) || !!pickMaterialCodeFromMap(byIdItem);
    const rollup = isRollupExt(byIdBid);

    let cat = catDecl;
    if (!cat) { // heurística: rollup sem qty/material tende a ser service, senão material
      if (altId && rollup && !hasQtyLocal && !hasMat) cat = "service";
      else cat = "material";
    }

    const groupKey = keyOf(invId, altId, itemId); // agrupa estritamente por itemId também
    console.log(`[DEBUG] Row ItemId: ${itemId} | AltId: ${altId} | GroupKey Gerada: ${groupKey}`);

    let g = groups.get(groupKey);
    if (!g) { g = { invId, rows: [], itemIds: new Set(), cat }; groups.set(groupKey, g); }
    g.rows.push(r);
    g.itemIds.add(itemId);
    if (!g.cat && cat) g.cat = cat;
  }

  const results = [];
  for (const g of groups.values()) {
    let byIdItemMerged = {}; // merge de terms dos itens (caso grupo tenha +1 itemId)
    for (const iid of g.itemIds) {
      const m = itemTermsMap[String(iid)];
      if (m) byIdItemMerged = { ...byIdItemMerged, ...m };
    }

    const rowsInfo = g.rows.map((r) => { // pre-process do grupo pra escolher row preferido
      const bidMap = byFieldId(r);
      return {
        row: r,
        bidMap,
        matFromBid: pickMaterialCodeFromMap(bidMap),
        qty: hasQty(bidMap),
        price: hasPrice(bidMap),
        title: r?.item?.title || "",
      };
    });

    let matRaw = rowsInfo.find((x) => !!x.matFromBid)?.matFromBid || pickMaterialCodeFromMap(byIdItemMerged) || null; // material: bid > item

    const preferred = rowsInfo.find((x) => !!x.matFromBid) || rowsInfo.find((x) => x.qty) || rowsInfo.find((x) => x.price) || rowsInfo[0]; // escolhe row mais “completa”

    let byId = { ...byIdItemMerged }; // merge final: item terms + bid terms (bid sobrescreve)
    for (const ri of rowsInfo) byId = { ...byId, ...ri.bidMap };

    const qv = byId?.QUANTITY?.value?.quantityValue || null;
    const unitMoney = moneyObj(byId["PRICE"]);
    const extMoney = moneyObj(byId["EXTENDEDPRICE"]);

    const unitOfMeasure = qv?.unitOfMeasureCode || byId["UnitOfMeasure"]?.value?.simpleValue || byId["UOM"]?.value?.simpleValue || null;

    const reqDateRaw = byId["REQUESTDELIVERYDATE"]?.value?.dateValue;
    const deliveryEdm = toEdmDateFromApi(reqDateRaw); // "YYYY-MM-DD"
    const deliveryNice = formatNiceDate(reqDateRaw); // string pt-BR

    const lifnrTerm =
      byId["LIFNR"]?.value?.simpleValue ||
      byId["VendorNumber"]?.value?.simpleValue ||
      byId["ERPVendor"]?.value?.simpleValue ||
      byId["ERPVENDOR"]?.value?.simpleValue ||
      byId["VENDOR"]?.value?.simpleValue ||
      byId["GITALIFNR"]?.value?.simpleValue ||
      null;

    const lifnrRaw = lifnrTerm ?? extractSapVendorId(preferred.row) ?? extractSapVendorId(g.rows[0]) ?? null; // vendor: term > orgIDs
    const lifnr10 = lifnrRaw ? String(lifnrRaw).padStart(10, "0") : null; // SAP LIFNR 10 dígitos

    const itemId =
      String(preferred?.row?.item?.itemId ?? preferred?.row?.itemId ?? "") ||
      [...g.itemIds].sort((a, b) => Number(a) - Number(b))[0] ||
      null;

    const title = (preferred?.title || pickSimple(byId, "ItemDescription") || "").trim();
    const catNorm = (g.cat || (pickSimple(byId, "ItemCategory") || "")).toLowerCase();

    const hasMatValue = !!matRaw;
    const hasQtyValue = hasAnyAmount(qv?.amount);
    const hasPriceValue = hasAnyAmount(unitMoney.amount);
    const rollup = isRollupExt(byId);

    const isInfoLike = isInfoTitle(title);
    const unknownCat = !catNorm || (catNorm !== "material" && catNorm !== "service");
    const noData = !hasMatValue && !hasQtyValue && !hasPriceValue;
    const isTotalsRow = rollup && !hasQtyValue && !hasMatValue;

    if ((isInfoLike && noData) || (unknownCat && noData) || isTotalsRow) continue; // descarta linhas “lixo”
    if (!(hasQtyValue && hasPriceValue)) continue; // regra: precisa qty e preço

    const mapped = { // payload final pro backend/UI
      ItemId: itemId,
      itemDescription: preferred.title || pickSimple(byId, "ItemDescription") || null,
      quantity: qv?.amount ?? null,
      unitOfMeasure,
      price: unitMoney.amount,
      currency: unitMoney.currency,
      lifnr: lifnr10,
      MaterialCode: matRaw ?? null,

      ncm: pickSimple(byId, "GITASHORTSTRINGIFZ000050"),
      mva: byId["GITABIGDECIFZ000003"]?.value?.bigDecimalValue ?? null,
      Extrinsic_Aliquota_ICMS: byId["GITABIGDECIFZ000004"]?.value?.bigDecimalValue ?? null,
      Extrinsic_ICMS_Apurado: moneyObj(byId["GITAMONEYIFZ000046"]).amount,
      Extrinsic_Aliquota_IPI: byId["GITABIGDECIFZ000005"]?.value?.bigDecimalValue ?? null,
      Extrinsic_IPI_Apurado: moneyObj(byId["GITAMONEYIFZ000047"]).amount,
      Extrinsic_Aliquota_PIS: byId["GITABIGDECIFZ000029"]?.value?.bigDecimalValue ?? null,
      Extrinsic_PIS_Apurado: moneyObj(byId["GITAMONEYIFZ000048"]).amount,
      Extrinsic_Aliquota_Cofins: byId["GITABIGDECIFZ000028"]?.value?.bigDecimalValue ?? null,
      Extrinsic_Cofins_apurado: moneyObj(byId["GITAMONEYIFZ000049"]).amount,
      Extrinsic_Aliquota_ICMS_Interna: byId["GITABIGDECIFZ000006"]?.value?.bigDecimalValue ?? null,
      Extrinsic_Origem_do_Material: pickSimple(byId, "GITASHORTSTRINGIFZ000153"),

      EXTENDEDPRICE: extMoney.amount,
      CodigoRequisicao: pickSimple(byId, "RequisitionId"),
      PLANT: pickSimple(byId, "Plant"),
      ItemCategory: pickSimple(byId, "ItemCategory"),
      grupo_de_materias: pickSimple(byId, "MaterialGroup"),
      Incoterms: pickSimple(byId, "Incoterms"),
      NumeroItensRequisicao: pickSimple(byId, "RequisitionLineItemNumber"),
      CodigoRFQ: pickSimple(byId, "RFQId"),
      PrazoEntrega: pickSimple(byId, "LEADTIME"),
      DeliveryDateEdm: deliveryEdm,
      DeliveryDateNice: deliveryNice,
      DeliveryDate: deliveryEdm,
      _invitationId: g.invId, // usado depois pra mapear supplierName/email
      _groupItemIds: [...g.itemIds], // debug/auditoria
    };

    results.push(mapped);
  }

  return { rows, results };
}

async function fetchParentProjectId(docId) { // tenta achar parentProjectId via /events/{id}; fallback via /events/identifiers
  const pathEvent = `/events/${encodeURIComponent(docId)}`;
  try {
    const d = await destGet(DEST.EVENTS, pathEvent, { params: {}, headers: {}, timeoutMs: HTTP_TIMEOUT_MS });
    const pid = d?.parentProjectId || d?.projectId || d?.parentProjectUniqueName || null;
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

async function fetchSupplierInvitationsList(docId, round) { // lista convites do round (pra nome/email/vendor sap)
  const path = `/events/${encodeURIComponent(docId)}/rounds/${encodeURIComponent(round)}/supplierInvitations`;
  const data = await destGet(DEST.EVENTS, path, { params: {}, headers: {}, timeoutMs: HTTP_TIMEOUT_MS });
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
