// srv/service.js
const cds = require("@sap/cds");
const { LOG } = require("./lib/util/log");
const { formatAribaScenarioError, safeErr } = require("./lib/util/errors");
const { DEST, HTTP_TIMEOUT_MS, ARIBA_EVENT_ROUND } = require("./lib/config");
const { createSemaphore } = require("./lib/util/throttle");

const { destPost } = require("./lib/http/destination");
const {
  fetchSupplierBids,
  fetchParentProjectId,
  fetchSupplierInvitationsList,
  pickSupplierNameByInvitation,
  pickSupplierNameFromRows,
  extractSapOrgEntry,
  extractSapVendorId,
} = require("./lib/ariba/events");
const { fetchAribaHeader } = require("./lib/ariba/pm");
const { enrichWithTaxCode } = require("./lib/s4/taxcode");
const {
  getBapiClient,
  buildSmokePayload,
  normalizeBapiResult,
  padLeft,
} = require("./lib/soap/bapi-po-create");
const { mapWithConcurrency } = require("./lib/util/concurrency");

module.exports = function () {
  this.on("GetQuotes", async (req) => {
    const { docId } = req.data || {};
    if (!docId) return req.error(400, "Parâmetro 'docId' é obrigatório.");
    const round = Number.isFinite(Number(ARIBA_EVENT_ROUND))
      ? Number(ARIBA_EVENT_ROUND)
      : 1;

    LOG.infoL("[GetQuotes] START", { docId, round });

    try {
      const { rows, results } = await fetchSupplierBids(docId);
      LOG.infoL("[GetQuotes] supplierBids", {
        rows: rows.length,
        results: results.length,
      });
      if (!rows.length || !results.length) return { header: null, items: [] };

      const list = await fetchSupplierInvitationsList(docId, round).catch(
        () => [],
      );
      LOG.infoL("[GetQuotes] invitations", {
        count: Array.isArray(list) ? list.length : 0,
      });

      const nameByInvId = new Map(),
        emailByInvId = new Map(),
        vendorByInvId = new Map();
      for (const it of list) {
        const invId = String(
          it?.invitationId ?? it?.userId ?? it?.uniqueName ?? "",
        );
        if (!invId) continue;
        const name =
          it?.organization?.name ||
          it?.supplierName ||
          it?.organizationName ||
          it?.supplier?.name ||
          null;
        const email =
          it?.emailAddress ||
          it?.supplierEmail ||
          it?.email ||
          it?.mainContact?.emailAddress ||
          it?.contact?.email ||
          null;
        const sapEntry = extractSapOrgEntry(it);
        const sapId = sapEntry?.value ?? extractSapVendorId(it);
        if (name) nameByInvId.set(invId, name);
        if (email) emailByInvId.set(invId, email);
        if (sapId) vendorByInvId.set(invId, sapId);
      }

      for (const invId of new Set(
        results.map((r) => r._invitationId).filter(Boolean),
      )) {
        if (!nameByInvId.has(invId)) {
          const fb =
            pickSupplierNameByInvitation(rows, invId) ||
            pickSupplierNameFromRows(rows);
          if (fb) nameByInvId.set(invId, fb);
        }
      }

      let parentProjectId = null;
      try {
        parentProjectId = await fetchParentProjectId(docId);
      } catch { }
      LOG.infoL("[GetQuotes] parentProjectId", { parentProjectId });

      let header = null;
      try {
        if (parentProjectId) header = await fetchAribaHeader(parentProjectId);
      } catch { }
      LOG.infoL("[GetQuotes] header", { hasHeader: !!header });

      const headerWithDoc = Object.assign({ docId }, header || {}, {
        supplierName: null,
      });
      const itemsOut = results.map((r) => {
        const { _invitationId, _itemId, ...pub } = r;
        const invId = _invitationId || null;
        const supplierName = invId ? nameByInvId.get(invId) || null : null;
        const supplierIdSap = invId ? vendorByInvId.get(invId) || null : null;
        const email = invId ? emailByInvId.get(invId) || null : null;
        return {
          ...pub,
          supplierName,
          SupplierCode: supplierIdSap,
          invitationId: invId,
          invitationEmail: email,
        };
      });

      LOG.infoL("[GetQuotes] END", { items: itemsOut.length });
      return { header: headerWithDoc, items: itemsOut };
    } catch (e) {
      const status = e.response?.status || 502;
      const msg = e.response?.data?.message || e.response?.data || e.message;
      LOG.errorL("[GetQuotes] ERROR", { status, msg });
      return req.error(status, "Falha ao consultar supplierBids no Ariba.");
    }
  });

  this.on("CreateScenario", async (req) => {
    const { eventId, title, scenarioType, supplierBids } = req.data || {};
    if (!eventId) return req.error(400, "Parâmetro 'eventId' é obrigatório.");
    if (!Array.isArray(supplierBids) || supplierBids.length === 0) {
      return req.error(
        400,
        "'supplierBids' deve ser um array com pelo menos 1 item.",
      );
    }

    LOG.infoL("[CreateScenario] START", {
      eventId,
      title,
      scenarioType,
      bids: supplierBids.length,
    });

    const payload = {
      eventId,
      title: title || "Cenário via API",
      scenarioType: Number.isFinite(+scenarioType) ? +scenarioType : 0,
      supplierBids: supplierBids.map((it) => ({
        eventId,
        itemId: Number(it.itemId),
        invitationId: String(it.invitationId || ""),
        bidType: it.bidType || "Primary",
        winningSplitType: Number(it.winningSplitType ?? 1),
        winningSplitValue: Number(it.winningSplitValue ?? 100),
      })),
    };

    const relPath = `/events/${encodeURIComponent(eventId)}/scenarios`;
    try {
      const { data, headers } = await destPost(DEST.EVENTS, relPath, payload, {
        timeoutMs: HTTP_TIMEOUT_MS,
      });
      const correlationId =
        headers?.["x-correlation-id"] || headers?.["x-correlationid"] || null;
      const scenarioId =
        data?.scenarioId || data?.id || data?.scenarioID || null;
      LOG.infoL("[CreateScenario] OK", { scenarioId, correlationId });
      return {
        success: true,
        scenarioId,
        aribaResponse: JSON.stringify(data),
        correlationId,
      };
    } catch (e) {
      const { status, correlationId, userMessage, technical } =
        formatAribaScenarioError(e);
      LOG.errorL("[CreateScenario] ERROR", {
        status,
        correlationId,
        userMessage,
      });
      return req.error(status, userMessage, { correlationId, technical });
    }
  });

  this.on("simularPO", async (req) => {
    const {
      requests = [],
      concurrency,       // concorrência entre fornecedores (mapWithConcurrency)
      chunkSize,         // tamanhos dos lotes por fornecedor
      vendorParallel,    // paralelo por fornecedor (quantos chunks simultâneos dentro do fornecedor)
      globalParallel     // limite global de chamadas SOAP simultâneas
    } = req.data || {};

    // Defaults + ENV overrides
    const LIMIT = Number.isFinite(+concurrency) ? +concurrency :
      Number.isFinite(+process.env.CONCURRENCY) ? +process.env.CONCURRENCY : Infinity;

    const PER_VENDOR_CHUNK = Number.isFinite(+chunkSize) ? +chunkSize :
      Number.isFinite(+process.env.CHUNK_SIZE) ? +process.env.CHUNK_SIZE : 5;

    const PER_VENDOR_PARALLEL = Number.isFinite(+vendorParallel) ? +vendorParallel :
      Number.isFinite(+process.env.VENDOR_PARALLEL) ? +process.env.VENDOR_PARALLEL : Infinity;

    const GLOBAL_PARALLEL = Number.isFinite(+globalParallel) ? +globalParallel :
      Number.isFinite(+process.env.GLOBAL_PARALLEL) ? +process.env.GLOBAL_PARALLEL : Infinity;

    LOG.infoL("[simularPO] START", {
      requests: requests.length,
      limit: LIMIT,
      chunk: PER_VENDOR_CHUNK,
      vendorParallel: PER_VENDOR_PARALLEL,
      globalParallel: GLOBAL_PARALLEL
    });

    try {
      if (!Array.isArray(requests) || requests.length === 0) return [];

      // cria cliente SOAP 1x
      const client = await getBapiClient();
      // semáforo global opcional
      const globalSem = createSemaphore(GLOBAL_PARALLEL);

      // mapeia 1 fornecedor
      const mapper = async (r, idxReq) => {
        const { header = {}, items: rawItems = [], schedules = [], testRun = true } = r || {};
        LOG.infoL("[mapper] header", {
          idx: idxReq,
          vendor: header.vendor, purchOrg: header.purchOrg, compCode: header.compCode,
          items: rawItems.length, testRun
        });

        // 1) resolve TaxCode (uma vez, pro conjunto inteiro do fornecedor)
        const items = rawItems.map(({ taxCode, ...rest }) => rest);
        const enrichInput = items.map((it, i) => ({
          __idx: i,
          Supplier: padLeft(String(header.vendor || ""), 10, "0"),
          Material: it.material || "",
          PurchasingOrganization: header.purchOrg,
          Plant: it.plant
        }));

        const enriched = await enrichWithTaxCode(enrichInput, {
          headerVendor: padLeft(String(header.vendor || ""), 10, "0"),
          throwIfMissing: true
        });

        for (const row of enriched) {
          if (row?.__idx != null) {
            items[row.__idx].taxCode = row.TaxCode ?? undefined;
            items[row.__idx].purchasingInfoRecord = row.PurchasingInfoRecord ?? undefined;
          }
        }
        const missing = items.filter(x => !x.taxCode).length;
        LOG.infoL("[mapper] taxcode", { idx: idxReq, resolved: items.length - missing, missing });
        if (missing) throw new Error(`Não foi possível obter TaxCode para ${missing} item(ns).`);

        // 2) quebra em chunks por fornecedor
        const chunks = chunkArray(items, PER_VENDOR_CHUNK);
        LOG.infoL("[mapper] chunks", { idx: idxReq, chunks: chunks.length, chunkSize: PER_VENDOR_CHUNK });

        // 3) monta tarefas SOAP por chunk
        const tasks = chunks.map((chunkItems, cidx) => async () => {
          const t0 = Date.now();
          try {
            // filtra schedules APENAS dos itens do chunk (evita POSCHEDULE pra item fora do payload)
            const schedForChunk = filterSchedulesForChunk(schedules, chunkItems);

            const payload = buildSmokePayload(header, chunkItems, schedForChunk, testRun);

            const resp = await globalSem.run(async () => {
              // se quiser evitar "rajada perfeita", habilite um jitterzinho aqui:
              // await new Promise(rs => setTimeout(rs, Math.floor(Math.random()*20)));
              const rSoap = await client.BAPI_PO_CREATE1Async(payload);
              return Array.isArray(rSoap) ? rSoap[0] : rSoap;
            });

            const out = normalizeBapiResult(resp, !!payload.TESTRUN);
            LOG.infoL("[mapper] CHUNK SOAP OK", {
              idx: `${idxReq}.${cidx + 1}`,
              itens: out.itens?.length || 0,
              ms: Date.now() - t0,
              inflight: globalSem.stats().inFlight,
              queued: globalSem.stats().queued
            });
            return out;
          } catch (e) {
            LOG.errorL("[mapper] CHUNK SOAP ERROR", {
              idx: `${idxReq}.${cidx + 1}`,
              ms: Date.now() - t0,
              err: e?.message || String(e)
            });
            return { __chunkError: true, __chunkIndex: cidx, message: e?.message || String(e) };
          }
        });

        // 4) executa os chunks com limite por fornecedor
        const chunkResults = await runTasksWithLimit(tasks, PER_VENDOR_PARALLEL);

        // 5) agrega para o formato que o front já entende
        return mergeChunkResults(chunkResults, header);
      };

      // concorrência entre fornecedores (mantemos seu mapWithConcurrency existente)
      const results = await mapWithConcurrency(requests, LIMIT, mapper);
      LOG.infoL("[simularPO] END", { results: results.length });
      return results;

    } catch (e) {
      const info = safeErr(e);
      LOG.errorL("[simularPO] ERROR", { msg: info.message || info.code || "Erro", status: info.responseStatus });
      return req.error(502, `Falha na simulação em lote: ${info.message || info.code || "Erro desconhecido"}`);
    }
  });

  function chunkArray(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  // Executa uma lista de funções-async (tasks) com limite de paralelismo.
  // Se limit for Infinity/undefined/0/negativo, roda tudo em paralelo (Promise.all).
  async function runTasksWithLimit(tasks, limit) {
    if (!Array.isArray(tasks) || tasks.length === 0) return [];
    const n = Number(limit);
    if (!Number.isFinite(n) || n <= 0 || n >= tasks.length) {
      return Promise.all(tasks.map((t) => t()));
    }
    const out = new Array(tasks.length);
    let i = 0;
    const workers = Math.min(n, tasks.length);
    async function worker() {
      while (true) {
        const idx = i++;
        if (idx >= tasks.length) break;
        try {
          out[idx] = await tasks[idx]();
        } catch (err) {
          out[idx] = { __chunkError: true, __chunkIndex: idx, message: err?.message || String(err) };
        }
      }
    }
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return out;
  }

  function filterSchedulesForChunk(allSchedules = [], chunkItems = []) {
    if (!Array.isArray(allSchedules) || !allSchedules.length) return [];
    const poSet = new Set(
      chunkItems.map(it => String(Number.isInteger(it.poItem) ? it.poItem : it.poItem || "").padStart(2, "0"))
    );
    return allSchedules.filter(s => poSet.has(String(Number.isInteger(s?.poItem) ? s.poItem : s?.poItem || "")));
  }

  function pickHeaderFallback(headerIn) {
    return {
      empresa: headerIn.compCode,
      orgCompras: headerIn.purchOrg,
      grupoCompras: headerIn.purchGroup,
      fornecedor: padLeft(String(headerIn.vendor || ""), 10, "0"),
      moeda: headerIn.currency,
      incoterms1: headerIn.incoterms1,
      incoterms2: headerIn.incoterms2,
      criadoEm: new Date().toISOString().slice(0, 10),
      criadoPor: "INT_MAPA",
      poNumber: ""
    };
  }

  function mergeChunkResults(chunksNorm = [], headerIn) {
    const ok = chunksNorm.filter(c => !c.__chunkError);
    const err = chunksNorm.filter(c => c.__chunkError);

    // header: usa do primeiro OK; senão um fallback com dados do header de entrada
    const header = ok[0]?.header || pickHeaderFallback(headerIn);

    const itens = ok.flatMap(c => Array.isArray(c.itens) ? c.itens : []);
    const msgsOk = ok.flatMap(c => Array.isArray(c.returnMessages) ? c.returnMessages : []);
    const msgsErr = err.map(e => ({
      type: "E", id: "CHUNK", number: "000",
      message: e.message || "Falha ao processar chunk", logNo: null
    }));
    const mensagens = [...msgsOk, ...msgsErr];

    return {
      testRun: true, // você está usando TESTRUN
      header,
      itens,
      returnMessages: mensagens,
      mensagens
    };
  }
};
