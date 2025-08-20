const cds = require('@sap/cds');

// pluga endpoints REST antes do server subir
cds.on('bootstrap', app => {
  // sanity check rápido
  app.get('/api/health', (_req, res) => res.send('ok'));

  // GET /api/ariba/quotes?docId=...&supplierId=...&lineNumber=...
  app.get('/api/ariba/quotes', async (req, res, next) => {
    try {
      const db = await cds.connect.to('db');
      const { AribaQuotes } = cds.entities('ariba');

      const { docId, supplierId, lineNumber } = req.query;
      const where = {};
      if (docId) where.docId = docId;
      if (supplierId) where.supplierId = supplierId;
      if (lineNumber != null) {
        const n = Number(lineNumber);
        if (Number.isNaN(n)) return res.status(400).json({ error: 'lineNumber inválido' });
        where.lineNumber = n;
      }

      let q = SELECT.from(AribaQuotes);
      if (Object.keys(where).length) q = q.where(where);

      const rows = await db.run(q);
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });
});

// mantém o server padrão do CAP
module.exports = cds.server;
