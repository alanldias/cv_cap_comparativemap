
const cds = require('@sap/cds');
require('dotenv').config();
const axios = require('axios');
const { simularPO } = require('./utils/simular-po') // <<=== Lógica da chamada da BAPI
const { getDestination, addDestinationToRequestConfig } = require('@sap-cloud-sdk/connectivity')


// Log
const LOG = cds.log('ariba-service')

// Token dos ENDPOINTS de EVENTS (teu projeto)
const { getAccessToken } = require('../srv/auth/aribaOauth')

// ==================== SWITCH DESTINATION vs .ENV ====================
const USE_DESTINATION = (process.env.USE_DESTINATION || 'false') === 'true'
const EVENTS_DEST = process.env.ARIBA_DEST_EVENTS || 'ARIBA_Event_Management_Test'
const PROJECTS_DEST = process.env.ARIBA_DEST_PROJECTS || 'ARIBA_Project_Management_Test'

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

// ==================== HELPER: GET via Destination ====================
async function destGet(destName, relativePath, { params = {}, headers = {}, timeoutMs = 30000 } = {}) {
  const destination = await getDestination({ destinationName: destName })
  const reqCfg = await addDestinationToRequestConfig(
    { method: 'get', url: relativePath, params, headers, timeout: timeoutMs },
    destination
  )
  const { data } = await axios.request(reqCfg) // Authorization + headers/queries da destination
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
      params: {}, headers: {}, timeoutMs: Number(HTTP_TIMEOUT_MS) || 30000
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
async function fetchParentProjectId(docId, headersCommon) {
  const path = `/events/identifiers`
  let data
  if (USE_DESTINATION) {
    data = await destGet(EVENTS_DEST, path, { params: {}, headers: {}, timeoutMs: Number(HTTP_TIMEOUT_MS) || 30000 })
  } else {
    const urlIds = `${ARIBA_BASE_URL_EVENTS}${path}`
    const resp = await axios.get(urlIds, {
      params: {
        realm: ARIBA_REALM,
        user: ARIBA_USER,
        passwordAdapter: ARIBA_PASSWORD_ADAPTER,
        $filter: '(createDateFrom gt 01082025000000 and createDateTo lt 31122025000000)'
      },
      headers: headersCommon,
      timeout: Number(HTTP_TIMEOUT_MS) || 30000
    })
    data = resp.data
  }
  const arr = toArr(data)
  const parentProjectId = arr.find(x => String(x?.internalId) === String(docId))?.parentProjectId ?? null
  return parentProjectId
}

/**
 * 3) Lista de supplier invitations do round
 */
async function fetchSupplierInvitationsList(docId, round, headersCommon) {
  const path = `/events/${encodeURIComponent(docId)}/rounds/${encodeURIComponent(round)}/supplierInvitations`
  let data
  if (USE_DESTINATION) {
    data = await destGet(EVENTS_DEST, path, { params: {}, headers: {}, timeoutMs: Number(HTTP_TIMEOUT_MS) || 30000 })
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

/**
 * 4) Supplier Invitation por ID COMPLETO (não concatena email!)
 */
async function fetchSupplierInvitationById(docId, round, resourceId, headersCommon) {
  if (!resourceId) return null
  const path = `/events/${encodeURIComponent(docId)}/rounds/${encodeURIComponent(round)}/supplierInvitations/${encodeURIComponent(resourceId)}`
  let data
  if (USE_DESTINATION) {
    data = await destGet(EVENTS_DEST, path, { params: {}, headers: {}, timeoutMs: Number(HTTP_TIMEOUT_MS) || 30000 })
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

  this.on('SimulateBapiPoCreate', async req => {
    // Esses logs só aparecem se a validação do CAP deixar passar.
    LOG.info("[SimulateBapiPoCreate] req.data =", JSON.stringify(req.data, null, 2));

    const { items = [], header = {} } = req.data ?? {};
    LOG.info("[SimulateBapiPoCreate] items.length =", Array.isArray(items) ? items.length : `(!array: ${typeof items})`);
    LOG.info("[SimulateBapiPoCreate] header =", header);

    if (!Array.isArray(items)) return req.error(400, "'items' deve ser um array.");
    if (!items.length) LOG.warn("[SimulateBapiPoCreate] 'items' chegou vazio.");

    // 1) Resolver LIFNR por item (se não vier no payload)
    async function resolveLifnrForItem(it) {
      if (it.lifnr) return String(it.lifnr).padStart(10, '0');
      // ======= PONTO DE INTEGRAÇÃO =======
      // Implemente aqui sua lógica real:
      // - Consultar uma tabela de mapeamento (ex.: tabela CDS sua)
      // - Ou chamar API do S/4 (A_Supplier / Business Partner) com chave (CNPJ, supplierId, etc.)
      // - Evite "nome" puro; prefira chaves confiáveis. Sem mock.
      // Se não for possível resolver, lance erro claro:
      throw Object.assign(new Error(`Não foi possível resolver LIFNR para o fornecedor do item (ex.: ${it.supplierName || it.MaterialCode || 'sem identificação'})`), { userMessage: true });
    }
    // 2) Normalizar e validar que cada item tenha LIFNR resolvido
    const itemsComLifnr = [];
    for (const it of items) {
      const lifnr = await resolveLifnrForItem(it).catch(err => {
        throw req.error(400, err.userMessage ? err.message : `Falha ao resolver LIFNR: ${err.message}`);
      });
      itemsComLifnr.push({ ...it, lifnr });
    }
    // 3) Agrupar por fornecedor
    const grupos = itemsComLifnr.reduce((acc, it) => {
      (acc[it.lifnr] ||= []).push(it);
      return acc;
    }, {});
    // 4) Executar simulações em série (ou em paralelo com Promise.all se seu backend suportar)
    const respostas = [];
    for (const [lifnr, grupo] of Object.entries(grupos)) {
      const cab = { ...header, fornecedor: lifnr }; // força fornecedor por grupo
      try {
        const resp = await simularPO(grupo, cab);
        respostas.push({ lifnr, ...resp });
      } catch (e) {
        // agrega erro do grupo com contexto de LIFNR
        const msg = e.userMessage || e.message || `Erro ao simular para LIFNR ${lifnr}`;
        return req.error(400, msg);
      }
    }
    // 5) Agregar numa resposta só (formato compatível com a sua UI atual)
    // Você pode unificar as tabelas e mensagens:
    const success = respostas.every(r => r.success);
    const messages = respostas.flatMap(r => r.messages || []);
    const tabelaItens = respostas.flatMap(r =>
      (r.tabelaItens || []).map(line => ({ ...line, fornecedor: r.lifnr }))
    );
    const purchaseOrder = null; // Em TESTRUN pode não ter, e multi-fornecedor geraria múltiplas ordens.

    return { success, messages, purchaseOrder, tabelaItens };
  });

}
