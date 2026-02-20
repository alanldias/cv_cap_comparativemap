sap.ui.define([], function () {
  "use strict";

  /**
   * ✅ Como ligar o mock:
   * - URL: ...index.html?mock=true
   * - ou LocalStorage: localStorage.setItem("comparativemap.mock", "1")
   *
   * 🔧 Se você quiser FORÇAR mock sempre (pra demo), deixe MOCK_ENABLED_BY_DEFAULT = true
   * Se quiser voltar pro backend sem mexer em código, deixe false e use ?mock=true só quando precisar.
   */
  const MOCK_ENABLED_BY_DEFAULT = true;

  function isMockEnabled(view) {
    try {
      if (MOCK_ENABLED_BY_DEFAULT) return true;

      const qs =
        (typeof window !== "undefined" &&
          window.location &&
          window.location.search) ||
        "";
      if (/[?&]mock(=1|=true)?/i.test(qs)) return true;

      const ls =
        typeof window !== "undefined" && window.localStorage
          ? window.localStorage.getItem("comparativemap.mock")
          : null;
      if (ls === "1" || ls === "true") return true;

      // fallback inteligente: se não tem model OData, não trava a demo
      return !view?.getModel?.();
    } catch (e) {
      return true;
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function money(n) {
    const x = Number(n);
    return Number.isFinite(x) ? Number(x.toFixed(2)) : 0;
  }

  function toEdmDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function toNiceDate(edm) {
    // "YYYY-MM-DD" -> "DD/MM/YYYY"
    const s = String(edm || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "-";
    return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
  }

  function seedFromDocId(docId) {
    const s = String(docId || "").replace(/\D/g, "");
    const n = Number(s.slice(-6) || "1");
    return Number.isFinite(n) ? n : 1;
  }

  function buildMockQuotes(docId) {
    const seed = seedFromDocId(docId);
    const baseDate = new Date();
    baseDate.setDate(baseDate.getDate() + 10);
    const deliveryEdm = toEdmDate(baseDate);

    const header = {
      docId: String(docId || ""),
      tipoPedido: "NB",
      purchasingOrganization: "BR01",
      purchasingGroup: "A01",
      companyCode: "1000",
      incoterms1: "FOB",
      incoterms2: "São Paulo - SP",
      paymentTerms: "30D",
      moeda: "BRL",
    };

    const suppliers = [
      {
        supplierName: "MetalParts S.A.",
        lifnr: "0000123401",
        suppliercode: "0000123401",
        invitationId: "INV-3401",
        invitationEmail: "cotacoes@metalparts.com",
      },
      {
        supplierName: "Fasteners Brasil Ltda.",
        lifnr: "0000123402",
        suppliercode: "0000123402",
        invitationId: "INV-3402",
        invitationEmail: "sales@fastenersbr.com",
      },
      {
        supplierName: "Indústria FixPro",
        lifnr: "0000123403",
        suppliercode: "0000123403",
        invitationId: "INV-3403",
        invitationEmail: "comercial@fixpro.com",
      },
    ];

    const materials = [
      {
        MaterialCode: "000000000000123456",
        itemDescription: "Parafuso Sextavado Inox M8 x 30",
        ncm: "73181500",
        grupo_de_materias: "MRO-FIX",
        ItemCategory: "0",
        PLANT: "1000",
        unitOfMeasure: "EA",
      },
      {
        MaterialCode: "000000000000123457",
        itemDescription: "Porca Travante Inox M8",
        ncm: "73181600",
        grupo_de_materias: "MRO-FIX",
        ItemCategory: "0",
        PLANT: "1000",
        unitOfMeasure: "EA",
      },
      {
        MaterialCode: "000000000000123458",
        itemDescription: "Arruela Lisa Inox M8",
        ncm: "73182200",
        grupo_de_materias: "MRO-FIX",
        ItemCategory: "0",
        PLANT: "1000",
        unitOfMeasure: "EA",
      },
      {
        MaterialCode: "000000000000777001",
        itemDescription: "Kit EPIs (Luva + Óculos + Protetor Auricular)",
        ncm: "39262000",
        grupo_de_materias: "MRO-EPI",
        ItemCategory: "0",
        PLANT: "1100",
        unitOfMeasure: "EA",
      },
    ];

    // Gera linhas: cada fornecedor cota os mesmos itens com preços diferentes
    let poItem = 10;
    const items = [];

    for (let m = 0; m < materials.length; m++) {
      for (let s = 0; s < suppliers.length; s++) {
        const sup = suppliers[s];
        const mat = materials[m];

        // variação determinística pra parecer “real”
        const qty = [50, 120, 200, 30][m] + ((seed + s * 7 + m * 11) % 15);
        const basePrice = [1.25, 0.85, 0.22, 38.9][m];
        const spread = 1 + (s * 0.035) + ((seed % 9) * 0.002);
        const price = money(basePrice * spread);

        const ext = money(price * qty);

        const aliqICMS = 18;
        const aliqIPI = m === 3 ? 0 : 5; // EPIs isenta no mock só pra variar
        const aliqPIS = 1.65;
        const aliqCOFINS = 7.6;
        const mva = 40;

        items.push({
          // chaves usadas pela UI / seleção / serviços
          poItem, // ajuda o Mapper a bater 1:1 no resultado da simulação
          itemId: `ITM-${String(seed).slice(-3)}-${String(poItem).padStart(4, "0")}`,
          ItemId: `ITM-${String(seed).slice(-3)}-${String(poItem).padStart(4, "0")}`,

          supplierName: sup.supplierName,
          suppliercode: sup.suppliercode,
          SupplierCode: sup.suppliercode,
          supplierId: sup.lifnr,
          lifnr: sup.lifnr,
          LIFNR: sup.lifnr,
          invitationId: sup.invitationId,
          _invitationId: sup.invitationId,
          invitationEmail: sup.invitationEmail,

          itemDescription: mat.itemDescription,
          currency: "BRL",
          quantity: qty,
          price,

          EXTENDEDPRICE: ext,

          ncm: mat.ncm,
          mva,

          Extrinsic_Aliquota_ICMS: aliqICMS,
          Extrinsic_ICMS_Apurado: money(ext * (aliqICMS / 100)),

          Extrinsic_Aliquota_IPI: aliqIPI,
          Extrinsic_IPI_Apurado: money(ext * (aliqIPI / 100)),

          Extrinsic_Aliquota_PIS: aliqPIS,
          Extrinsic_PIS_Apurado: money(ext * (aliqPIS / 100)),

          Extrinsic_Aliquota_Cofins: aliqCOFINS,
          Extrinsic_Cofins_apurado: money(ext * (aliqCOFINS / 100)),

          Extrinsic_Aliquota_ICMS_Interna: aliqICMS,
          Extrinsic_Origem_do_Material: "Nacional",

          PLANT: mat.PLANT,
          ItemCategory: mat.ItemCategory,
          CodigoRequisicao: `45${String(10000000 + (seed % 9999999)).slice(0, 8)}`,
          grupo_de_materias: mat.grupo_de_materias,
          MaterialCode: mat.MaterialCode,

          Incoterms: "FOB",
          NumeroItensRequisicao: String(poItem),
          CodigoRFQ: `RFQ-2026-${String(1000 + (seed % 9000)).padStart(4, "0")}`,

          DeliveryDateEdm: deliveryEdm,
          DeliveryDateNice: toNiceDate(deliveryEdm),
          PrazoEntrega: "10 dias",

          unitOfMeasure: mat.unitOfMeasure,
        });

        poItem += 10;
      }
    }

    return { header, items };
  }

  function buildMockSchedules(qty) {
    const d1 = new Date();
    d1.setDate(d1.getDate() + 10);
    const d2 = new Date();
    d2.setDate(d2.getDate() + 20);

    const q1 = Math.max(0, Math.floor(qty * 0.6));
    const q2 = Math.max(0, Math.floor(qty - q1));

    return [
      { delivDate: toEdmDate(d1), quantity: q1 },
      { delivDate: toEdmDate(d2), quantity: q2 },
    ].filter((x) => x.quantity > 0);
  }

  function buildMockSimularPO(requests) {
    const reqs = Array.isArray(requests) ? requests : [];
    const priceDate = toEdmDate(new Date());

    return reqs.map((req, idx) => {
      const vendor =
        String(req?.header?.vendor || "").trim() || `00001234${String(idx + 1).padStart(2, "0")}`;
      const currency = String(req?.header?.currency || "BRL").toUpperCase().slice(0, 3);

      // “desconto” fake por fornecedor só pra ficar bonito
      const discount = 0.02 + (idx % 3) * 0.01; // 2%, 3%, 4%

      const itens = (req.items || []).map((it) => {
        const qty = Number(it?.quantity || 0) || 0;
        const gross = Number(it?.netPrice || 0) || 0; // no teu mapper isso vem do preço do item
        const net = money(gross * (1 - discount));
        const base = net * qty;

        return {
          poItem: it?.poItem,
          material: it?.material || "",

          quantidade: qty,
          netPrice: net,
          descricao: it?.shortText || "Item",
          unidade: it?.unit || "EA",
          poUnit: it?.unit || "EA",

          // campos extras do dialog
          ncm: "73181500",
          taxCode: "I0",
          taxJurCode: null,
          priceUnit: 1,
          priceDate,

          schedules: buildMockSchedules(qty),

          // impostos fake calculados
          icms: money(base * 0.18),
          ipi: money(base * 0.05),
        };
      });

      return {
        success: true,
        header: {
          fornecedor: vendor,
          vendor,
          moeda: currency,
        },
        itens,
        returnMessages: [],
      };
    });
  }

  // =========================
  // API pública (mesmos nomes)
  // =========================

  async function fetchQuotes(view, docId) {
    if (isMockEnabled(view)) {
      await sleep(250);
      return buildMockQuotes(docId);
    }

    // === Backend real (mantido pra você reativar quando quiser) ===
    const oOData = view.getModel();
    if (!oOData) throw new Error("Modelo OData V4 não encontrado.");

    const oCtx = oOData.bindContext("/GetQuotes(...)");
    oCtx.setParameter("docId", String(docId));
    await oCtx.execute();

    return oCtx.getBoundContext().requestObject(); // { header, items }
  }

  async function simularPO(view, requests, concurrency) {
    if (isMockEnabled(view)) {
      await sleep(450);
      return buildMockSimularPO(requests);
    }

    // === Backend real (mantido) ===
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
    if (isMockEnabled(view)) {
      await sleep(300);
      const rand = Math.floor(100000 + Math.random() * 900000);
      return {
        success: true,
        scenarioId: `SCN-DEMO-${rand}`,
        correlationId: `CORR-${Date.now()}`,
        // opcional: eco pra debug
        echo: { eventId, title, scenarioType, supplierBidsCount: supplierBids?.length || 0 },
      };
    }

    // === Backend real (mantido) ===
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
