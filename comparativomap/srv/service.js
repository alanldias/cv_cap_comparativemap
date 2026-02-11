const cds = require("@sap/cds");
const { LOG } = require("./lib/util/log");
const { formatAribaScenarioError, safeErr } = require("./lib/util/errors");
const {
  DEST,
  HTTP_TIMEOUT_MS,
  ARIBA_EVENT_ROUND,
  SERVICE_TAXCODE_DEFAULT,
} = require("./lib/config");
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

// Geração de PO_ITEM no padrão SAP (01000, 01010, ...)
const POITEM_START = 1000;
const POITEM_STEP = 10;
const POITEM_WIDTH = 5;
const makePoItem = (idx) =>
  String(POITEM_START + idx * POITEM_STEP).padStart(POITEM_WIDTH, "0");

module.exports = function () {
  // Guard de autorização por role (CAP req.user.is)
  const ensureMAP_VIEWER = (req) => {
    console.log("[AUTH DEBUG] user.id  =", req.user.id);
    console.log("[AUTH DEBUG] roles    =", req.user.roles);
    console.log("[AUTH DEBUG] attr     =", req.user.attr);
    if (!req.user || !req.user.is("MAP_VIEWER")) {
      return req.error(
        403,
        "Você não tem autorização para acessar o Mapa Comparativo.",
      );
    }
  };

  // Consulta cotações do evento (Ariba Sourcing Event) + enriquece nomes/ids
  this.on("GetQuotes", async (req) => {
    ensureMAP_VIEWER(req);

    const { docId } = req.data || {};
    if (!docId) return req.error(400, "Parâmetro 'docId' é obrigatório.");

    // Round do evento (alguns tenants separam por rodada)
    const round = Number.isFinite(Number(ARIBA_EVENT_ROUND))
      ? Number(ARIBA_EVENT_ROUND)
      : 1;

    LOG.infoL("[GetQuotes] START", { docId, round });

    try {
      // Modo offline: simula falha de conectividade pra testar UX/erros
      if (docId === "OFFLINE") {
        const fakeError = new Error("Connection refused: ariba.api.com:443");
        fakeError.response = {
          status: 502,
          data: { message: "Bad Gateway: Unable to connect to remote host" },
        };
        throw fakeError;
      }

      // Busca bids/linhas do evento (fonte principal)
      const { rows, results } = await fetchSupplierBids(docId);
      console.log(results);

      LOG.infoL("[GetQuotes] supplierBids", {
        rows: rows.length,
        results: results.length,
      });

      // Sem dados: devolve estrutura vazia pro front
      if (!rows.length || !results.length) return { header: null, items: [] };

      // Busca lista de convites (para nome/email/SAP vendor id)
      const list = await fetchSupplierInvitationsList(docId, round).catch(
        () => [],
      );

      LOG.infoL("[GetQuotes] invitations", {
        count: Array.isArray(list) ? list.length : 0,
      });

      // Maps para lookup rápido por invitationId
      const nameByInvId = new Map(),
        emailByInvId = new Map(),
        vendorByInvId = new Map();

      // Extrai campos tolerando variação de payload do Ariba
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

        // Normaliza Vendor SAP a partir de extensões/atributos do convite
        const sapEntry = extractSapOrgEntry(it);
        const sapId = sapEntry?.value ?? extractSapVendorId(it);

        if (name) nameByInvId.set(invId, name);
        if (email) emailByInvId.set(invId, email);
        if (sapId) vendorByInvId.set(invId, sapId);
      }
      // Fallbacks de nome quando convite não trouxe organização
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

      // Descobre projeto pai (PM) pra puxar header do evento
      let parentProjectId = null;
      try {
        parentProjectId = await fetchParentProjectId(docId);
      } catch { }

      LOG.infoL("[GetQuotes] parentProjectId", { parentProjectId });

      // Header do Ariba (título, datas etc.) quando disponível
      let header = null;
      try {
        if (parentProjectId) header = await fetchAribaHeader(parentProjectId);
      } catch { }

      LOG.infoL("[GetQuotes] header", { hasHeader: !!header });

      // Devolve header com docId e mantém compat do front
      const headerWithDoc = Object.assign({ docId }, header || {}, {
        supplierName: null,
      });

      // Normaliza itens e injeta campos úteis pro front/UI
      const itemsOut = results.map((r, idx) => {
        const { _invitationId, _itemId, ...pub } = r;
        const invId = _invitationId || null;

        const supplierName = invId ? nameByInvId.get(invId) || null : null;
        const supplierIdSap = invId ? vendorByInvId.get(invId) || null : null;
        const email = invId ? emailByInvId.get(invId) || null : null;

        return {
          poItem: makePoItem(idx), // backend garante sequência SAP-friendly
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
      // Status HTTP quando veio de axios/destination; senão vira 500
      const status = e.response?.status || 500;

      // Loga detalhe técnico, mas mensagem pro usuário é controlada
      const msgTecnica =
        e.response?.data?.message || e.response?.data || e.message;
      LOG.errorL("[GetQuotes] ERROR", { status, msg: msgTecnica });

      // Só 400/404 mapeiam para “docId inválido”
      if (status === 400 || status === 404) {
        return req.error(404, "DocId inválido. \n Corrija e tente novamente!");
      }

      // Restante: falha técnica/transiente
      return req.error(
        status || 502,
        "Falha técnica ao consultar Ariba ou indisponibilidade momentânea.",
      );
    }
  });
  // Cria cenário no Ariba com split/percentual por item+convite
  this.on("CreateScenario", async (req) => {
    ensureMAP_VIEWER(req);

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

    // Payload conforme endpoint /events/{id}/scenarios (Ariba)
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
      // Chama Ariba via Destination (BTP)
      const { data, headers } = await destPost(DEST.EVENTS, relPath, payload, {
        timeoutMs: HTTP_TIMEOUT_MS,
      });
      // Correlation ajuda suporte/trace no Ariba
      const correlationId =
        headers?.["x-correlation-id"] || headers?.["x-correlationid"] || null;
      // Normaliza retorno de id (variações)
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
      // Centraliza mapeamento de erro (mensagem pro usuário + detalhes técnicos)
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
  // Simula criação de PO no S/4 via BAPI (SOAP) com chunk e paralelismo controlado
  this.on("simularPO", async (req) => {
    ensureMAP_VIEWER(req);
    const {
      requests = [],
      concurrency, // concorrência entre fornecedores
      chunkSize, // tamanho do lote por fornecedor
      vendorParallel, // paralelismo de chunks por fornecedor
      globalParallel, // limite global de SOAP inflight
    } = req.data || {};
    // Defaults com override via ENV (útil em stress-test)
    const LIMIT = Number.isFinite(+concurrency)
      ? +concurrency
      : Number.isFinite(+process.env.CONCURRENCY)
        ? +process.env.CONCURRENCY
        : Infinity;
    const PER_VENDOR_CHUNK = Number.isFinite(+chunkSize)
      ? +chunkSize
      : Number.isFinite(+process.env.CHUNK_SIZE)
        ? +process.env.CHUNK_SIZE
        : 5;
    const PER_VENDOR_PARALLEL = Number.isFinite(+vendorParallel)
      ? +vendorParallel
      : Number.isFinite(+process.env.VENDOR_PARALLEL)
        ? +process.env.VENDOR_PARALLEL
        : Infinity;
    const GLOBAL_PARALLEL = Number.isFinite(+globalParallel)
      ? +globalParallel
      : Number.isFinite(+process.env.GLOBAL_PARALLEL)
        ? +process.env.GLOBAL_PARALLEL
        : Infinity;
    LOG.infoL("[simularPO] START", {
      requests: requests.length,
      limit: LIMIT,
      chunk: PER_VENDOR_CHUNK,
      vendorParallel: PER_VENDOR_PARALLEL,
      globalParallel: GLOBAL_PARALLEL,
    });
    try {
      if (!Array.isArray(requests) || requests.length === 0) return [];
      // Cria cliente SOAP uma vez (evita overhead por request)
      const client = await getBapiClient();
      // Semáforo global para evitar overload no S/4 / CPI / Cloud Connector
      const globalSem = createSemaphore(GLOBAL_PARALLEL);
      // Processa 1 “request” (1 fornecedor / 1 header + itens)
      const mapper = async (r, idxReq) => {
        const {
          header = {},
          items: rawItems = [],
          schedules = [],
          testRun = true,
        } = r || {};

        LOG.infoL("[mapper] header", {
          idx: idxReq,
          vendor: header.vendor,
          purchOrg: header.purchOrg,
          compCode: header.compCode,
          items: rawItems.length,
          testRun,
        });
        // Normaliza PO_ITEM vindo do front ("01000" -> 1000, tolera strings)
        const normPo = (v) => {
          const s = String(v ?? "").trim();
          if (!s) return null;
          const n = Number(s.replace(/\D/g, ""));
          return Number.isFinite(n) ? n : null;
        };
        // Copia defensiva: não muta payload original do req
        const items = rawItems.map((it) => ({ ...it }));
        // Valida presença de poItem (necessário para remap pós-BAPI)
        for (const [i, it] of items.entries()) {
          const n = normPo(it.poItem);
          if (n == null) {
            throw new Error(
              `Item sem poItem no request #${idxReq + 1} (idx=${i + 1}). Envie poItem a partir do front.`,
            );
          }
          it.poItem = n;
        }
        // Bloqueia duplicados para evitar colisão na montagem do payload
        const seen = new Set();
        const dups = [];
        for (const it of items) {
          if (seen.has(it.poItem)) dups.push(it.poItem);
          seen.add(it.poItem);
        }
        if (dups.length) {
          throw new Error(
            `poItem duplicado no request do fornecedor ${header.vendor}: ${Array.from(new Set(dups)).join(", ")}`,
          );
        }
        // Guarda de segurança: nunca deixa preço zerado seguir pra BAPI
        for (const it of items) {
          const p = Number(it.price !== undefined ? it.price : it.netPrice);
          if (!Number.isFinite(p) || p <= 0.000001) {
            throw new Error(
              `Bloqueio de Segurança: O item (Material: ${it.material || "N/A"}, PO Item: ${it.poItem}) ` +
              `do fornecedor ${header.vendor} está com preço zerado (0.00).`,
            );
          }
        }
        // Ordena para garantir estabilidade (remap por índice)
        items.sort((a, b) => a.poItem - b.poItem);
        // Item category "D" = serviço (tax fixo; não consulta PIR/tax no S/4)
        const isService = (it) =>
          String(it.itemCat || "").trim().toUpperCase() === "D";
        // Vendor pad para 10 dígitos conforme SAP (LIFNR)
        const vendor10 = padLeft(String(header.vendor || ""), 10, "0");
        // Monta payload de enriquecimento de TaxCode/PIR para itens não-serviço
        const needsTaxFetch = [];
        items.forEach((it, idx) => {
          if (isService(it)) {
            it.taxCode = SERVICE_TAXCODE_DEFAULT;
            it.purchasingInfoRecord = undefined;
          } else {
            needsTaxFetch.push({
              __idx: idx,
              Supplier: vendor10,
              Material: it.material || "",
              PurchasingOrganization: header.purchOrg,
              Plant: it.plant,
            });
          }
        });
        // Chama OData só quando necessário
        if (needsTaxFetch.length) {
          const enriched = await enrichWithTaxCode(needsTaxFetch, {
            headerVendor: vendor10,
            throwIfMissing: true,
          });
          for (const row of enriched) {
            if (row?.__idx != null) {
              items[row.__idx].taxCode = row.TaxCode ?? undefined;
              items[row.__idx].purchasingInfoRecord =
                row.PurchasingInfoRecord ?? undefined;
            }
          }
        }
        // Bloqueia se algum item ficou sem taxCode
        const missing = items.filter((x) => !x.taxCode).length;
        LOG.infoL("[mapper] taxcode (service-skip)", {
          idx: idxReq,
          total: items.length,
          serviceFixed: items.filter(isService).length,
          fetched: needsTaxFetch.length,
          missing,
        });
        if (missing)
          throw new Error(
            `Não foi possível obter TaxCode para ${missing} item(ns).`,
          );
        // Chunking por fornecedor para não estourar limites da BAPI
        const chunks = chunkArray(items, PER_VENDOR_CHUNK);
        LOG.infoL("[mapper] chunks", {
          idx: idxReq,
          chunks: chunks.length,
          chunkSize: PER_VENDOR_CHUNK,
        });
        // Cada task = 1 chamada BAPI para um chunk
        const tasks = chunks.map((chunkItems, cidx) => async () => {
          const t0 = Date.now();
          try {
            // Filtra schedules que pertencem aos itens do chunk
            const schedForChunk = filterSchedulesForChunk(schedules, chunkItems);
            // PoItem pad para o formato de retorno/visual (01000)
            const inputPoPad = chunkItems.map((it) =>
              padLeft(String(it.poItem), 5, "0"),
            );
            // Monta payload da BAPI (testRun usa TESTRUN)
            const payload = buildSmokePayload(
              header,
              chunkItems,
              schedForChunk,
              testRun,
            );
            LOG.infoL("[mapper] chunk IN", {
              idx: `${idxReq}.${cidx + 1}`,
              poItems: inputPoPad,
            });
            // Aplica limite global de inflight SOAP
            const resp = await globalSem.run(async () => {
              const rSoap = await client.BAPI_PO_CREATE1Async(payload);
              return Array.isArray(rSoap) ? rSoap[0] : rSoap;
            });
            // Normaliza retorno para shape esperado pelo front
            const out = normalizeBapiResult(resp, !!payload.TESTRUN);
            // Remapeia poItem retornado pela BAPI para o poItem original do chunk
            const before = (out.itens || []).map((i) => i.poItem);
            out.itens = (out.itens || []).map((i, k) => ({
              ...i,
              poItem: inputPoPad[k] || i.poItem,
            }));
            LOG.infoL("[mapper] chunk OUT remap", {
              idx: `${idxReq}.${cidx + 1}`,
              from: before,
              to: out.itens.map((i) => i.poItem),
            });
            LOG.infoL("[mapper] CHUNK SOAP OK", {
              idx: `${idxReq}.${cidx + 1}`,
              itens: out.itens?.length || 0,
              ms: Date.now() - t0,
              inflight: globalSem.stats().inFlight,
              queued: globalSem.stats().queued,
            });
            return out;
          } catch (e) {
            const idxStr = `${idxReq}.${cidx + 1}`;
            const resp = e?.response;
            // Dump controlado pra diagnosticar SOAP faults/proxy errors
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
                console.error(
                  JSON.stringify(resp.data, null, 2).slice(0, 4000),
                );
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
            // Normaliza erro por chunk sem derrubar o fornecedor inteiro
            return {
              __chunkError: true,
              __chunkIndex: cidx,
              message: e?.message || String(e),
            };
          }
        });
        // Executa tasks com limite por fornecedor (evita saturar um único vendor)
        const chunkResults = await runTasksWithLimit(tasks, PER_VENDOR_PARALLEL);
        // Consolida chunks (header + itens + mensagens)
        return mergeChunkResults(chunkResults, header);
      };
      // Concorre fornecedores (cada request) com limite configurável
      const results = await mapWithConcurrency(requests, LIMIT, mapper);
      LOG.infoL("[simularPO] END", { results: results.length });
      return results;
    } catch (e) {
      // safeErr padroniza leitura de erros (axios/soap/etc.)
      const info = safeErr(e);
      LOG.errorL("[simularPO] ERROR", {
        msg: info.message || info.code || "Erro",
        status: info.responseStatus,
      });
      return req.error(
        502,
        `Falha na simulação em lote: ${info.message || info.code || "Erro desconhecido"}`,
      );
    }
  });

  // Healthcheck simples para validar auth + rota
  this.on("Ping", (req) => {
    return "OK";
  });

  // Chunk helper: divide array em lotes fixos
  function chunkArray(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  // Runner com limite de paralelismo para lista de tasks async
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
          out[idx] = {
            __chunkError: true,
            __chunkIndex: idx,
            message: err?.message || String(err),
          };
        }
      }
    }
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return out;
  }

  // Mantém schedules apenas para itens presentes no chunk (por poItem)
  function filterSchedulesForChunk(allSchedules = [], chunkItems = []) {
    if (!Array.isArray(allSchedules) || !allSchedules.length) return [];
    const norm = (v) => {
      const s = String(v ?? "").trim();
      if (!s) return null;
      const n = Number(s.replace(/\D/g, ""));
      return Number.isFinite(n) ? n : null;
    };
    const poSet = new Set(
      chunkItems.map((it) => norm(it.poItem)).filter((v) => v != null),
    );
    return allSchedules.filter((s) => poSet.has(norm(s?.poItem)));
  }

  // Fallback de header quando todos os chunks falham (mantém formato)
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
      poNumber: "",
    };
  }

  // Consolida chunks OK + erros num único response por fornecedor
  function mergeChunkResults(chunksNorm = [], headerIn) {
    const ok = chunksNorm.filter((c) => !c.__chunkError);
    const err = chunksNorm.filter((c) => c.__chunkError);

    const header = ok[0]?.header || pickHeaderFallback(headerIn);

    const itens = ok.flatMap((c) => (Array.isArray(c.itens) ? c.itens : []));
    const msgsOk = ok.flatMap((c) =>
      Array.isArray(c.returnMessages) ? c.returnMessages : [],
    );
    const msgsErr = err.map((e) => ({
      type: "E",
      id: "CHUNK",
      number: "000",
      message: e.message || "Falha ao processar chunk",
      logNo: null,
    }));
    const mensagens = [...msgsOk, ...msgsErr];

    return {
      testRun: true,
      header,
      itens,
      returnMessages: mensagens,
      mensagens,
    };
  }
};
