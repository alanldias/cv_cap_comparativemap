const { getSoapService } = require("../../soap-destination");
const { SOAP } = require("../config");
const { dbg } = require("../util/log");

function padLeft(str, len, ch = "0") {
  str = String(str ?? "");
  return str.length >= len ? str : ch.repeat(len - str.length) + str;
}
function isoDate(d) {
  const y = d.getFullYear(),
    m = String(d.getMonth() + 1).padStart(2, "0"),
    day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function markX(obj, extra = {}) {
  const x = { ...extra };
  for (const [k, v] of Object.entries(obj)) {
    if (k === "PO_ITEM" || k === "SCHED_LINE") {
      x[k] = obj[k];
      continue;
    }
    if (v !== undefined && v !== null && String(v) !== "") x[k] = "X";
  }
  return x;
}

async function getBapiClient() {
  const endpoint = { url: null };
  dbg("[getBapiClient] WSDL_PATH (resolved) =", SOAP.WSDL_PATH);
  const client = await getSoapService(
    "BAPI_PO_CREATE",
    SOAP.WSDL_PATH,
    endpoint,
    "POST",
  );
  if (typeof client.BAPI_PO_CREATE1Async !== "function") {
    throw new Error(
      "Método SOAP BAPI_PO_CREATE1Async indisponível no port/endereço atual.",
    );
  }
  return client;
}

function buildSmokePayload(header, items, schedules, testRun) {
  const hdr = {
    DOC_TYPE: header.docType || "NB",
    COMP_CODE: header.compCode || "1000",
    PURCH_ORG: header.purchOrg || "1000",
    PUR_GROUP: header.purchGroup || "001",
    VENDOR: padLeft(String(header.vendor || "123456"), 10, "0"),
    CURRENCY: header.currency || "BRL",
    ...(header.incoterms1 ? { INCOTERMS1: header.incoterms1 } : {}),
    ...(header.incoterms2 ? { INCOTERMS2: header.incoterms2 } : {}),
  };
  const hdrX = markX(hdr);

  const itemList =
    Array.isArray(items) && items.length > 0
      ? items
      : [
        {
          poItem: 10,
          plant: "BR01",
          shortText: "Teste chamada BAPI",
          quantity: 1,
          unit: "PC",
          taxCode: "I1",
        },
      ];

  const poitem = [],
    poitemx = [];

  // ==================== INÍCIO DA MUDANÇA ====================
  console.log(`[buildSmokePayload] Montando payload para ${itemList.length} itens do chunk.`);
  itemList.forEach((it, i) => {
    const poItemValue = it.poItem ?? (i + 1) * 10; // 👈 front tem prioridade
    const PO_ITEM = padLeft(String(poItemValue), 5, "0");

    const rec = {
      PO_ITEM, // Usando o valor correto!
      PLANT: it.plant,
      QUANTITY: String(it.quantity),
      PO_UNIT: it.unit,
      ...(it.material
        ? { MATERIAL: padLeft(String(it.material).trim(), 18, "0") }
        : {}),
      ...(it.shortText
        ? { SHORT_TEXT: String(it.shortText).slice(0, 40) }
        : {}),
      ...(it.taxCode ? { TAX_CODE: String(it.taxCode).slice(0, 2) } : {}),
      ...(it.netPrice != null ? { NET_PRICE: String(it.netPrice) } : {}),
    };
    poitem.push(rec);
    poitemx.push(markX(rec, { PO_ITEM }));
  });

  const today = isoDate(new Date());

  // A lógica das schedules também deve respeitar o poItem que veio do frontend
  const schedList =
    Array.isArray(schedules) && schedules.length > 0
      ? schedules.map((s, idx) => ({
        // Usamos o s.poItem que já veio no payload de schedules
        PO_ITEM: padLeft(String(s.poItem ?? (idx + 1) * 10), 5, "0"),
        SCHED_LINE: padLeft(String(s.schedLine ?? 1), 4, "0"),
        DELIVERY_DATE: s.deliveryDate
          ? isoDate(new Date(s.deliveryDate))
          : today,
        QUANTITY: String(s.quantity ?? "0"),
      }))
      : poitem.map((p) => ({
        PO_ITEM: p.PO_ITEM, // O fallback agora usa o poItem correto que acabamos de definir
        SCHED_LINE: "0001",
        DELIVERY_DATE: today,
        QUANTITY: p.QUANTITY,
      }));
  // ===================== FIM DA MUDANÇA ======================

  const posched = [],
    poschedx = [];
  schedList.forEach((s) => {
    posched.push(s);
    poschedx.push(markX(s));
  });

  return {
    TESTRUN: testRun ? "X" : "",
    POHEADER: hdr,
    POHEADERX: hdrX,
    POITEM: { item: poitem },
    POITEMX: { item: poitemx },
    POSCHEDULE: { item: posched },
    POSCHEDULEX: { item: poschedx },
  };
}

function normalizeBapiResult(r0, testRunFlag) {
  const toArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  const headerRaw = r0?.EXPHEADER || {};
  const itensRaw = toArray(r0?.POITEM?.item);
  const schedRaw = toArray(r0?.POSCHEDULE?.item);

  const schedByItem = schedRaw.reduce((acc, s) => {
    const key = String(s.PO_ITEM || "").padStart(5, "0");
    (acc[key] ||= []).push({
      schedLine: s.SCHED_LINE,
      deliveryDate: s.DELIVERY_DATE,
      qty: Number(s.QUANTITY || 0),
    });
    return acc;
  }, {});

  const itens = itensRaw.map((i) => {
    const key = String(i.PO_ITEM || "").padStart(5, "0");
    return {
      poItem: key,
      material: i.MATERIAL_LONG || i.MATERIAL,
      descricao: i.SHORT_TEXT,
      quantidade: Number(i.QUANTITY || 0),
      unidade: i.PO_UNIT,
      netPrice: Number(i.NET_PRICE || 0),
      priceUnit: Number(i.PRICE_UNIT || 1),
      taxCode: i.TAX_CODE,
      taxJurCode: i.TAXJURCODE,
      ncm: i.BRAS_NBM,
      priceDate: i.PRICE_DATE,
      schedules: schedByItem[key] || [],
    };
  });

  const messages = toArray(r0?.RETURN?.item).map((m) => ({
    type: m.TYPE,
    id: m.ID,
    number: m.NUMBER,
    message: m.MESSAGE,
    logNo: m.LOG_NO,
    v1: m.MESSAGE_V1,
    v2: m.MESSAGE_V2,
    v3: m.MESSAGE_V3,
    v4: m.MESSAGE_V4,
  }));

  return {
    testRun: !!testRunFlag,
    header: {
      empresa: headerRaw.COMP_CODE,
      orgCompras: headerRaw.PURCH_ORG,
      grupoCompras: headerRaw.PUR_GROUP,
      fornecedor: headerRaw.VENDOR,
      moeda: headerRaw.CURRENCY,
      incoterms1: headerRaw.INCOTERMS1,
      incoterms2: headerRaw.INCOTERMS2,
      criadoEm: headerRaw.CREAT_DATE,
      criadoPor: headerRaw.CREATED_BY,
      poNumber: headerRaw.PO_NUMBER || "",
    },
    itens,
    returnMessages: messages,
    mensagens: messages,
  };
}

module.exports = {
  getBapiClient,
  buildSmokePayload,
  normalizeBapiResult,
  padLeft,
};
