const { destGet } = require('../http/destination')
const { DEST, HTTP_TIMEOUT_MS } = require('../config')

const firstToken = (s) => (s || '').trim().split(' ')[0] || null
const cut = (s, n) => (s || '').substring(0, n) || null

async function aribaPmGet(path, params = {}) {
    return await destGet(DEST.PROJECTS, path, { params, headers: {}, timeoutMs: Number(HTTP_TIMEOUT_MS) || 30000 })
}

function getCustomField(p, fieldId) {
    const pools = [p?.externalFields, p?.sourcingProjectCustomFields, p?.projectCustomFields, p?.fields, p?.customFields].filter(Boolean)
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
    const data = await aribaPmGet(`/projects/${encodeURIComponent(projectId)}`)
    return mapAribaHeader(data || {})
}

module.exports = { fetchAribaHeader, mapAribaHeader }
