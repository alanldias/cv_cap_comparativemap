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

function toDATS(edm /* "YYYY-MM-DD" */) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(edm)) {
    throw new Error("Edm.Date inválida (YYYY-MM-DD): " + edm);
  }
  return edm.replace(/-/g, ""); // "YYYYMMDD"
}
function todayDATS() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
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

  // Arrays para Itens e as novas CONDIÇÕES (POCOND)
  const poitem = [], poitemx = [];
  const pocond = [], pocondx = []; // <--- Isso faltava no seu código

  itemList.forEach((it, i) => {
    const _po = Number(String(it.poItem ?? "").replace(/\D/g, ""));
    if (!Number.isFinite(_po)) {
      throw new Error(`buildSmokePayload: item sem poItem válido (idx=${i + 1}).`);
    }
    const PO_ITEM = padLeft(String(_po), 5, "0");

    const rec = {
      PO_ITEM,
      PO_PRICE: "1", // Importante ser 1 quando enviamos conditions manuais like PB00                           
      PLANT: it.plant,
      QUANTITY: String(Number(it.quantity ?? 0)),
      PO_UNIT: it.unit,
      ...(it.material
        ? { MATERIAL: padLeft(String(it.material).trim(), 18, "0").slice(-18) }
        : {}),
      ...(it.shortText ? { SHORT_TEXT: String(it.shortText).slice(0, 40) } : {}),
      ...(it.taxCode ? { TAX_CODE: String(it.taxCode).slice(0, 2) } : {}),
      ...(it.netPrice != null ? { NET_PRICE: String(it.netPrice) } : {}),
    };
    poitem.push(rec);
    poitemx.push(markX(rec, { PO_ITEM }));

    // >>> REINSERINDO A LÓGICA DO PB00 (ESSENCIAL PARA O CÁLCULO)
    if (it.netPrice != null) {
      const condRec = {
        PO_ITEM: PO_ITEM,
        COND_TYPE: "PB00", // Código do preço bruto
        COND_VALUE: String(it.netPrice),
        CURRENCY: header.currency || "BRL",
        CHANGE_ID: "I"
      };
      pocond.push(condRec);
      pocondx.push({
        PO_ITEM: PO_ITEM,
        COND_TYPE: "X",
        COND_VALUE: "X",
        CHANGE_ID: "X"
      });
    }
    // <<< FIM LÓGICA PB00
  });

  const today = isoDate(new Date());
  const schedList =
    Array.isArray(schedules) && schedules.length > 0
      ? schedules.map((s, idx) => ({
        PO_ITEM: (() => {
          const _po = Number(String(s.poItem ?? "").replace(/\D/g, ""));
          if (!Number.isFinite(_po)) {
            throw new Error(`buildSmokePayload: schedule sem poItem válido (idx=${idx + 1}).`);
          }
          return padLeft(String(_po), 5, "0");
        })(),
        SCHED_LINE: padLeft(String(s.schedLine ?? 1), 4, "0"),
        DELIV_DATE: s.deliveryDate ? toDATS(String(s.deliveryDate)) : todayDATS(),
        QUANTITY: String(s.quantity ?? "0"),
      }))
      : poitem.map((p) => ({
        PO_ITEM: p.PO_ITEM,
        SCHED_LINE: "0001",
        DELIV_DATE: todayDATS(),
        QUANTITY: p.QUANTITY,
      }));

  const posched = [], poschedx = [];
  schedList.forEach((s) => {
    posched.push(s);
    poschedx.push(markX(s));
  });

  console.log("[buildSmokePayload] CONDITIONS (PB00):", JSON.stringify(pocond, null, 2));

  return {
    TESTRUN: testRun ? "X" : "",
    POHEADER: hdr,
    POHEADERX: hdrX,
    POITEM: { item: poitem },
    POITEMX: { item: poitemx },
    POSCHEDULE: { item: posched },
    POSCHEDULEX: { item: poschedx },
    // >>> Importante: Enviar as condições para o SAP
    POCOND: { item: pocond },
    POCONDX: { item: pocondx }
  };
}

function normalizeItemKey(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  const n = Number(s.replace(/\D/g, ""));
  if (!Number.isFinite(n)) return "";
  return String(n).padStart(5, "0");
}

function normalizeBapiResult(r0, testRunFlag) {
  const toArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  const headerRaw = r0?.EXPHEADER || {};
  const itensRaw = toArray(r0?.POITEM?.item);
  const schedRaw = toArray(r0?.POSCHEDULE?.item);

  // Lê a tabela de condições
  const condRaw = toArray(r0?.POCOND?.item);

  // -----------------------------------------------------------
  // >>> COLOQUE O SEU CÓDIGO DE DEBUG AQUI (ENTRE ESTAS LINHAS)
  // -----------------------------------------------------------
  condRaw.forEach(c => {
    // Filtra apenas o ICM2 para não poluir o log
    if (c.COND_TYPE === 'ICM2') {
        console.log("=== RAIO-X DO ICM2 ===");
        
        // 1. Tenta identificar a Taxa direta
        console.log("Taxa (COND_VALUE):", c.COND_VALUE); 
        
        // 2. Tenta identificar o Montante Total
        console.log("Montante/Valor Calculado:", c.COND_VAL || "N/A"); 
        
        // 3. Tenta identificar a Base
        console.log("Base de Cálculo (COND_BASE):", c.COND_BASE || "N/A");

        // 4. LISTA TUDO
        console.log(">> TODAS AS PROPRIEDADES:", JSON.stringify(c, null, 2));
        
        console.log("======================");
    }
  });
  // -----------------------------------------------------------
  // >>> FIM DO DEBUG
  // -----------------------------------------------------------

  // Log para conferência (pode comentar depois)
  console.log(">>> DEBUG CONDITIONS:", JSON.stringify(
    condRaw
      .filter(c => Number(c.COND_VALUE) !== 0)
      .map(c => ({
        kRaw: c.PO_ITEM || c.ITM_NUMBER,
        k: normalizeItemKey(c.PO_ITEM || c.ITM_NUMBER),
        t: c.COND_TYPE,
        v: c.COND_VALUE
      })),
    null,
    2
  ));

  // Agrupa condições por Item
  const conditionsByItem = condRaw.reduce((acc, c) => {
    const key = normalizeItemKey(c.PO_ITEM || c.ITM_NUMBER);
    if (!key) return acc;

    if (!acc[key]) acc[key] = { icms: 0, ipi: 0 };

    const val = Number(c.COND_VALUE || 0);
    if (!Number.isFinite(val)) return acc;

    const type = (c.COND_TYPE || "").toUpperCase();

    // ICMS
    if ([
      "BICM", "BX13", "ICM1", "ICM2", "ICM3", "ICMS",
      "MWST", "ICOF", "ZCM8", "ZINB", "ZICO", "ZRED", "ZREI"
    ].includes(type)) {
      acc[key].icms += val;
    }

    // IPI
    if ([
      "BIPI", "BX23", "IPI1", "IPI2", "IPIS", "IPI", "ZIPI"
    ].includes(type)) {
      acc[key].ipi += val;
    }

    return acc;
  }, {});

  const schedByItem = schedRaw.reduce((acc, s) => {
    const key = normalizeItemKey(s.PO_ITEM);
    if (!key) return acc;

    (acc[key] ||= []).push({
      schedLine: s.SCHED_LINE,
      deliveryDate: s.DELIV_DATE,
      qty: Number(s.QUANTITY || 0),
    });
    return acc;
  }, {});

  const itens = itensRaw.map((i) => {
    const key = normalizeItemKey(i.PO_ITEM);

    const taxes = conditionsByItem[key] || { icms: 0, ipi: 0 };

    console.log(`[TAX MATCH] Item ${key} -> ICMS: ${taxes.icms} | IPI: ${taxes.ipi}`);

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

      icmsValue: taxes.icms,
      ipiValue: taxes.ipi
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