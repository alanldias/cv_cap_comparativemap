// srv/lib/s4/taxcode.js
const { getDestination } = require('@sap-cloud-sdk/connectivity')
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client')
const { S4, DEST } = require('../config')
const { LOG, kv, mask } = require('../util/log')

async function enrichWithTaxCode(items, options = {}) {
    const input = Array.isArray(items) ? items : []
    if (!input.length) return []

    const s4hDest = options.destinationName ?? DEST.S4H
    const sapClient = options.sapClient ?? S4.SAP_CLIENT
    const odataPath = options.path ?? S4.ODATA_PATH
    const timeoutMs = options.timeoutMs != null ? Number(options.timeoutMs) : S4.TIMEOUT_MS
    const throwIfMissing = !!options.throwIfMissing

    const _esc = (v = '') => String(v).replace(/'/g, "''").trim()
    const _canon = v => String(v ?? '').trim().toUpperCase()
    const _no0 = s => String(s || '').replace(/^0+/, '')
    const _supKey = s => _no0(String(s || '').replace(/\D/g, ''))
    const _matKey = m => _canon(_no0(m))
    const _tripKey = (M, PO, P) => [_matKey(M), _canon(PO), _canon(P)].join('|')

    const headerVendor = String(options.headerVendor || '').replace(/\D/g, '').replace(/^0+/, '') || null
    const preferredByItem = input.map(it => _supKey(it.Supplier) || headerVendor || null)

    // chaves únicas
    const triples = []; const seen = new Set()
    for (const it of input) {
        const k = _tripKey(it.Material, it.PurchasingOrganization, it.Plant)
        if (!k.includes('||') && !seen.has(k)) {
            seen.add(k)
            triples.push({ Material: it.Material, PurchasingOrganization: it.PurchasingOrganization, Plant: it.Plant })
        }
    }

    LOG.infoL('[taxcode] START', { items: input.length, triples: triples.length, dest: s4hDest, sapClient, path: odataPath, timeoutMs })

    if (!triples.length) {
        const out = input.map(it => ({ ...it, TaxCode: null, PurchasingInfoRecord: null }))
        if (throwIfMissing) throw new Error('Não foi possível montar as chaves (Material/Org/Plant) para consultar TaxCode.')
        return out
    }

    const dest = await getDestination({ destinationName: s4hDest })
    if (!dest) throw new Error(`Destination '${s4hDest}' não encontrada.`)

    const CHUNK = 25
    const totalChunks = Math.ceil(triples.length / CHUNK)
    const allRows = []

    for (let i = 0; i < triples.length; i += CHUNK) {
        const chunkIdx = (i / CHUNK) + 1
        const part = triples.slice(i, i + CHUNK)
        const filter = part.map(t =>
            `(Material eq '${_esc(t.Material)}' and PurchasingOrganization eq '${_esc(t.PurchasingOrganization)}' and Plant eq '${_esc(t.Plant)}')`
        ).join(' or ')
        const query = [
            '$format=json',
            '$select=Supplier,Material,PurchasingOrganization,Plant,PurchasingInfoRecord,TaxCode',
            `$filter=${encodeURIComponent(filter)}`,
            `sap-client=${encodeURIComponent(sapClient)}`
        ].join('&')
        const url = `${odataPath}?${query}`

        LOG.infoL('[taxcode] CHUNK GET', { idx: chunkIdx, totalChunks, size: part.length, url })

        const t0 = Date.now()
        try {
            const resp = await executeHttpRequest(
                dest,
                { method: 'GET', url, headers: { Accept: 'application/json' }, timeout: timeoutMs },
                { fetchCsrfToken: false }
            )
            const rows = resp.data?.d?.results ?? resp.data?.value ?? []
            allRows.push(...rows)
            LOG.infoL('[taxcode] CHUNK OK', { idx: chunkIdx, ms: Date.now() - t0, rows: rows.length })
        } catch (e) {
            LOG.errorL('[taxcode] CHUNK ERROR', { idx: chunkIdx, ms: Date.now() - t0, err: e?.message || String(e) })
            throw new Error(`[TaxCode] Falha ao consultar S/4 (${odataPath}) para ${part.length} chave(s): ${e?.message || e}`)
        }
    }

    // indexa por tripla
    const byTrip = new Map()
    for (const r of allRows) {
        const k = _tripKey(r.Material, r.PurchasingOrganization, r.Plant)
            ; (byTrip.get(k) || byTrip.set(k, []).get(k)).push(r)
    }
    LOG.infoL('[taxcode] INDEX', { keys: byTrip.size, totalRows: allRows.length })

    const chooseBest = (list, preferSup) => {
        if (!Array.isArray(list) || !list.length) return null
        const rank = x => (x && String(x.TaxCode || '').trim() ? 1 : 0)
        const pir = x => String(x.PurchasingInfoRecord || '')
        const sup = x => _supKey(x.Supplier)
        const prefer = _supKey(preferSup)
        const sorted = list.slice().sort((a, b) => {
            const aPref = (sup(a) === prefer) ? 1 : 0
            const bPref = (sup(b) === prefer) ? 1 : 0
            if (aPref !== bPref) return bPref - aPref
            const aHas = rank(a), bHas = rank(b)
            if (aHas !== bHas) return bHas - aHas
            const pirCmp = pir(b).localeCompare(pir(a)) // desc
            if (pirCmp !== 0) return pirCmp
            return sup(a).localeCompare(sup(b))
        })
        return sorted[0] || null
    }

    const out = input.map((it, idx) => {
        const k = _tripKey(it.Material, it.PurchasingOrganization, it.Plant)
        const list = byTrip.get(k) || []
        const pick = chooseBest(list, preferredByItem[idx])
        return {
            ...it,
            TaxCode: pick?.TaxCode ?? null,
            PurchasingInfoRecord: pick?.PurchasingInfoRecord ?? null,
            __taxSupplierUsed: pick?.Supplier ?? null
        }
    })

    const missing = out.filter(x => !x.TaxCode).length
    LOG.infoL('[taxcode] END', { enriched: out.length, missing })

    if (throwIfMissing && missing) {
        const detalhes = out
            .map((row, idx) => ({ row, src: input[idx], pref: preferredByItem[idx] }))
            .filter(x => !x.row.TaxCode)
            .slice(0, 10) // limita no log
            .map(x => `• MAT=${x.src.Material || '-'} | Plant=${x.src.Plant || '-'} | POrg=${x.src.PurchasingOrganization || '-'}${x.pref ? ` | PreferSup=${x.pref}` : ''}`)
            .join('\n')
        throw new Error(`Não foi possível obter TaxCode para ${missing} item(ns):\n${detalhes}`)
    }

    return out
}

module.exports = { enrichWithTaxCode }
