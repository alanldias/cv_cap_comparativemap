const cds = require('@sap/cds');

module.exports = cds.service.impl(async function () {
  const { AribaQuotes } = this.entities;

  // Function import "GetQuotes" - consulta por parâmetros (docId, supplierId, lineNumber)
  this.on('GetQuotes', async (req) => {
    const { docId, supplierId, lineNumber } = req.data;

    // Monta SELECT dinâmico com AND implícito
    let q = SELECT.from(AribaQuotes);
    const where = {};

    if (docId) where.docId = docId;
    if (supplierId) where.supplierId = supplierId;

    if (lineNumber !== undefined && lineNumber !== null) {
      const n = Number(lineNumber);
      if (Number.isNaN(n)) return req.reject(400, 'lineNumber inválido');
      where.lineNumber = n;
    }

    if (Object.keys(where).length) q = q.where(where);
    return await cds.run(q);
  });

  // (Opcional) Hooks de boas práticas — log, validações leves, etc.
  this.before('READ', 'AribaQuotes', (req) => {
    // Ex.: validar formatos, aplicar defaults, auditoria, etc.
    // console.log('READ AribaQuotes', req.query);
  });
});
