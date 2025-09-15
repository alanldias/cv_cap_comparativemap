const cds = require('@sap/cds')
const LOG = cds.log?.('ariba-service') || console
function dbg(...args) {
    if (process.env.NODE_ENV !== 'production') console.debug('[DBG]', ...args)
    else LOG.info?.(...args) // opcional gravar em INFO em prod
}
function mask(s) {
    if (s == null) return s
    const t = String(s)
    if (t.length <= 6) return '***'
    return `${t.slice(0, 4)}***${t.slice(-2)}`
}
module.exports = { LOG, dbg, mask }
