const cds = require('@sap/cds');
const axios = require('axios');

/** ====== ENV / CONFIG ====== */
const TOKEN_URL   = process.env.ARIBA_TOKEN_URL;             // ex.: https://api.ariba.com/v2/oauth/token
const CLIENT_ID   = process.env.ARIBA_CLIENT_ID;
const CLIENT_SEC  = process.env.ARIBA_CLIENT_SECRET;
const API_KEY     = process.env.ARIBA_API_KEY;               // Application Key
const PM_BASE_URL = process.env.ARIBA_PM_BASE_URL;           // ex.: https://openapi.ariba.com/api/sourcing-project-management/v2/prod

const ARIBA_REALM       = process.env.ARIBA_REALM || '744701080-T';
const ARIBA_USER        = process.env.ARIBA_USER  || 'acopino.consult';
const ARIBA_PWD_ADAPTER = process.env.ARIBA_PWD_ADAPTER || 'ThirdPartyUser';

const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 30000);

/** ====== TOKEN CACHE ====== */
let _oauthCache = { token: null, exp: 0 };
async function getAribaToken() {
  const now = Date.now();
  if (_oauthCache.token && now < _oauthCache.exp - 60_000) {
    return _oauthCache.token; // usa o token ainda válido (com 1min de folga)
  }
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SEC}`).toString('base64');
  const { data } = await axios.post(
    TOKEN_URL,
    'grant_type=client_credentials',
    { headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  _oauthCache.token = data.access_token;
  _oauthCache.exp   = now + (data.expires_in ?? 3600) * 1000;
  return _oauthCache.token;
}

/** ====== CLIENTE ARIBA (PM) com retry em 401 ====== */
async function aribaPmGet(path, params = {}) {
  const token = await getAribaToken();
  try {
    const { data } = await axios.get(`${PM_BASE_URL}${path}`, {
      params,
      headers: { apikey: API_KEY, Authorization: `Bearer ${token}` },
      timeout: HTTP_TIMEOUT_MS
    });
    return data;
  } catch (e) {
    // Se expirou no caminho, tenta 1x renovar
    if (e?.response?.status === 401) {
      _oauthCache = { token: null, exp: 0 };
      const newToken = await getAribaToken();
      const { data } = await axios.get(`${PM_BASE_URL}${path}`, {
        params,
        headers: { apikey: API_KEY, Authorization: `Bearer ${newToken}` },
        timeout: HTTP_TIMEOUT_MS
      });
      return data;
    }
    throw e;
  }
}

/** ====== HELPERS DE MAPEAMENTO ====== */
const firstToken = (s) => (s || '').trim().split(' ')[0] || null;
const cut        = (s, n) => (s || '').substring(0, n) || null;

function getCustomField(p, fieldId) {
  const pools = [
    p?.externalFields,                 // seu payload mostrou incoterms aqui
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

  const inc1 = getCustomField(p, 'cus_wsincoterms') || getCustomField(p, 'cus_wsIncoterms'); // variação de id
  const inc2 = getCustomField(p, 'cus_wslocal');
  const payt = getCustomField(p, 'arb_PaymentTerms'); // pode não existir

  return {
    tipoPedido: docCat,                                  // ZATV
    purchasingOrganization: cut(firstToken(purOrg), 4),  // CV01
    purchasingGroup:        cut(firstToken(purGrp), 3),  // 003
    companyCode:            cut(firstToken(compCode), 4),// 1001
    incoterms1: inc1,                                     // CIF
    incoterms2: inc2,                                     // ex.: CURITIBA (ou "CIF" no seu payload exemplo)
    paymentTerms: payt || null
  };
}

/** ====== IMPLEMENTAÇÃO CAP ====== */
module.exports = cds.service.impl(function () {

  // Function OData: service.aribaHeader(projectId)
  this.on('aribaHeader', async (req) => {
    const wsId = req.data.projectId || 'WS1639759115';

    try {
      const data = await aribaPmGet(`/projects/${encodeURIComponent(wsId)}`, {
        realm: ARIBA_REALM,
        user: ARIBA_USER,
        passwordAdapter: ARIBA_PWD_ADAPTER
      });
      return mapAribaHeader(data || {});
    } catch (e) {
      const status = e.response?.status || 502;
      const detail = e.response?.data || e.message;
      console.error('[aribaHeader] Erro:', status, detail);
      return req.error(status, 'Falha ao consultar o cabeçalho no Ariba (PM).');
    }
  });

  // (se quiser, depois reutilizamos o mesmo token para o GetQuotes/sourcing-event)
});
