// srv/service.js
const cds = require('@sap/cds');
require('dotenv').config();
const axios = require('axios');
const { getDestination, addDestinationToRequestConfig } = require('@sap-cloud-sdk/connectivity');

// Log customizado para este serviço
const LOG = cds.log('ariba-service');

// Token dos ENDPOINTS de EVENTS (teu projeto)
const { getAccessToken } = require('../srv/auth/aribaOauth');

// ==================== SWITCH DESTINATION vs .ENV ====================
const USE_DESTINATION = (process.env.USE_DESTINATION || 'false') === 'true';
const EVENTS_DEST   = process.env.ARIBA_DEST_EVENTS   || 'ARIBA_Event_Management_Test';
const PROJECTS_DEST = process.env.ARIBA_DEST_PROJECTS || 'ARIBA_Project_Management_Test';

// ==================== ENV VARS (fallback .env) ====================
const {
  // EVENTS
  ARIBA_BASE_URL_EVENTS,
  ARIBA_API_KEY_EVENTS,

  // PROJECTS / PM
  ARIBA_BASE_URL_PROJECTS,
  ARIBA_API_KEY_PROJECTS,

  // Comuns
  ARIBA_REALM,
  ARIBA_USER,
  ARIBA_PASSWORD_ADAPTER,
  HTTP_TIMEOUT_MS,

  // OAuth PM (fallback .env)
  ARIBA_PM_OAUTH_TOKEN_URL,
  ARIBA_PM_OAUTH_CLIENT_ID,
  ARIBA_PM_OAUTH_CLIENT_SECRET,
  ARIBA_PM_OAUTH_GRANT_TYPE
} = process.env;

// ==================== HELPER: GET via Destination ====================
async function destGet(destName, relativePath, { params = {}, headers = {}, timeoutMs = 30000 } = {}) {
  const destination = await getDestination({ destinationName: destName });
  const reqCfg = await addDestinationToRequestConfig(
    { method: 'get', url: relativePath, params, headers, timeout: timeoutMs },
    destination
  );
  const { data } = await axios.request(reqCfg); // Authorization e props da destination
  return data;
}

// ==================== CÓDIGO PM (PROJECTS) ====================
// cache simples de token (fallback .env; não usado quando USE_DESTINATION=true)
let _pmOauthCache = { token: null, exp: 0 };

async function getPmAccessToken() {
  if (USE_DESTINATION) throw new Error('getPmAccessToken não deve ser usado com Destination');
  LOG.info('[getPmAccessToken] Tentando obter token PM (.env)');
  const now = Date.now();
  if (_pmOauthCache.token && now < _pmOauthCache.exp - 60_000) {
    LOG.info('[getPmAccessToken] Usando token do cache.');
    return _pmOauthCache.token;
  }
  const basic = Buffer.from(`${ARIBA_PM_OAUTH_CLIENT_ID}:${ARIBA_PM_OAUTH_CLIENT_SECRET}`).toString('base64');
  const grantType = ARIBA_PM_OAUTH_GRANT_TYPE || 'client_credentials';

  const { data } = await axios.post(
    ARIBA_PM_OAUTH_TOKEN_URL,
    `grant_type=${encodeURIComponent(grantType)}`,
    { headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  _pmOauthCache.token = data.access_token;
  _pmOauthCache.exp   = now + (data.expires_in ?? 3600) * 1000;
  return _pmOauthCache.token;
}

async function aribaPmGet(path, params = {}) {
  LOG.info(`[aribaPmGet] ${USE_DESTINATION ? 'via Destination' : 'via .env'} ${path}`);

  if (USE_DESTINATION) {
    // Destination (OAuth2ClientCredentials + apikey/queries configurados na destination)
    return await destGet(PROJECTS_DEST, path, {
      params: {}, // deixar queries (realm/user/passwordAdapter) na destination
      headers: {},
      timeoutMs: Number(HTTP_TIMEOUT_MS) || 30000
    });
  }

  // --- fallback .env ---
  const token = await getPmAccessToken();
  try {
    const { data } = await axios.get(`${ARIBA_BASE_URL_PROJECTS}${path}`, {
      params,
      headers: { apikey: ARIBA_API_KEY_PROJECTS, Authorization: `Bearer ${token}` },
      timeout: Number(HTTP_TIMEOUT_MS) || 30000
    });
    return data;
  } catch (e) {
    if (e?.response?.status === 401) {
      _pmOauthCache = { token: null, exp: 0 };
      const newToken = await getPmAccessToken();
      const { data } = await axios.get(`${ARIBA_BASE_URL_PROJECTS}${path}`, {
        params,
        headers: { apikey: ARIBA_API_KEY_PROJECTS, Authorization: `Bearer ${newToken}` },
        timeout: Number(HTTP_TIMEOUT_MS) || 30000
      });
      return data;
    }
    throw e;
  }
}

// ==================== MAPEAMENTO HEADER PM ====================
const firstToken = (s) => (s || '').trim().split(' ')[0] || null;
const cut        = (s, n) => (s || '').substring(0, n) || null;

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
    if (Array.isArray(f.textValue))               return f.textValue[0];
    if (Array.isArray(f.values) && f.values[0])   return f.values[0].value || f.values[0].name;
    if ('booleanValue' in f)                      return String(f.booleanValue);
    if ('numberValue'  in f)                      return String(f.numberValue);
    if ('value'        in f)                      return f.value;
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

// função interna para buscar header do projeto (PM)
async function fetchAribaHeader(projectId) {
  const data = await aribaPmGet(`/projects/${encodeURIComponent(projectId)}`, {
    realm: ARIBA_REALM,
    user: ARIBA_USER,
    passwordAdapter: ARIBA_PASSWORD_ADAPTER
  });
  return mapAribaHeader(data || {});
}

// ==================== HANDLER ODATA ====================
module.exports = function () {
  this.on('GetQuotes', async (req) => {
    const { docId } = (req.data || {});
    if (!docId) return req.error(400, "Parâmetro 'docId' é obrigatório.");

    // Headers de EVENTS só quando .env; com Destination não precisa
    let headersCommon = {};
    if (!USE_DESTINATION) {
      const token = await getAccessToken();
      headersCommon = {
        apiKey: ARIBA_API_KEY_EVENTS,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`
      };
    }

    try {
      // supplierBids (EVENTS)
      const { rows, result, invitationId  } = await fetchSupplierBids(docId, headersCommon);
      console.log(`[GetQuotes] invitationId (interno): ${invitationId}`);
      if (!rows.length || !result) return { header: null, items: [] };

      // identifiers → parentProjectId (EVENTS)
      let parentProjectId = null;
      try {
        parentProjectId = await fetchParentProjectId(docId, headersCommon);
      } catch (err) {
        LOG.warn('[GetQuotes] identifiers falhou:', err?.response?.status, err?.response?.data || err.message);
      }

      // header (PROJECTS/PM)
      let header = null;
      try {
        if (parentProjectId) header = await fetchAribaHeader(parentProjectId);
      } catch (e) {
        LOG.warn('[GetQuotes] Falha ao buscar header PM:', e?.response?.status, e?.response?.data || e.message);
      }
      const headerWithDoc = Object.assign({ docId }, header || {});

      return { header: headerWithDoc, items: [ result ] };
    } catch (e) {
      const status = e.response?.status || 502;
      const msg = e.response?.data?.message || e.response?.data || e.message;
      LOG.error('[GetQuotes] Erro Ariba:', status, msg);
      return req.error(status, 'Falha ao consultar supplierBids no Ariba.');
    }
  });
};

// ==================== HELPERS (EVENTS) ====================
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
  LOG.info(`[fetchSupplierBids] docId=${docId} ${USE_DESTINATION ? 'via Destination' : 'via .env'}`);
  const path = `/events/${encodeURIComponent(docId)}/supplierBids`;

  let data;
  if (USE_DESTINATION) {
    data = await destGet(EVENTS_DEST, path, {
      params: {}, // queries (realm/user/passwordAdapter) podem estar na destination
      headers: {},
      timeoutMs: Number(HTTP_TIMEOUT_MS) || 30000
    });
  } else {
    const urlBids = `${ARIBA_BASE_URL_EVENTS}${path}`;
    const resp = await axios.get(urlBids, {
      params: { realm: ARIBA_REALM, user: ARIBA_USER, passwordAdapter: ARIBA_PASSWORD_ADAPTER },
      headers: headersCommon,
      timeout: Number(HTTP_TIMEOUT_MS) || 30000
    });
    data = resp.data;
  }

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

   const ownerRow = rows.find(r =>
    Array.isArray(r?.itemsWithBid) &&
    r.itemsWithBid.map(String).includes(String(chosenItemId))
  );

  const invitationId = ownerRow?.invitationId ?? targetRow?.invitationId ?? null;
    LOG.info(`[fetchSupplierBids] invitationId para chosenItemId ${chosenItemId}: ${invitationId}`);


  const targetRow = rows.find(r => String(r?.item?.itemId ?? r?.itemId) === String(chosenItemId));
  if (!targetRow) return { rows, result: null };

  const byId = byFieldId(targetRow);
  const unit = moneyObj(byId['PRICE']);
  const qv   = byId['QUANTITY']?.value?.quantityValue;
  const ext  = moneyObj(byId['EXTENDEDPRICE']);

  const ncm  = byId['GITASHORTSTRINGIFZ000050']?.value?.simpleValue ?? null;
  const mva  = byId['GITABIGDECIFZ000003']?.value?.bigDecimalValue ?? null;

  const aliquotaICMS          = byId['GITABIGDECIFZ000004']?.value?.bigDecimalValue ?? null;
  const icmsApuradoAmount     = moneyObj(byId['GITAMONEYIFZ000046']).amount;
  const aliquotaIPI           = byId['GITABIGDECIFZ000005']?.value?.bigDecimalValue ?? null;
  const ipiApuradoAmount      = moneyObj(byId['GITAMONEYIFZ000047']).amount;
  const aliquotaPIS           = byId['GITABIGDECIFZ000029']?.value?.bigDecimalValue ?? null;
  const pisApuradoAmount      = moneyObj(byId['GITAMONEYIFZ000048']).amount;
  const aliquotaCOFINS        = byId['GITABIGDECIFZ000028']?.value?.bigDecimalValue ?? null;
  const cofinsApuradoAmount   = moneyObj(byId['GITAMONEYIFZ000049']).amount;
  const aliquotaICMSInterna   = byId['GITABIGDECIFZ000006']?.value?.bigDecimalValue ?? null;
  const origemMaterial        = byId['GITASHORTSTRINGIFZ000153']?.value?.simpleValue ?? null;

  const plant         = byId['Plant']?.value?.simpleValue ?? null;
  const itemCategory  = byId['ItemCategory']?.value?.simpleValue ?? null;
  const grupoMaterias = byId['MaterialGroup']?.value?.simpleValue ?? null;
  const taxCode       = byId['GITASHORTSTRINGIFZ000152']?.value?.simpleValue ?? null;
  const materialCode  = byId['MaterialCode']?.value?.simpleValue ?? null;

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

  return { rows, result, invitationId  };
}

async function fetchParentProjectId(docId, headersCommon) {
  LOG.info(`[fetchParentProjectId] docId=${docId} ${USE_DESTINATION ? 'via Destination' : 'via .env'}`);
  const path = `/events/identifiers`;

  let data;
  if (USE_DESTINATION) {
    data = await destGet(EVENTS_DEST, path, {
      params: {}, // filter/realm/etc podem estar na destination
      headers: {},
      timeoutMs: Number(HTTP_TIMEOUT_MS) || 30000
    });
  } else {
    const urlIds = `${ARIBA_BASE_URL_EVENTS}${path}`;
    const resp = await axios.get(urlIds, {
      params: {
        realm: ARIBA_REALM,
        user: ARIBA_USER,
        passwordAdapter: ARIBA_PASSWORD_ADAPTER,
        $filter: '(createDateFrom gt 01082025000000 and createDateTo lt 31122025000000)',
      },
      headers: headersCommon,
      timeout: Number(HTTP_TIMEOUT_MS) || 30000
    });
    data = resp.data;
  }

  const arr = toArr(data);
  const parentProjectId = arr.find(x => String(x?.internalId) === String(docId))?.parentProjectId ?? null;
  return parentProjectId;
}
