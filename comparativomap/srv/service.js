const cds = require('@sap/cds');
require('dotenv').config();
const axios = require('axios');
const { simularPO } = require('./utils/simular-po');
const { getDestination, addDestinationToRequestConfig } = require('@sap-cloud-sdk/connectivity');
const { getAccessToken } = require('../srv/auth/aribaOauth');

const LOG = cds.log('ariba-service');

/** ======================== CONFIG ======================== */
const USE_DESTINATION = (process.env.USE_DESTINATION || 'false') === 'true';
const EVENTS_DEST = process.env.ARIBA_DEST_EVENTS || 'ARIBA_Event_Management_Test';
const PROJECTS_DEST = process.env.ARIBA_DEST_PROJECTS || 'ARIBA_Project_Management_Test';

const {
  // EVENTS
  ARIBA_BASE_URL_EVENTS,
  ARIBA_API_KEY_EVENTS,

  // PROJECTS / PM
  ARIBA_BASE_URL_PROJECTS,
  ARIBA_API_KEY_PROJECTS,

  // Common
  ARIBA_REALM,
  ARIBA_USER,
  ARIBA_PASSWORD_ADAPTER,
  HTTP_TIMEOUT_MS,

  // OAuth PM (fallback .env)
  ARIBA_PM_OAUTH_TOKEN_URL,
  ARIBA_PM_OAUTH_CLIENT_ID,
  ARIBA_PM_OAUTH_CLIENT_SECRET,
  ARIBA_PM_OAUTH_GRANT_TYPE,

  // Round padrão de eventos (quando não vem no payload)
  ARIBA_EVENT_ROUND
} = process.env;

const TIMEOUT = Number(HTTP_TIMEOUT_MS) || 30000;
const DEFAULT_ROUND = Number.isFinite(Number(ARIBA_EVENT_ROUND)) ? Number(ARIBA_EVENT_ROUND) : 1;

/** ======================== HELPERS GERAIS ======================== */
const q = { realm: ARIBA_REALM, user: ARIBA_USER, passwordAdapter: ARIBA_PASSWORD_ADAPTER };

async function destGet(destName, url, { params = {}, headers = {}, timeoutMs = TIMEOUT } = {}) {
  const destination = await getDestination({ destinationName: destName });
  const reqCfg = await addDestinationToRequestConfig(
    { method: 'get', url, params, headers, timeout: timeoutMs },
    destination
  );
  const { data } = await axios.request(reqCfg);
  return data;
}

// ################################ BEATRIZ - POST #####################################
async function destPost(destName, url, body, { params = {}, headers = {}, timeoutMs = TIMEOUT } = {}) {
  const destination = await getDestination({ destinationName: destName });
  const reqCfg = await addDestinationToRequestConfig(
    { method: 'post', url, data: body, params, headers, timeout: timeoutMs },
    destination
  );
  const resp = await axios.request(reqCfg);
  return { data: resp.data, headers: resp.headers };
}
// ################################ FIM - BEATRIZ - POST #####################################

const toArr = (d) =>
  Array.isArray(d?.payload) ? d.payload : Array.isArray(d) ? d : d ? [d] : [];

const firstToken = (s) => (s || '').trim().split(' ')[0] || null;
const cut = (s, n) => (s || '').substring(0, n) || null;

const termsFrom = (row) => row?.item?.terms || row?.terms || [];
const byFieldId = (row) =>
  Object.fromEntries(termsFrom(row).filter((t) => t?.fieldId).map((t) => [t.fieldId, t]));

const moneyObj = (term) => {
  const mv = term?.value?.moneyValue || term?.value?.supplierValue;
  return mv ? { amount: mv.amount ?? null, currency: mv.currency ?? null } : { amount: null, currency: null };
};

function pickSupplierNameFromRows(rows) {
  if (!Array.isArray(rows)) return null;
  const r = rows.find(
    (x) =>
      x?.organization?.name ||
      x?.supplier?.name ||
      x?.supplierName ||
      x?.organizationName ||
      x?.supplier?.organizationName
  );
  return (
    r?.organization?.name ||
    r?.supplier?.name ||
    r?.supplierName ||
    r?.organizationName ||
    r?.supplier?.organizationName ||
    null
  );
}

function pickSupplierNameByInvitation(rows, invId) {
  const r = rows.find((x) => String(x?.invitationId) === String(invId));
  return (
    r?.organization?.name ||
    r?.supplier?.name ||
    r?.supplierName ||
    r?.organizationName ||
    r?.supplier?.organizationName ||
    null
  );
}

// ################################ BEATRIZ - FORMATA MENSAGEM DE ERRO #####################################
function formatAribaScenarioError(e) {
  const status = e?.response?.status || 502;
  const headers = e?.response?.headers || {};
  const body = e?.response?.data || {};
  const correlationId = headers['x-correlation-id'] || headers['x-correlationid'] || null;

  // Extrai campos comuns
  const errObj = body?.error || body;
  const code = errObj?.errorCode || errObj?.code || null;
  const message = errObj?.message || body?.message || e.message || 'Erro desconhecido.';
  const description = (errObj?.description || body?.description || '').toString().trim() || null;

  // Padrão conhecido: título duplicado
  if (/duplicate scenario title/i.test(message)) {
    return {
      status,
      correlationId,
      userMessage: 'Cenário já exite.',
      technical: { status, code, message, description }
    };
  }

  // Coleta validações detalhadas, quando existirem
  const validations = []
    .concat(body?.violations || [])
    .concat(body?.details || [])
    .concat(body?.errors || []);

  const validationText = Array.isArray(validations) && validations.length
    ? validations.slice(0, 10).map(v => {
        const field = v.field || v.path || v.name || 'campo';
        const msg = v.message || v.description || JSON.stringify(v.value);
        return `${field}: ${msg}`;
      }).join(' ; ')
    : null;

  // Monta mensagem amigável
  const parts = [];
  if (description && description !== message) parts.push(`Descrição: ${description}`);
  if (code) parts.push(`Código: ${code}`);
  if (validationText) parts.push(`Validações: ${validationText}`);

  const userMessage = `Falha ao criar cenário no Ariba. ${[message, ...parts].filter(Boolean).join(' ')}`;

  // Inclui um raw truncado para diagnóstico (sem vazar gigante)
  let raw = '';
  try { raw = JSON.stringify(body); } catch (_) {}
  if (raw && raw.length > 2000) raw = raw.slice(0, 2000) + '...';

  return {
    status,
    correlationId,
    userMessage,
    technical: { status, code, message, description, raw }
  };
}
// ################################ FIM - BEATRIZ - FORMATA MENSAGEM DE ERRO #####################################
/** ======================== PROJECTS (PM) ======================== */
// Cache simples de token (usado só sem Destination)
let _pmOauthCache = { token: null, exp: 0 };

async function getPmAccessToken() {
  if (USE_DESTINATION) throw new Error('getPmAccessToken não deve ser usado com Destination');
  const now = Date.now();
  if (_pmOauthCache.token && now < _pmOauthCache.exp - 60_000) return _pmOauthCache.token;

  const basic = Buffer.from(`${ARIBA_PM_OAUTH_CLIENT_ID}:${ARIBA_PM_OAUTH_CLIENT_SECRET}`).toString('base64');
  const grantType = ARIBA_PM_OAUTH_GRANT_TYPE || 'client_credentials';

  const { data } = await axios.post(
    ARIBA_PM_OAUTH_TOKEN_URL,
    `grant_type=${encodeURIComponent(grantType)}`,
    { headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  _pmOauthCache = { token: data.access_token, exp: now + (data.expires_in ?? 3600) * 1000 };
  return _pmOauthCache.token;
}

async function aribaPmGet(path, params = {}) {
  if (USE_DESTINATION) {
    return destGet(PROJECTS_DEST, path, { params, timeoutMs: TIMEOUT });
  }
  const token = await getPmAccessToken();
  const url = `${ARIBA_BASE_URL_PROJECTS}${path}`;
  try {
    const { data } = await axios.get(url, {
      params,
      headers: { apikey: ARIBA_API_KEY_PROJECTS, Authorization: `Bearer ${token}` },
      timeout: TIMEOUT
    });
    return data;
  } catch (e) {
    if (e?.response?.status === 401) {
      _pmOauthCache = { token: null, exp: 0 };
      const newToken = await getPmAccessToken();
      const { data } = await axios.get(url, {
        params,
        headers: { apikey: ARIBA_API_KEY_PROJECTS, Authorization: `Bearer ${newToken}` },
        timeout: TIMEOUT
      });
      return data;
    }
    throw e;
  }
}

function getCustomField(p, fieldId) {
  const pools = [
    p?.externalFields,
    p?.sourcingProjectCustomFields,
    p?.projectCustomFields,
    p?.fields,
    p?.customFields
  ].filter(Boolean);

  for (const arr of pools) {
    const f = (arr || []).find((x) => x.fieldId === fieldId);
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
  const docCat = bs?.documentCategory?.[0]?.value || bs?.documentCategory?.[0]?.key || null;
  const purOrg = bs?.purchasingOrganization?.[0]?.value || bs?.purchasingOrganization?.[0]?.key || null;
  const purGrp = bs?.purchasingGroup?.[0]?.value || bs?.purchasingGroup?.[0]?.key || null;
  const compCode = bs?.companyCode?.[0]?.value || bs?.companyCode?.[0]?.key || null;

  const inc1 = getCustomField(p, 'cus_wsincoterms') || getCustomField(p, 'cus_wsIncoterms');
  const inc2 = getCustomField(p, 'cus_wslocal');
  const payt = getCustomField(p, 'arb_PaymentTerms');

  return {
    tipoPedido: docCat,
    purchasingOrganization: cut(firstToken(purOrg), 4),
    purchasingGroup: cut(firstToken(purGrp), 3),
    companyCode: cut(firstToken(compCode), 4),
    incoterms1: inc1,
    incoterms2: inc2,
    paymentTerms: payt || null
  };
}

async function fetchAribaHeader(projectId) {
  const data = await aribaPmGet(`/projects/${encodeURIComponent(projectId)}`, q);
  return mapAribaHeader(data || {});
}

/** ======================== EVENTS (supplier bids, identifiers, invitations) ======================== */
async function fetchSupplierBids(docId, headersCommon) {
  const path = `/events/${encodeURIComponent(docId)}/supplierBids`;
  let data;

  if (USE_DESTINATION) {
    data = await destGet(EVENTS_DEST, path, { timeoutMs: TIMEOUT });
  } else {
    const url = `${ARIBA_BASE_URL_EVENTS}${path}`;
    const resp = await axios.get(url, { params: q, headers: headersCommon, timeout: TIMEOUT });
    data = resp.data;
  }

  const rows = toArr(data);
  if (!rows.length) return { rows: [], results: [] };

  const results = [];
  for (const row of rows) {
    const invId = row?.invitationId ?? null;
    const itemIds = Array.isArray(row?.itemsWithBid) ? row.itemsWithBid.map(String) : [];
    if (!itemIds.length) continue;

    for (const itemId of itemIds) {
      const targetRow =
        rows.find(
          (r) =>
            String(r?.item?.itemId ?? r?.itemId) === String(itemId) &&
            String(r?.invitationId) === String(invId)
        ) ||
        rows.find((r) => String(r?.item?.itemId ?? r?.itemId) === String(itemId));

      if (!targetRow) continue;

      const byId = byFieldId(targetRow);

      const lifnrTerm =
        byId['LIFNR']?.value?.simpleValue ||
        byId['VendorNumber']?.value?.simpleValue ||
        byId['ERPVendor']?.value?.simpleValue ||
        byId['ERPVENDOR']?.value?.simpleValue ||
        byId['VENDOR']?.value?.simpleValue ||
        byId['GITALIFNR']?.value?.simpleValue ||
        null;

      const unit = moneyObj(byId['PRICE']);
      const qv = byId['QUANTITY']?.value?.quantityValue;
      const ext = moneyObj(byId['EXTENDEDPRICE']);

      const mapped = {
        ItemId: itemId,
        itemDescription: targetRow?.item?.title ?? null,
        quantity: qv?.amount ?? null,
        unitOfMeasure: qv?.unitOfMeasureCode ?? null,
        price: unit.amount,
        currency: unit.currency,
        lifnr: lifnrTerm ? String(lifnrTerm).padStart(10, '0') : null,

        // Extrinsics / tributos
        ncm: byId['GITASHORTSTRINGIFZ000050']?.value?.simpleValue ?? null,
        mva: byId['GITABIGDECIFZ000003']?.value?.bigDecimalValue ?? null,
        Extrinsic_Aliquota_ICMS: byId['GITABIGDECIFZ000004']?.value?.bigDecimalValue ?? null,
        Extrinsic_ICMS_Apurado: moneyObj(byId['GITAMONEYIFZ000046']).amount,
        Extrinsic_Aliquota_IPI: byId['GITABIGDECIFZ000005']?.value?.bigDecimalValue ?? null,
        Extrinsic_IPI_Apurado: moneyObj(byId['GITAMONEYIFZ000047']).amount,
        Extrinsic_Aliquota_PIS: byId['GITABIGDECIFZ000029']?.value?.bigDecimalValue ?? null,
        Extrinsic_PIS_Apurado: moneyObj(byId['GITAMONEYIFZ000048']).amount,
        Extrinsic_Aliquota_Cofins: byId['GITABIGDECIFZ000028']?.value?.bigDecimalValue ?? null,
        Extrinsic_Cofins_apurado: moneyObj(byId['GITAMONEYIFZ000049']).amount,
        Extrinsic_Aliquota_ICMS_Interna: byId['GITABIGDECIFZ000006']?.value?.bigDecimalValue ?? null,
        Extrinsic_Origem_do_Material: byId['GITASHORTSTRINGIFZ000153']?.value?.simpleValue ?? null,

        // Demais
        EXTENDEDPRICE: ext.amount,
        PLANT: byId['Plant']?.value?.simpleValue ?? null,
        ItemCategory: byId['ItemCategory']?.value?.simpleValue ?? null,
        TAX_CODE: byId['GITASHORTSTRINGIFZ000152']?.value?.simpleValue ?? null,
        MaterialCode: byId['MaterialCode']?.value?.simpleValue ?? null,
        grupo_de_materias: byId['MaterialGroup']?.value?.simpleValue ?? null
      };

      results.push({ ...mapped, _invitationId: invId, _itemId: itemId });
    }
  }

  return { rows, results };
}

async function fetchParentProjectId(docId, headersCommon) {
  const path = `/events/identifiers`;
  let data;

  if (USE_DESTINATION) {
    data = await destGet(EVENTS_DEST, path, { timeoutMs: TIMEOUT });
  } else {
    const url = `${ARIBA_BASE_URL_EVENTS}${path}`;
    const resp = await axios.get(url, {
      params: { ...q, $filter: '(createDateFrom gt 01082025000000 and createDateTo lt 31122025000000)' },
      headers: headersCommon,
      timeout: TIMEOUT
    });
    data = resp.data;
  }

  const arr = toArr(data);
  return arr.find((x) => String(x?.internalId) === String(docId))?.parentProjectId ?? null;
}

async function fetchSupplierInvitationsList(docId, round, headersCommon) {
  const path = `/events/${encodeURIComponent(docId)}/rounds/${encodeURIComponent(round)}/supplierInvitations`;
  if (USE_DESTINATION) return toArr(await destGet(EVENTS_DEST, path, { timeoutMs: TIMEOUT }));
  const url = `${ARIBA_BASE_URL_EVENTS}${path}`;
  const { data } = await axios.get(url, { params: q, headers: headersCommon, timeout: TIMEOUT });
  return toArr(data);
}

async function fetchSupplierInvitationById(docId, round, resourceId, headersCommon) {
  if (!resourceId) return null;
  const path = `/events/${encodeURIComponent(docId)}/rounds/${encodeURIComponent(round)}/supplierInvitations/${encodeURIComponent(resourceId)}`;

  let data;
  if (USE_DESTINATION) {
    data = await destGet(EVENTS_DEST, path, { timeoutMs: TIMEOUT });
  } else {
    const url = `${ARIBA_BASE_URL_EVENTS}${path}`;
    const resp = await axios.get(url, { params: q, headers: headersCommon, timeout: TIMEOUT });
    data = resp.data;
  }

  const supplierName =
    data?.organization?.name ||
    data?.mainContact?.orgName ||
    data?.mainContact?.organization ||
    (Array.isArray(data?.contacts) && (data.contacts[0]?.orgName || data.contacts[0]?.organization)) ||
    data?.organizationName ||
    data?.supplier?.organizationName ||
    data?.supplier?.name ||
    data?.supplierName ||
    null;

  const emailDetected =
    data?.mainContact?.emailAddress ||
    data?.emailAddress ||
    data?.supplier?.email ||
    data?.supplierEmail ||
    data?.contact?.email ||
    (String(resourceId).includes('_') ? String(resourceId).split('_')[1] : null) ||
    null;

  return {
    supplierName: supplierName || (emailDetected ? String(emailDetected).split('@')[0] : null),
    supplierEmail: emailDetected
  };
}

/** ======================== HANDLERS ODATA ======================== */
module.exports = function () {
  this.on('GetQuotes', async (req) => {
    const { docId } = req.data || {};
    if (!docId) return req.error(400, "Parâmetro 'docId' é obrigatório.");

    const round = DEFAULT_ROUND;

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
      // 1) Supplier bids
      const { rows, results } = await fetchSupplierBids(docId, headersCommon);
      if (!rows.length || !results.length) return { header: null, items: [] };

      // 2) Cache de nomes por invitationId com busca em massa + resoluções pontuais
      const inviteIds = [...new Set(results.map((r) => r._invitationId).filter(Boolean))];
      const nameCache = new Map();
      const emailByInvId = new Map();

      let list = [];
      try {
        list = await fetchSupplierInvitationsList(docId, round, headersCommon);
      } catch (_) {}

      for (const it of list) {
        const invId = String(it?.invitationId ?? it?.userId ?? it?.uniqueName ?? '');
        if (!invId) continue;

        const email =
          it?.emailAddress ||
          it?.supplierEmail ||
          it?.email ||
          it?.mainContact?.emailAddress ||
          it?.contact?.email ||
          null;
        if (email) emailByInvId.set(invId, email);

        const name =
          it?.organization?.name || it?.supplierName || it?.organizationName || it?.supplier?.name || null;
        if (name) nameCache.set(invId, name);
      }

      for (const invId of inviteIds) {
        if (nameCache.has(invId)) continue;

        let resourceId = null;
        if (String(invId).includes('_')) {
          resourceId = String(invId);
        } else {
          const email = emailByInvId.get(String(invId));
          if (email) resourceId = `${String(invId)}_${String(email)}`;
        }

        if (resourceId) {
          try {
            const inv = await fetchSupplierInvitationById(docId, round, resourceId, headersCommon);
            if (inv?.supplierName) nameCache.set(invId, inv.supplierName);
          } catch (_) {}
        }

        if (!nameCache.has(invId)) {
          const fallback = pickSupplierNameByInvitation(rows, invId) || pickSupplierNameFromRows(rows);
          if (fallback) nameCache.set(invId, fallback);
        }
      }

      // 3) Identifiers → parentProjectId
      let parentProjectId = null;
      try {
        parentProjectId = await fetchParentProjectId(docId, headersCommon);
      } catch (_) {}

      // 4) Header (PM)
      let header = null;
      try {
        if (parentProjectId) header = await fetchAribaHeader(parentProjectId);
      } catch (_) {}

      // 5) Retorno
      const headerWithDoc = { docId, ...(header || {}), supplierName: null };
      const itemsOut = results.map((r) => {
        const supplierName = r._invitationId ? nameCache.get(r._invitationId) || null : null;
        const email = emailByInvId.get(String(r._invitationId)) || null;
        const { _invitationId, _itemId, ...pub } = r;
        return {
          ...pub,
          supplierName,
          itemId: r._itemId,
          invitationId: r._invitationId,
          invitationEmail: email
        };
      });

      return { header: headerWithDoc, items: itemsOut };
    } catch (e) {
      const status = e.response?.status || 502;
      const msg = e.response?.data?.message || e.response?.data || e.message;
      LOG.error('[GetQuotes] Erro Ariba:', status, msg);
      return req.error(status, 'Falha ao consultar supplierBids no Ariba.');
    }
  });

  this.on('SimulateBapiPoCreate1', async (req) => {
    LOG.info('[SimulateBapiPoCreate] req.data =', JSON.stringify(req.data, null, 2));

    const { items = [], header = {} } = req.data ?? {};
    LOG.info('[SimulateBapiPoCreate] items.length =', Array.isArray(items) ? items.length : `(!array: ${typeof items})`);
    LOG.info('[SimulateBapiPoCreate] header =', header);

    if (!Array.isArray(items)) return req.error(400, "'items' deve ser um array.");
    if (!items.length) LOG.warn("[SimulateBapiPoCreate] 'items' chegou vazio.");

    // Resolver LIFNR por item quando não informado
    async function resolveLifnrForItem(it) {
      if (it.lifnr) return String(it.lifnr).padStart(10, '0');
      throw Object.assign(
        new Error(
          `Não foi possível resolver LIFNR para o fornecedor do item (ex.: ${it.supplierName || it.MaterialCode || 'sem identificação'})`
        ),
        { userMessage: true }
      );
    }

    const itemsComLifnr = [];
    for (const it of items) {
      const lifnr = await resolveLifnrForItem(it).catch((err) => {
        throw req.error(400, err.userMessage ? err.message : `Falha ao resolver LIFNR: ${err.message}`);
      });
      itemsComLifnr.push({ ...it, lifnr });
    }

    const grupos = itemsComLifnr.reduce((acc, it) => {
      (acc[it.lifnr] ||= []).push(it);
      return acc;
    }, {});

    const respostas = [];
    for (const [lifnr, grupo] of Object.entries(grupos)) {
      const cab = { ...header, fornecedor: lifnr };
      try {
        const resp = await simularPO(grupo, cab);
        respostas.push({ lifnr, ...resp });
      } catch (e) {
        const msg = e.userMessage || e.message || `Erro ao simular para LIFNR ${lifnr}`;
        return req.error(400, msg);
      }
    }

    const success = respostas.every((r) => r.success);
    const messages = respostas.flatMap((r) => r.messages || []);
    const tabelaItens = respostas.flatMap((r) => (r.tabelaItens || []).map((line) => ({ ...line, fornecedor: r.lifnr })));
    const purchaseOrder = null; // Em TESTRUN pode não existir; multi-fornecedor geraria múltiplas ordens.

    return { success, messages, purchaseOrder, tabelaItens };
  });

  this.on('SimulateBapiPoCreate', async (req) => {
    try {
      const { items = [], header = {} } = req.data ?? {};
      const resp = await simularPO(items, header);
      return resp;
    } catch (e) {
      const msg = e.userMessage || e.message || 'Falha ao simular pedido.';
      return req.error(400, msg);
    }
  });

 // ################################ BEATRIZ - CRIA SCENARIO #####################################
  this.on('CreateScenario', async (req) => {
    const { eventId, title, scenarioType, supplierBids } = req.data || {};
    if (!eventId) return req.error(400, "Parâmetro 'eventId' é obrigatório.");
    if (!Array.isArray(supplierBids) || supplierBids.length === 0) {
      return req.error(400, "'supplierBids' deve ser um array com pelo menos 1 item.");
    }

    const payload = {
      eventId,
      title: title || 'Cenário via API',
      scenarioType: Number.isFinite(+scenarioType) ? +scenarioType : 0,
      supplierBids: supplierBids.map((it) => ({
        eventId,
        itemId: Number(it.itemId),
        invitationId: String(it.invitationId || ''),
        bidType: it.bidType || 'Primary',
        winningSplitType: Number(it.winningSplitType ?? 1),
        winningSplitValue: Number(it.winningSplitValue ?? 100)
      }))
    };

    // 🔎 LOG do que será enviado para a premiação
    LOG.info('[CreateScenario] Payload de premiação (CreateScenario) ⇒',
      JSON.stringify({
        eventId: payload.eventId,
        title: payload.title,
        scenarioType: payload.scenarioType,
        supplierBidsCount: payload.supplierBids.length,
        supplierBids: payload.supplierBids
      }, null, 2)
    );

    const relPath = `/events/${encodeURIComponent(eventId)}/scenarios`;

    // 🔎 LOG do destino/URL da chamada
    LOG.info('[CreateScenario] Alvo da chamada ⇒',
      USE_DESTINATION
        ? `Destination "${EVENTS_DEST}" path "${relPath}"`
        : `${ARIBA_BASE_URL_EVENTS}${relPath}`
    );

    try {
      let data, headers;
      if (USE_DESTINATION) {
        ({ data, headers } = await destPost(EVENTS_DEST, relPath, payload, { timeoutMs: TIMEOUT }));
      } else {
        const token = await getAccessToken();
        const url = `${ARIBA_BASE_URL_EVENTS}${relPath}`;
        const resp = await axios.post(url, payload, {
          params: q,
          headers: {
            apiKey: ARIBA_API_KEY_EVENTS,
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          timeout: TIMEOUT
        });
        data = resp.data;
        headers = resp.headers;
      }

      const correlationId = headers?.['x-correlation-id'] || headers?.['x-correlationid'] || null;
      const scenarioId = data?.scenarioId || data?.id || data?.scenarioID || null;

      return { success: true, scenarioId, aribaResponse: JSON.stringify(data), correlationId };
    } catch (e) {
      const { status, correlationId, userMessage, technical } = formatAribaScenarioError(e);
      LOG.error('[CreateScenario] Falha no POST /scenarios:', technical);
      return req.error(status, userMessage, { correlationId, technical });
    }
  });
   // ################################ FIM - BEATRIZ - CRIA SCENARIO #####################################

};
