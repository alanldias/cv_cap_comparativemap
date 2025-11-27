// srv/service.js
const util = require('util');
const cds = require("@sap/cds");
const { LOG } = require("./lib/util/log");
const { formatAribaScenarioError, safeErr } = require("./lib/util/errors");
const { DEST, HTTP_TIMEOUT_MS, ARIBA_EVENT_ROUND, SERVICE_TAXCODE_DEFAULT } = require("./lib/config");
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

const POITEM_START = 1000;  // 01000
const POITEM_STEP = 10;    // de 10 em 10
const POITEM_WIDTH = 5;     // 5 dígitos com zero à esquerda
const makePoItem = (idx) =>
  String(POITEM_START + idx * POITEM_STEP).padStart(POITEM_WIDTH, "0");

module.exports = function () {
  const { FilterViews } = this.entities;

  this.on("SaveView", async (req) => {
    const {
      name,
      docId = null,
      filtersJSON = "{}",
      uiSortJSON = "{}",
      uiGroupJSON = "{}",
      uiColumnsJSON = "{}",
    } = req.data || {};

    if (!name) return req.error(400, "Nome da visão é obrigatório.");

    const userId = req.user?.id || "anonymous";

    const entry = {
      name,
      docId,
      userId,
      isPublic: true,
      filtersJSON: typeof filtersJSON === "string" ? filtersJSON : JSON.stringify(filtersJSON || {}),
      uiSortJSON: typeof uiSortJSON === "string" ? uiSortJSON : JSON.stringify(uiSortJSON || {}),
      uiGroupJSON: typeof uiGroupJSON === "string" ? uiGroupJSON : JSON.stringify(uiGroupJSON || {}),
      uiColumnsJSON: typeof uiColumnsJSON === "string" ? uiColumnsJSON : JSON.stringify(uiColumnsJSON || {})
    };

    console.log(entry + "dados")

    const inserted = await INSERT.into(FilterViews).entries(entry);
    // seleciona com managed preenchido
    const saved = await SELECT.one.from(FilterViews).where({ ID: inserted.ID });
    return saved;
  });

  this.on("GetQuotes", async (req) => {
    const { docId } = req.data || {};
    if (!docId) return req.error(400, "Parâmetro 'docId' é obrigatório.");

    const round = Number.isFinite(Number(ARIBA_EVENT_ROUND))
      ? Number(ARIBA_EVENT_ROUND)
      : 1;

    LOG.infoL("[GetQuotes] START", { docId, round });

    try {

      if (docId === "OFFLINE") {
        // Simulamos um erro técnico feio (como se o Axios tivesse falhado)
        const fakeError = new Error("Connection refused: ariba.api.com:443");
        // Simulamos a estrutura de resposta de erro HTTP
        fakeError.response = {
          status: 502,
          data: { message: "Bad Gateway: Unable to connect to remote host" }
        };

        // Jogamos o erro para cair no seu catch lá embaixo
        throw fakeError;
      }

      const { rows, results } = await fetchSupplierBids(docId);
      console.log(results)
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
      const itemsOut = results.map((r, idx) => {
        const { _invitationId, _itemId, ...pub } = r;
        const invId = _invitationId || null;
        const supplierName = invId ? nameByInvId.get(invId) || null : null;
        const supplierIdSap = invId ? vendorByInvId.get(invId) || null : null;
        const email = invId ? emailByInvId.get(invId) || null : null;

        return {
          poItem: makePoItem(idx),           //  novo campo gerado no backend
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
      const status = e.response?.status || 500;

      // Pega a mensagem técnica para LOG, mas não usamos ela para decidir a msg do usuário
      const msgTecnica = e.response?.data?.message || e.response?.data || e.message;
      LOG.errorL("[GetQuotes] ERROR", { status, msg: msgTecnica });

      // 🟢 LÓGICA SEGURA:
      // Apenas 400 (Bad Request) e 404 (Not Found) indicam com certeza erro de ID/Dados.
      if (status === 400 || status === 404) {
        return req.error(404, "DocId inválido. \n Corrija e tente novamente!");
      }

      // 🔴 QUALQUER OUTRO ERRO (500, 502, 503, Erro de Rede sem status, etc.)
      // Retorna mensagem de falha técnica genérica.
      return req.error(status || 502, "Falha técnica ao consultar Ariba ou indisponibilidade momentânea.");
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

        // normalizador do PO_ITEM vindo do front
        const normPo = v => {
          const s = String(v ?? "").trim();
          if (!s) return null;
          const n = Number(s.replace(/\D/g, "")); // aceita "01000" -> 1000
          return Number.isFinite(n) ? n : null;
        };

        // 1) copiamos itens mantendo campos que precisamos; NÃO confiamos no taxCode do front
        const items = rawItems.map(it => ({ ...it }));

        // 1.1) valida poItem
        for (const [i, it] of items.entries()) {
          const n = normPo(it.poItem);
          if (n == null) {
            throw new Error(`Item sem poItem no request #${idxReq + 1} (idx=${i + 1}). Envie poItem a partir do front.`);
          }
          it.poItem = n; // garante número
        }

        // 1.2) checa duplicados
        const seen = new Set();
        const dups = [];
        for (const it of items) {
          if (seen.has(it.poItem)) dups.push(it.poItem);
          seen.add(it.poItem);
        }
        if (dups.length) {
          throw new Error(
            `poItem duplicado no request do fornecedor ${header.vendor}: ${Array.from(new Set(dups)).join(", ")}`
          );
        }

        for (const it of items) {
          // Garante conversão para number (aceita price ou netPrice dependendo do seu payload)
          const p = Number(it.price !== undefined ? it.price : it.netPrice);
          
          if (!Number.isFinite(p) || p <= 0.000001) {
            throw new Error(
              `Bloqueio de Segurança: O item (Material: ${it.material || 'N/A'}, PO Item: ${it.poItem}) ` +
              `do fornecedor ${header.vendor} está com preço zerado (0.00).`
            );
          }
        }

        // 1.3) ordena por poItem (mantemos essa regra)
        items.sort((a, b) => a.poItem - b.poItem);

        // 2) Determina quais itens são serviço (não consultar S/4)
        const isService = (it) => String(it.itemCat || "").trim().toUpperCase() === "D";

        const vendor10 = padLeft(String(header.vendor || ""), 10, "0");


        // Separe os itens que precisam de consulta no S/4
        const needsTaxFetch = [];
        items.forEach((it, idx) => {
          if (isService(it)) {
            // serviço: usa fixo e não consulta
            it.taxCode = SERVICE_TAXCODE_DEFAULT;
            it.purchasingInfoRecord = undefined;
          } else {
            needsTaxFetch.push({
              __idx: idx,
              Supplier: vendor10,
              Material: it.material || "",
              PurchasingOrganization: header.purchOrg,
              Plant: it.plant
            });
          }
        });

        // Só chama o OData se realmente houver itens não-serviço
        if (needsTaxFetch.length) {
          const enriched = await enrichWithTaxCode(needsTaxFetch, {
            headerVendor: vendor10,
            throwIfMissing: true
          });
          for (const row of enriched) {
            if (row?.__idx != null) {
              items[row.__idx].taxCode = row.TaxCode ?? undefined;
              items[row.__idx].purchasingInfoRecord = row.PurchasingInfoRecord ?? undefined;
            }
          }
        }

        const missing = items.filter(x => !x.taxCode).length;
        LOG.infoL("[mapper] taxcode (service-skip)", {
          idx: idxReq,
          total: items.length,
          serviceFixed: items.filter(isService).length,
          fetched: needsTaxFetch.length,
          missing
        });
        if (missing) throw new Error(`Não foi possível obter TaxCode para ${missing} item(ns).`);

        // 4) Quebra em chunks por fornecedor (sem mudanças)
        const chunks = chunkArray(items, PER_VENDOR_CHUNK);
        LOG.infoL("[mapper] chunks", { idx: idxReq, chunks: chunks.length, chunkSize: PER_VENDOR_CHUNK });

        const tasks = chunks.map((chunkItems, cidx) => async () => {
          const t0 = Date.now();
          try {
            const schedForChunk = filterSchedulesForChunk(schedules, chunkItems);

            const inputPoPad = chunkItems.map(it => padLeft(String(it.poItem), 5, '0'));

            const payload = buildSmokePayload(header, chunkItems, schedForChunk, testRun);

            LOG.infoL("[mapper] chunk IN", { idx: `${idxReq}.${cidx + 1}`, poItems: inputPoPad });

            const resp = await globalSem.run(async () => {
              const rSoap = await client.BAPI_PO_CREATE1Async(payload);
              return Array.isArray(rSoap) ? rSoap[0] : rSoap;
            });

            // ==================================================================
            // INÍCIO DO TESTE DE LOG VISUAL
            // ==================================================================
            const bannerTitle = `[DEBUG BAPI] Chunk ${idxReq}.${cidx + 1}`;
            
            console.log("\n\n" + "=".repeat(60));
            console.log(`🚀 ${bannerTitle} - INÍCIO DA COMPARAÇÃO`);
            console.log("=".repeat(60) + "\n");

            // --- MÉTODO 1: JSON.stringify ---
            console.log("📝 OPÇÃO 1: JSON.stringify");
            console.log("   (Vantagem: Formato JSON válido, fácil de copiar e colar no VS Code)");
            console.log("-".repeat(40));
            
            try {
                // null, 2 garante a indentação bonita
                console.log(JSON.stringify(resp, null, 2)); 
            } catch (err) {
                console.log("[Erro ao converter JSON]:", err.message);
            }

            console.log("\n" + "-".repeat(60) + "\n");

            // --- MÉTODO 2: util.inspect ---
            console.log("🔍 OPÇÃO 2: util.inspect");
            console.log("   (Vantagem: Mostra tipos reais (Number vs String), cores e tudo que é oculto)");
            console.log("-".repeat(40));

            console.log(util.inspect(resp, { 
                showHidden: false,   // Mostra propriedades não enumeráveis se true
                depth: null,         // null = expande TUDO (cuidado se for objeto gigante)
                colors: true,        // Usa cores do terminal
                maxArrayLength: null // Não corta arrays grandes (mostra todos os itens)
            }));

            console.log("\n" + "=".repeat(60));
            console.log(`🏁 ${bannerTitle} - FIM DA COMPARAÇÃO`);
            console.log("=".repeat(60) + "\n\n");
            // ==================================================================
            // FIM DO TESTE
            // ==================================================================

            const out = normalizeBapiResult(resp, !!payload.TESTRUN);

            // >>> REMAPEIA: substitui o poItem retornado pela BAPI pelo que veio do front (mesma ordem)
            const before = (out.itens || []).map(i => i.poItem);
            out.itens = (out.itens || []).map((i, k) => ({ ...i, poItem: inputPoPad[k] || i.poItem }));

            LOG.infoL("[mapper] chunk OUT remap", {
              idx: `${idxReq}.${cidx + 1}`,
              from: before,
              to: out.itens.map(i => i.poItem)
            });

            LOG.infoL("[mapper] CHUNK SOAP OK", {
              idx: `${idxReq}.${cidx + 1}`,
              itens: out.itens?.length || 0,
              ms: Date.now() - t0,
              inflight: globalSem.stats().inFlight,
              queued: globalSem.stats().queued
            });
            return out;
          } catch (e) {
            const idxStr = `${idxReq}.${cidx + 1}`;
            const resp = e?.response;

            console.error("=== SOAP RAW ERROR ===");
            console.error("chunk:", idxStr);
            console.error("status:", resp?.status, resp?.statusText);
            console.error("headers:", resp?.headers);

            if (resp?.data) {
              if (typeof resp.data === "string") {
                console.error("body (first 4000 chars):");
                console.error(resp.data.slice(0, 4000));
              } else {
                console.error("body (non-string):");
                console.error(JSON.stringify(resp.data, null, 2).slice(0, 4000));
              }
            } else {
              console.error("no resp.data, full error object:");
              console.error(e);
            }

            console.error("=== END SOAP RAW ERROR ===");

            LOG.errorL("[mapper] CHUNK SOAP ERROR DETAIL", {
              idx: idxStr,
              ms: Date.now() - t0,
              message: e?.message || String(e),
              name: e?.name,
            });

            return { __chunkError: true, __chunkIndex: cidx, message: e?.message || String(e) };
          }

        });

        // 4) executa os chunks com limite por fornecedor
        const chunkResults = await runTasksWithLimit(tasks, PER_VENDOR_PARALLEL);

        return mergeChunkResults(chunkResults, header);
      };

      // concorrência entre fornecedores 
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
    const norm = v => {
      const s = String(v ?? "").trim();
      if (!s) return null;
      const n = Number(s.replace(/\D/g, ""));
      return Number.isFinite(n) ? n : null;
    };
    const poSet = new Set(chunkItems.map(it => norm(it.poItem)).filter(v => v != null));
    return allSchedules.filter(s => poSet.has(norm(s?.poItem)));
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
      testRun: true,
      header,
      itens,
      returnMessages: mensagens,
      mensagens
    };
  }
};
