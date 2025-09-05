require('dotenv').config()
'use strict'
const cds = require('@sap/cds')
const axios = require('axios')
const { getDestination } = require('@sap-cloud-sdk/connectivity')
const path = require('path')
const { getSoapService } = require('./soap-client')
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client')


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
const { getAccessToken } = require('../srv/auth/aribaOauth')
const { url } = require('inspector')

// ==================== SWITCH DESTINATION vs .ENV ====================
const USE_DESTINATION = (process.env.USE_DESTINATION || 'false') === 'true'
const EVENTS_DEST = process.env.ARIBA_DEST_EVENTS || 'ARIBA_Event_Management_Test'
const PROJECTS_DEST = process.env.ARIBA_DEST_PROJECTS || 'ARIBA_Sourcing_Project_Management_Test'

const EVENTS_API_PREFIX = process.env.ARIBA_EVENTS_API_PREFIX || '/api/sourcing-event/v2/prod'
const PM_API_PREFIX = process.env.ARIBA_PM_API_PREFIX || '/api/sourcing-project-management/v2/prod'


const _destTokenCache = {} // cache simples por tokenUrl|clientId


async function _fetchTokenFromDestination(destination) {
  // a base do token na sua destination é https://api.ariba.com/v2 — aqui acrescentamos /oauth/token se faltar
  const base = destination.tokenServiceUrl || destination.tokenUrl || destination.token_service_url
  if (!base) throw new Error('Destination não possui tokenServiceUrl')
  const tokenUrl = /\/oauth\b/i.test(base) ? base : base.replace(/\/$/, '') + '/oauth/token'

  const clientId = destination.clientId || destination.clientid || destination.client_id
  const clientSecret = destination.clientSecret || destination.clientsecret || destination.client_secret
  const grantType = destination.grantType || destination.grant_type || 'client_credentials'
  if (!clientId || !clientSecret) throw new Error('Faltando clientId/clientSecret no destination')

  const key = tokenUrl + '|' + clientId
  const now = Date.now()
  if (_destTokenCache[key] && now < _destTokenCache[key].exp - 60_000) return _destTokenCache[key].token

  const includeGrantInBody = !/\bgrant_type=/.test(tokenUrl)
  const body = new URLSearchParams()
  if (includeGrantInBody) body.append('grant_type', grantType)
  if (destination.scope) body.append('scope', destination.scope)

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const resp = await axios.post(tokenUrl, body.toString(), {
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: Number(HTTP_TIMEOUT_MS) || 15000
  })
  const { access_token, expires_in } = resp.data || {}
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
  ARIBA_PM_OAUTH_GRANT_TYPE,

  // Round padrão para supplier invitations (se não usar Destination)
  ARIBA_EVENT_ROUND
} = process.env

// ==================== HELPER: GET via Destination (robusto) ====================
async function destGet(destName, relativePath, { params = {}, headers = {}, timeoutMs = 30000 } = {}) {
  const destination = await getDestination({ destinationName: destName })
  if (!destination) throw new Error(`Destination ${destName} não encontrada (ver process.env.destinations / VCAP_SERVICES)`)

  // 1) normaliza caminho (ex.: /events/... → /api/sourcing-event/v2/prod/events/...)
  const urlPath = _maybePrefixPath(destName, relativePath)

  // 2) config base da chamada
  const baseCfg = {
    method: 'get',
    url: urlPath,
    params: { ...params },
    headers: { ...headers },
    timeout: Number(timeoutMs) || 30000
  }

  // 3) para EVENTS, se não veio nos params, injeta realm/user/passwordAdapter do .env
  if (destName === EVENTS_DEST || destName === PROJECTS_DEST) {
    if (ARIBA_REALM && baseCfg.params.realm == null) baseCfg.params.realm = ARIBA_REALM
    if (ARIBA_USER && baseCfg.params.user == null) baseCfg.params.user = ARIBA_USER
    if (ARIBA_PASSWORD_ADAPTER && baseCfg.params.passwordAdapter == null) {
      baseCfg.params.passwordAdapter = ARIBA_PASSWORD_ADAPTER
    }
  }

  // 4) tenta usar o helper oficial (se existir nessa versão)
  let reqCfg
  if (addDestinationToRequestConfig) {
    try {
      reqCfg = await addDestinationToRequestConfig(baseCfg, destination)
    } catch (e) {
      LOG.warn?.('[destGet] addDestinationToRequestConfig falhou; usando fallback:', e.message)
    }
  }

  // 5) fallback manual (merge baseURL + headers + auth + apikey)
  if (!reqCfg) {
    reqCfg = {
      baseURL: destination.url,              // ex.: https://openapi.ariba.com
      ...baseCfg,
      headers: { ...(destination.headers || {}), ...(baseCfg.headers || {}) }
    }

    // Authorization → usa authTokens da binding OU busca via OAuth2 Client Credentials
    if (destination.authTokens?.[0]?.value) {
      reqCfg.headers.authorization = reqCfg.headers.authorization || `Bearer ${destination.authTokens[0].value}`
    } else if ((destination.authentication || '').toLowerCase() === 'oauth2clientcredentials') {
      try {
        const token = await _fetchTokenFromDestination(destination)
        if (token) reqCfg.headers.authorization = `Bearer ${token}`
      } catch (e) {
        LOG.error?.('[destGet] erro ao obter token:', e.message)
      }
    }

    // apikey → da destination.headers primeiro; se não houver, cai pro fallback do .env
    if (!reqCfg.headers.apikey && destination.headers?.apikey) reqCfg.headers.apikey = destination.headers.apikey
    if (!reqCfg.headers.apikey && destName === EVENTS_DEST && ARIBA_API_KEY_EVENTS) reqCfg.headers.apikey = ARIBA_API_KEY_EVENTS
    if (!reqCfg.headers.apikey && destName === PROJECTS_DEST && ARIBA_API_KEY_PROJECTS) reqCfg.headers.apikey = ARIBA_API_KEY_PROJECTS

    // defaults de conteúdo
    if (!reqCfg.headers.Accept) reqCfg.headers.Accept = 'application/json'
    if (!reqCfg.headers['Content-Type']) reqCfg.headers['Content-Type'] = 'application/json'
  }

  // 6) executa
  const { data } = await axios.request(reqCfg)
  return data
}

// ==================== CÓDIGO PM (PROJECTS) ====================
// cache simples de token (fallback .env; não usado quando USE_DESTINATION=true)
let _pmOauthCache = { token: null, exp: 0 }

async function getPmAccessToken() {
  if (USE_DESTINATION) throw new Error('getPmAccessToken não deve ser usado com Destination')
  const now = Date.now()
  if (_pmOauthCache.token && now < _pmOauthCache.exp - 60_000) return _pmOauthCache.token

  const basic = Buffer.from(`${ARIBA_PM_OAUTH_CLIENT_ID}:${ARIBA_PM_OAUTH_CLIENT_SECRET}`).toString('base64')
  const grantType = ARIBA_PM_OAUTH_GRANT_TYPE || 'client_credentials'

  const { data } = await axios.post(
    ARIBA_PM_OAUTH_TOKEN_URL,
    `grant_type=${encodeURIComponent(grantType)}`,
    { headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  )
  _pmOauthCache.token = data.access_token
  _pmOauthCache.exp = now + (data.expires_in ?? 3600) * 1000
  return _pmOauthCache.token
}

async function aribaPmGet(path, params = {}) {
  if (USE_DESTINATION) {
    // IMPORTANTE: repassar params para a Destination
    return await destGet(PROJECTS_DEST, path, {
      params, headers: {}, timeoutMs: Number(HTTP_TIMEOUT_MS) || 30000
    })
  }
  const token = await getPmAccessToken()
  try {
    const { data } = await axios.get(`${ARIBA_BASE_URL_PROJECTS}${path}`, {
      params,
      headers: { apikey: ARIBA_API_KEY_PROJECTS, Authorization: `Bearer ${token}` },
      timeout: Number(HTTP_TIMEOUT_MS) || 30000
    })
    return data
  } catch (e) {
    if (e?.response?.status === 401) {
      _pmOauthCache = { token: null, exp: 0 }
      const newToken = await getPmAccessToken()
      const { data } = await axios.get(`${ARIBA_BASE_URL_PROJECTS}${path}`, {
        params,
        headers: { apikey: ARIBA_API_KEY_PROJECTS, Authorization: `Bearer ${newToken}` },
        timeout: Number(HTTP_TIMEOUT_MS) || 30000
      })
      return data
    }
    throw e
  }
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

async function fetchAribaHeader(projectId) {
  const data = await aribaPmGet(`/projects/${encodeURIComponent(projectId)}`, {
    // pode mover estes 3 para a Destination (Additional Properties → URL.queries.*)
    realm: ARIBA_REALM,
    user: ARIBA_USER,
    passwordAdapter: ARIBA_PASSWORD_ADAPTER
  })
  return mapAribaHeader(data || {})
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

/**
 * 1) supplierBids:
 *    - Para CADA fornecedor (row) e CADA itemId em itemsWithBid, gera um resultado.
 *    - Para mapear valores do item, procura uma row cujo item.itemId == itemId
 *      priorizando a mesma invitationId; se não achar, usa a primeira que casar o itemId.
 *    - Retorna:
 *        { rows, results: [ { mappedFields..., _invitationId, _itemId } ] }
 */
async function fetchSupplierBids(docId, headersCommon) {
  const path = `/events/${encodeURIComponent(docId)}/supplierBids`
  let data
  if (USE_DESTINATION) {
    data = await destGet(EVENTS_DEST, path, {
      params: { realm: ARIBA_REALM, user: ARIBA_USER, passwordAdapter: ARIBA_PASSWORD_ADAPTER },
      headers: {}, timeoutMs: Number(HTTP_TIMEOUT_MS) || 30000
    })
  } else {
    const urlBids = `${ARIBA_BASE_URL_EVENTS}${path}`
    const resp = await axios.get(urlBids, {
      params: { realm: ARIBA_REALM, user: ARIBA_USER, passwordAdapter: ARIBA_PASSWORD_ADAPTER },
      headers: headersCommon,
      timeout: Number(HTTP_TIMEOUT_MS) || 30000
    })
    data = resp.data
  }

  const rows = toArr(data)
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

      const plant = byId['Plant']?.value?.simpleValue ?? null
      const itemCategory = byId['ItemCategory']?.value?.simpleValue ?? null
      const grupoMaterias = byId['MaterialGroup']?.value?.simpleValue ?? null
      const taxCode = byId['GITASHORTSTRINGIFZ000152']?.value?.simpleValue ?? null
      const materialCode = byId['MaterialCode']?.value?.simpleValue ?? null

      const mapped = {
        ItemId: itemId,
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
      }

      // guardamos internamente pra resolver supplierName depois
      results.push({ ...mapped, _invitationId: invId, _itemId: itemId })
    }
  }

  return { rows, results }
}

/**
 * 2) Identifiers → parentProjectId
 */
/**
 * 2) Identifiers → parentProjectId (robusto)
 */
async function fetchParentProjectId(docId, headersCommon) {
  // 1ª tentativa: /events/{docId}
  const pathEvent = `/events/${encodeURIComponent(docId)}`
  try {
    let dataEvt
    if (USE_DESTINATION) {
      dataEvt = await destGet(EVENTS_DEST, pathEvent, {
        params: { realm: ARIBA_REALM, user: ARIBA_USER, passwordAdapter: ARIBA_PASSWORD_ADAPTER },
        headers: {},
        timeoutMs: Number(HTTP_TIMEOUT_MS) || 30000
      })
    } else {
      const urlEvt = `${ARIBA_BASE_URL_EVENTS}${pathEvent}`
      const respEvt = await axios.get(urlEvt, {
        params: { realm: ARIBA_REALM, user: ARIBA_USER, passwordAdapter: ARIBA_PASSWORD_ADAPTER },
        headers: headersCommon,
        timeout: Number(HTTP_TIMEOUT_MS) || 30000
      })
      dataEvt = respEvt.data
    }
    const pid =
      dataEvt?.parentProjectId ||
      dataEvt?.projectId ||
      dataEvt?.parentProjectUniqueName ||
      null
    if (pid) return pid
  } catch (e) {
    // segue para fallback
  }

  // 2ª tentativa (fallback): /events/identifiers com filtro por internalId
  const pathIds = `/events/identifiers`
  let data
  const idsParams = {
    realm: ARIBA_REALM,
    user: ARIBA_USER,
    passwordAdapter: ARIBA_PASSWORD_ADAPTER,
    $filter: `(internalId eq ${encodeURIComponent(docId)})`
  }
  if (USE_DESTINATION) {
    data = await destGet(EVENTS_DEST, pathIds, {
      params: idsParams,
      headers: {},
      timeoutMs: Number(HTTP_TIMEOUT_MS) || 30000
    })
  } else {
    const urlIds = `${ARIBA_BASE_URL_EVENTS}${pathIds}`
    const resp = await axios.get(urlIds, {
      params: idsParams,
      headers: headersCommon,
      timeout: Number(HTTP_TIMEOUT_MS) || 30000
    })
    data = resp.data
  }
  const arr = toArr(data)
  const hit = arr.find(x => String(x?.internalId) === String(docId))
  return hit?.parentProjectId ?? null
}

/**
 * 3) Lista de supplier invitations do round
 */
async function fetchSupplierInvitationsList(docId, round, headersCommon) {
  const path = `/events/${encodeURIComponent(docId)}/rounds/${encodeURIComponent(round)}/supplierInvitations`
  let data
  if (USE_DESTINATION) {
    data = await destGet(EVENTS_DEST, path, {
      params: { realm: ARIBA_REALM, user: ARIBA_USER, passwordAdapter: ARIBA_PASSWORD_ADAPTER },
      headers: {}, timeoutMs: Number(HTTP_TIMEOUT_MS) || 30000
    })
  } else {
    const url = `${ARIBA_BASE_URL_EVENTS}${path}`
    const resp = await axios.get(url, {
      params: { realm: ARIBA_REALM, user: ARIBA_USER, passwordAdapter: ARIBA_PASSWORD_ADAPTER },
      headers: headersCommon,
      timeout: Number(HTTP_TIMEOUT_MS) || 30000
    })
    data = resp.data
  }
  return toArr(data)
}

//
async function fetchSupplierInvitationById(docId, round, resourceId, headersCommon) {
  if (!resourceId) return null
  const path = `/events/${encodeURIComponent(docId)}/rounds/${encodeURIComponent(round)}/supplierInvitations/${encodeURIComponent(resourceId)}`
  let data
  if (USE_DESTINATION) {
    data = await destGet(EVENTS_DEST, path, {
      params: { realm: ARIBA_REALM, user: ARIBA_USER, passwordAdapter: ARIBA_PASSWORD_ADAPTER },
      headers: {}, timeoutMs: Number(HTTP_TIMEOUT_MS) || 30000
    })
  } else {
    const url = `${ARIBA_BASE_URL_EVENTS}${path}`
    const resp = await axios.get(url, {
      params: { realm: ARIBA_REALM, user: ARIBA_USER, passwordAdapter: ARIBA_PASSWORD_ADAPTER },
      headers: headersCommon,
      timeout: Number(HTTP_TIMEOUT_MS) || 30000
    })
    data = resp.data
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
    null

  const emailDetected =
    data?.mainContact?.emailAddress ||
    data?.emailAddress ||
    data?.supplier?.email ||
    data?.supplierEmail ||
    data?.contact?.email ||
    (String(resourceId).includes('_') ? String(resourceId).split('_')[1] : null) ||
    null

  return {
    supplierName: supplierName || (emailDetected ? String(emailDetected).split('@')[0] : null),
    supplierEmail: emailDetected
  }
}

// ==================== HANDLER ODATA ====================
module.exports = function () {
  this.on('GetQuotes', async (req) => {
    const { docId } = (req.data || {})
    if (!docId) return req.error(400, "Parâmetro 'docId' é obrigatório.")
    const round = Number.isFinite(Number(ARIBA_EVENT_ROUND)) ? Number(ARIBA_EVENT_ROUND) : 1

    // Headers de EVENTS só quando .env; com Destination não precisa
    let headersCommon = {}
    if (!USE_DESTINATION) {
      const token = await getAccessToken()
      headersCommon = {
        apiKey: ARIBA_API_KEY_EVENTS,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`
      }
    }

    try {
      // 1) supplierBids (EVENTS) -> pega TODOS os itens/fornecedores (+ guarda invitationId interno)
      const { rows, results } = await fetchSupplierBids(docId, headersCommon)
      if (!rows.length || !results.length) return { header: null, items: [] }

      // 2) resolver supplierName por invitationId (com cache)
      const inviteIds = [...new Set(results.map(r => r._invitationId).filter(Boolean))]
      const nameCache = new Map()

      // tenta resolver em massa usando a lista do round (um GET só)
      let list = []
      try { list = await fetchSupplierInvitationsList(docId, round, headersCommon) } catch (e) { /* noop */ }

      const emailByInvId = new Map()
      for (const it of list) {
        const invId = String(it?.invitationId ?? it?.userId ?? it?.uniqueName ?? '')
        if (!invId) continue
        const email = it?.emailAddress || it?.supplierEmail || it?.email || it?.mainContact?.emailAddress || it?.contact?.email || null
        if (email) emailByInvId.set(invId, email)
        // nome direto se já vier
        const name =
          it?.organization?.name || it?.supplierName || it?.organizationName || it?.supplier?.name || null
        if (name) nameCache.set(invId, name)
      }

      // para cada convite pendente, busca por ID completo (se necessário)
      for (const invId of inviteIds) {
        if (nameCache.has(invId)) continue

        let resourceId = null
        if (String(invId).includes('_')) {
          resourceId = String(invId)
        } else {
          const email = emailByInvId.get(String(invId))
          if (email) resourceId = `${String(invId)}_${String(email)}`
        }

        if (resourceId) {
          try {
            const inv = await fetchSupplierInvitationById(docId, round, resourceId, headersCommon)
            if (inv?.supplierName) nameCache.set(invId, inv.supplierName)
          } catch (e) { /* continua */ }
        }

        // fallback por rows caso ainda vazio
        if (!nameCache.has(invId)) {
          const fallback = pickSupplierNameByInvitation(rows, invId) || pickSupplierNameFromRows(rows)
          if (fallback) nameCache.set(invId, fallback)
        }
      }

      // 3) identifiers → parentProjectId (EVENTS)
      let parentProjectId = null
      try { parentProjectId = await fetchParentProjectId(docId, headersCommon) } catch (e) { /* noop */ }
      LOG.info?.('[GetQuotes] parentProjectId resolvido:', parentProjectId)

      // 4) header (PROJECTS/PM)
      let header = null
      try {
        if (parentProjectId) header = await fetchAribaHeader(parentProjectId)
      } catch (e) { /* noop */ }

      // 5) monta retorno com TODOS os itens
      const headerWithDoc = Object.assign({ docId }, header || {}, { supplierName: null }) // opcional no header
      const itemsOut = results.map(r => {
        const supplierName = r._invitationId ? (nameCache.get(r._invitationId) || null) : null
        // remove campos internos antes de expor
        const { _invitationId, _itemId, ...pub } = r
        return { ...pub, supplierName }
      })

      return { header: headerWithDoc, items: itemsOut }

    } catch (e) {
      const status = e.response?.status || 502
      const msg = e.response?.data?.message || e.response?.data || e.message
      LOG.error('[GetQuotes] Erro Ariba:', status, msg)
      return req.error(status, 'Falha ao consultar supplierBids no Ariba.')
    }
  })

  this.on('getTaxCode', async (req) => {
    const VENDOR = '1000034808'
    const MATERIAL = '000000000000084363' // MATNR
    const PURCH_ORG = 'C001'
    const PURCHASINGINFOREC = '5300000217'

    // cria client SOAP usando Destination + WSDL
    const endpoint = { url: null }
    const wsdl = path.join(__dirname, 'external', 'zbapi_inforecord_getlist.wsdl')
    const client = await getSoapService('BAPI_INFORECORD_GETLIST', wsdl, endpoint, 'POST')

    // forçar o endpoint a ser o da Destination + path configurado
    client.setEndpoint(endpoint.url)

    console.log(endpoint.url)

    // monta os PARÂMETROS (objeto JS)
    const params = {
      DELETED_INFORECORDS: '',
      GENERAL_DATA: 'X',
      INFORECORD_GENERAL: { item: [] },
      INFORECORD_PURCHORG: { item: [] },
      INFORECORD_SEGMENT: { item: [] },
      INFO_TYPE: '',
      MATERIAL: MATERIAL,
      MATERIAL_EVG: {},
      MATERIAL_LONG: '',
      MAT_GRP: '',
      PLANT: '',
      PURCHASINGINFOREC: PURCHASINGINFOREC,
      PURCHORG_DATA: 'X',
      PURCHORG_VEND: 'X',
      PURCH_ORG: PURCH_ORG,
      PUR_GROUP: '',
      RETURN: { item: [] },
      VENDOR: VENDOR,
      VEND_MAT: '',
      VEND_MATG: '',
      VEND_PART: ''
    }

    try {
      // chama a operação gerada pelo WSDL (sem construir SOAP na mão)
      const resp = await client.BAPI_INFORECORD_GETLISTAsync(params)

      // resp[0] = objeto parseado (JS) da resposta SOAP (as tabelas etc.)
      return resp[0]
    } catch (e) {
      console.error('[getTaxCode] SOAP ERROR =>', e?.message || e)
      throw req.error(`Erro na chamada SOAP via Destination: ${e?.message || 'sem mensagem'}`)
    }
  })

   this.on('testInfoRecordOData', async (req) => {
    const destinationName = process.env.DESTINATION_NAME || 'S4H_QAS_CQ5_MAPA'
    const url = '/sap/opu/odata/sap/API_INFORECORD_PROCESS_SRV/?sap-client=300&$format=json'

    try {
      const resp = await executeHttpRequest(
        { destinationName },
        {
          method: 'GET',
          url,
          headers: { Accept: 'application/json' },
          responseType: 'text',   // devolve texto cru (alguns gateways retornam JSON com charset diferente)
          timeout: 20000
        },
        { fetchCsrfToken: false } // não precisa CSRF pra GET
      )

      return {
        ok: true,
        status: resp.status,
        headers: resp.headers,
        body: resp.data           // JSON em texto (ou HTML/login se tiver SSO)
      }
    } catch (e) {
      const status  = e?.response?.status
      const headers = e?.response?.headers
      const body    = e?.response?.data
      console.error('[testInfoRecordOData] error =>', {
        message: e?.message,
        status,
        bodySnippet: typeof body === 'string' ? body.slice(0, 600) : body
      })
      throw req.error(`Erro na chamada SOAP via Destination: ${e?.message || 'sem mensagem'}`)
    }
  })

}
