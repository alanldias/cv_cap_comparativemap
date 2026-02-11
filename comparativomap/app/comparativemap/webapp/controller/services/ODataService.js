sap.ui.define([], function () {
  "use strict";

  async function fetchQuotes(view, docId) {
    const oOData = view.getModel();
    if (!oOData) throw new Error("Modelo OData V4 não encontrado.");

    const oCtx = oOData.bindContext("/GetQuotes(...)");
    oCtx.setParameter("docId", String(docId));
    await oCtx.execute();

    return oCtx.getBoundContext().requestObject(); // { header, items }
  }

  async function simularPO(view, requests, concurrency) {
    const oOData = view.getModel();
    if (!oOData) throw new Error("Modelo OData V4 não encontrado.");

    const oCtx = oOData.bindContext("/simularPO(...)");
    oCtx.setParameter("requests", requests);
    oCtx.setParameter("concurrency", Number(concurrency) || 4);
    await oCtx.execute();

    const opResult = oCtx.getBoundContext().getObject();
    const arr = Array.isArray(opResult)
      ? opResult
      : opResult?.value || opResult?.results || [];

    return Array.isArray(arr) ? arr : opResult ? [opResult] : [];
  }

  async function createScenario(view, { eventId, title, scenarioType, supplierBids }) {
    const oOData = view.getModel();
    if (!oOData) throw new Error("Modelo OData V4 não encontrado.");

    const oOp = oOData.bindContext("/CreateScenario(...)");
    oOp.setParameter("eventId", eventId);
    oOp.setParameter("title", title);
    oOp.setParameter("scenarioType", Number(scenarioType) || 0);
    oOp.setParameter("supplierBids", supplierBids);
    await oOp.execute();

    return oOp.getBoundContext().getObject(); // { success, scenarioId, correlationId, ... }
  }

  return { fetchQuotes, simularPO, createScenario };
});
