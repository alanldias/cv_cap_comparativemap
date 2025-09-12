try { require('dotenv').config() } catch { }

const cds = require('@sap/cds')
const axios = require('axios')
const { getDestination } = require('@sap-cloud-sdk/connectivity')
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client')
const { getSoapService } = require('./soap-destination');




// tenta usar o helper se a sua versão do SDK expor; caso contrário, caímos no fallback
let addDestinationToRequestConfig
try {
  addDestinationToRequestConfig = require('@sap-cloud-sdk/connectivity').addDestinationToRequestConfig
} catch (_) {
  addDestinationToRequestConfig = null
}

// Log
const LOG = cds.log('ariba-service')

// Token dos ENDPOINTS de EVENTS (teu projeto)
// const { getAccessToken } = require('../srv/auth/aribaOauth')


// ==================== PARA CHAMADA SOAP ====================
const WSDL_PATH = './srv/external/bapi_po_create1.wsdl';


// ==================== SWITCH DESTINATION vs .ENV ====================
const HTTP_TIMEOUT_MS = 30000
const ARIBA_EVENT_ROUND = 1
const EVENTS_DEST = 'ARIBA_Event_Management_Test'
const PROJECTS_DEST = 'ARIBA_Sourcing_Project_Management_Test'

const EVENTS_API_PREFIX = '/api/sourcing-event/v2/prod'
const PM_API_PREFIX = '/api/sourcing-project-management/v2/prod'

// ==== S/4 Defaults ====
const S4H_DEST = 'S4H_QAS_CQ5_MAPA'
const S4H_SAP_CLIENT = '300'
const S4H_ODATA_PATH = '/sap/opu/odata/sap/API_INFORECORD_PROCESS_SRV/A_PurgInfoRecdOrgPlantData'
const S4H_TIMEOUT_MS = HTTP_TIMEOUT_MS

// ==== Token cache (OAuth dest) ====
const _destTokenCache = {}

const DBG_PREFIX = '[ARIBA]';
const dbg = (...args) => console.log(DBG_PREFIX, ...args);
const mask = (s) => {
  if (s == null) return s;
  const t = String(s);
  if (t.length <= 6) return '***';
  return `${t.slice(0, 4)}***${t.slice(-2)}`;
};


function _escapeOData(v = '') {
  return String(v).replace(/'/g, "''").trim()
}
function _makeKey(Supplier, Material, PurchasingOrganization, Plant) {
  return [Supplier, Material, PurchasingOrganization, Plant].map(v => (v ?? '').trim()).join('|')
}


async function _fetchTokenFromDestination(destination) {
  const op = destination.originalProperties || {}

  // Tenta várias chaves para o token URL
  let base =
    destination.tokenServiceUrl ||
    destination.tokenUrl ||
    destination.token_service_url ||
    op.tokenServiceURL ||
    op.TokenServiceURL ||
    op['URL.tokenServiceURL']

  if (!base) throw new Error('Destination não possui tokenServiceUrl')
  const tokenUrl = /\/oauth\b/i.test(base) ? base.replace(/\/$/, '') : base.replace(/\/$/, '') + '/oauth/token'
  dbg('[token] tokenUrl decidido =', tokenUrl)

  // Tenta várias chaves para clientId/secret
  const clientId =
    destination.clientId || destination.clientid || destination.client_id ||
    op.clientId || op.clientid || op.client_id
  const clientSecret =
    destination.clientSecret || destination.clientsecret || destination.client_secret ||
    op.clientSecret || op.clientsecret || op.client_secret
  dbg('[token] clientId =', mask(clientId), '| clientSecret = (oculto)')

  const grantType =
    destination.grantType || destination.grant_type || op.grantType || op.grant_type || 'client_credentials'
  dbg('[token] grantType =', grantType)

  if (!clientId || !clientSecret) throw new Error('Faltando clientId/clientSecret no destination')

  const key = tokenUrl + '|' + clientId
  const now = Date.now()
  if (_destTokenCache[key] && now < _destTokenCache[key].exp - 60_000) return _destTokenCache[key].token
  dbg('[token] cache miss → solicitando novo token')

  const includeGrantInBody = !/\bgrant_type=/.test(tokenUrl)
  const body = new URLSearchParams()
  if (includeGrantInBody) body.append('grant_type', grantType)
  if (destination.scope || op.scope) body.append('scope', destination.scope || op.scope)

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const resp = await axios.post(tokenUrl, body.toString(), {
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: Number(HTTP_TIMEOUT_MS) || 15000
  })
  const { access_token, expires_in } = resp.data || {}
  dbg('[token] obtido com sucesso. expires_in =', expires_in)
  _destTokenCache[key] = { token: access_token, exp: now + (expires_in ?? 3600) * 1000 }
  return access_token
}

function _maybePrefixPath(destName, relativePath) {
  const rel = relativePath.startsWith('/') ? relativePath : `/${relativePath}`

  // Events: /events/... => /api/sourcing-event/v2/prod/events/...
  if (destName === EVENTS_DEST && /^\/events(\/|$)/i.test(rel)) {
    return `${EVENTS_API_PREFIX}${rel}`
  }

  // Projects/PM: /projects/... => /api/sourcing-project-management/v2/prod/projects/...
  if (destName === PROJECTS_DEST && /^\/projects(\/|$)/i.test(rel)) {
    return `${PM_API_PREFIX}${rel}`
  }

  return relativePath
}

// === Helpers de normalização de Destination ===
function _op(dest) {
  // retorna um objeto flat com tudo que acharmos
  const op = dest?.originalProperties || {}
  const out = { ...op }

  // 1) Alguns ambientes colocam em op.Properties = { k: v }
  if (op && typeof op.Properties === 'object' && op.Properties) {
    Object.entries(op.Properties).forEach(([k, v]) => {
      if (out[k] == null) out[k] = v
    })
  }

  // (2) destinationConfiguration (object) — comum no BTP
  if (op && typeof op.destinationConfiguration === 'object' && op.destinationConfiguration) {
    Object.entries(op.destinationConfiguration).forEach(([k, v]) => {
      if (out[k] == null) out[k] = v
    })
  }

  // (3) additionalProperties/AdditionalProperties (array de {key/value} ou {name/value})
  const arr = op.additionalProperties || op.AdditionalProperties
  if (Array.isArray(arr)) {
    for (const it of arr) {
      const k = it?.key ?? it?.Key ?? it?.name ?? it?.Name
      const v = it?.value ?? it?.Value
      if (k != null && out[k] == null) out[k] = v
    }
  }

  return out
}
function _findAdditionalProp(destination, name) {
  const op = _op(destination)
  const keys = Object.keys(op)
  const hit = keys.find(k => String(k).toLowerCase() === String(name).toLowerCase())
  if (hit) return op[hit]

  // formatos "namespaced" comuns do cockpit
  const low = String(name).toLowerCase()
  if (low === 'realm') return op['URL.queries.realm'] ?? op['url.queries.realm'] ?? null
  if (low === 'user') return op['URL.queries.user'] ?? op['url.queries.user'] ?? null
  if (low === 'passwordadapter') return op['URL.queries.passwordAdapter'] ?? op['url.queries.passwordAdapter'] ?? null
  if (low === 'sap-client') return op['URL.queries.sap-client'] ?? op['url.queries.sap-client'] ?? null
  return null
}

function _mergeQueryParamsFromDestination(destination, params = {}) {
  const op = _op(destination)
  const out = { ...params }

  // 1) URL.queries.*
  for (const [k, v] of Object.entries(op)) {
    const m = /^URL\.queries\.(.+)$/i.exec(k)
    if (m && v != null && v !== '' && out[m[1]] == null) out[m[1]] = String(v)
  }

  // 2) chaves soltas (case-insensitive) + variantes
  for (const k of ['realm', 'user', 'passwordAdapter', 'sap-client']) {
    if (out[k] != null && out[k] !== '') continue
    const val =
      _findAdditionalProp(destination, k) ??
      op[k] ?? op[k?.toLowerCase?.()] ?? op[k?.toUpperCase?.()] ??
      destination[k]
    if (val != null && val !== '') out[k] = String(val)
  }

  return out
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
  try { raw = JSON.stringify(body); } catch (_) { }
  if (raw && raw.length > 2000) raw = raw.slice(0, 2000) + '...';

  return {
    status,
    correlationId,
    userMessage,
    technical: { status, code, message, description, raw }
  };
}

function _mergeHeadersFromDestination(destination, headers = {}) {
  const op = _op(destination)
  const out = { ...headers }

  // 1) Pega URL.headers.*
  for (const [k, v] of Object.entries(op)) {
    const m = /^URL\.headers\.(.+)$/i.exec(k)
    if (m && v != null && v !== '' && out[m[1]] == null) out[m[1]] = String(v)
  }

  // 2) Tolerância: apiKey em variações e defaults comuns
  for (const name of ['apiKey', 'apikey', 'APIKey']) {
    if (out[name] != null && out[name] !== '') continue
    const val = op[name] ?? destination.headers?.[name]
    if (val != null && val !== '') out[name] = String(val)
  }

  // (opcional) se quiser garantir Accept/Content-Type por aqui
  out.Accept ??= 'application/json'
  out['Content-Type'] ??= 'application/json'

  return out
}
async function destPost(destName, relativePath, body, { params = {}, headers = {}, timeoutMs = 30000 } = {}) {
  dbg('[destPost] START', { destName, relativePath })
  const destination = await getDestination({ destinationName: destName, useCache: false })
  if (!destination) throw new Error(`Destination ${destName} não encontrada`)
  dbg('[destPost] destination.url =', destination.url)

  const urlPath = _maybePrefixPath(destName, relativePath)
  dbg('[destPost] computed path =', urlPath)

  const baseCfg = {
    method: 'post',
    url: urlPath,
    data: body,
    params: { ...params },
    headers: { ...headers },
    timeout: Number(timeoutMs) || 30000
  }

  // Flatten das Additional Properties
  const op = _op(destination)

  // 1) Query params da Destination + “soltos”
  baseCfg.params = _mergeQueryParamsFromDestination(destination, baseCfg.params)
  // 2) Força realm/user/passwordAdapter p/ Ariba
  baseCfg.params = _ensureAribaQueryParams(destName, destination, baseCfg.params)

  // 3) Headers da Destination (URL.headers.* + apiKey etc.)
  baseCfg.headers = _mergeHeadersFromDestination(destination, baseCfg.headers)

  let reqCfg
  if (addDestinationToRequestConfig) {
    try {
      reqCfg = await addDestinationToRequestConfig(baseCfg, destination)
      dbg('[destPost] usando addDestinationToRequestConfig (SDK)')
    } catch (e) {
      LOG.warn?.('[destPost] addDestinationToRequestConfig falhou; usando fallback:', e.message)
    }
  }

  if (!reqCfg) {
    reqCfg = {
      baseURL: destination.url,
      ...baseCfg,
      headers: { ...(destination.headers || {}), ...(baseCfg.headers || {}) }
    }

    if (destination.authTokens?.[0]?.value) {
      reqCfg.headers.authorization ||= `Bearer ${destination.authTokens[0].value}`
      dbg('[destPost] usando auth token já presente na destination')
    } else if ((destination.authentication || '').toLowerCase() === 'oauth2clientcredentials') {
      try {
        const token = await _fetchTokenFromDestination(destination)
        if (token) reqCfg.headers.authorization = `Bearer ${token}`
        dbg('[destPost] token OAuth adicionado ao header Authorization')
      } catch (e) {
        LOG.error?.('[destPost] erro ao obter token:', e.message)
        dbg('[destPost] erro ao obter token:', e.message)
      }
    }
  }

  // ---------- API KEY (Destination -> ENV fallback) ----------
  const keyFromOP = Object.entries(op).find(([k]) => /^URL\.headers\.(api[-_]?key)$/i.test(k))?.[1]
  let apiKey =
    reqCfg.headers.apiKey || reqCfg.headers.APIKey || reqCfg.headers.apikey || reqCfg.headers['api-key'] ||
    (destination.headers || {}).apiKey || (destination.headers || {})['api-key'] || keyFromOP

  if (!apiKey) {
    const envApiKey =
      destName === EVENTS_DEST
        ? process.env.ARIBA_API_KEY_EVENTS
        : destName === PROJECTS_DEST
          ? process.env.ARIBA_API_KEY_PROJECTS
          : null
    if (envApiKey) {
      apiKey = envApiKey
      dbg('[destPost] apiKey via ENV para', destName, '→ presente')
    } else {
      dbg('[destPost] apiKey AUSENTE (ok se endpoint não exigir)')
    }
  } else {
    dbg('[destPost] apiKey obtida da Destination (valor oculto)')
  }

  if (apiKey) {
    reqCfg.headers.apiKey = apiKey
    dbg('[destPost] Header apiKey final adicionado.')
  }
  // -----------------------------------------------------------

  reqCfg.headers.Accept ??= 'application/json'
  reqCfg.headers['Content-Type'] ??= 'application/json'
  dbg('[destPost] REQUEST =>', { method: reqCfg.method || 'POST', baseURL: reqCfg.baseURL, url: reqCfg.url, timeout: reqCfg.timeout })

  const resp = await axios.request(reqCfg)
  dbg('[destPost] RESPONSE OK status =', resp.status)
  return { data: resp.data, headers: resp.headers, status: resp.status }
}
// ==================== HELPER: GET via Destination (robusto) ====================
async function destGet(destName, relativePath, { params = {}, headers = {}, timeoutMs = 30000 } = {}) {
  dbg('[destGet] START', { destName, relativePath })
  const destination = await getDestination({ destinationName: destName, useCache: false })
  if (!destination) throw new Error(`Destination ${destName} não encontrada`)
  dbg('[destGet] destination.url =', destination.url)

  const urlPath = _maybePrefixPath(destName, relativePath)
  dbg('[destGet] computed path =', urlPath)

  const baseCfg = {
    method: 'get',
    url: urlPath,
    params: { ...params },
    headers: { ...headers },
    timeout: Number(timeoutMs) || 30000
  }

  // Use sempre o flatten dos Additional Properties
  const op = _op(destination)
  dbg('[destGet] op keys snapshot ->', Object.keys(op).slice(0, 25))
  dbg('[destGet] op realm candidates ->', {
    'realm': op.realm,
    'URL.queries.realm': op['URL.queries.realm'],
    'destinationConfiguration.realm': op?.destinationConfiguration?.realm
  })

  // 1) Pega QUALQUER URL.queries.* + chaves “soltas”
  baseCfg.params = _mergeQueryParamsFromDestination(destination, baseCfg.params)
  // 2) Garante realm/user/passwordAdapter para as duas destinations do Ariba
  baseCfg.params = _ensureAribaQueryParams(destName, destination, baseCfg.params)

  // logs úteis
  dbg('[destGet] merged params keys =', Object.keys(baseCfg.params))
  dbg('[destGet] merged params (realm/user/passwordAdapter) =', {
    realm: baseCfg.params.realm,
    user: baseCfg.params.user,
    passwordAdapter: baseCfg.params.passwordAdapter
  })

  baseCfg.headers = _mergeHeadersFromDestination(destination, baseCfg.headers)
  dbg('[destGet] merged params keys =', Object.keys(baseCfg.params))
  dbg('[destGet] merged headers keys =', Object.keys(baseCfg.headers))

  let reqCfg
  if (addDestinationToRequestConfig) {
    try {
      reqCfg = await addDestinationToRequestConfig(baseCfg, destination)
      dbg('[destGet] usando addDestinationToRequestConfig (SDK)')
    } catch (e) {
      LOG.warn?.('[destGet] addDestinationToRequestConfig falhou; usando fallback:', e.message)
      dbg('[destGet] SDK helper falhou → fallback manual')
    }
  }

  if (!reqCfg) {
    reqCfg = {
      baseURL: destination.url,
      ...baseCfg,
      headers: { ...(destination.headers || {}), ...(baseCfg.headers || {}) }
    }

    if (destination.authTokens?.[0]?.value) {
      reqCfg.headers.authorization ||= `Bearer ${destination.authTokens[0].value}`
      dbg('[destGet] usando auth token já presente na destination')
    } else if ((destination.authentication || '').toLowerCase() === 'oauth2clientcredentials') {
      try {
        const token = await _fetchTokenFromDestination(destination)
        if (token) reqCfg.headers.authorization = `Bearer ${token}`
        dbg('[destGet] token OAuth adicionado ao header Authorization')
      } catch (e) {
        LOG.error?.('[destGet] erro ao obter token:', e.message)
        dbg('[destGet] erro ao obter token:', e.message)
      }
    }
  }

  // ---------- API KEY (Destination -> ENV fallback) ----------
  const dh = destination.headers || {}
  // 'op' agora já é flatten (_op(destination)), então pega 'URL.headers.apiKey' mesmo se estiver em additionalProperties
  const keyFromOP = Object.entries(op).find(([k]) => /^URL\.headers\.(api[-_]?key)$/i.test(k))?.[1]

  let apiKey =
    reqCfg.headers.apiKey || reqCfg.headers.APIKey || reqCfg.headers.apikey || reqCfg.headers['api-key'] ||
    dh.apiKey || dh.APIKey || dh.apikey || dh['api-key'] ||
    keyFromOP

  if (!apiKey) {
    // fallback por destination
    const envApiKey =
      destName === EVENTS_DEST
        ? process.env.ARIBA_API_KEY_EVENTS
        : destName === PROJECTS_DEST
          ? process.env.ARIBA_API_KEY_PROJECTS
          : null

    if (envApiKey) {
      apiKey = envApiKey
      dbg('[destGet] apiKey via ENV para', destName, '→ presente')
    } else {
      dbg('[destGet] apiKey AUSENTE (ok se endpoint não exigir)')
    }
  } else {
    dbg('[destGet] apiKey obtida da Destination (valor oculto)')
  }

  if (apiKey) {
    reqCfg.headers.apiKey = apiKey;
    dbg('[destGet] Header apiKey final adicionado.');
  }
  // -----------------------------------------------------------

  reqCfg.headers.Accept ??= 'application/json'
  reqCfg.headers['Content-Type'] ??= 'application/json'
  dbg('[destGet] final headers keys =', Object.keys(reqCfg.headers))
  dbg('[destGet] REQUEST =>', { method: reqCfg.method || 'GET', baseURL: reqCfg.baseURL, url: reqCfg.url, timeout: reqCfg.timeout })
  const resp = await axios.request(reqCfg)
  const len = Array.isArray(resp.data) ? resp.data.length : (resp.data?.payload?.length ?? 'n/a')
  dbg('[destGet] RESPONSE OK status =', resp.status, '| data.len =', len)
  return resp.data
}

function _ensureAribaQueryParams(destName, destination, params) {
  // só força para as duas destinations do Ariba
  if (destName !== EVENTS_DEST && destName !== PROJECTS_DEST) return params

  const out = { ...params }

  // 1) tenta destination (additional properties, chaves soltas e URL.queries.*)
  let realm = out.realm ?? _findAdditionalProp(destination, 'realm')
  let user = out.user ?? _findAdditionalProp(destination, 'user')
  let pad = out.passwordAdapter ?? _findAdditionalProp(destination, 'passwordAdapter')

  // 2) fallback via ENV (mesmo user/passwordAdapter para ambas)
  realm ||= process.env.ARIBA_REALM            // opcional, se quiser permitir override por ENV
  user ||= process.env.ARIBA_USER             // << defina no CF
  pad ||= process.env.ARIBA_PASSWORD_ADAPTER // << defina no CF

  if (realm) out.realm = String(realm).trim()
  if (user) out.user = String(user).trim()
  if (pad) out.passwordAdapter = String(pad).trim()

  return out
}

// ==================== CÓDIGO PM (PROJECTS) ====================

async function aribaPmGet(path, params = {}) {
  dbg('[aribaPmGet] path =', path, '| params =', params)
  return await destGet(PROJECTS_DEST, path, {
    params, headers: {}, timeoutMs: Number(HTTP_TIMEOUT_MS) || 30000
  })
}

// ==================== MAPEAMENTO HEADER PM ====================
const firstToken = (s) => (s || '').trim().split(' ')[0] || null
const cut = (s, n) => (s || '').substring(0, n) || null

function getCustomField(p, fieldId) {
  const pools = [
    p?.externalFields,
    p?.sourcingProjectCustomFields,
    p?.projectCustomFields,
    p?.fields,
    p?.customFields
  ].filter(Boolean)

  for (const arr of pools) {
    const f = (arr || []).find(x => x.fieldId === fieldId)
    if (!f) continue
    if (Array.isArray(f.flexMasterDataTypeValue)) return f.flexMasterDataTypeValue[0]
    if (Array.isArray(f.textValue)) return f.textValue[0]
    if (Array.isArray(f.values) && f.values[0]) return f.values[0].value || f.values[0].name
    if ('booleanValue' in f) return String(f.booleanValue)
    if ('numberValue' in f) return String(f.numberValue)
    if ('value' in f) return f.value
  }
  return null
}

function mapAribaHeader(p) {
  const bs = p?.businessSystem || {}
  const docCat = bs?.documentCategory?.[0]?.value || bs?.documentCategory?.[0]?.key || null
  const purOrg = bs?.purchasingOrganization?.[0]?.value || bs?.purchasingOrganization?.[0]?.key || null
  const purGrp = bs?.purchasingGroup?.[0]?.value || bs?.purchasingGroup?.[0]?.key || null
  const compCode = bs?.companyCode?.[0]?.value || bs?.companyCode?.[0]?.key || null

  const inc1 = getCustomField(p, 'cus_wsincoterms') || getCustomField(p, 'cus_wsIncoterms')
  const inc2 = getCustomField(p, 'cus_wslocal')
  const payt = getCustomField(p, 'arb_PaymentTerms')

  return {
    tipoPedido: docCat,
    purchasingOrganization: cut(firstToken(purOrg), 4),
    purchasingGroup: cut(firstToken(purGrp), 3),
    companyCode: cut(firstToken(compCode), 4),
    incoterms1: inc1,
    incoterms2: inc2,
    paymentTerms: payt || null
  }
}

// ==================== HELPERS (EVENTS) ====================
const toArr = (d) =>
  Array.isArray(d?.payload) ? d.payload :
    Array.isArray(d) ? d :
      (d ? [d] : [])

const termsFrom = (row) => (row?.item?.terms || row?.terms || [])
const byFieldId = (row) =>
  Object.fromEntries(termsFrom(row).filter(t => t?.fieldId).map(t => [t.fieldId, t]))

const moneyObj = (term) => {
  const mv = term?.value?.moneyValue || term?.value?.supplierValue
  return mv ? { amount: mv.amount ?? null, currency: mv.currency ?? null }
    : { amount: null, currency: null }
}

// fallback de nome genérico
function pickSupplierNameFromRows(rows) {
  if (!Array.isArray(rows)) return null
  const hit = rows.find(r =>
    r?.organization?.name ||
    r?.supplier?.name || r?.supplierName || r?.organizationName || r?.supplier?.organizationName
  )
  return (
    hit?.organization?.name ||
    hit?.supplier?.name ||
    hit?.supplierName ||
    hit?.organizationName ||
    hit?.supplier?.organizationName ||
    null
  )
}

// fallback de nome por invitationId específico
function pickSupplierNameByInvitation(rows, invId) {
  const hit = rows.find(r => String(r?.invitationId) === String(invId))
  if (!hit) return null
  return (
    hit?.organization?.name ||
    hit?.supplier?.name ||
    hit?.supplierName ||
    hit?.organizationName ||
    hit?.supplier?.organizationName ||
    null
  )
}

function extractSapVendorId(obj) {
  const org = obj?.organization ?? obj?.supplier ?? null
  if (!org) return null
  const arr = org.organizationIDs || org.organizationIds || obj.organizationIDs || obj.organizationIds || []
  const hit = Array.isArray(arr) ? arr.find(x => String(x?.domain).toLowerCase() === 'sap') : null
  return hit?.value ?? org?.erpVendorID ?? null
}

function extractSapOrgEntry(obj) {
  const org = obj?.organization ?? obj?.supplier ?? null
  if (!org) return null
  const arr = org.organizationIDs || org.organizationIds || obj.organizationIDs || obj.organizationIds || []
  if (!Array.isArray(arr)) return null
  const entry = arr.find(x => String(x?.domain).toLowerCase() === 'sap') || null
  return entry ? { domain: entry.domain, value: entry.value } : null
}

//CHAMADA DE API /api/sourcing-project-management/v2/prod/projects/WS
async function fetchAribaHeader(projectId) {
  dbg('[fetchAribaHeader] projectId =', projectId)
  const data = await aribaPmGet(`/projects/${encodeURIComponent(projectId)}`)
  return mapAribaHeader(data || {})
}

/**
 * 1) supplierBids:
 *    - Para CADA fornecedor (row) e CADA itemId em itemsWithBid, gera um resultado.
 *    - Para mapear valores do item, procura uma row cujo item.itemId == itemId
 *      priorizando a mesma invitationId; se não achar, usa a primeira que casar o itemId.
 *    - Retorna:
 *        { rows, results: [ { mappedFields..., _invitationId, _itemId } ] }
 */

//CHAMADA DE API /api/sourcing-event/v2/prod/events/DocId/supplierBids
async function fetchSupplierBids(docId) {
  dbg('[fetchSupplierBids] docId =', docId)
  const path = `/events/${encodeURIComponent(docId)}/supplierBids`

  const data = await destGet(EVENTS_DEST, path, {
    params: {}, headers: {}, timeoutMs: HTTP_TIMEOUT_MS
  })

  const rows = toArr(data)
  dbg('[fetchSupplierBids] rows =', Array.isArray(rows) ? rows.length : 0)
  if (!rows.length) return { rows: [], results: [] }

  const results = []

  for (const row of rows) {
    const invId = row?.invitationId ?? null
    const itemIds = Array.isArray(row?.itemsWithBid) ? row.itemsWithBid.map(String) : []
    if (!itemIds.length) continue

    for (const itemId of itemIds) {
      // 1) achar uma linha com os termos do item
      let targetRow =
        rows.find(r => String(r?.item?.itemId ?? r?.itemId) === String(itemId) && String(r?.invitationId) === String(invId)) ||
        rows.find(r => String(r?.item?.itemId ?? r?.itemId) === String(itemId))

      if (!targetRow) continue

      const byId = byFieldId(targetRow)
      // Tenta pegar o LIFNR direto dos termos do Ariba (ajuste as chaves conforme seu template)
      const lifnrTerm =
        byId['LIFNR']?.value?.simpleValue ||
        byId['VendorNumber']?.value?.simpleValue ||
        byId['ERPVendor']?.value?.simpleValue ||
        byId['ERPVENDOR']?.value?.simpleValue ||
        byId['VENDOR']?.value?.simpleValue ||
        byId['GITALIFNR']?.value?.simpleValue || // se vocês usaram extrinsic custom
        null;
      const unit = moneyObj(byId['PRICE'])
      const qv = byId['QUANTITY']?.value?.quantityValue
      const ext = moneyObj(byId['EXTENDEDPRICE'])

      const ncm = byId['GITASHORTSTRINGIFZ000050']?.value?.simpleValue ?? null
      const mva = byId['GITABIGDECIFZ000003']?.value?.bigDecimalValue ?? null

      const aliquotaICMS = byId['GITABIGDECIFZ000004']?.value?.bigDecimalValue ?? null
      const icmsApuradoAmount = moneyObj(byId['GITAMONEYIFZ000046']).amount
      const aliquotaIPI = byId['GITABIGDECIFZ000005']?.value?.bigDecimalValue ?? null
      const ipiApuradoAmount = moneyObj(byId['GITAMONEYIFZ000047']).amount
      const aliquotaPIS = byId['GITABIGDECIFZ000029']?.value?.bigDecimalValue ?? null
      const pisApuradoAmount = moneyObj(byId['GITAMONEYIFZ000048']).amount
      const aliquotaCOFINS = byId['GITABIGDECIFZ000028']?.value?.bigDecimalValue ?? null
      const cofinsApuradoAmount = moneyObj(byId['GITAMONEYIFZ000049']).amount
      const aliquotaICMSInterna = byId['GITABIGDECIFZ000006']?.value?.bigDecimalValue ?? null
      const origemMaterial = byId['GITASHORTSTRINGIFZ000153']?.value?.simpleValue ?? null
      const codigoRequisicao = byId['RequisitionId']?.value?.simpleValue ?? null
      const plant = byId['Plant']?.value?.simpleValue ?? null
      const itemCategory = byId['ItemCategory']?.value?.simpleValue ?? null
      const grupoMaterias = byId['MaterialGroup']?.value?.simpleValue ?? null
      // const taxCode = byId['GITASHORTSTRINGIFZ000152']?.value?.simpleValue ?? null
      const materialCode = byId['MaterialCode']?.value?.simpleValue ?? null

      // pega o valor bruto, independente se vem em .value ou direto
      const deliveryRaw = byId['REQUESTDELIVERYDATE']?.value ?? byId['REQUESTDELIVERYDATE'] ?? null

      const mapped = {
        ItemId: itemId,
        itemDescription: targetRow?.item?.title ?? null,
        quantity: qv?.amount ?? null,
        unitOfMeasure: qv?.unitOfMeasureCode ?? null,
        price: unit.amount,
        currency: unit.currency,
        lifnr: lifnrTerm ? String(lifnrTerm).padStart(10, '0') : null,
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
        CodigoRequisicao: codigoRequisicao,
        PLANT: plant,
        ItemCategory: itemCategory,
        // TAX_CODE: taxCode,
        MaterialCode: materialCode,
        grupo_de_materias: grupoMaterias,
        DELIVERY_DATE_RAW: deliveryRaw ?? null
      }

      // guardamos internamente pra resolver supplierName depois
      results.push({ ...mapped, _invitationId: invId, _itemId: itemId })
    }
  }
  dbg('[fetchSupplierBids] results mapeados =', results.length)
  return { rows, results }
}

/**
 * 2) Identifiers → parentProjectId
 */
//CHAMADA DE API /sourcing-event/v2/prod/events/identifiers
async function fetchParentProjectId(docId) {
  dbg('[fetchParentProjectId] docId =', docId)
  // 1ª tentativa: /events/{docId}
  const pathEvent = `/events/${encodeURIComponent(docId)}`
  try {
    const dataEvt = await destGet(EVENTS_DEST, pathEvent, {
      params: {}, headers: {}, timeoutMs: HTTP_TIMEOUT_MS
    })
    const pid =
      dataEvt?.parentProjectId ||
      dataEvt?.projectId ||
      dataEvt?.parentProjectUniqueName ||
      null
    dbg('[fetchParentProjectId] tentativa 1 →', pid ? 'OK' : 'sem pid')
    if (pid) return pid
  } catch (e) {
    dbg('[fetchParentProjectId] tentativa 1 falhou:', e?.message)
  }

  // 2ª tentativa (fallback): /events/identifiers com filtro por internalId
  const pathIds = `/events/identifiers`
  const data = await destGet(EVENTS_DEST, pathIds, {
    params: { $filter: `(internalId eq ${encodeURIComponent(docId)})` },
    headers: {}, timeoutMs: HTTP_TIMEOUT_MS
  })
  const arr = toArr(data)
  dbg('[fetchParentProjectId] tentativa 2 → registros =', Array.isArray(arr) ? arr.length : 0)
  const hit = arr.find(x => String(x?.internalId) === String(docId))
  return hit?.parentProjectId ?? null
}

// CHAMADA DE API /sourcing-event/v2/prod/events/DocId/rounds/1/supplierInvitation/
async function fetchSupplierInvitationsList(docId, round) {
  dbg('[fetchSupplierInvitationsList] docId =', docId, '| round =', round)
  const path = `/events/${encodeURIComponent(docId)}/rounds/${encodeURIComponent(round)}/supplierInvitations`
  const data = await destGet(EVENTS_DEST, path, {
    params: {}, headers: {}, timeoutMs: HTTP_TIMEOUT_MS
  })
  const out = toArr(data)
  dbg('[fetchSupplierInvitationsList] invitations =', Array.isArray(out) ? out.length : 0)
  return out // <— apenas o array de registros
}

// buscar o iva por pedido enviado
async function enrichWithTaxCode(items, options = {}) {
  const input = Array.isArray(items) ? items : [];
  dbg('[enrichWithTaxCode:v3] start | items =', input.length);
  if (!input.length) return [];

  // ===== opções/destinos =====
  const s4hDest =
    options.destinationName
    ?? (typeof S4H_DEST !== 'undefined' && S4H_DEST)
    ?? cds?.env?.requires?.BAPI_PO_CREATE?.credentials?.destination
    ?? 'S4H_QAS_CQ5_MAPA';

  const sapClient = options.sapClient ?? S4H_SAP_CLIENT;
  const odataPath = options.path ?? S4H_ODATA_PATH;
  const timeoutMs = options.timeoutMs != null ? Number(options.timeoutMs) : S4H_TIMEOUT_MS;

  // fornecedor “preferido” do header deste request (se existir)
  const headerVendor = String(options.headerVendor || '')
    .replace(/\D/g, '')
    .replace(/^0+/, '') || null;

  // ===== helpers =====
  const _esc = (v = '') => String(v).replace(/'/g, "''").trim();
  const _canon = v => String(v ?? '').trim().toUpperCase();
  const _no0 = s => String(s || '').replace(/^0+/, '');
  const _supKey = s => _no0(String(s || '').replace(/\D/g, ''));
  const _matKey = m => _canon(_no0(m));
  const _tripKey = (M, PO, P) => [_matKey(M), _canon(PO), _canon(P)].join('|');

  // cada item pode ter um fornecedor preferido específico (se vier no próprio item)
  const preferredByItem = input.map(it => {
    const fromItem = _supKey(it.Supplier);
    return fromItem || headerVendor || null;
  });

  // ===== coleto triplas únicas (Material, POrg, Plant) =====
  const triples = [];
  const seen = new Set();
  for (const it of input) {
    const k = _tripKey(it.Material, it.PurchasingOrganization, it.Plant);
    if (!k.includes('||') && !seen.has(k)) {
      seen.add(k);
      triples.push({
        Material: it.Material,
        PurchasingOrganization: it.PurchasingOrganization,
        Plant: it.Plant
      });
    }
  }
  if (!triples.length) {
    dbg('[enrichWithTaxCode:v3] sem chaves únicas');
    return input.map(it => ({ ...it, TaxCode: null, PurchasingInfoRecord: null }));
  }

  // ===== chama OData em lotes (sem Supplier no filtro) =====
  const dest = await getDestination({ destinationName: s4hDest });
  if (!dest) throw new Error(`Destination '${s4hDest}' não encontrada.`);

  const CHUNK = 25; // ajuste se o gateway limitar URL
  const allRows = [];
  for (let i = 0; i < triples.length; i += CHUNK) {
    const part = triples.slice(i, i + CHUNK);
    const filter = part.map(t =>
      `(Material eq '${_esc(t.Material)}' and PurchasingOrganization eq '${_esc(t.PurchasingOrganization)}' and Plant eq '${_esc(t.Plant)}')`
    ).join(' or ');

    const query = [
      '$format=json',
      '$select=Supplier,Material,PurchasingOrganization,Plant,PurchasingInfoRecord,TaxCode',
      `$filter=${encodeURIComponent(filter)}`,
      `sap-client=${encodeURIComponent(sapClient)}`
    ].join('&');

    const url = `${odataPath}?${query}`;
    const resp = await executeHttpRequest(
      dest,
      { method: 'GET', url, headers: { Accept: 'application/json' }, timeout: timeoutMs },
      { fetchCsrfToken: false }
    );
    const rows = resp.data?.d?.results ?? resp.data?.value ?? [];
    dbg('[enrichWithTaxCode:v3] lote OK, rows =', rows.length);
    allRows.push(...rows);
  }

  // ===== indexa por tripla e define seleção determinística =====
  const byTrip = new Map(); // keyTrip -> rows[]
  for (const r of allRows) {
    const k = _tripKey(r.Material, r.PurchasingOrganization, r.Plant);
    (byTrip.get(k) || byTrip.set(k, []).get(k)).push(r);
  }

  // escolha “melhor linha” com prioridade por item
  const chooseBest = (list, preferSup) => {
    if (!Array.isArray(list) || !list.length) return null;

    // ordenação estável e determinística:
    // 1) bateu fornecedor preferido? (desc)
    // 2) tem TaxCode? (desc)
    // 3) PIR maior? (desc)
    // 4) Supplier numérico crescente (asc) para desempatar
    const rank = x => (x && String(x.TaxCode || '').trim() ? 1 : 0);
    const pir = x => String(x.PurchasingInfoRecord || '');
    const sup = x => _supKey(x.Supplier);

    const prefer = _supKey(preferSup);

    const sorted = list.slice().sort((a, b) => {
      const aPref = (sup(a) === prefer) ? 1 : 0;
      const bPref = (sup(b) === prefer) ? 1 : 0;
      if (aPref !== bPref) return bPref - aPref;

      const aHas = rank(a), bHas = rank(b);
      if (aHas !== bHas) return bHas - aHas;

      const pirCmp = pir(b).localeCompare(pir(a)); // desc
      if (pirCmp !== 0) return pirCmp;

      // desempate final estável
      return sup(a).localeCompare(sup(b));
    });

    return sorted[0] || null;
  };

  // ===== mapeia de volta um-a-um (cada item com sua preferência) =====
  const out = input.map((it, idx) => {
    const k = _tripKey(it.Material, it.PurchasingOrganization, it.Plant);
    const list = byTrip.get(k) || [];
    const pick = chooseBest(list, preferredByItem[idx]);

    if (!pick) {
      console.warn('[enrichWithTaxCode:v3] sem match para', {
        Material: it.Material, PurchasingOrganization: it.PurchasingOrganization, Plant: it.Plant
      });
    } else {
      const used = _supKey(pick.Supplier);
      const want = _supKey(preferredByItem[idx]);
      if (want && used !== want) {
        console.warn('[enrichWithTaxCode:v3] usando TaxCode de fornecedor diferente da preferência', {
          prefer: want, used, Material: it.Material, Plant: it.Plant
        });
      }
    }

    return {
      ...it,
      TaxCode: pick?.TaxCode ?? null,
      PurchasingInfoRecord: pick?.PurchasingInfoRecord ?? null,
      __taxSupplierUsed: pick?.Supplier ?? null // debug opcional
    };
  });

  dbg('[enrichWithTaxCode:v3] done | resolved =', out.filter(x => !!x.TaxCode).length, '/', out.length);
  return out;
}

// ==================== HANDLER ODATA ====================
module.exports = function () {
  this.on('GetQuotes', async (req) => {
    dbg('[GetQuotes] START data =', req.data)
    const { docId } = (req.data || {})
    if (!docId) return req.error(400, "Parâmetro 'docId' é obrigatório.")
    const round = Number.isFinite(Number(ARIBA_EVENT_ROUND)) ? Number(ARIBA_EVENT_ROUND) : 1


    try {
      // 1) supplierBids (EVENTS) -> pega TODOS os itens/fornecedores (+ guarda invitationId interno)
      const { rows, results } = await fetchSupplierBids(docId)
      dbg('[GetQuotes] supplierBids → rows:', rows.length, '| results:', results.length)
      if (!rows.length || !results.length) return { header: null, items: [] }

      // 2) resolver supplierName + email + SAP Vendor + entry domain/value por invitationId (um GET só)
      const list = await fetchSupplierInvitationsList(docId, round).catch((e) => {
        dbg('[GetQuotes] supplierInvitations ERRO:', e?.message)
        return []
      })
      dbg('[GetQuotes] invitations list:', Array.isArray(list) ? list.length : 0)
      const nameByInvId = new Map()
      const emailByInvId = new Map()
      const vendorByInvId = new Map()      // string (valor)

      for (const it of list) {
        const invId = String(it?.invitationId ?? it?.userId ?? it?.uniqueName ?? '')
        if (!invId) continue

        const name =
          it?.organization?.name || it?.supplierName || it?.organizationName || it?.supplier?.name || null
        const email =
          it?.emailAddress || it?.supplierEmail || it?.email || it?.mainContact?.emailAddress || it?.contact?.email || null

        const sapEntry = extractSapOrgEntry(it) // objeto { domain, value }
        const sapId = sapEntry?.value ?? extractSapVendorId(it) // string fallback

        if (name) nameByInvId.set(invId, name)
        if (email) emailByInvId.set(invId, email)
        if (sapId) vendorByInvId.set(invId, sapId)
      }

      // Fallback de nome por rows se faltar na lista
      for (const invId of new Set(results.map(r => r._invitationId).filter(Boolean))) {
        if (!nameByInvId.has(invId)) {
          const fb = pickSupplierNameByInvitation(rows, invId) || pickSupplierNameFromRows(rows)
          if (fb) nameByInvId.set(invId, fb)
        }
      }

      // 3) identifiers → parentProjectId (EVENTS)
      let parentProjectId = null
      try {
        parentProjectId = await fetchParentProjectId(docId)
      } catch (e) { /* noop */ }
      LOG.info?.('[GetQuotes] parentProjectId resolvido:', parentProjectId)
      dbg('[GetQuotes] parentProjectId =', parentProjectId)

      // 4) header (PROJECTS/PM)
      let header = null
      try {
        if (parentProjectId) header = await fetchAribaHeader(parentProjectId)
      } catch (e) { /* noop */ }
      dbg('[GetQuotes] header mapeado =', header ? 'OK' : 'null')

      // 5) monta retorno com TODOS os itens
      const headerWithDoc = Object.assign({ docId }, header || {}, { supplierName: null }) // opcional no header
      const itemsOut = results.map(r => {
        const invId = r._invitationId
        const supplierName = invId ? (nameByInvId.get(invId) || null) : null
        const supplierIdSap = invId ? (vendorByInvId.get(invId) || null) : null

        // remove campos internos antes de expor
        const { _invitationId, _itemId, ...pub } = r;
        const email = _invitationId ? (emailByInvId.get(_invitationId) || null) : null;
        // acrescenta:
        // - Supplier: string (ID SAP)
        // - SupplierOrgId: objeto original do Ariba { domain: 'sap', value: '...' }
        return {
          ...pub,
          supplierName,
          SupplierCode: supplierIdSap,
          invitationId: _invitationId || null,
          invitationEmail: email
        };
      })

      dbg('[GetQuotes] END → itemsOut =', itemsOut.length)
      return { header: headerWithDoc, items: itemsOut }

    } catch (e) {
      const status = e.response?.status || 502
      const msg = e.response?.data?.message || e.response?.data || e.message
      LOG.error('[GetQuotes] Erro Ariba:', status, msg)
      dbg('[GetQuotes] ERROR:', status, msg)
      return req.error(status, 'Falha ao consultar supplierBids no Ariba.')
    }
  })

  // ################################ BEATRIZ - CRIA SCENARIO #####################################
  this.on('CreateScenario', async (req) => {
    const { eventId, title, scenarioType, supplierBids } = req.data || {}
    if (!eventId) return req.error(400, "Parâmetro 'eventId' é obrigatório.")
    if (!Array.isArray(supplierBids) || supplierBids.length === 0) {
      return req.error(400, "'supplierBids' deve ser um array com pelo menos 1 item.")
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
    }

    LOG.info('[CreateScenario] Payload ⇒', JSON.stringify({
      eventId: payload.eventId,
      title: payload.title,
      scenarioType: payload.scenarioType,
      supplierBidsCount: payload.supplierBids.length
    }))

    const relPath = `/events/${encodeURIComponent(eventId)}/scenarios`
    LOG.info('[CreateScenario] Alvo (Destination) ⇒', `Destination "${EVENTS_DEST}" path "${relPath}"`)

    try {
      const { data, headers } = await destPost(EVENTS_DEST, relPath, payload, { timeoutMs: HTTP_TIMEOUT_MS })
      const correlationId = headers?.['x-correlation-id'] || headers?.['x-correlationid'] || null
      const scenarioId = data?.scenarioId || data?.id || data?.scenarioID || null

      LOG.info('[CreateScenario] OK ⇒', { scenarioId, correlationId })
      return { success: true, scenarioId, aribaResponse: JSON.stringify(data), correlationId }
    } catch (e) {
      const { status, correlationId, userMessage, technical } = formatAribaScenarioError(e)
      LOG.error('[CreateScenario] Falha POST /scenarios:', technical)
      return req.error(status, userMessage, { correlationId, technical })
    }
  })
  // ################################ FIM - BEATRIZ - CRIA SCENARIO #####################################



  // ================== ACTION ÚNICA (lote) ==================
  this.on('simularPO', async req => {
    console.time('[simularPO] total');
    const t0 = Date.now();
    console.log('========== [simularPO] START (lote) ==========');

    try {
      // 0) Entrada no novo formato
      const { requests = [], concurrency } = req.data || {};
      const LIMIT = Number(
        (Number.isFinite(concurrency) ? concurrency : (process.env.CONCURRENCY || 4))
      );

      console.log('[simularPO] Raw req.data keys:', Object.keys(req.data || {}));
      if (!Array.isArray(requests) || requests.length === 0) {
        console.log('[simularPO] Nenhuma request recebida -> []');
        console.timeEnd('[simularPO] total');
        return [];
      }

      console.log('[simularPO] Input resume (lote):', {
        requests: requests.length,
        concurrency: LIMIT
      });
      console.log('[simularPO] Exemplo header[0] (resumo):', {
        vendor: requests[0]?.header?.vendor,
        purchOrg: requests[0]?.header?.purchOrg,
        compCode: requests[0]?.header?.compCode,
        docType: requests[0]?.header?.docType,
        items: Array.isArray(requests[0]?.items) ? requests[0].items.length : 0
      });

      // 1) Cria o cliente SOAP uma única vez
      console.log('[simularPO] Criando client SOAP via Destination com WSDL:', WSDL_PATH);
      const endpoint = { url: null };
      console.time('[simularPO] getSoapService');
      const client = await getSoapService('BAPI_PO_CREATE', WSDL_PATH, endpoint, 'POST');
      console.timeEnd('[simularPO] getSoapService');
      console.log('[simularPO] Endpoint efetivo:', endpoint.url);

      // 1.1) (Opcional) Inspeção do WSDL
      try {
        const services = client?.wsdl?.definitions?.services || {};
        for (const sName in services) {
          const service = services[sName];
          for (const pName in (service.ports || {})) {
            const port = service.ports[pName];
            console.log(`[simularPO] WSDL -> Service="${sName}" Port="${pName}" Address="${port.location}"`);
          }
        }
      } catch (wErr) {
        console.warn('[simularPO] Aviso ao inspecionar WSDL:', wErr?.message || wErr);
      }

      // 1.1b) Sanidade: checar operação no client
      if (typeof client.BAPI_PO_CREATE1Async !== 'function') {
        console.error('[simularPO] Método SOAP "BAPI_PO_CREATE1Async" não encontrado no client.');
        try {
          console.log('[simularPO] Métodos disponíveis (top 20):',
            Object.keys(client || {}).filter(k => typeof client[k] === 'function').slice(0, 20));
          console.log('[simularPO] client.describe():');
          console.dir(client.describe?.(), { depth: null });
        } catch { }
        throw new Error('Método SOAP BAPI_PO_CREATE1Async indisponível no port/endereço atual.');
      }

      // 1.2) Listeners de debug do node-soap (ative com SOAP_DEBUG=1)
      if (String(process.env.SOAP_DEBUG) === '1') {
        client.on('request', (xml, eid) => {
          console.log('--- [SOAP REQUEST] eid=', eid, '---\n', xml, '\n--- [/SOAP REQUEST] ---');
        });
        client.on('response', (body, response, eid) => {
          console.log('--- [SOAP RESPONSE] eid=', eid, 'status=', response?.statusCode, '---\n', body, '\n--- [/SOAP RESPONSE] ---');
        });
        client.on('soapError', (err) => {
          console.error('--- [SOAP FAULT] ---\n', safeErr(err), '\n--- [/SOAP FAULT] ---');
        });
      }

      // 2) Mapper: ENRIQUECE TaxCode via OData e chama a BAPI
      const mapper = async (r, idx) => {
        console.time(`[mapper:${idx}] total`);
        const {
          header = {},
          items: rawItems = [],
          schedules = [],
          testRun = true
        } = r || {};

        console.log(`[mapper:${idx}] START`, {
          vendor: header.vendor, purchOrg: header.purchOrg,
          compCode: header.compCode, items: rawItems.length, testRun
        });

        // zera taxCode que puder vir do front
        const items = rawItems.map(({ taxCode, ...rest }) => rest);

        // Enriquecimento de TaxCode via S/4 (PIR por centro)
        const enrichInput = items.map((it, i) => ({
          __idx: i,
          Supplier: padLeft(String(header.vendor || ''), 10, '0'),
          Material: it.material || '',
          PurchasingOrganization: header.purchOrg,
          Plant: it.plant
        }));
        console.log(`[mapper:${idx}] enrichInput sample (até 2):`, enrichInput.slice(0, 2));

        console.time(`[mapper:${idx}] enrichWithTaxCode`);
        const enriched = await enrichWithTaxCode(enrichInput, {
          headerVendor: padLeft(String(header.vendor || ''), 10, '0')
        });
        console.timeEnd(`[mapper:${idx}] enrichWithTaxCode`);
        console.log(`[mapper:${idx}] enriched count=`, enriched.length);

        for (const row of enriched) {
          if (row?.__idx != null) {
            items[row.__idx].taxCode = row.TaxCode ?? undefined;
            items[row.__idx].purchasingInfoRecord = row.PurchasingInfoRecord ?? undefined;
            console.log(`[mapper:${idx}] TaxCode OK idx=${row.__idx}`, {
              material: items[row.__idx].material,
              plant: items[row.__idx].plant,
              taxCode: items[row.__idx].taxCode
            });
          }
        }

        const missing = items
          .map((it, i) => ({ i, poItem: it.poItem ?? (i + 1) * 10, material: it.material, plant: it.plant, taxCode: it.taxCode }))
          .filter(x => !x.taxCode);

        if (missing.length) {
          const detalhes = missing
            .map(m => `Item ${String(m.poItem).toString().padStart(5, '0')} (mat=${m.material || '-'}, plant=${m.plant || '-'})`)
            .join(', ');
          console.error(`[mapper:${idx}] FALHA enriquecimento TaxCode ->`, detalhes);
          throw new Error(`Não foi possível obter TaxCode para ${missing.length} item(ns): ${detalhes}`);
        }

        // Monta payload e chama BAPI
        const payload = buildSmokePayload(header, items, schedules, testRun);
        console.log(`[mapper:${idx}] Payload pronto`, {
          TESTRUN: payload.TESTRUN,
          POITEM_len: payload.POITEM?.item?.length,
          POSCHEDULE_len: payload.POSCHEDULE?.item?.length
        });

        console.time(`[mapper:${idx}] SOAP`);
        const resp = await client.BAPI_PO_CREATE1Async(payload);
        console.timeEnd(`[mapper:${idx}] SOAP`);
        const r0 = Array.isArray(resp) ? resp[0] : resp;

        const normalized = normalizeBapiResult(r0, !!payload.TESTRUN);
        console.log(
          `[mapper:${idx}] OK -> itens=${normalized.itens?.length || 0} msgs=${normalized.returnMessages?.length || 0}`
        );
        console.timeEnd(`[mapper:${idx}] total`);
        return normalized;
      };

      // 3) Executa em paralelo com limite de concorrência
      console.log('[pool] start', { limit: LIMIT, size: requests.length });
      const results = await mapWithConcurrency(requests, LIMIT, async (r, i) => {
        try {
          return await mapper(r, i);
        } catch (err) {
          console.error(`[pool] mapper erro idx=${i}:`, err?.message || err);
          throw err;
        }
      });
      console.log('[pool] end');

      // Resumo das mensagens por request
      console.log('[simularPO] Resumo mensagens por request:',
        results.map((r, i) => ({
          i,
          header_vendor: r?.header?.fornecedor,
          msgs: (r?.returnMessages || []).map(m => `${m.type}:${m.id}/${m.number}`).join(', ')
        }))
      );

      console.log('========== [simularPO] END OK in', (Date.now() - t0), 'ms, results=', results.length, ' ==========');
      console.timeEnd('[simularPO] total');
      return results;

    } catch (e) {
      const info = safeErr(e);
      console.error('========== [simularPO] ERROR ==========');
      console.error('[simularPO] Detalhes do erro:', info);
      console.error('=======================================');
      console.timeEnd('[simularPO] total');
      return req.error(502, `Falha na simulação em lote: ${info.message || info.code || 'Erro desconhecido'}`);
    }
  });

  /* =================== Helpers =================== */

  // Pool de concorrência (preserva a ordem dos resultados)
  async function mapWithConcurrency(arr, limit, mapper) {
    const results = new Array(arr.length);
    let i = 0;
    const workers = Math.min(limit, arr.length);
    console.log('[pool] workers=', workers);
    async function worker(wid) {
      while (i < arr.length) {
        const idx = i++;
        console.log(`[pool] worker#${wid} -> idx=${idx}`);
        try {
          results[idx] = await mapper(arr[idx], idx);
        } catch (err) {
          console.error(`[pool] worker#${wid} erro idx=${idx}:`, err?.message || err);
          results[idx] = {
            testRun: true,
            header: {},
            itens: [],
            returnMessages: [{
              type: 'E', id: 'SERVER', number: '000',
              message: err?.message || String(err)
            }],
            mensagens: [{
              type: 'E', id: 'SERVER', number: '000',
              message: err?.message || String(err)
            }]
          };
        }
      }
    }
    await Promise.all(Array.from({ length: workers }, (_, k) => worker(k + 1)));
    return results;
  }

  // Normaliza resposta da BAPI no formato SimulacaoPOResult
  function normalizeBapiResult(r0, testRunFlag) {
    const toArray = v => (Array.isArray(v) ? v : (v ? [v] : []));
    const headerRaw = r0?.EXPHEADER || {};
    const itensRaw = toArray(r0?.POITEM?.item);
    const schedRaw = toArray(r0?.POSCHEDULE?.item);

    const schedByItem = schedRaw.reduce((acc, s) => {
      const key = String(s.PO_ITEM || '').padStart(5, '0');
      (acc[key] ||= []).push({
        schedLine: s.SCHED_LINE,
        deliveryDate: s.DELIVERY_DATE,
        qty: Number(s.QUANTITY || 0)
      });
      return acc;
    }, {});

    const itens = itensRaw.map(i => {
      const key = String(i.PO_ITEM || '').padStart(5, '0');
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
        schedules: schedByItem[key] || []
      };
    });

    const messages = toArray(r0?.RETURN?.item).map(m => ({
      type: m.TYPE, id: m.ID, number: m.NUMBER, message: m.MESSAGE,
      logNo: m.LOG_NO, v1: m.MESSAGE_V1, v2: m.MESSAGE_V2, v3: m.MESSAGE_V3, v4: m.MESSAGE_V4
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
        poNumber: headerRaw.PO_NUMBER || '' // vazio em TESTRUN
      },
      itens,
      returnMessages: messages,
      mensagens: messages
    };
  }

  // Payload "fumaça": se nada vier do front, monta o mínimo p/ a BAPI responder algo.
  function buildSmokePayload(header, items, schedules, testRun) {
    const hdr = {
      DOC_TYPE: header.docType || 'NB',
      COMP_CODE: header.compCode || '1000',
      PURCH_ORG: header.purchOrg || '1000',
      PUR_GROUP: header.purchGroup || '001',
      VENDOR: padLeft(String(header.vendor || '123456'), 10, '0'),
      CURRENCY: header.currency || 'BRL',
      ...(header.incoterms1 ? { INCOTERMS1: header.incoterms1 } : {}),
      ...(header.incoterms2 ? { INCOTERMS2: header.incoterms2 } : {})
    };
    const hdrX = markX(hdr);

    const itemList = (Array.isArray(items) && items.length > 0) ? items : [{
      poItem: 10,
      plant: 'BR01',
      shortText: 'Teste chamada BAPI',
      quantity: 1,
      unit: 'PC',
      taxCode: 'I1'
    }];

    const poitem = [];
    const poitemx = [];
    itemList.forEach((it, i) => {
      const PO_ITEM = padLeft(String(Number.isInteger(it.poItem) ? it.poItem : (i + 1) * 10), 5, '0');
      const rec = {
        PO_ITEM,
        PLANT: it.plant,
        QUANTITY: String(it.quantity),
        PO_UNIT: it.unit,
        ...(it.material ? { MATERIAL: padLeft(String(it.material).trim(), 18, '0') } : {}),
        ...(it.shortText ? { SHORT_TEXT: String(it.shortText).slice(0, 40) } : {}),
        ...(it.taxCode ? { TAX_CODE: String(it.taxCode).slice(0, 2) } : {}),
        ...(it.netPrice != null ? { NET_PRICE: String(it.netPrice) } : {})
      };
      poitem.push(rec);
      poitemx.push(markX(rec, { PO_ITEM }));
    });

    const today = isoDate(new Date());
    const schedList = (Array.isArray(schedules) && schedules.length > 0)
      ? schedules.map((s, idx) => ({
        PO_ITEM: padLeft(String(Number.isInteger(s.poItem) ? s.poItem : (idx + 1) * 10), 5, '0'),
        SCHED_LINE: padLeft(String(s.schedLine ?? 1), 4, '0'),
        DELIVERY_DATE: s.deliveryDate ? isoDate(new Date(s.deliveryDate)) : today,
        QUANTITY: String(s.quantity ?? '0')
      }))
      : poitem.map(p => ({
        PO_ITEM: p.PO_ITEM,
        SCHED_LINE: '0001',
        DELIVERY_DATE: today,
        QUANTITY: p.QUANTITY
      }));

    const posched = [];
    const poschedx = [];
    schedList.forEach(s => {
      posched.push(s);
      poschedx.push(markX(s));
    });

    return {
      TESTRUN: testRun ? 'X' : '',
      POHEADER: hdr,
      POHEADERX: hdrX,
      POITEM: { item: poitem },
      POITEMX: { item: poitemx },
      POSCHEDULE: { item: posched },
      POSCHEDULEX: { item: poschedx }
    };
  }

  function padLeft(str, len, ch = '0') {
    str = String(str ?? '');
    return str.length >= len ? str : ch.repeat(len - str.length) + str;
  }
  function isoDate(d) {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function markX(obj, extra = {}) {
    const x = { ...extra };
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'PO_ITEM' || k === 'SCHED_LINE') { x[k] = obj[k]; continue; }
      if (v !== undefined && v !== null && String(v) !== '') x[k] = 'X';
    }
    return x;
  }

  // Constrói um objeto legível com os principais campos de erro
  function safeErr(e = {}) {
    const info = {
      name: e.name,
      message: e.message,
      code: e.code,
      errno: e.errno,
      address: e.address,
      port: e.port,
      statusCode: e.statusCode,
      responseStatus: e.response?.status || e.status,
      responseBody: (e.body || e.response?.data || e.response?.body || e.root)
        ? clip(String(e.body || e.response?.data || e.response?.body || JSON.stringify(e.root)))
        : undefined,
      fault: e.fault || e.root?.Envelope?.Body?.Fault,
      stack: e.stack ? clip(e.stack, 1200) : undefined
    };
    return info;
  }
  function clip(s, max = 800) {
    if (!s) return s;
    return s.length > max ? (s.slice(0, max) + ` ... (${s.length - max} chars more)`) : s;
  }
}
