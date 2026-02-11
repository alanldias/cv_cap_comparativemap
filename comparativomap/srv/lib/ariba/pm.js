const { destGet } = require("../http/destination");
const { DEST, HTTP_TIMEOUT_MS } = require("../config");

const firstToken = (s) => (s || "").trim().split(" ")[0] || null; // pega 1º token (antes do espaço)
const cut = (s, n) => (s || "").substring(0, n) || null; // corta string (evita tamanhos inválidos pro SAP)

async function aribaPmGet(path, params = {}) { // GET no Ariba PM via destination (DEST.PROJECTS)
  return await destGet(DEST.PROJECTS, path, {
    params,
    headers: {},
    timeoutMs: Number(HTTP_TIMEOUT_MS) || 30000,
  });
}

function getCustomField(p, fieldId) { // busca custom field em múltiplos pools (Ariba muda o shape)
  const pools = [
    p?.externalFields,
    p?.sourcingProjectCustomFields,
    p?.projectCustomFields,
    p?.fields,
    p?.customFields,
  ].filter(Boolean);

  for (const arr of pools) {
    const f = (arr || []).find((x) => x.fieldId === fieldId); // fieldId é o identificador “fixo”
    if (!f) continue;

    if (Array.isArray(f.flexMasterDataTypeValue)) return f.flexMasterDataTypeValue[0]; // master data
    if (Array.isArray(f.textValue)) return f.textValue[0]; // texto simples
    if (Array.isArray(f.values) && f.values[0]) return f.values[0].value || f.values[0].name; // lista/lookup
    if ("booleanValue" in f) return String(f.booleanValue); // boolean
    if ("numberValue" in f) return String(f.numberValue); // number
    if ("value" in f) return f.value; // fallback genérico
  }
  return null;
}

function mapAribaHeader(p) { // mapeia payload do PM -> header “SAP-like” pro resto do fluxo
  const bs = p?.businessSystem || {}; // business system contém org/comp/pgrp etc.

  const docCat = bs?.documentCategory?.[0]?.value || bs?.documentCategory?.[0]?.key || null; // doc type / category
  const purOrg = bs?.purchasingOrganization?.[0]?.value || bs?.purchasingOrganization?.[0]?.key || null; // POrg
  const purGrp = bs?.purchasingGroup?.[0]?.value || bs?.purchasingGroup?.[0]?.key || null; // PGrp
  const compCode = bs?.companyCode?.[0]?.value || bs?.companyCode?.[0]?.key || null; // Bukrs

  const inc1 = getCustomField(p, "cus_wsincoterms") || getCustomField(p, "cus_wsIncoterms"); // tolera variação de ID
  const inc2 = getCustomField(p, "cus_wslocal"); // local/incoterms2
  const payt = getCustomField(p, "arb_PaymentTerms"); // payment terms (custom)

  return {
    tipoPedido: docCat,
    purchasingOrganization: cut(firstToken(purOrg), 4), // SAP: 4 chars
    purchasingGroup: cut(firstToken(purGrp), 3), // SAP: 3 chars
    companyCode: cut(firstToken(compCode), 4), // SAP: 4 chars
    incoterms1: inc1,
    incoterms2: inc2,
    paymentTerms: payt || null,
  };
}

async function fetchAribaHeader(projectId) { // carrega project no PM e retorna header mapeado
  const data = await aribaPmGet(`/projects/${encodeURIComponent(projectId)}`);
  return mapAribaHeader(data || {});
}

module.exports = { fetchAribaHeader, mapAribaHeader };
