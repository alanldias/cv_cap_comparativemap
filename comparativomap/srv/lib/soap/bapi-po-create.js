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
  return edm.replace(/-/g, "");
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

  const poitem = [],
    poitemx = [];
  const pocond = [],
    pocondx = [];

  itemList.forEach((it, i) => {
    const _po = Number(String(it.poItem ?? "").replace(/\D/g, ""));
    if (!Number.isFinite(_po)) {
      throw new Error(
        `buildSmokePayload: item sem poItem válido (idx=${i + 1}).`,
      );
    }
    const PO_ITEM = padLeft(String(_po), 5, "0");

    const rec = {
      PO_ITEM,
      PO_PRICE: "1",
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

    if (it.netPrice != null) {
      const condRec = {
        PO_ITEM: PO_ITEM,
        COND_TYPE: "PB00",
        COND_VALUE: String(it.netPrice),
        CURRENCY: header.currency || "BRL",
        CHANGE_ID: "I",
      };
      pocond.push(condRec);
      pocondx.push({
        PO_ITEM: PO_ITEM,
        COND_TYPE: "X",
        COND_VALUE: "X",
        CHANGE_ID: "X",
      });
    }
  });

  const schedList =
    Array.isArray(schedules) && schedules.length > 0
      ? schedules.map((s, idx) => ({
        PO_ITEM: (() => {
          const _po = Number(String(s.poItem ?? "").replace(/\D/g, ""));
          if (!Number.isFinite(_po)) {
            throw new Error(
              `buildSmokePayload: schedule sem poItem válido (idx=${idx + 1
              }).`,
            );
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

  const posched = [],
    poschedx = [];
  schedList.forEach((s) => {
    posched.push(s);
    poschedx.push(markX(s));
  });

  console.log(
    "[buildSmokePayload] CONDITIONS (PB00):",
    JSON.stringify(pocond, null, 2),
  );

  // ================================================================
  // EXTENSIONIN / EXTENSIONOUT (BAPIPAREX)
  // ================================================================
  const EXT_STRUCTURE = "PO_COND_CUSTOM_EXTENSION";

  const extShellItem = {
    STRUCTURE: EXT_STRUCTURE,
    VALUEPART1: "",
    VALUEPART2: "",
    VALUEPART3: "",
    VALUEPART4: "",
  };

  return {
    TESTRUN: testRun ? "X" : "",
    POHEADER: hdr,
    POHEADERX: hdrX,
    POITEM: { item: poitem },
    POITEMX: { item: poitemx },
    POSCHEDULE: { item: posched },
    POSCHEDULEX: { item: poschedx },
    POCOND: { item: pocond },
    POCONDX: { item: pocondx },
    EXTENSIONIN: { item: [extShellItem] },
    EXTENSIONOUT: { item: [extShellItem] }, // ok manter pra teste
  };
}

function normalizeItemKey(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  const n = Number(s.replace(/\D/g, ""));
  if (!Number.isFinite(n)) return "";
  return String(n).padStart(5, "0");
}

function splitSlashList(s) {
  return String(s ?? "")
    .split("/")
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseSapNumber(raw) {
  if (raw == null) return 0;

  let s = String(raw).trim();
  if (!s) return 0;

  let negative = false;
  if (s.endsWith("-")) {
    negative = true;
    s = s.slice(0, -1).trim();
  }

  s = s.replace(/\s+/g, "");

  if (s.includes(",") && s.includes(".")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (s.includes(",") && !s.includes(".")) {
    s = s.replace(",", ".");
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return negative ? -n : n;
}

// extrai por "grupos" icms + ipi e devolve byIndex
function extractExtTaxes(extensionRaw, expectedItems = 0) {
  const out = {
    global: { icms: 0, ipi: 0 },
    byIndex: [], // [{icms, ipi}, ...] na ordem dos itens
    meta: { groupSize: 0, groupCount: 0, icmsOffset: -1, ipiOffset: -1 },
  };

  const list = Array.isArray(extensionRaw) ? extensionRaw : [];
  const ext = list.find(
    (e) => String(e?.STRUCTURE || "").toUpperCase() === "PO_COND_CUSTOM_EXTENSION",
  );
  if (!ext) return out;

  const names = splitSlashList(ext.VALUEPART1).map((x) => x.toUpperCase());
  const vals = splitSlashList(ext.VALUEPART2).map(parseSapNumber);

  if (!names.length || !vals.length) return out;

  // achar o primeiro ICMS e IPI no header
  const firstICMS = names.indexOf("ICMS");
  const firstIPI = names.indexOf("IPI");

  if (firstICMS < 0 || firstIPI < 0) {
    console.warn("[EXT] Não achei ICMS/IPI em VALUEPART1", { sample: names.slice(0, 12) });
    return out;
  }

  // groupSize = distância entre o primeiro ICMS e o próximo ICMS (repetição por item)
  // Ex: ICMS, IPI, ICMS, IPI => groupSize = 2
  let groupSize = 0;
  for (let i = firstICMS + 1; i < names.length; i++) {
    if (names[i] === "ICMS") {
      groupSize = i - firstICMS;
      break;
    }
  }
  // se só tem 1 grupo (1 item), não tem "próximo ICMS", então assume 2
  if (!groupSize) groupSize = 2;

  // offsets dentro do grupo
  const icmsOffset = firstICMS % groupSize;
  const ipiOffset = firstIPI % groupSize;

  out.meta.groupSize = groupSize;
  out.meta.icmsOffset = icmsOffset;
  out.meta.ipiOffset = ipiOffset;

  const groupCount = Math.min(
    Math.floor(names.length / groupSize),
    Math.floor(vals.length / groupSize),
  );
  out.meta.groupCount = groupCount;

  for (let g = 0; g < groupCount; g++) {
    const base = g * groupSize;
    out.byIndex.push({
      icms: Math.abs(vals[base + icmsOffset] ?? 0),
      ipi: Math.abs(vals[base + ipiOffset] ?? 0),
    });
  }

  out.global = out.byIndex[0] || out.global;

  if (expectedItems && expectedItems !== groupCount) {
    console.warn("[EXT] ALERTA: groups != itensRaw.length", {
      groupCount,
      expectedItems,
      groupSize,
      namesLen: names.length,
      valsLen: vals.length,
    });
  }

  return out;
}

function normalizeBapiResult(r0, testRunFlag) {
  const toArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

  const extNode =
    r0 && r0.EXTENSIONOUT !== undefined
      ? r0.EXTENSIONOUT
      : r0 && r0.EXTENSION_OUT !== undefined
        ? r0.EXTENSION_OUT
        : r0 && r0.ExtensionOut !== undefined
          ? r0.ExtensionOut
          : r0 && r0.extensionout !== undefined
            ? r0.extensionout
            : r0 && r0.extension_out !== undefined
              ? r0.extension_out
              : undefined;

  const extensionRaw = toArray(extNode?.item ?? extNode);

  const rowsCustom = extensionRaw.filter(
    (e) => String(e?.STRUCTURE || "").toUpperCase() === "PO_COND_CUSTOM_EXTENSION",
  );

  console.log("[EXT] total EXTENSIONOUT items =", extensionRaw.length);
  console.log("[EXT] PO_COND_CUSTOM_EXTENSION count =", rowsCustom.length);
  console.log(
    "[EXT] PO_COND_CUSTOM_EXTENSION rows =",
    JSON.stringify(rowsCustom, null, 2),
  );

  // ================================================================
  // resto
  // ================================================================
  const headerRaw = r0?.EXPHEADER || {};
  const itensRaw = toArray(r0?.POITEM?.item);
  const schedRaw = toArray(r0?.POSCHEDULE?.item);
  const condRaw = toArray(r0?.POCOND?.item);
  const taxRaw = toArray(r0?.POTAX?.item || r0?.POITEMTAX?.item);
  const messagesRaw = toArray(r0?.RETURN?.item);

  // ✅ aqui: extrai por índice (na ordem dos itensRaw)
  const ext = extractExtTaxes(extensionRaw, itensRaw.length);

  const taxesFromPotax = taxRaw.reduce((acc, t) => {
    const key = normalizeItemKey(t.PO_ITEM || t.ITEM_NO);
    if (!key) return acc;
    if (!acc[key]) acc[key] = { icms: 0, ipi: 0 };

    const condType = (t.COND_TYPE || t.KSCHL || "").toUpperCase();
    const taxValue = Number(t.TAX_VAL || t.WMWST || 0);

    if (["ICM2", "ICMS", "BICM", "BX13", "MWST", "ZICO"].includes(condType))
      acc[key].icms += taxValue;
    if (["IPI1", "IPI2", "IPIS", "ZIPI", "BX23"].includes(condType))
      acc[key].ipi += taxValue;

    return acc;
  }, {});

  const conditionsByItem = condRaw.reduce((acc, c) => {
    const key = normalizeItemKey(c.PO_ITEM || c.ITM_NUMBER);
    if (!key) return acc;
    if (!acc[key]) acc[key] = { icms: 0, ipi: 0 };

    const type = (c.COND_TYPE || "").toUpperCase();
    const calcType = (c.CALCTYPCON || "").toUpperCase();
    const condValue = Number(c.COND_VALUE || 0);
    const baseValue = Number(c.CONBASEVAL || 0);

    let valorCalculado = 0;
    if (calcType === "A") valorCalculado = (baseValue * condValue) / 100;
    else if (calcType === "B") valorCalculado = condValue;
    else valorCalculado = condValue;

    if (!Number.isFinite(valorCalculado)) return acc;

    if (
      ["BICM", "BX13", "ICMS", "MWST", "ZCM8", "ZINB", "ZICO", "ZRED", "ZREI"].includes(type)
    ) {
      acc[key].icms += valorCalculado;
    }
    if (["BIPI", "BX23", "IPI", "ZIPI"].includes(type)) {
      acc[key].ipi += valorCalculado;
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

  const itens = itensRaw.map((i, idx) => {
    const key = normalizeItemKey(i.PO_ITEM);

    let taxes = { icms: 0, ipi: 0 };
    if (taxRaw.length > 0 && taxesFromPotax[key]) taxes = taxesFromPotax[key];
    else taxes = conditionsByItem[key] || { icms: 0, ipi: 0 };

    // ✅ pega por índice; fallback pro global se faltar
    const extForIdx = ext.byIndex[idx] || ext.global;

    const asNumber = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

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

      icms: asNumber(extForIdx.icms),
      ipi: asNumber(extForIdx.ipi),
    };
  });

  const messages = messagesRaw.map((m) => ({
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

  const poCondCustomExtension = extensionRaw
    .filter((e) => String(e?.STRUCTURE || "").toUpperCase() === "PO_COND_CUSTOM_EXTENSION")
    .map((e) => ({
      STRUCTURE: e?.STRUCTURE ?? null,
      VALUEPART1: e?.VALUEPART1 ?? null,
      VALUEPART2: e?.VALUEPART2 ?? null,
      VALUEPART3: e?.VALUEPART3 ?? null,
      VALUEPART4: e?.VALUEPART4 ?? null,
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

    // útil pra debug (primeiro grupo)
    extTaxes: ext.global,
    extMeta: ext.meta,

    poCondCustomExtension,
  };
}

module.exports = {
  getBapiClient,
  buildSmokePayload,
  normalizeBapiResult,
  padLeft,
};
