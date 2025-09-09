require('dotenv').config()
'use strict'
const cds = require('@sap/cds')
const axios = require('axios')
const { getDestination } = require('@sap-cloud-sdk/connectivity')
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

// ==================== SWITCH DESTINATION vs .ENV ====================
const USE_DESTINATION = (process.env.USE_DESTINATION || 'false') === 'true'
const EVENTS_DEST = process.env.ARIBA_DEST_EVENTS || 'ARIBA_Event_Management_Test'
const PROJECTS_DEST = process.env.ARIBA_DEST_PROJECTS || 'ARIBA_Sourcing_Project_Management_Test'

const EVENTS_API_PREFIX = process.env.ARIBA_EVENTS_API_PREFIX || '/api/sourcing-event/v2/prod'
const PM_API_PREFIX = process.env.ARIBA_PM_API_PREFIX || '/api/sourcing-project-management/v2/prod'
const S4H_DEST = process.env.S4H_DEST || 'S4H_QAS_CQ5_MAPA'
const S4H_SAP_CLIENT = process.env.S4H_SAP_CLIENT || '300'
const S4H_ODATA_PATH = '/sap/opu/odata/sap/API_INFORECORD_PROCESS_SRV/A_PurgInfoRecdOrgPlantData'

const _destTokenCache = {} // cache simples por tokenUrl|clientId


function _escapeOData(v = '') {
  return String(v).replace(/'/g, "''").trim()
}
function _makeKey(Supplier, Material, PurchasingOrganization, Plant) {
  return [Supplier, Material, PurchasingOrganization, Plant].map(v => (v ?? '').trim()).join('|')
}


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

      // pega o valor bruto, independente se vem em .value ou direto
      const deliveryRaw = byId['REQUESTDELIVERYDATE']?.value ?? byId['REQUESTDELIVERYDATE'] ?? null

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
        grupo_de_materias: grupoMaterias,
        DELIVERY_DATE_RAW: deliveryRaw ?? null
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

// LISTA
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
  console.log(data)
  return toArr(data) // <— apenas o array de registros
}

// buscar o iva por pedido enviado
async function enrichWithTaxCode(items, options = {}) {
  const arr = Array.isArray(items) ? items : []
  if (!arr.length) return []

  const DEST_NAME = options.destinationName || process.env.S4H_DEST || 'S4H_QAS_CQ5_MAPA'
  const SAP_CLIENT = options.sapClient || process.env.S4H_SAP_CLIENT || '300'
  const ODATA_PATH = options.path || '/sap/opu/odata/sap/API_INFORECORD_PROCESS_SRV/A_PurgInfoRecdOrgPlantData'
  const TIMEOUT_MS = Number(options.timeoutMs || process.env.HTTP_TIMEOUT_MS || 30000)

  // monta $filter com OR de cada par Supplier/Material (+Org/Plant se vierem)
  const clauses = arr.map(({ Supplier, Material, PurchasingOrganization, Plant }) => {
    const parts = []
    if (Supplier) parts.push(`Supplier eq '${_escapeOData(Supplier)}'`)
    if (Material) parts.push(`Material eq '${_escapeOData(Material)}'`)
    if (PurchasingOrganization) parts.push(`PurchasingOrganization eq '${_escapeOData(PurchasingOrganization)}'`)
    if (Plant) parts.push(`Plant eq '${_escapeOData(Plant)}'`)
    return `(${parts.join(' and ')})`
  }).filter(c => c !== '()')

  // evita query "aberta" caso todos os itens venham incompletos
  const $filter = clauses.length ? clauses.join(' or ') : '1 eq 2'

  const $select = [
    'Supplier', 'Material', 'PurchasingOrganization', 'Plant',
    'PurchasingInfoRecord', 'TaxCode'
  ].join(',')

  const query = [
    '$format=json',
    `$select=${$select}`,
    `$filter=${encodeURIComponent($filter)}`,
    `sap-client=${encodeURIComponent(SAP_CLIENT)}`
  ].join('&')

  const relativeUrl = `${ODATA_PATH}?${query}`

  // Destination + log da URL completa (pra você testar no seu HTTP client)
  const dest = await getDestination({ destinationName: DEST_NAME })
  if (!dest) throw new Error(`Destination '${DEST_NAME}' não encontrada.`)

  const base = (dest.url || '').endsWith('/') ? dest.url.slice(0, -1) : (dest.url || '')
  const fullUrl = `${base}${relativeUrl.startsWith('/') ? '' : '/'}${relativeUrl}`
  console.log('[enrichWithTaxCode] OData URL =>', fullUrl)

  // chamada GET no OData
  let data
  try {
    const resp = await executeHttpRequest(
      dest,
      { method: 'GET', url: relativeUrl, headers: { Accept: 'application/json' }, timeout: TIMEOUT_MS },
      { fetchCsrfToken: false }
    )
    data = resp.data
  } catch (e) {
    const status = e?.response?.status || 502
    const msg = e?.response?.data?.error?.message || e?.message
    LOG?.error?.('[enrichWithTaxCode] Erro OData S/4:', status, msg)
    throw e
  }

  // OData V2 (data.d.results) ou V4 (data.value)
  const rows = data?.d?.results ?? data?.value ?? []

  // index por chave composta para casar com o input
  const byKey = new Map()
  for (const r of rows) {
    const key = _makeKey(r.Supplier, r.Material, r.PurchasingOrganization, r.Plant)
    if (!byKey.has(key)) byKey.set(key, r)
  }

  // devolve o mesmo array, enriquecido
  return arr.map(it => {
    const key = _makeKey(it.Supplier, it.Material, it.PurchasingOrganization, it.Plant)
    const r = byKey.get(key)
    return {
      ...it,
      TaxCode: r?.TaxCode ?? null,
      PurchasingInfoRecord: r?.PurchasingInfoRecord ?? null
    }
  })
}

// --- helpers locais (fora de module.exports) ---
function _escapeOData(v = '') {
  return String(v).replace(/'/g, "''").trim()
}
function _makeKey(Supplier, Material, PurchasingOrganization, Plant) {
  return [Supplier, Material, PurchasingOrganization, Plant]
    .map(v => (v ?? '').trim()).join('|')
}

// ==================== HANDLER ODATA ====================
module.exports = function () {

  // ==================== HANDLER ODATA ====================
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

        // 2) resolver supplierName + email + SAP Vendor + entry domain/value por invitationId (um GET só)
        const list = await fetchSupplierInvitationsList(docId, round, headersCommon).catch(() => [])
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
          const invId = r._invitationId
          const supplierName = invId ? (nameByInvId.get(invId) || null) : null
          const supplierIdSap = invId ? (vendorByInvId.get(invId) || null) : null

          // remove campos internos antes de expor
          const { _invitationId, _itemId, ...pub } = r
          // acrescenta:
          // - Supplier: string (ID SAP)
          // - SupplierOrgId: objeto original do Ariba { domain: 'sap', value: '...' }
          return { ...pub, supplierName, SupplierCode: supplierIdSap }
        })

        return { header: headerWithDoc, items: itemsOut }

      } catch (e) {
        const status = e.response?.status || 502
        const msg = e.response?.data?.message || e.response?.data || e.message
        LOG.error('[GetQuotes] Erro Ariba:', status, msg)
        return req.error(status, 'Falha ao consultar supplierBids no Ariba.')
      }
    })

  }

