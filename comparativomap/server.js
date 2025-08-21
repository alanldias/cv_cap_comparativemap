const cds = require('@sap/cds');

// ---- Config de toggle (env)
const USE_REMOTE = (process.env.USE_REMOTE || 'false').toLowerCase() === 'true';
const REMOTE_BASE = process.env.ARIBA_API_BASE || '';   
const API_KEY     = process.env.ARIBA_API_KEY;    

function buildRemotePath(q) {
  const params = new URLSearchParams(q);
  return `/quotes?${params.toString()}`;
}

const mapToExternalSchema = row => ({
  docId: row.docId,
  supplierId: row.supplierId,
  lineNumber: row.lineNumber,
  arb_Document_Type: row.arb_Document_Type,
  arb_PurchasingOrganization: row.arb_PurchasingOrganization,
  arb_PurchasingGroup: row.arb_PurchasingGroup,
  arb_CompanyCode: row.arb_CompanyCode,
  INCOTERMS1: row.INCOTERMS1,
  INCOTERMS2: row.INCOTERMS2,
  arb_PaymentTerms: row.arb_PaymentTerms,
  currency: row.currency,
  materialCode: row.materialCode,
  materialDesc: row.materialDesc,
  quantity: row.quantity,
  uom: row.uom,
  netPrice: row.netPrice,
  supplierName: row.supplierName
});

cds.on('bootstrap', app => {
  // health-check
  app.get('/api/health', (_req, res) => res.send('ok'));

  app.get('/api/comparativemap/quotes', async (req, res, next) => {
    try {
      // 1) Tenta REMOTO se flag ligada
      if (USE_REMOTE && REMOTE_BASE) {
        const remote = await cds.connect.to('AribaApproval');
        const path = buildRemotePath(req.query);
        const result = await remote.send({
          method: 'GET',
          path,
          headers: API_KEY ? { apikey: API_KEY } : {}
        });
        return res.json(result);
      }

      const db = await cds.connect.to('db');
      const { AribaQuotes } = cds.entities('comparativemap');

      const where = {};
      const { docId, supplierId, lineNumber } = req.query;
      if (docId) where.docId = docId;
      if (supplierId) where.supplierId = supplierId;
      if (lineNumber != null) {
        const n = Number(lineNumber);
        if (Number.isNaN(n)) return res.status(400).json({ error: 'lineNumber inválido' });
        where.lineNumber = n;
      }

      let q = SELECT.from(AribaQuotes);
      if (Object.keys(where).length) q = q.where(where);
      q = q.orderBy('docId', 'supplierId', 'lineNumber');
      const rows = await db.run(q);
      return res.json(rows.map(mapToExternalSchema));
    } catch (e) {
      next(e);
    }
  });
});

module.exports = cds.server;
