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

function addTzColon(s) {
  return typeof s === "string"
    ? s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")
    : s;
}

function parseApiDate(raw) {
  if (!raw) return null;
  const norm = addTzColon(String(raw));
  const d = new Date(norm);
  return isNaN(d) ? null : d;
}

// *** NOVO: formato técnico para BAPI/UI: "YYYY-MM-DD" ***
function toEdmDateFromApi(raw, tz = "America/Sao_Paulo") {
  const d = parseApiDate(raw);
  if (!d) return null;
  // Extrai a data no fuso desejado, sem ambiguidade (yyyy-mm-dd):
  const y = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric" }).format(d);
  const m = new Intl.DateTimeFormat("en-CA", { timeZone: tz, month: "2-digit" }).format(d);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz, day: "2-digit" }).format(d);
  return `${y}-${m}-${day}`;
}

// (opcional) string "bonita" para exibição
function formatNiceDate(raw, tz = "America/Sao_Paulo") {
  const d = parseApiDate(raw);
  if (!d) return null;
  const date = new Intl.DateTimeFormat("pt-BR", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(d);
  const time = new Intl.DateTimeFormat("pt-BR", {
    timeZone: tz, hour: "2-digit", minute: "2-digit"
  }).format(d);
  return `${date} \n ${time}`;
}

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

async function fetchEventItemsTermsMap(docId) {
  const path = `/events/${encodeURIComponent(docId)}/items`;
  const data = await destGet(DEST.EVENTS, path, {
    params: {}, headers: {}, timeoutMs: HTTP_TIMEOUT_MS,
  });
  const arr = toArr(data);
  const map = {};
  for (const it of arr) {
    const itemObj = it?.item || it;
    const itemId = String(itemObj?.itemId ?? it?.id ?? it?.ItemId ?? "");
    if (!itemId) continue;
    const terms = termsFrom(itemObj);
    map[itemId] = Object.fromEntries(
      terms.filter(t => t?.fieldId).map(t => [t.fieldId, t]),
    );
  }
  return map;
}

function pickSimple(byMap, ...keys) {
  for (const k of keys) {
    const t = byMap[k] || byMap[k?.toUpperCase()] || byMap[k?.toLowerCase()];
    const v = t?.value?.simpleValue;
    if (v != null && v !== "") return v;
  }
  return null;
}

const keyOf = (invId, altId, itemId) => `${String(invId)}::${String(altId || itemId)}`;
function hasQty(b) {
  return !!(b?.QUANTITY?.value?.quantityValue?.amount);
}
function hasPrice(b) {
  const mv = b?.PRICE?.value?.moneyValue || b?.PRICE?.value?.supplierValue;
  return !!(mv?.amount);
}

function normCat(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (s.startsWith("serv")) return "service";
  if (s.startsWith("mat")) return "material";
  return null;
}
function isRollupExt(byMap) {
  return !!byMap?.EXTENDEDPRICE?.rollup;
}
function isInfoTitle(t = "") {
  return /\b(contato|contact|inform[aã]?[cç][oõ]es?\s+adicionais|totais?|total|resumo|summary|informações do fornecedor|informacoes do fornecedor)\b/i.test(t.trim());
}
function hasAnyAmount(v) {
  return v != null && v !== "" && Number.isFinite(Number(v));
}
function isRollupExt(byMap) {
  return !!byMap?.EXTENDEDPRICE?.rollup;
}

function pickMaterialCodeFromMap(byMap) {
  if (!byMap) return null;
  const direct =
    byMap["MaterialCode"]?.value?.simpleValue ||
    byMap["MATERIAL"]?.value?.simpleValue ||
    byMap["MaterialNumber"]?.value?.simpleValue || null;
  if (direct) return direct;
  // fallback por título (templates variam)
  const any = Object.values(byMap);
  const t = any.find(t => /c[óo]digo.*material/i.test(String(t?.title || "")));
  return t?.value?.simpleValue || null;
}

async function fetchSupplierBids(docId) {
  const itemTermsMap = await fetchEventItemsTermsMap(docId);

  const path = `/events/${encodeURIComponent(docId)}/supplierBids`;
  const data = await destGet(DEST.EVENTS, path, { params: {}, headers: {}, timeoutMs: HTTP_TIMEOUT_MS });
  const rows = toArr(data);
  if (!rows.length) return { rows: [], results: [] };

  // --- 1) Agrupa linhas (pai + sub-linhas) por invitationId + alternativeId ---
  const groups = new Map();
  for (const r of rows) {
    const invId = String(r?.invitationId ?? "");
    const itemId = String(r?.item?.itemId ?? r?.itemId ?? "");
    if (!itemId) continue;
    const altId = String(r?.alternativeId ?? r?.item?.alternativeId ?? "");

    // maps para decidir a categoria
    const byIdBid = byFieldId(r);
    const byIdItem = itemTermsMap[String(itemId)] || {};

    // 1) tenta pegar categoria explícita dos termos
    const catDecl =
      normCat(pickSimple(byIdBid, "ItemCategory")) ||
      normCat(pickSimple(byIdItem, "ItemCategory"));

    // 2) heurística: se não declarado, infere por comportamento típico de "service"
    const hasQty = !!(byIdBid?.QUANTITY?.value?.quantityValue?.amount);
    const hasMat = !!pickMaterialCodeFromMap(byIdBid) || !!pickMaterialCodeFromMap(byIdItem);
    const rollup = isRollupExt(byIdBid);

    let cat = catDecl;
    if (!cat) {
      if (altId && rollup && !hasQty && !hasMat) cat = "service";
      else cat = "material";
    }

    // 3) chave do grupo dependendo da categoria
    // - material => ignora alternativeId (um grupo por itemId)
    // - service  => usa alternativeId para colapsar pai + sublinhas
    const groupKey = cat === "service"
      ? keyOf(invId, altId, itemId)
      : keyOf(invId, "", itemId); // força ignorar altId

    let g = groups.get(groupKey);
    if (!g) {
      g = { invId, rows: [], itemIds: new Set(), cat };
      groups.set(groupKey, g);
    }
    g.rows.push(r);
    g.itemIds.add(itemId);
    // guarda a categoria "mais forte" do grupo (se aparecer)
    if (!g.cat && cat) g.cat = cat;
  }

  // --- 2) Consolida por grupo, fazendo merge dos terms do(s) item(ns) + dos bids ---
  const results = [];
  for (const g of groups.values()) {
    // 1) junte os terms dos itens (pai + sub) no grupo
    let byIdItemMerged = {};
    for (const iid of g.itemIds) {
      const m = itemTermsMap[String(iid)];
      if (m) byIdItemMerged = { ...byIdItemMerged, ...m };
    }

    // 2) prepare info dos rows do grupo
    const rowsInfo = g.rows.map(r => {
      const bidMap = byFieldId(r);
      return {
        row: r,
        bidMap,
        matFromBid: pickMaterialCodeFromMap(bidMap),
        qty: hasQty(bidMap),
        price: hasPrice(bidMap),
        title: r?.item?.title || ""
      };
    });

    // 3) material code: tente primeiro no BID; se não, nos ITEM TERMS
    let matRaw =
      rowsInfo.find(x => !!x.matFromBid)?.matFromBid ||
      pickMaterialCodeFromMap(byIdItemMerged) || null;

    // 4) escolha o "row preferido" para title/descrição
    const preferred =
      rowsInfo.find(x => !!x.matFromBid) ||
      rowsInfo.find(x => x.qty) ||
      rowsInfo.find(x => x.price) ||
      rowsInfo[0]; // fallback

    // 5) quantity/UoM/price do merge completo (itens + bids)
    let byId = { ...byIdItemMerged };
    for (const ri of rowsInfo) byId = { ...byId, ...ri.bidMap };

    const qv = byId?.QUANTITY?.value?.quantityValue || null;
    const unitMoney = moneyObj(byId["PRICE"]);
    const extMoney = moneyObj(byId["EXTENDEDPRICE"]);

    const unitOfMeasure =
      qv?.unitOfMeasureCode ||
      byId["UnitOfMeasure"]?.value?.simpleValue ||
      byId["UOM"]?.value?.simpleValue ||
      null;

    const reqDateRaw = byId["REQUESTDELIVERYDATE"]?.value?.dateValue;
    const deliveryEdm = toEdmDateFromApi(reqDateRaw);
    const deliveryNice = formatNiceDate(reqDateRaw);

    const lifnrTerm =
      byId["LIFNR"]?.value?.simpleValue ||
      byId["VendorNumber"]?.value?.simpleValue ||
      byId["ERPVendor"]?.value?.simpleValue ||
      byId["ERPVENDOR"]?.value?.simpleValue ||
      byId["VENDOR"]?.value?.simpleValue ||
      byId["GITALIFNR"]?.value?.simpleValue ||
      null;

    const lifnrRaw =
      lifnrTerm ??
      extractSapVendorId(preferred.row) ??
      extractSapVendorId(g.rows[0]) ??
      null;

    const lifnr10 = lifnrRaw ? String(lifnrRaw).padStart(10, "0") : null;

    // ItemId representativo = do row preferido (não o menor)
    const itemId =
      String(preferred?.row?.item?.itemId ?? preferred?.row?.itemId ?? "") ||
      [...g.itemIds].sort((a, b) => Number(a) - Number(b))[0] || null;

    const title = (preferred?.title || pickSimple(byId, "ItemDescription") || "").trim();
    const catNorm = (g.cat || (pickSimple(byId, "ItemCategory") || "")).toLowerCase();

    const hasMat = !!matRaw;
    const hasQtyValue = hasAnyAmount(qv?.amount);
    const hasPriceValue = hasAnyAmount(unitMoney.amount);
    const rollup = isRollupExt(byId);

    const isInfoLike = isInfoTitle(title);
    const unknownCat = !catNorm || (catNorm !== "material" && catNorm !== "service");
    const noData = !hasMat && !hasQtyValue && !hasPriceValue;
    const isTotalsRow = rollup && !hasQtyValue && !hasMat;

    // 1) joga fora linhas claramente informativas/totais sem dados
    if ((isInfoLike && noData) || (unknownCat && noData) || isTotalsRow) {
      continue;
    }

    // 2) regra decisiva de "item válido": precisa ter QUANTIDADE E PREÇO (>0)
    if (!(hasQtyValue && hasPriceValue)) {
      // opcional: se quiser só exigir no service, troque por:
      // if (catNorm === 'service' && !(hasQtyValue && hasPriceValue)) { continue; }
      continue;
    }

    const mapped = {
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
      _invitationId: g.invId,
      _groupItemIds: [...g.itemIds],
    };

    results.push(mapped);
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
  } catch { }
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
