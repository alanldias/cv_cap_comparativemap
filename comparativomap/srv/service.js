const cds = require('@sap/cds');
require('dotenv').config();
// const soap = require('soap');
const axios = require('axios');
// const { getDestination, addDestinationToRequestConfig } = require('@sap-cloud-sdk/connectivity');
const { getAccessToken } = require('../srv/auth/aribaOauth');


const {
  ARIBA_BASE_URL_EVENTS,
  ARIBA_REALM,
  ARIBA_USER,
  ARIBA_PASSWORD_ADAPTER,
  ARIBA_API_KEY_EVENTS,
  HTTP_TIMEOUT_MS
} = process.env;

module.exports = function () {
  this.on('GetQuotes', async (req) => {
    const { docId, onlyParentProjectId } = (req.data || {});
    if (!docId) return req.error(400, "Parâmetro 'docId' é obrigatório.");

    // token dinâmico
    const token = await getAccessToken();

    // usa a nova var de env se existir, senão fallback
    const apiKeyToUse = ARIBA_API_KEY_EVENTS;

    const headersCommon = {
      apiKey: apiKeyToUse,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    };

    try {
      // delega a lógica de supplierBids para a função dedicada
      const { rows, result } = await fetchSupplierBids(docId, headersCommon);

      if (!rows.length) {
        if (onlyParentProjectId) {
          const ppid = await fetchParentProjectId(docId, headersCommon);
          if (!ppid) return req.error(404, `parentProjectId não encontrado para ${docId}.`);
          return { parentProjectId: ppid };
        }
        return [];
      }

      if (!result) return req.error(404, `Não foi possível extrair dados do item para ${docId}.`);

      // identifiers
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

      return [{ ...result, parentProjectId }];

    } catch (e) {
      const status = e.response?.status || 502;
      const msg = e.response?.data?.message || e.response?.data || e.message;
      console.error('[GetQuotes] Erro Ariba:', status, msg);
      return req.error(status, 'Falha ao consultar supplierBids no Ariba.');
    }
  });
};

const toArr = (d) =>
  Array.isArray(d?.payload) ? d.payload :
    Array.isArray(d) ? d :
      (d ? [d] : []);

const termsFrom = (row) => (row?.item?.terms || row?.terms || []);
const byFieldId = (row) =>
  Object.fromEntries(termsFrom(row).filter(t => t?.fieldId).map(t => [t.fieldId, t]));
const moneyObj = (term) => {
  const mv = term?.value?.moneyValue || term?.value?.supplierValue;
  return mv ? { amount: mv.amount ?? null, currency: mv.currency ?? null }
    : { amount: null, currency: null };
};

async function fetchSupplierBids(docId, headersCommon) {
  const urlBids = `${ARIBA_BASE_URL_EVENTS}/events/${encodeURIComponent(docId)}/supplierBids`;
  const { data } = await axios.get(urlBids, {
    params: { realm: ARIBA_REALM, user: ARIBA_USER, passwordAdapter: ARIBA_PASSWORD_ADAPTER },
    headers: headersCommon,
    timeout: Number(HTTP_TIMEOUT_MS) || 30000
  });

  const rows = toArr(data);
  if (!rows.length) return { rows: [], result: null };

  const itemsWithBid = [...new Set(
    rows.flatMap(r => Array.isArray(r?.itemsWithBid) ? r.itemsWithBid : [])
  )].map(String);

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

async function fetchParentProjectId(docId, headersCommon) {
  const urlIds = `${ARIBA_BASE_URL_EVENTS}/events/identifiers`;

  const { data } = await axios.get(urlIds, {
    params: {
      realm: ARIBA_REALM,
      user: ARIBA_USER,
      passwordAdapter: ARIBA_PASSWORD_ADAPTER,
      $filter: '(createDateFrom gt 01082025000000 and createDateTo lt 31122025000000)',
    },
    headers: headersCommon,
    timeout: Number(HTTP_TIMEOUT_MS) || 30000,
  });

  const arr = toArr(data);
  return arr.find(x => String(x?.internalId) === String(docId))?.parentProjectId ?? null;
}
