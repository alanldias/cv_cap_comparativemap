// srv/service.js
const cds = require('@sap/cds');
require('dotenv').config();
const axios = require('axios');
const { simularPO } = require('./utils/simular-po') // <<=== Lógica da chamada da BAPI

// Log customizado para este serviço
const LOG = cds.log('ariba-service');

// Token dos ENDPOINTS de EVENTS (já existia no teu projeto)
const { getAccessToken } = require('../srv/auth/aribaOauth');

// ==================== ENV VARS ====================
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

  // OAuth PM
  ARIBA_PM_OAUTH_TOKEN_URL,
  ARIBA_PM_OAUTH_CLIENT_ID,
  ARIBA_PM_OAUTH_CLIENT_SECRET,
  ARIBA_PM_OAUTH_GRANT_TYPE
} = process.env;

// ==================== CÓDIGO DELA (PM) -> FUNÇÕES INTERNAS ====================
// cache simples de token (sem inFlight)
let _pmOauthCache = { token: null, exp: 0 };

async function getPmAccessToken() {
  LOG.info('[getPmAccessToken] Tentando obter token para o serviço PM.');
  const now = Date.now();
  if (_pmOauthCache.token && now < _pmOauthCache.exp - 60_000) {
    LOG.info('[getPmAccessToken] Usando token do cache.');
    return _pmOauthCache.token; // 1 min de folga
  }
  LOG.info('[getPmAccessToken] O cache está vazio ou o token expirou. Solicitando um novo token.');
  const basic = Buffer.from(`${ARIBA_PM_OAUTH_CLIENT_ID}:${ARIBA_PM_OAUTH_CLIENT_SECRET}`).toString('base64');
  const grantType = ARIBA_PM_OAUTH_GRANT_TYPE || 'client_credentials';

  try {
    const { data } = await axios.post(
      ARIBA_PM_OAUTH_TOKEN_URL,
      `grant_type=${encodeURIComponent(grantType)}`,
      {
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    LOG.info('[getPmAccessToken] Novo token obtido com sucesso. Salvando no cache.');
    _pmOauthCache.token = data.access_token;
    _pmOauthCache.exp = now + (data.expires_in ?? 3600) * 1000;
    return _pmOauthCache.token;
  } catch (error) {
    LOG.error(`[getPmAccessToken] Falha ao obter token: ${error.message}`);
    throw error;
  }
}

async function aribaPmGet(path, params = {}) {
  LOG.info(`[aribaPmGet] Chamando a API do PM para o path: ${path}`);
  const token = await getPmAccessToken();
  try {
    const { data } = await axios.get(`${ARIBA_BASE_URL_PROJECTS}${path}`, {
      params,
      headers: { apikey: ARIBA_API_KEY_PROJECTS, Authorization: `Bearer ${token}` },
      timeout: Number(HTTP_TIMEOUT_MS) || 30000
    });
    LOG.info(`[aribaPmGet] Resposta da API do PM recebida com sucesso para o path: ${path}`);
    return data;
  } catch (e) {
    LOG.warn(`[aribaPmGet] Primeira tentativa falhou para o path ${path}. Tentando novamente com novo token.`);
    if (e?.response?.status === 401) {
      _pmOauthCache = { token: null, exp: 0 };
      const newToken = await getPmAccessToken();
      const { data } = await axios.get(`${ARIBA_BASE_URL_PROJECTS}${path}`, {
        params,
        headers: { apikey: ARIBA_API_KEY_PROJECTS, Authorization: `Bearer ${newToken}` },
        timeout: Number(HTTP_TIMEOUT_MS) || 30000
      });
      LOG.info(`[aribaPmGet] Segunda tentativa bem-sucedida para o path: ${path}`);
      return data;
    }
    LOG.error(`[aribaPmGet] Erro crítico na chamada da API do PM: ${e.message}`);
    throw e;
  }
}

// helpers do mapeamento do cabeçalho (iguais às do código dela)
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

  LOG.debug(`[getCustomField] Procurando pelo campo customizado: ${fieldId}`);
  for (const arr of pools) {
    const f = (arr || []).find(x => x.fieldId === fieldId);
    if (!f) continue;
    LOG.debug(`[getCustomField] Encontrado valor para ${fieldId}: ${JSON.stringify(f)}`);
    if (Array.isArray(f.flexMasterDataTypeValue)) return f.flexMasterDataTypeValue[0];
    if (Array.isArray(f.textValue)) return f.textValue[0];
    if (Array.isArray(f.values) && f.values[0]) return f.values[0].value || f.values[0].name;
    if ('booleanValue' in f) return String(f.booleanValue);
    if ('numberValue' in f) return String(f.numberValue);
    if ('value' in f) return f.value;
  }
  LOG.debug(`[getCustomField] Nenhum valor encontrado para o campo customizado: ${fieldId}`);
  return null;
}

function mapAribaHeader(p) {
  LOG.info('[mapAribaHeader] Mapeando cabeçalho do projeto Ariba.');
  const bs = p?.businessSystem || {};
  const docCat = bs?.documentCategory?.[0]?.value || bs?.documentCategory?.[0]?.key || null;
  const purOrg = bs?.purchasingOrganization?.[0]?.value || bs?.purchasingOrganization?.[0]?.key || null;
  const purGrp = bs?.purchasingGroup?.[0]?.value || bs?.purchasingGroup?.[0]?.key || null;
  const compCode = bs?.companyCode?.[0]?.value || bs?.companyCode?.[0]?.key || null;

  const inc1 = getCustomField(p, 'cus_wsincoterms') || getCustomField(p, 'cus_wsIncoterms');
  const inc2 = getCustomField(p, 'cus_wslocal');
  const payt = getCustomField(p, 'arb_PaymentTerms');

  const mappedHeader = {
    tipoPedido: docCat,
    purchasingOrganization: cut(firstToken(purOrg), 4),
    purchasingGroup: cut(firstToken(purGrp), 3),
    companyCode: cut(firstToken(compCode), 4),
    incoterms1: inc1,
    incoterms2: inc2,
    paymentTerms: payt || null
  };
  LOG.debug(`[mapAribaHeader] Cabeçalho mapeado: ${JSON.stringify(mappedHeader)}`);
  return mappedHeader;
}

// função interna (não OData) para você chamar quando quiser
async function fetchAribaHeader(projectId) {
  LOG.info(`[fetchAribaHeader] Buscando cabeçalho do projeto Ariba para projectId: ${projectId}`);
  const data = await aribaPmGet(`/projects/${encodeURIComponent(projectId)}`, {
    realm: ARIBA_REALM,
    user: ARIBA_USER,
    passwordAdapter: ARIBA_PASSWORD_ADAPTER
  });
  LOG.info('[fetchAribaHeader] Dados brutos do cabeçalho recebidos. Mapeando...');
  return mapAribaHeader(data || {});
}

// ==================== TEU CÓDIGO (EVENTS) INALTERADO ====================
module.exports = function () {
  this.on('GetQuotes', async (req) => {
    const { docId } = (req.data || {});
    if (!docId) return req.error(400, "Parâmetro 'docId' é obrigatório.");

    const token = await getAccessToken();
    const headersCommon = {
      apiKey: ARIBA_API_KEY_EVENTS,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    };

    try {
      const { rows, result } = await fetchSupplierBids(docId, headersCommon);
      if (!rows.length || !result) return { header: null, items: [] };

      // tenta descobrir o parentProjectId (identifiers no EVENTS)
      let parentProjectId = null;
      try {
        parentProjectId = await fetchParentProjectId(docId, headersCommon);
      } catch (err) {
        console.warn('[GetQuotes] identifiers falhou:', err?.response?.status, err?.response?.data || err.message);
      }

      // busca header no PM (PROJECTS)
      let header = null;
      try {
        if (parentProjectId) {
          header = await fetchAribaHeader(parentProjectId);
        }
      } catch (e) {
        console.warn('[GetQuotes] Falha ao buscar header PM:', e?.response?.status, e?.response?.data || e.message);
      }
      const headerWithDoc = Object.assign({ docId }, header || {});

      // devolve no formato do CDS
      return { header: headerWithDoc, items: [result] };

    } catch (e) {
      const status = e.response?.status || 502;
      const msg = e.response?.data?.message || e.response?.data || e.message;
      console.error('[GetQuotes] Erro Ariba:', status, msg);
      return req.error(status, 'Falha ao consultar supplierBids no Ariba.');
    }
  });

  this.on('simulateBapiPoCreate', async req => {
    const { items = [], header = {} } = req.data ?? {};
    try {
      const resposta = await simularPO(items, header);
      if (!resposta.success) {
        const msg = resposta.messages?.map(m => m.text).join(' | ') || 'Falha na simulação';
        req.error(400, msg, { details: resposta.messages });
      }
      return resposta;
    } catch (e) {
      req.error(400, e.userMessage || e.message || 'Erro ao simular BAPI_PO_CREATE1');
    }
  });
};

// ==================== HELPERS (EVENTS) ====================
const toArr = (d) => {
  LOG.debug('[toArr] Convertendo dados para array.');
  return Array.isArray(d?.payload) ? d.payload :
    Array.isArray(d) ? d :
      (d ? [d] : []);
};

const termsFrom = (row) => {
  LOG.debug('[termsFrom] Extraindo termos da linha.');
  return (row?.item?.terms || row?.terms || []);
};

const byFieldId = (row) => {
  LOG.debug('[byFieldId] Mapeando termos por fieldId.');
  return Object.fromEntries(termsFrom(row).filter(t => t?.fieldId).map(t => [t.fieldId, t]));
};

const moneyObj = (term) => {
  LOG.debug('[moneyObj] Criando objeto de dinheiro.');
  const mv = term?.value?.moneyValue || term?.value?.supplierValue;
  return mv ? { amount: mv.amount ?? null, currency: mv.currency ?? null }
    : { amount: null, currency: null };
};

async function fetchSupplierBids(docId, headersCommon) {
  LOG.info(`[fetchSupplierBids] Buscando supplier bids para docId: ${docId}`);
  const urlBids = `${ARIBA_BASE_URL_EVENTS}/events/${encodeURIComponent(docId)}/supplierBids`;
  try {
    const { data } = await axios.get(urlBids, {
      params: { realm: ARIBA_REALM, user: ARIBA_USER, passwordAdapter: ARIBA_PASSWORD_ADAPTER },
      headers: headersCommon,
      timeout: Number(HTTP_TIMEOUT_MS) || 30000
    });
    const rows = toArr(data);
    LOG.info(`[fetchSupplierBids] Encontrados ${rows.length} bids.`);
    if (!rows.length) return { rows: [], result: null };

    const itemsWithBid = [...new Set(
      rows.flatMap(r => Array.isArray(r?.itemsWithBid) ? r.itemsWithBid : [])
    )].map(String);

    const chosenItemId =
      itemsWithBid[0] ||
      (rows.find(r => r?.bidRank === 1)?.item?.itemId ?? rows.find(r => r?.bidRank === 1)?.itemId) ||
      (rows[0]?.item?.itemId ?? rows[0]?.itemId);
    LOG.info(`[fetchSupplierBids] Item escolhido para detalhamento: ${chosenItemId}`);

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
    LOG.debug(`[fetchSupplierBids] Resultado do item processado: ${JSON.stringify(result)}`);
    return { rows, result };
  } catch (error) {
    LOG.error(`[fetchSupplierBids] Falha ao buscar supplier bids: ${error.message}`);
    throw error;
  }
}

async function fetchParentProjectId(docId, headersCommon) {
  LOG.info(`[fetchParentProjectId] Buscando ParentProjectId para docId: ${docId}`);
  const urlIds = `${ARIBA_BASE_URL_EVENTS}/events/identifiers`;
  try {
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
    const parentProjectId = arr.find(x => String(x?.internalId) === String(docId))?.parentProjectId ?? null;
    LOG.info(`[fetchParentProjectId] ParentProjectId encontrado: ${parentProjectId}`);
    return parentProjectId;
  } catch (error) {
    LOG.error(`[fetchParentProjectId] Falha ao buscar ParentProjectId: ${error.message}`);
    throw error;
  }
}