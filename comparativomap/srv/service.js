// srv/service.js
require('dotenv').config();
const cds = require('@sap/cds');
const axios = require('axios');
const { getAccessToken } = require('./auth/aribaOauth'); // ajuste se necessário

// ENV
const {
  ARIBA_BASE_URL_EVENTS,
  ARIBA_REALM,
  ARIBA_USER,
  ARIBA_PASSWORD_ADAPTER,
  ARIBA_API_KEY_EVENTS,
  HTTP_TIMEOUT_MS
} = process.env;

// ----------------- HELPERS -----------------
const toArr = (d) =>
  Array.isArray(d?.payload) ? d.payload :
  Array.isArray(d) ? d :
  (d ? [d] : []);

const termsFrom = (row) => (row?.item?.terms || row?.terms || []);
const byFieldId = (row) =>
  Object.fromEntries(termsFrom(row).filter(t => t?.fieldId).map(t => [t.fieldId, t]));

const moneyObj = (term) => {
  const mv = term?.value?.moneyValue || term?.value?.supplierValue;
  return mv ? { amount: mv.amount ?? null, currency: mv.currency ?? null } : { amount: null, currency: null };
};

const firstToken = (s) => (s || '').trim().split(' ')[0] || null;
const cut = (s, n) => (s || '').substring(0, n) || null;

function getCustomField(p, fieldId) {
  const pools = [
    p?.externalFields,
    p?.sourcingProjectCustomFields,
    p?.projectCustomFields,
    p?.fields,
    p?.customFields
  ].filter(Boolean);

  for (const arr of pools) {
    const f = (arr || []).find(x => x.fieldId === fieldId);
    if (!f) continue;
    if (Array.isArray(f.flexMasterDataTypeValue)) return f.flexMasterDataTypeValue[0];
    if (Array.isArray(f.textValue)) return f.textValue[0];
    if (Array.isArray(f.values) && f.values[0]) return f.values[0].value || f.values[0].name;
    if ('booleanValue' in f) return String(f.booleanValue);
    if ('numberValue' in f) return String(f.numberValue);
    if ('value' in f) return f.value;
  }
  return null;
}

function mapAribaHeader(p) {
  const bs = p?.businessSystem || {};
  const docCat   = bs?.documentCategory?.[0]?.value || bs?.documentCategory?.[0]?.key || null;
  const purOrg   = bs?.purchasingOrganization?.[0]?.value || bs?.purchasingOrganization?.[0]?.key || null;
  const purGrp   = bs?.purchasingGroup?.[0]?.value || bs?.purchasingGroup?.[0]?.key || null;
  const compCode = bs?.companyCode?.[0]?.value || bs?.companyCode?.[0]?.key || null;

  const inc1 = getCustomField(p, 'cus_wsincoterms') || getCustomField(p, 'cus_wsIncoterms');
  const inc2 = getCustomField(p, 'cus_wslocal');
  const payt = getCustomField(p, 'arb_PaymentTerms');

  return {
    tipoPedido: docCat,
    purchasingOrganization: cut(firstToken(purOrg), 4),
    purchasingGroup:        cut(firstToken(purGrp), 3),
    companyCode:            cut(firstToken(compCode), 4),
    incoterms1: inc1,
    incoterms2: inc2,
    paymentTerms: payt || null
  };
}

// ----------------- ARIBA API HELPERS -----------------

// fetchSupplierBids: busca supplierBids e normaliza o "item alvo" (o mesmo comportamento de antes)
async function fetchSupplierBids(docId, headersCommon) {
  const urlBids = `${ARIBA_BASE_URL_EVENTS}/events/${encodeURIComponent(docId)}/supplierBids`;

  const { data } = await axios.get(urlBids, {
    params: {
      realm: ARIBA_REALM,
      user: ARIBA_USER,
      passwordAdapter: ARIBA_PASSWORD_ADAPTER
    },
    headers: headersCommon,
    timeout: Number(HTTP_TIMEOUT_MS) || 30000
  });

  const rows = toArr(data);
  if (!rows.length) return { rows: [], result: null };

  const itemsWithBid = [...new Set(rows.flatMap(r => Array.isArray(r?.itemsWithBid) ? r.itemsWithBid : []))].map(String);

  const chosenItemId =
    itemsWithBid[0] ||
    (rows.find(r => r?.bidRank === 1)?.item?.itemId ?? rows.find(r => r?.bidRank === 1)?.itemId) ||
    (rows[0]?.item?.itemId ?? rows[0]?.itemId);

  if (!chosenItemId) return { rows, result: null };

  const targetRow = rows.find(r => String(r?.item?.itemId ?? r?.itemId) === String(chosenItemId));
  if (!targetRow) return { rows, result: null };

  const byId = byFieldId(targetRow);

  const unit = moneyObj(byId['PRICE']);
  const qv = byId['QUANTITY']?.value?.quantityValue;
  const ext = moneyObj(byId['EXTENDEDPRICE']);

  const ncm = byId['GITASHORTSTRINGIFZ000050']?.value?.simpleValue ?? null;
  const mva = byId['GITABIGDECIFZ000003']?.value?.bigDecimalValue ?? null;

  const aliquotaICMS = byId['GITABIGDECIFZ000004']?.value?.bigDecimalValue ?? null;
  const icmsApuradoAmount = moneyObj(byId['GITAMONEYIFZ000046']).amount;
  const aliquotaIPI = byId['GITABIGDECIFZ000005']?.value?.bigDecimalValue ?? null;
  const ipiApuradoAmount = moneyObj(byId['GITAMONEYIFZ000047']).amount;
  const aliquotaPIS = byId['GITABIGDECIFZ000029']?.value?.bigDecimalValue ?? null;
  const pisApuradoAmount = moneyObj(byId['GITAMONEYIFZ000048']).amount;
  const aliquotaCOFINS = byId['GITABIGDECIFZ000028']?.value?.bigDecimalValue ?? null;
  const cofinsApuradoAmount = moneyObj(byId['GITAMONEYIFZ000049']).amount;
  const aliquotaICMSInterna = byId['GITABIGDECIFZ000006']?.value?.bigDecimalValue ?? null;
  const origemMaterial = byId['GITASHORTSTRINGIFZ000153']?.value?.simpleValue ?? null;

  const plant = byId['Plant']?.value?.simpleValue ?? null;
  const itemCategory = byId['ItemCategory']?.value?.simpleValue ?? null;
  const grupoMaterias = byId['MaterialGroup']?.value?.simpleValue ?? null;
  const taxCode = byId['GITASHORTSTRINGIFZ000152']?.value?.simpleValue ?? null;
  const materialCode = byId['MaterialCode']?.value?.simpleValue ?? null;

  const result = {
    ItemId: targetRow?.item?.itemId ?? targetRow?.itemId ?? null,
    itemDescription: targetRow?.item?.title ?? null,

    quantity: qv?.amount ?? null,
    unitOfMeasure: qv?.unitOfMeasureCode ?? null,

    price: unit.amount,
    currency: unit.currency,

    ncm, mva,
    Extrinsic_Aliquota_ICMS: aliquotaICMS,
    Extrinsic_ICMS_Apurado: icmsApuradoAmount,
    Extrinsic_Aliquota_IPI: aliquotaIPI,
    Extrinsic_IPI_Apurado: ipiApuradoAmount,
    Extrinsic_Aliquota_PIS: aliquotaPIS,
    Extrinsic_PIS_Apurado: pisApuradoAmount,
    Extrinsic_Aliquota_Cofins: aliquotaCOFINS,
    Extrinsic_Cofins_apurado: cofinsApuradoAmount,
    Extrinsic_Aliquota_ICMS_Interna: aliquotaICMSInterna,
    Extrinsic_Origem_do_Material: origemMaterial,

    EXTENDEDPRICE: ext.amount,
    PLANT: plant,
    ItemCategory: itemCategory,
    TAX_CODE: taxCode,
    MaterialCode: materialCode,
    grupo_de_materias: grupoMaterias
  };

  return { rows, result };
}

// fetchParentProjectId (identifiers collection)
async function fetchParentProjectId(docId, headersCommon) {
  const urlIds = `${ARIBA_BASE_URL_EVENTS}/events/identifiers`;

  const { data } = await axios.get(urlIds, {
    params: {
      realm: ARIBA_REALM,
      user: ARIBA_USER,
      passwordAdapter: ARIBA_PASSWORD_ADAPTER,
      $filter: '(createDateFrom gt 01082025000000 and createDateTo lt 31122025000000)'
    },
    headers: headersCommon,
    timeout: Number(HTTP_TIMEOUT_MS) || 30000
  });

  const arr = toArr(data);
  return arr.find(x => String(x?.internalId) === String(docId))?.parentProjectId ?? null;
}

// ----------------- CAP Service Implementation -----------------
module.exports = cds.service.impl(function () {

  // aribaHeader function (consulta projeto WS... )
  this.on('aribaHeader', async (req) => {
    const projectId = req.data.projectId || req.data.wsId || null;
    if (!projectId) return req.error(400, "Parâmetro 'projectId' obrigatório.");

    try {
      const token = await getAccessToken();
      const apiKey = ARIBA_API_KEY_EVENTS;
      const headersCommon = {
        apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`
      };

      // endpoint de projetos (usando a mesma base events)
      const url = `${ARIBA_BASE_URL_EVENTS}/projects/${encodeURIComponent(projectId)}`;

      const { data } = await axios.get(url, {
        params: { realm: ARIBA_REALM, user: ARIBA_USER, passwordAdapter: ARIBA_PASSWORD_ADAPTER },
        headers: headersCommon,
        timeout: Number(HTTP_TIMEOUT_MS) || 30000
      });

      // data pode vir bruto; aplicamos o mapeamento
      return mapAribaHeader(data || {});
    } catch (e) {
      console.error('[aribaHeader] Erro:', e?.response?.status, e?.response?.data || e.message);
      return req.error(e?.response?.status || 502, 'Falha ao consultar aribaHeader.');
    }
  });

  // GetQuotes (orquestrador) - usa funções auxiliares acima
  this.on('GetQuotes', async (req) => {
    const { docId, onlyParentProjectId } = (req.data || {});
    if (!docId) return req.error(400, "Parâmetro 'docId' é obrigatório.");

    try {
      const token = await getAccessToken();
      const apiKeyToUse = ARIBA_API_KEY_EVENTS;
      const headersCommon = {
        apiKey: apiKeyToUse,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`
      };

      // supplierBids
      const { rows, result } = await fetchSupplierBids(docId, headersCommon);

      // se não há bids, tenta retornar só parentProjectId quando solicitado
      if (!rows.length) {
        if (onlyParentProjectId) {
          const ppid = await fetchParentProjectId(docId, headersCommon);
          if (!ppid) return req.error(404, `parentProjectId não encontrado para ${docId}.`);
          return { parentProjectId: ppid };
        }
        return [];
      }

      if (!result) return req.error(404, `Não foi possível extrair dados do item para ${docId}.`);

      // identifiers (parentProjectId)
      let parentProjectId = null;
      try {
        parentProjectId = await fetchParentProjectId(docId, headersCommon);
      } catch (err) {
        console.warn('[GetQuotes] identifiers falhou:', err?.response?.status, err?.response?.data || err.message);
      }

      if (onlyParentProjectId) {
        if (!parentProjectId) return req.error(404, `parentProjectId não encontrado para ${docId}.`);
        return { parentProjectId };
      }

      // devolve um array com 1 item (compatível com seu front atual)
      return [{ ...result, parentProjectId }];

    } catch (e) {
      console.error('[GetQuotes] Erro Ariba:', e?.response?.status, e?.response?.data || e.message);
      return req.error(e?.response?.status || 502, 'Falha ao consultar supplierBids no Ariba.');
    }
  });

}); // fim cds.service.impl
