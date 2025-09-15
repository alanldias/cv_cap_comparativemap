const cds = require('@sap/cds')
const { LOG } = require('./lib/util/log')
const { formatAribaScenarioError, safeErr } = require('./lib/util/errors')
const { DEST, HTTP_TIMEOUT_MS, ARIBA_EVENT_ROUND } = require('./lib/config')

const { destPost } = require('./lib/http/destination')
const { fetchSupplierBids, fetchParentProjectId, fetchSupplierInvitationsList,
  pickSupplierNameByInvitation, pickSupplierNameFromRows,
  extractSapOrgEntry, extractSapVendorId } = require('./lib/ariba/events')
const { fetchAribaHeader } = require('./lib/ariba/pm')
const { enrichWithTaxCode } = require('./lib/s4/taxcode')
const { getBapiClient, buildSmokePayload, normalizeBapiResult, padLeft } = require('./lib/soap/bapi-po-create')
const { mapWithConcurrency } = require('./lib/util/concurrency')

module.exports = function () {

  this.on('GetQuotes', async (req) => {
    const { docId } = (req.data || {})
    if (!docId) return req.error(400, "Parâmetro 'docId' é obrigatório.")
    const round = Number.isFinite(Number(ARIBA_EVENT_ROUND)) ? Number(ARIBA_EVENT_ROUND) : 1

    try {
      const { rows, results } = await fetchSupplierBids(docId)
      if (!rows.length || !results.length) return { header: null, items: [] }

      const list = await fetchSupplierInvitationsList(docId, round).catch(() => [])
      const nameByInvId = new Map(), emailByInvId = new Map(), vendorByInvId = new Map()
      for (const it of list) {
        const invId = String(it?.invitationId ?? it?.userId ?? it?.uniqueName ?? '')
        if (!invId) continue
        const name = it?.organization?.name || it?.supplierName || it?.organizationName || it?.supplier?.name || null
        const email = it?.emailAddress || it?.supplierEmail || it?.email || it?.mainContact?.emailAddress || it?.contact?.email || null
        const sapEntry = extractSapOrgEntry(it)
        const sapId = sapEntry?.value ?? extractSapVendorId(it)
        if (name) nameByInvId.set(invId, name)
        if (email) emailByInvId.set(invId, email)
        if (sapId) vendorByInvId.set(invId, sapId)
      }
      for (const invId of new Set(results.map(r => r._invitationId).filter(Boolean))) {
        if (!nameByInvId.has(invId)) {
          const fb = pickSupplierNameByInvitation(rows, invId) || pickSupplierNameFromRows(rows)
          if (fb) nameByInvId.set(invId, fb)
        }
      }

      let parentProjectId = null
      try { parentProjectId = await fetchParentProjectId(docId) } catch { }
      let header = null
      try { if (parentProjectId) header = await fetchAribaHeader(parentProjectId) } catch { }

      const headerWithDoc = Object.assign({ docId }, header || {}, { supplierName: null })
      const itemsOut = results.map(r => {
        const { _invitationId, _itemId, ...pub } = r
        const invId = _invitationId || null
        const supplierName = invId ? (nameByInvId.get(invId) || null) : null
        const supplierIdSap = invId ? (vendorByInvId.get(invId) || null) : null
        const email = invId ? (emailByInvId.get(invId) || null) : null
        return { ...pub, supplierName, SupplierCode: supplierIdSap, invitationId: invId, invitationEmail: email }
      })

      return { header: headerWithDoc, items: itemsOut }

    } catch (e) {
      const status = e.response?.status || 502
      const msg = e.response?.data?.message || e.response?.data || e.message
      LOG.error('[GetQuotes] Erro Ariba:', status, msg)
      return req.error(status, 'Falha ao consultar supplierBids no Ariba.')
    }
  })

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

    const relPath = `/events/${encodeURIComponent(eventId)}/scenarios`
    try {
      const { data, headers } = await destPost(DEST.EVENTS, relPath, payload, { timeoutMs: HTTP_TIMEOUT_MS })
      const correlationId = headers?.['x-correlation-id'] || headers?.['x-correlationid'] || null
      const scenarioId = data?.scenarioId || data?.id || data?.scenarioID || null
      return { success: true, scenarioId, aribaResponse: JSON.stringify(data), correlationId }
    } catch (e) {
      const { status, correlationId, userMessage, technical } = formatAribaScenarioError(e)
      LOG.error('[CreateScenario] Falha POST /scenarios:', technical)
      return req.error(status, userMessage, { correlationId, technical })
    }
  })

  this.on('simularPO', async req => {
    try {
      const { requests = [], concurrency } = req.data || {};
      const LIMIT = Number((Number.isFinite(concurrency) ? concurrency : (process.env.CONCURRENCY || 4)));
      if (!Array.isArray(requests) || requests.length === 0) return [];

      const client = await getBapiClient()

      const mapper = async (r) => {
        const { header = {}, items: rawItems = [], schedules = [], testRun = true } = r || {}
        const items = rawItems.map(({ taxCode, ...rest }) => rest)
        const enrichInput = items.map((it, i) => ({
          __idx: i,
          Supplier: padLeft(String(header.vendor || ''), 10, '0'),
          Material: it.material || '',
          PurchasingOrganization: header.purchOrg,
          Plant: it.plant
        }))
        const enriched = await enrichWithTaxCode(enrichInput, {
          headerVendor: padLeft(String(header.vendor || ''), 10, '0')
        })
        for (const row of enriched) {
          if (row?.__idx != null) {
            items[row.__idx].taxCode = row.TaxCode ?? undefined;
            items[row.__idx].purchasingInfoRecord = row.PurchasingInfoRecord ?? undefined;
          }
        }
        const missing = items.map((it, i) => ({ i, poItem: it.poItem ?? (i + 1) * 10, material: it.material, plant: it.plant, taxCode: it.taxCode })).filter(x => !x.taxCode);
        if (missing.length) throw new Error(`Não foi possível obter TaxCode para ${missing.length} item(ns).`);

        const payload = buildSmokePayload(header, items, schedules, testRun);
        const resp = await client.BAPI_PO_CREATE1Async(payload);
        const r0 = Array.isArray(resp) ? resp[0] : resp;
        return normalizeBapiResult(r0, !!payload.TESTRUN);
      }

      const results = await mapWithConcurrency(requests, LIMIT, mapper)
      return results

    } catch (e) {
      const info = safeErr(e);
      return req.error(502, `Falha na simulação em lote: ${info.message || info.code || 'Erro desconhecido'}`);
    }
  })
}
