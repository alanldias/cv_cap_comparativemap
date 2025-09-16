sap.ui.define([], function () {
  "use strict";
  async function e(e, t) {
    const r = e.getModel();
    if (!r) throw new Error("Modelo OData V4 não encontrado.");
    const n = r.bindContext("/GetQuotes(...)");
    n.setParameter("docId", String(t));
    await n.execute();
    return n.getBoundContext().requestObject();
  }
  async function t(e, t, r) {
    const n = e.getModel();
    const o = n.bindContext("/simularPO(...)");
    o.setParameter("requests", t);
    o.setParameter("concurrency", Number(r) || 4);
    await o.execute();
    let a = o.getBoundContext().getObject();
    if (typeof o.getReturnValueContext === "function") {
      const e = o.getReturnValueContext();
      if (e) a = e.getObject() || a;
    }
    const s = Array.isArray(a) ? a : a?.value || a?.results || [];
    return Array.isArray(s) ? s[0] || {} : a || {};
  }
  async function r(
    e,
    { eventId: t, title: r, scenarioType: n, supplierBids: o },
  ) {
    const a = e.getModel();
    const s = a.bindContext("/CreateScenario(...)");
    s.setParameter("eventId", t);
    s.setParameter("title", r);
    s.setParameter("scenarioType", Number(n) || 0);
    s.setParameter("supplierBids", o);
    await s.execute();
    return s.getBoundContext().getObject();
  }
  return { fetchQuotes: e, simularPO: t, createScenario: r };
});
//# sourceMappingURL=ODataService.js.map
