sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/Device",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/ui/model/Sorter",
  "sap/ui/model/json/JSONModel",
  "sap/m/ViewSettingsDialog",
  "sap/m/ViewSettingsItem",
  "sap/m/ViewSettingsFilterItem",
  "sap/m/MessageBox",
  "sap/ui/util/Storage",
  "sap/m/MessageToast",
  "sap/ui/core/Fragment"
], function (
  Controller,
  Device,
  Filter,
  FilterOperator,
  Sorter,
  JSONModel,
  ViewSettingsDialog,
  ViewSettingsItem,
  ViewSettingsFilterItem,
  MessageBox,
  Storage,
  MessageToast,
  Fragment
) {
  "use strict";

  return Controller.extend("comparativemap.comparativemap.controller.ComparativeMap", {

    /* =========================================================================
     * 1) LIFECYCLE / MODELOS
     * ========================================================================= */
    // ################################ BEATRIZ - FOI ALTERADO PARA RECUPERAR CAMPOS NECESSARIOS PARA A PREMIAÇÃO  #####################################
    onInit() {
      const vm = new JSONModel({
        header: {
          tipoPedido: "", purchasingOrganization: "", purchasingGroup: "",
          companyCode: "", incoterms1: "", incoterms2: "", paymentTerms: "",
          docId: "", moeda: "", fornecedor: ""
        },
        headerRows: [],
        rows: [] // mapeadas em onBuscar com _originalQty
      });
      vm.setSizeLimit(10000);
      vm.setDefaultBindingMode(sap.ui.model.BindingMode.TwoWay);
      this.getView().setModel(vm, "vm");

      const qm = new JSONModel({
        items: [],        // linhas selecionadas para simulação (com qtySim)
        perKey: {},       // somatórios por itemKey (se precisar)
        validAward: false,
        _summaryText: "",
        idx: {},          // índice robusto (material + NAME/LIFNR)
        idByKey: {}       // dados para enriquecer res>rows (inclui supplierName/masterQty)
      });
      qm.setSizeLimit(10000);
      this.getView().setModel(qm, "qm");

      this._oFilterDialog = null;
      this._oSortDialog = null;
      this._oGroupDialog = null;
      this._groupReset = false;

      this._storage = new Storage(Storage.Type.local, "comparativemap");
      this._prefsKey = "tblDocs-prefs";
      this._prefs = this._loadPrefs();

      this.mGroupFunctions = {
        supplierName: (oCtx) => {
          const v = oCtx.getProperty("supplierName") || "";
          return { key: v, text: v };
        },
        arb_PurchasingOrganization: (oCtx) => {
          const v = oCtx.getProperty("arb_PurchasingOrganization") || "";
          return { key: v, text: "Org. Compras " + v };
        },
        arb_CompanyCode: (oCtx) => {
          const v = oCtx.getProperty("arb_CompanyCode") || "";
          return { key: v, text: "Empresa " + v };
        }
      };
    },

    /* =========================================================================
     * 2) BUSCA / EDIÇÃO INLINE
     * ========================================================================= */
    async onBuscar() {
      const oView = this.getView();
      const oOData = oView.getModel();
      const oVM = oView.getModel("vm");
      const docId = (oView.byId("inputDoID").getValue() || "").trim();
      const tbl = oView.byId("tblDocs");

      try {
        if (!oOData) throw new Error("Modelo OData V4 não encontrado.");
        if (!docId) { MessageToast.show("Informe o Doc ID"); return; }

        tbl.setBusy(true);

        const oCtx = oOData.bindContext("/GetQuotes(...)");
        oCtx.setParameter("docId", docId);
        await oCtx.execute();

        const res = await oCtx.getBoundContext().requestObject();

        // Anota a quantidade original (_originalQty) para clamp futuro
        const rows = (Array.isArray(res?.items) ? res.items : []).map(r => ({
          ...r,
          _originalQty: Number(r.quantity) || 0
        }));

        oVM.setProperty("/header", res?.header || {});
        oVM.setProperty("/rows", rows);
        oVM.setProperty("/headerRows", res?.header ? [res.header] : []);

        this.byId("tblDocs").getBinding("items")?.refresh(true);

        if (!rows.length) MessageToast.show("Nenhum item retornado para esse Doc ID.");
      } catch (e) {
        console.error("[onBuscar] ERRO:", e);
        MessageBox.error("Falha ao buscar dados: " + (e.message || e));
      } finally {
        tbl.setBusy(false);
      }
    },

    // Edição inline da quantidade na tabela principal — não pode exceder a original
    onQtyInlineChange: function (oEvent) {
      const ctx = oEvent.getSource()?.getBindingContext("vm");
      if (!ctx) return;
      const row = ctx.getObject() || {};
      const max = Number(row._originalQty) || 0;

      let v = Number(row.quantity);
      if (isNaN(v) || v < 0) v = 0;
      if (max && v > max) v = max;
      v = Math.floor(v);

      row.quantity = v;
      ctx.getModel().checkUpdate(true);
    },

    onCloseDialog: function (oEvent) {
      // 1) tenta achar o Dialog subindo a árvore a partir do botão
      try {
        let ctrl = oEvent && oEvent.getSource ? oEvent.getSource() : null;
        while (ctrl && ctrl.getParent && !(ctrl.isA && ctrl.isA("sap.m.Dialog"))) {
          ctrl = ctrl.getParent();
        }
        if (ctrl && ctrl.isA && ctrl.isA("sap.m.Dialog")) {
          ctrl.close();
          return;
        }
      } catch (e) {
        // segue para o fallback
      }

      // 2) fallback: fecha pelos refs conhecidos
      this._dlgRes && this._dlgRes.close && this._dlgRes.close();
      this._dlgAward && this._dlgAward.close && this._dlgAward.close();
      this._dlgSim && this._dlgSim.close && this._dlgSim.close();
      this._oSimDialog && this._oSimDialog.close && this._oSimDialog.close();
    },


    /* =========================================================================
     * 3) SIMULAÇÃO (sem popup intermediário)
     * ========================================================================= */
    async onSimularCompra() {
      const oView = this.getView();
      const oTbl = this.byId("tblDocs");

      const selCtx = oTbl.getSelectedContexts("vm") || [];
      const selecionados = selCtx.map(c => c.getObject());

      if (!selecionados.length) {
        MessageBox.warning("Selecione ao menos uma linha.");
        return;
      }
      console.log(selecionados)

      // Mapeia itens para o QM e constrói índices (NAME/LIFNR)
      const items = selecionados.map((r, i) => ({
        id: i + 1,
        itemKey: this._getItemKey(r),

        // identificação fornecedor/item vindos do GetQuotes
        supplierName: r.supplierName,
        lifnr: r.lifnr || r.supplierId || null,
        itemId: r.itemId || r.ItemId || null,
        invitationId: r.invitationId || r._invitationId || null,
        invitationEmail: r.invitationEmail || null,

        // material/descrição
        MaterialCode: r.MaterialCode || r.materialCode,
        materialCode: r.MaterialCode || r.materialCode,
        description: r.itemDescription || r.materialDesc || r.itemDEscription,

        // quantidades/preço/moeda
        masterQty: Number(r._originalQty || r.quantity) || 0, // ORIGINAL
        supplierQty: Number(r.quantity) || 0,                  // valor editável atual
        qtySim: Number(r.quantity) || 0,                       // usar o que está na linha
        price: Number(r.price) || 0,
        currency: r.currency,

        // campos p/ simulação
        unitOfMeasure: r.unitOfMeasure || r.PO_UNIT || r.unidade || null,
        PLANT: r.PLANT || r.centro || null,
        // TAX_CODE: r.TAX_CODE || r.iva || null,
        ItemCategory: r.ItemCategory || r.itemCategory || null,
        grupo_de_materias: r.grupo_de_materias || r.grupoMateriais || r.MaterialGroup || null,
        PREQ_NO: r.PREQ_NO || null,
        PREQ_ITEM: r.PREQ_ITEM || null
      }));

      const idx = {};
      const idByKey = {};
      items.forEach(it => {
        const matKey = this._normKey(this._getItemKey(it));
        const nameKey = this._normKey(it.supplierName);
        const lifnr = this._pad10(it.lifnr || it.supplierId || (/^\d+$/.test(it.supplierName) ? it.supplierName : ""));

        const meta = {
          itemId: it.itemId ?? null,
          invitationId: it.invitationId ?? null,
          invitationEmail: it.invitationEmail ?? null,
          masterQty: Number(it.masterQty) || 0, // ORIGINAL
          supplierName: it.supplierName || "",
          lifnr: lifnr,
          description: it.description || it.itemDescription || it.materialDesc || "",
          materialCode: it.materialCode || it.MaterialCode || ""
        };

        idx[`${matKey}|NAME:${nameKey}`] = meta;
        if (lifnr) idx[`${matKey}|LIFNR:${lifnr}`] = meta;

        idByKey[`${matKey}|NAME:${nameKey}`] = meta;
        if (lifnr) idByKey[`${matKey}|LIFNR:${lifnr}`] = meta;
      });

      const qm = oView.getModel("qm");
      qm.setProperty("/idx", idx);
      qm.setProperty("/idByKey", idByKey);
      qm.setProperty("/items", items);
      qm.setProperty("/perKey", {});
      qm.setProperty("/validAward", false);
      qm.setProperty("/_summaryText", "");

      // dispara a simulação direto
      await this.onConfirmSimulate();
    },
    onConfirmSimulate: async function () {
      const oView = this.getView();
      const oModel = oView.getModel();
      const qm = oView.getModel("qm");
      const vm = oView.getModel("vm");

      const itemsQM = qm.getProperty("/items") || [];
      const rawHeader = vm.getProperty("/header") || {};

      const payload = itemsQM
        .filter(it => Number(it.qtySim) > 0)
        .map(it => ({
          // IDs (se o backend ecoar ótimo; senão enriquecemos na volta)
          itemId: it.itemId ?? null,
          invitationId: it.invitationId ?? null,
          invitationEmail: it.invitationEmail ?? null,
          supplierName: it.supplierName ?? null,
          lifnr: it.lifnr ?? null,

          // dados de item
          MaterialCode: it.MaterialCode ?? it.materialCode ?? null,
          itemDescription: it.itemDescription ?? it.description ?? it.materialDesc ?? it.itemDEscription ?? null,
          quantity: Number(it.qtySim), // usa a quantidade editada na tabela principal
          unitOfMeasure: it.unitOfMeasure ?? it.PO_UNIT ?? it.unidade ?? null,
          price: Number(it.price) || 0,
          currency: it.currency ?? null,
          PLANT: it.PLANT ?? it.plant ?? it.centro ?? null,
          // TAX_CODE: it.TAX_CODE ?? it.iva ?? null,
          ItemCategory: it.ItemCategory ?? it.itemCategory ?? null,
          grupo_de_materias: it.grupo_de_materias ?? it.grupoMateriais ?? it.MaterialGroup ?? null,
          PREQ_NO: it.PREQ_NO ?? null,
          PREQ_ITEM: it.PREQ_ITEM ?? null
        }));

      const firstCurrency = payload.length ? payload[0].currency : null;

      const header = {
        docId: rawHeader.docId ?? null,
        tipoPedido: rawHeader.tipoPedido ?? null,
        purchasingOrganization: rawHeader.purchasingOrganization ?? null,
        purchasingGroup: rawHeader.purchasingGroup ?? null,
        companyCode: rawHeader.companyCode ?? null,
        incoterms1: rawHeader.incoterms1 ?? null,
        incoterms2: rawHeader.incoterms2 ?? null,
        paymentTerms: rawHeader.paymentTerms ?? null,
        fornecedor: rawHeader.fornecedor ?? null,
        moeda: rawHeader.moeda ?? firstCurrency
      };

      if (!payload.length) {
        MessageToast.show("Informe quantidades maiores que zero para simular.");
        return;
      }

      sap.ui.core.BusyIndicator.show(0);
      try {
        const ctx = oModel.bindContext("/SimulateBapiPoCreate(...)");
        ctx.setParameter("header", header);
        ctx.setParameter("items", payload);

        await ctx.execute();

        const result = await ctx.getBoundContext().requestObject();
        await this._openResultDialog(result);
      } catch (e) {
        console.error("[onConfirmSimulate] ERRO:", e);
        MessageBox.error("Falha na simulação: " + (e.message || e));
      } finally {
        sap.ui.core.BusyIndicator.hide();
      }
    },

    /* =========================================================================
     * 4) RESULTADO DA SIMULAÇÃO (Original + Qtd p/ premiar + Premiar direto)
     * ========================================================================= */
    _openResultDialog: function (result) {
      const oView = this.getView();
      const idByKey = oView.getModel("qm").getProperty("/idByKey") || {};

      const enrRows = (result?.rows || []).map(r => {
        const itemKeyRaw = String(r.materialCode || r.MaterialCode || this._getItemKey(r));
        const matKey = this._normKey(itemKeyRaw);
        const nameKey = this._normKey(r.supplierName);
        const lifnr = this._pad10(r.lifnr || r.supplierId || (/^\d+$/.test(r.supplierName) ? r.supplierName : ""));

        const trials = [
          lifnr ? `${matKey}|LIFNR:${lifnr}` : null,
          `${matKey}|NAME:${nameKey}`
        ].filter(Boolean);

        let meta = null;
        for (const t of trials) { if (idByKey[t]) { meta = idByKey[t]; break; } }

        const originalQty = Number(meta?.masterQty ?? r.masterQty ?? 0) || 0;

        return Object.assign({}, r, {
          itemKey: itemKeyRaw,
          itemId: meta?.itemId ?? r.itemId ?? r.ItemId ?? null,
          invitationId: meta?.invitationId ?? r.invitationId ?? null,
          invitationEmail: meta?.invitationEmail ?? r.invitationEmail ?? null,

          supplierName: r.supplierName || meta?.supplierName || (lifnr || ""),

          originalQty, // NOVO: usado nas validações de premiação
          qtyAward: 0  // usuário aloca
        });
      });

      const resModel = new JSONModel({ rows: enrRows });
      oView.setModel(resModel, "res");

      if (!this._dlgRes) {
        this._dlgRes = sap.ui.xmlfragment(oView.getId(),
          "comparativemap.comparativemap.view.fragments.ResultadoSimulacao", this);
        oView.addDependent(this._dlgRes);
      }
      this._dlgRes.open();
    },
    // ################################ FIM - BEATRIZ - FOI ALTERADO PARA RECUPERAR CAMPOS NECESSARIOS PARA A PREMIAÇÃO  #####################################
    // ################################ BEATRIZ - QUANTIDADE  #####################################
    onAwardQtyChangeRes: function (oEvent) {
      const input = oEvent.getSource();
      const ctx = input.getBindingContext("res");
      const obj = ctx?.getObject() || {};

      let v = Number(input.getValue());
      if (isNaN(v) || v < 0) v = 0;

      const max = Number(obj.originalQty) || 0; // validação vem da ORIGINAL
      if (v > max) v = max;

      v = Math.floor(v);
      obj.qtyAward = v;
      ctx.getModel().checkUpdate(true);
      input.setValue(String(v));
    },
    // ################################ FIM - BEATRIZ - QUANTIDADE  #####################################

    // ################################ BEATRIZ - AWARD #####################################
    onAwardDirect: async function () {
      const oView = this.getView();
      const oModel = oView.getModel();
      const vm = oView.getModel("vm");

      const tbl = this._dlgRes?.getContent?.()[0];
      const selected = tbl?.getSelectedContexts("res").map(c => c.getObject()) || [];
      if (!selected.length) {
        MessageToast.show("Selecione ao menos uma linha para premiar.");
        return;
      }

      // 🧩 Conjunto de TODOS os itens do evento (obrigatórios para premiar)
      const allRows = vm?.getProperty("/rows") || [];
      const allItems = new Map(); // itemId -> { label, original }
      allRows.forEach(r => {
        const itemId = Number(r.itemId ?? r.ItemId);
        if (!Number.isFinite(itemId)) return;
        const label = r.itemKey || r.itemDescription || r.MaterialCode || r.materialCode || String(itemId);
        const origCand = Number(r.originalQty ?? r.original ?? r.quantityOriginal ?? r.quantity ?? 0);
        const prev = allItems.get(itemId) || { label, original: 0 };
        const original = Number.isFinite(origCand) ? Math.max(prev.original, Math.floor(origCand)) : prev.original;
        allItems.set(itemId, { label, original });
      });

      // ✅ Agrupar SELECIONADOS por itemId (único). Evita juntar itens com o mesmo nome.
      const supplierBids = [];
      const problemas = [];
      const faltaIds = [];
      const byItem = new Map();

      selected.forEach(r => {
        const itemId = Number(r.itemId ?? r.ItemId);
        if (!Number.isFinite(itemId)) {
          faltaIds.push(`${r.supplierName || 'Fornecedor'} / ${r.materialCode || r.MaterialCode || r.itemKey || r.itemDescription || '(sem chave)'}`);
          return;
        }
        const label =
          r.itemKey || r.itemDescription || r.MaterialCode || r.materialCode || String(itemId);

        const origCand = Number(r.originalQty ?? r.original ?? r.quantityOriginal ?? r.quantity ?? 0);

        if (!byItem.has(itemId)) byItem.set(itemId, { label, original: 0, rows: [] });
        const g = byItem.get(itemId);
        if (Number.isFinite(origCand) && origCand > g.original) g.original = Math.floor(origCand);
        g.rows.push(r);
      });

      // 🔎 Diagnóstico dos grupos selecionados
      console.log("[Award] Grupos (SELECIONADOS) por itemId:", Array.from(byItem.entries()).map(([id, g]) => ({
        itemId: id, label: g.label, original: g.original, rows: g.rows.length
      })));
      console.log("[Award] Itens obrigatórios (TODOS) do evento:", Array.from(allItems.entries()).map(([id, g]) => ({
        itemId: id, label: g.label, original: g.original
      })));

      // 🚫 TRAVA #1 — Todos os itens devem estar representados na seleção
      const faltandoItens = [];
      for (const [id, meta] of allItems.entries()) {
        if (!byItem.has(id)) faltandoItens.push(`#${id} (${meta.label})`);
      }
      if (faltandoItens.length) {
        sap.m.MessageBox.error(
          "Para concluir a premiação, TODOS os itens do evento devem estar selecionados.\n\n" +
          "Itens não selecionados:\n" + faltandoItens.join("\n")
        );
        return;
      }

      // 🚫 TRAVA #2 — Para cada item, a soma dos selecionados deve FECHAR a quantidade original
      for (const [itemId, gSel] of byItem.entries()) {
        // Preferir original vindo do conjunto completo (mais confiável)
        const metaAll = allItems.get(itemId);
        const original = Math.floor(Number((metaAll?.original ?? 0) || gSel.original || 0));
        if (original <= 0) {
          problemas.push(`Item #${itemId} (${metaAll?.label || gSel.label}): quantidade ORIGINAL inválida.`);
          continue;
        }

        let sum = 0;
        gSel.rows.forEach(r => {
          let q = Math.floor(Number(r.qtyAward) || 0);
          if (q < 0) q = 0;
          if (q > original) q = original; // clamp defensivo
          r.qtyAward = q;
          sum += q;
        });

        if (sum !== original) {
          problemas.push(`Item #${itemId} (${metaAll?.label || gSel.label}): restante ${original - sum} (a soma deve fechar ${original}).`);
          continue;
        }
      }

      if (problemas.length) {
        sap.m.MessageBox.error(
          "As quantidades por item precisam fechar com a quantidade ORIGINAL:\n\n" +
          problemas.join("\n")
        );
        return;
      }

      // ✅ Cálculo de splits (%), ajuste de arredondamento e montagem do payload
      for (const [itemId, gSel] of byItem.entries()) {
        const metaAll = allItems.get(itemId);
        const original = Math.floor(Number((metaAll?.original ?? 0) || gSel.original || 0));

        let sumPerc = 0;
        const percList = gSel.rows.map((r, ix) => {
          const p = Math.round(((r.qtyAward * 100) / original) * 1000) / 1000;
          sumPerc += p;
          return { ix, p };
        });
        const diff = Math.round((100 - sumPerc) * 1000) / 1000;
        if (Math.abs(diff) >= 0.001) {
          const lastIdx = (percList.findLast?.(x => x.p > 0)?.ix) ?? (percList.length - 1);
          if (lastIdx >= 0) percList[lastIdx].p = Math.max(0, Math.round((percList[lastIdx].p + diff) * 1000) / 1000);
        }

        percList.forEach(({ ix, p }) => {
          const r = gSel.rows[ix];
          if (p <= 0) return;

          const fullInvitation = this._ensureInvitationResourceId(r.invitationId, r.invitationEmail);
          if (!fullInvitation) {
            faltaIds.push(`${r.supplierName || 'Fornecedor'} / #${itemId} (${metaAll?.label || gSel.label})`);
            return;
          }

          supplierBids.push({
            itemId,
            invitationId: String(fullInvitation),
            bidType: "Primary",
            winningSplitType: 1,
            winningSplitValue: Number(p.toFixed(3))
          });
        });

        // 🔎 Log por item
        console.log("[Award] itemId:", itemId,
          "| label:", metaAll?.label || gSel.label,
          "| original:", metaAll?.original ?? gSel.original,
          "| splits:", supplierBids.filter(b => b.itemId === itemId));
      }

      if (!supplierBids.length || faltaIds.length) {
        sap.m.MessageBox.error(
          "Itens sem identificação suficiente (itemId/invitationId). Revise a seleção.\n\n" +
          (faltaIds.length ? `Pendentes:\n${faltaIds.join("\n")}` : "")
        );
        return;
      }

      // 🔎 Log do payload final
      console.log("[Award] supplierBids payload:", supplierBids);

      const sEventId = vm.getProperty("/header/docId") || oView.getModel("res")?.getProperty("/header/docId");
      if (!sEventId) {
        sap.m.MessageBox.error("DocID do evento não encontrado no header.");
        return;
      }

      const oOp = oModel.bindContext("/CreateScenario(...)");
      oOp.setParameter("eventId", sEventId);
      oOp.setParameter("title", "Premiação via UI (direto)");
      oOp.setParameter("scenarioType", 0);
      oOp.setParameter("supplierBids", supplierBids);

      sap.ui.core.BusyIndicator.show(0);
      try {
        await oOp.execute();
        const out = oOp.getBoundContext().getObject();
        sap.ui.core.BusyIndicator.hide();

        if (out?.success) {
          sap.m.MessageBox.success(
            `Cenário criado com sucesso!\nScenario ID: ${out.scenarioId || "(n/a)"}\nCorrelation-ID: ${out.correlationId || "(n/a)"}`
          );
          this._dlgRes?.close();
        } else {
          sap.m.MessageBox.warning("CreateScenario executou, porém sem success=true.");
        }
      } catch (e) {
        sap.ui.core.BusyIndicator.hide();
        // Mensagem compacta (sem "ver mais detalhes")
        let msg = "Falha ao criar cenário.";
        if (this._compactODataErrorText) {
          msg = this._compactODataErrorText(e);
        } else if (this._parseODataError) {
          const parsed = this._parseODataError(e);
          msg = parsed.correlationId ? `${parsed.text}\n\nCorrelation-ID: ${parsed.correlationId}` : parsed.text;
        }
        sap.m.MessageBox.error(msg);
      }
    },
    // ################################ FIM - BEATRIZ - AWARD #####################################

    // ################################ BEATRIZ - TRATATIVA DE ERRO #####################################
    _parseODataError(err) {
      const tryJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

      // Tenta extrair o corpo em diferentes formatos (OData V4 / jQuery / fetch)
      let body =
        err?.cause?.error ||                               // UI5 OData V4 embala aqui
        (typeof err?.cause?.response?.body === "string" && tryJson(err.cause.response.body)) ||
        (typeof err?.message === "string" && tryJson(err.message)) ||
        err?.error ||
        null;

      const oError = body?.error || body || {};
      const topMessage =
        (typeof oError?.message === "string" && oError.message) ||
        (typeof oError?.message?.value === "string" && oError.message.value) ||
        "Falha ao criar cenário.";

      const detailsArr = Array.isArray(oError?.details) ? oError.details : [];
      const lines = detailsArr.map(d => {
        const msg = d.message || d["@aribaDescription"] || d["@aribaMessage"] || "";
        const code = d["@aribaCode"] ? ` [${d["@aribaCode"]}]` : "";
        const tgt = d.target ? ` (${d.target})` : "";
        return `• ${msg}${code}${tgt}`;
      });

      // Correlation-ID em vários lugares possíveis
      const correlationId =
        oError?.correlationId ||
        detailsArr.find(d => d["@correlationId"])?.["@correlationId"] ||
        err?.cause?.response?.headers?.["x-correlation-id"] ||
        err?.cause?.response?.headers?.["x-correlationid"] ||
        null;

      // Se não houver details estruturados, manda um JSON resumido
      let detailsText = "";
      if (lines.length) {
        detailsText = lines.join("\n");
      } else if (oError && Object.keys(oError).length) {
        detailsText = JSON.stringify(oError, null, 2);
      } else if (typeof err?.cause?.response?.body === "string") {
        detailsText = err.cause.response.body;
      } else {
        detailsText = err?.message || "";
      }

      // Raw (se veio no details pelo backend com '@raw')
      const raw = detailsArr.find(d => d["@raw"])?.["@raw"];
      if (raw) {
        const rawStr = typeof raw === "string" ? raw : JSON.stringify(raw);
        detailsText += `\n\nRaw:\n${rawStr.substring(0, 2000)}${rawStr.length > 2000 ? "..." : ""}`;
      }

      return {
        text: topMessage,
        details: detailsText,
        correlationId
      };
    },
    // ################################ FIM BEATRIZ - TRATATIVA DE ERRO #####################################

    /* =========================================================================
     * 5) VIEW SETTINGS (Filter / Sort / Group)
     * ========================================================================= */
    handleFilterButtonPressed() { this._openFilterDialog(); },
    handleSortButtonPressed() { this._openSortDialog(); },
    handleGroupButtonPressed() { this._openGroupDialog(); },

    onFilterSelectAllFornecedor() {
      this._prefs.filter.fornecedor = this._getDistinct("supplierName");
      this._savePrefs(); this._applyFiltersFromPrefs();
      MessageToast.show("Fornecedor: selecionado tudo.");
    },
    onFilterClearFornecedor() {
      this._prefs.filter.fornecedor = [];
      this._savePrefs(); this._applyFiltersFromPrefs();
      MessageToast.show("Fornecedor: seleção limpa.");
    },
    onFilterSelectAllNomeItem() {
      this._prefs.filter.nomeItem = this._getDistinct("itemDescription");
      this._savePrefs(); this._applyFiltersFromPrefs();
      MessageToast.show("Nome do item: selecionado tudo.");
    },
    onFilterClearNomeItem() {
      this._prefs.filter.nomeItem = [];
      this._savePrefs(); this._applyFiltersFromPrefs();
      MessageToast.show("Nome do item: seleção limpa.");
    },

    handleFilterDialogConfirm(oEvent) {
      const selected = oEvent.getParameters().filterItems || [];
      const grouped = {};
      selected.forEach((item) => {
        const [path, op, v1, v2] = item.getKey().split("___");
        (grouped[path] ||= []).push(new Filter(path, FilterOperator[op] || op, v1, v2));
      });

      const andFilters = [];
      Object.keys(grouped).forEach((path) => {
        const arr = grouped[path];
        andFilters.push(arr.length > 1 ? new Filter({ filters: arr, and: false }) : arr[0]);
      });

      const oTbl = this.byId("tblDocs");
      oTbl.getBinding("items").filter(andFilters);

      this._prefs.filter.fornecedor = (grouped.supplierName || []).map((f) => String(f.oValue1));
      this._prefs.filter.nomeItem = (grouped.itemDescription || []).map((f) => String(f.oValue1));
      this._savePrefs();
      this._applyFiltersFromPrefs();
    },

    handleSortDialogConfirm(oEvent) {
      const m = oEvent.getParameters();
      const sPath = m.sortItem.getKey();
      const bDesc = m.sortDescending;

      const oTbl = this.byId("tblDocs");
      const arr = [];
      if (this._prefs.group.key) {
        arr.push(new Sorter(
          this._prefs.group.key,
          !!this._prefs.group.desc,
          this.mGroupFunctions[this._prefs.group.key]
        ));
      }
      arr.push(new Sorter(sPath, bDesc));
      oTbl.getBinding("items").sort(arr);

      this._prefs.sort = { key: sPath, desc: !!bDesc };
      this._savePrefs();
    },

    resetGroupDialog() { this._groupReset = true; },

    handleGroupDialogConfirm(oEvent) {
      const m = oEvent.getParameters();
      const oTbl = this.byId("tblDocs");
      const oBinding = oTbl.getBinding("items");

      if (m.groupItem) {
        const sPath = m.groupItem.getKey();
        const bDesc = m.groupDescending;
        const vGroup = this.mGroupFunctions[sPath];

        const arr = [new Sorter(sPath, bDesc, vGroup)];
        if (this._prefs.sort.key) {
          arr.push(new Sorter(this._prefs.sort.key, !!this._prefs.sort.desc));
        }
        oBinding.sort(arr);

        this._prefs.group = { key: sPath, desc: !!bDesc };
        this._savePrefs();
      } else if (this._groupReset) {
        if (this._prefs.sort.key) {
          oBinding.sort([new Sorter(this._prefs.sort.key, !!this._prefs.sort.desc)]);
        } else {
          oBinding.sort();
        }
        this._groupReset = false;

        this._prefs.group = { key: null, desc: false };
        this._savePrefs();
      }
    },

    _openFilterDialog() {
      if (this._oFilterDialog) {
        this._oFilterDialog.destroy();
        this._oFilterDialog = null;
      }
      this._oFilterDialog = this._buildFilterDialog();
      this._oFilterDialog.open();
    },
    _buildFilterDialog() {
      const oView = this.getView();
      const dlg = new ViewSettingsDialog({ confirm: this.handleFilterDialogConfirm.bind(this) });
      if (Device.system.desktop) dlg.addStyleClass("sapUiSizeCompact");
      oView.addDependent(dlg);

      const fiForn = new ViewSettingsFilterItem({ text: "Fornecedor", key: "supplierName" });
      this._getDistinct("supplierName").forEach((val) => {
        const it = new ViewSettingsItem({ text: val, key: `supplierName___EQ___${val}` });
        if (this._prefs.filter.fornecedor?.includes(val)) it.setSelected(true);
        fiForn.addItem(it);
      });
      dlg.addFilterItem(fiForn);

      const fiNome = new ViewSettingsFilterItem({ text: "Nome do item", key: "itemDescription" });
      this._getDistinct("itemDescription").forEach((val) => {
        const it = new ViewSettingsItem({ text: val, key: `itemDescription___EQ___${val}` });
        if (this._prefs.filter.nomeItem?.includes(val)) it.setSelected(true);
        fiNome.addItem(it);
      });
      dlg.addFilterItem(fiNome);

      return dlg;
    },

    _openGroupDialog() {
      const oView = this.getView();
      if (!this._oGroupDialog) {
        this._oGroupDialog = new ViewSettingsDialog({
          confirm: this.handleGroupDialogConfirm.bind(this),
          reset: this.resetGroupDialog.bind(this)
        });
        if (Device.system.desktop) this._oGroupDialog.addStyleClass("sapUiSizeCompact");
        oView.addDependent(this._oGroupDialog);
      }

      this._oGroupDialog.destroyGroupItems();
      [
        { text: "Fornecedor", key: "supplierName" },
        { text: "Org. Compras", key: "arb_PurchasingOrganization" },
        { text: "Empresa", key: "arb_CompanyCode" }
      ].forEach((g) => this._oGroupDialog.addGroupItem(new ViewSettingsItem(g)));

      if (this._prefs.group.key) {
        this._oGroupDialog.setSelectedGroupItem(this._prefs.group.key);
        this._oGroupDialog.setGroupDescending(!!this._prefs.group.desc);
      }

      this._oGroupDialog.open();
    },

    _openSortDialog() {
      const oView = this.getView();
      if (!this._oSortDialog) {
        this._oSortDialog = new ViewSettingsDialog({ confirm: this.handleSortDialogConfirm.bind(this) });
        if (Device.system.desktop) this._oSortDialog.addStyleClass("sapUiSizeCompact");
        oView.addDependent(this._oSortDialog);
      }

      this._oSortDialog.destroySortItems();
      [
        { text: "Fornecedor", key: "supplierName" },
        { text: "Nome do item", key: "itemDescription" },
        { text: "Tipo de pedido", key: "arb_Document_Type" },
        { text: "Org. Compras", key: "arb_PurchasingOrganization" },
        { text: "Grp. Compradores", key: "arb_PurchasingGroup" },
        { text: "Empresa", key: "arb_CompanyCode" }
      ].forEach((f) => this._oSortDialog.addSortItem(new ViewSettingsItem(f)));

      if (this._prefs.sort.key) {
        this._oSortDialog.setSelectedSortItem(this._prefs.sort.key);
        this._oSortDialog.setSortDescending(!!this._prefs.sort.desc);
      }

      this._oSortDialog.open();
    },

    /* =========================================================================
     * 6) HELPERS
     * ========================================================================= */
    _loadPrefs() {
      try {
        const raw = this._storage.get(this._prefsKey);
        if (raw) return JSON.parse(raw);
      } catch (e) { }
      return {
        filter: { supplierName: [], itemDescription: [] },
        sort: { key: null, desc: false },
        group: { key: null, desc: false }
      };
    },
    _savePrefs() {
      this._storage.put(this._prefsKey, JSON.stringify(this._prefs));
    },

    _getDistinct(path) {
      const rows = this.getView().getModel("vm").getProperty("/rows") || [];
      const set = new Set();
      rows.forEach((r) => {
        const v = r[path];
        if (v !== undefined && v !== null && v !== "") set.add(String(v));
      });
      return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
    },

    _applyFiltersFromPrefs() {
      const oTbl = this.byId("tblDocs");
      if (!oTbl) return;
      const oBinding = oTbl.getBinding("items");
      if (!oBinding) return;

      const fGroups = [];
      if (this._prefs.filter.fornecedor?.length) {
        fGroups.push(
          new Filter({
            and: false,
            filters: this._prefs.filter.fornecedor.map(
              (v) => new Filter("supplierName", FilterOperator.EQ, v)
            )
          })
        );
      }
      if (this._prefs.filter.nomeItem?.length) {
        fGroups.push(
          new Filter({
            and: false,
            filters: this._prefs.filter.nomeItem.map(
              (v) => new Filter("itemDescription", FilterOperator.EQ, v)
            )
          })
        );
      }
      oBinding.filter(fGroups);

      const bar = this.byId("vsdFilterBar");
      const label = this.byId("vsdFilterLabel");
      if (bar && label) {
        if (fGroups.length) {
          bar.setVisible(true);
          const legend = [
            this._prefs.filter.fornecedor?.length
              ? `Fornecedor: ${this._prefs.filter.fornecedor.join(", ")}`
              : "",
            this._prefs.filter.nomeItem?.length
              ? `Nome do item: ${this._prefs.filter.nomeItem.join(", ")}`
              : ""
          ].filter(Boolean).join("  |  ");
          label.setText(legend);
        } else {
          bar.setVisible(false);
          label.setText("");
        }
      }
    },

    _applyGroupSortFromPrefs() {
      const oTbl = this.byId("tblDocs");
      if (!oTbl) return;
      const oBinding = oTbl.getBinding("items");
      if (!oBinding) return;

      const sorters = [];
      if (this._prefs.group.key) {
        sorters.push(
          new Sorter(
            this._prefs.group.key,
            !!this._prefs.group.desc,
            this.mGroupFunctions[this._prefs.group.key]
          )
        );
      }
      if (this._prefs.sort.key) {
        sorters.push(new Sorter(this._prefs.sort.key, !!this._prefs.sort.desc));
      }
      if (sorters.length) oBinding.sort(sorters);
    },

    // chave por material (ajuste se precisar Material+Centro)
    _getItemKey(row) {
      return String(row.MaterialCode || row.materialCode || row.ItemId || "");
    },

    _normKey(s) {
      return String(s || "")
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ").trim().toLowerCase();
    },

    _pad10(v) {
      const d = String(v || "").replace(/\D/g, "");
      return d ? d.padStart(10, "0") : null;
    },

    _ensureInvitationResourceId(invId, email) {
      if (!invId) return null;
      const s = String(invId);
      if (s.includes("_")) return s;
      if (email) return `${s}_${String(email)}`;
      return s;
    },
    /* ========= Utilidades específicas ========= */
    _filterItemsByDoc(docId) {
      const oTbl = this.byId("tblDocs");
      const oBinding = oTbl?.getBinding("items");
      if (!oBinding) return;

      const aFilters = docId ? [new Filter("docId", FilterOperator.EQ, String(docId))] : [];
      oBinding.filter(aFilters);
    },

    _buildHeaderRows(list, docId) {
      if (!Array.isArray(list) || !list.length) return [];
      // se veio docId, pega só aquele; senão, 1 por docId
      const byDoc = new Map();
      for (const r of list) {
        const id = r.docId ?? "";
        if (docId && String(id) !== String(docId)) continue;
        if (!byDoc.has(id)) {
          byDoc.set(id, {
            docId: id,
            arb_Document_Type: r.arb_Document_Type ?? "",
            arb_PurchasingOrganization: r.arb_PurchasingOrganization ?? "",
            arb_PurchasingGroup: r.arb_PurchasingGroup ?? "",
            arb_CompanyCode: r.arb_CompanyCode ?? "",
            INCOTERMS1: r.INCOTERMS1 ?? "",
            INCOTERMS2: r.INCOTERMS2 ?? "",
            arb_PaymentTerms: r.arb_PaymentTerms ?? ""
          });
        }
      }
      return Array.from(byDoc.values());
    },

    async _openSimFragment(aRows, docIds) {
      const oView = this.getView();

      const oSimModel = new JSONModel({
        docIds,                 // agora é array (IDs envolvidos)
        total: aRows.length,
        rows: aRows,            // coleção p/ tabela
        first: aRows?.[0] || {} // primeiro item (p/ cabeçalho/resumo)
      });

      if (!this._oSimDialog) {
        this._oSimDialog = await Fragment.load({
          id: oView.getId(), // importante p/ IDs estáveis
          name: "comparativemap.comparativemap.view.fragments.Simulacao", // ajuste ao seu namespace
          type: "XML",
          controller: this
        });
        oView.addDependent(this._oSimDialog);
      }

      this._oSimDialog.setModel(oSimModel, "sim");
      this._oSimDialog.open();
    },


    /** ************************************************************
  * SIMULAR (lote): Agrupa por fornecedor, monta requests[] e chama a action única
  * - Header-base vem do vm>/headerRows[0] (sem seleção)
  * - Itens: linhas selecionadas em vm>/rows
  * - Agora SEM chamada unitária: sempre envia array "requests" (um por fornecedor)
  ************************************************************* */
    onSimularPress: async function () {
      const oView = this.getView();
      const oOData = oView.getModel();      // OData V4 (/odata/v4/service)
      const vm = oView.getModel("vm");      // JSONModel com dados do Ariba

      console.groupCollapsed("[SIMULAR] clique");
      try {
        // 1) HEADER do VM (pega o primeiro registro da tabela de cabeçalho)
        const hCand = this._getHeaderFromVM(vm);
        this._dbg("Header bruto (vm>/headerRows[0] ou vm>/header)", hCand);

        // 2) ITENS selecionados na tabela inferior (vm>/rows)
        const oTbl = this.byId("tblDocs");
        if (!oTbl) throw new Error("Tabela 'tblDocs' não encontrada.");
        const aCtx = oTbl.getSelectedContexts("vm");
        if (!aCtx.length) throw new Error("Selecione pelo menos 1 item para simular.");
        const rows = aCtx.map(c => c.getObject());
        this._dbg(`Linhas selecionadas (count=${rows.length})`, rows);

        // 2.1) Prepara índices (idByKey) para enriquecer o resultado depois
        this._prepareQMFromSelection(rows);

        // 3) MAP: Header Ariba → Header BAPI (um fornecedor)
        const header = this._mapHeaderFromAriba(hCand, rows[0]);
        this._dbg("Header normalizado (→ simularPO.header)", header);

        // 4) MAP: cada linha selecionada → item BAPI
        const items = rows.map((r, idx) => this._mapRowToPOItem(r, idx));
        console.table(items);

        // 5) Schedules (1 por item) com data do Ariba (quando houver)
        const schedules = rows.map((r, i) => ({
          poItem: items[i].poItem,
          schedLine: 1,
          deliveryDate: this._getDeliveryDateFromRow(r),
          quantity: items[i].quantity
        }));
        console.table(schedules);

        // 6) VALIDAÇÃO mínima antes do backend (evita roundtrip bobo)
        const missing = [];
        if (!header.docType) missing.push("Tipo de Pedido (docType)");
        if (!header.compCode) missing.push("Empresa (compCode)");
        if (!header.purchOrg) missing.push("Org. de Compras (purchOrg)");
        if (!header.purchGroup) missing.push("Grupo de Compras (purchGroup)");
        if (!header.vendor) missing.push("Fornecedor (vendor/LIFNR)");
        if (!header.currency) missing.push("Moeda (currency)");

        const missingItems = [];
        items.forEach((it, i) => {
          const tag = `Item ${String((i + 1) * 10).padStart(5, '0')}`;
          if (!it.plant) missingItems.push(`${tag}: Centro (plant)`);
          if (!it.unit) missingItems.push(`${tag}: Unidade (unit)`);
          if (!it.quantity || Number(it.quantity) <= 0) missingItems.push(`${tag}: Quantidade (quantity)`);
          if (!it.material && !it.shortText) missingItems.push(`${tag}: MATERIAL ou SHORT_TEXT`);
        });

        if (missing.length || missingItems.length) {
          const msg = [
            missing.length ? "Cabeçalho faltando:\n- " + missing.join("\n- ") : "",
            missingItems.length ? "Itens faltando:\n- " + missingItems.join("\n- ") : ""
          ].filter(Boolean).join("\n\n");
          throw new Error(msg);
        }

        // 7) EXECUTA a action OData V4
        const oCtx = oOData.bindContext("/simularPO(...)");
        oCtx.setParameter("header", header);
        oCtx.setParameter("items", items);
        oCtx.setParameter("schedules", schedules);
        oCtx.setParameter("testRun", true);

        console.log("→ Executando oCtx.execute() /simularPO(...)");
        await oCtx.execute();

        // 8) Resultado da action
        const result = oCtx.getBoundContext().getObject();
        this._dbg("Resultado bruto da action", result);

        // 9) Converte BAPI → modelo do fragment ResultadoSimulacao
        const resRows = this._buildResRowsFromBapiResult(result);
        const resModel = new sap.ui.model.json.JSONModel({ rows: resRows });
        oView.setModel(resModel, "res");

        console.groupEnd();

        // 10) Abre o fragment correto
        if (!this._dlgRes) {
          this._dlgRes = await sap.ui.core.Fragment.load({
            id: oView.getId(),
            name: "comparativemap.comparativemap.view.fragments.ResultadoSimulacao", // <-- este é o correto
            type: "XML",
            controller: this
          });
          oView.addDependent(this._dlgRes);
        }
        this._dlgRes.open();

        // 11) (opcional) Mostra mensagens da BAPI se quiser (o seu result já tem returnMessages)
        this._showBapiMessages(result.returnMessages || result.mensagens || []);

      } catch (err) {
        console.error("[SIMULAR] ERRO:", err);
        console.groupEnd();
        sap.m.MessageBox.error(err.message || String(err));
      }
    },

    /** Constrói idByKey para casar depois BAPI → Ariba (itemId/invitationId/originalQty) */
    _prepareQMFromSelection(rows) {
      const qm = this.getView().getModel("qm");
      const idx = {};
      const idByKey = {};

      rows.forEach((r) => {
        const matKey = this._normKey(this._getItemKey(r));      // MaterialCode/ItemId
        const nameKey = this._normKey(r.supplierName || "");
        const lifnr = this._pad10(r.lifnr || r.supplierId || (/^\d+$/.test(r.supplierName) ? r.supplierName : ""));

        const meta = {
          itemId: r.itemId ?? r.ItemId ?? null,
          invitationId: r.invitationId ?? r._invitationId ?? null,
          invitationEmail: r.invitationEmail ?? null,
          masterQty: Number(r._originalQty || r.quantity) || 0,
          supplierName: r.supplierName || "",
          lifnr: lifnr,
          description: r.itemDescription || r.materialDesc || r.description || "",
          materialCode: r.MaterialCode || r.materialCode || ""
        };

        idx[`${matKey}|NAME:${nameKey}`] = meta;
        idByKey[`${matKey}|NAME:${nameKey}`] = meta;
        if (lifnr) {
          idx[`${matKey}|LIFNR:${lifnr}`] = meta;
          idByKey[`${matKey}|LIFNR:${lifnr}`] = meta;
        }
      });

      qm.setProperty("/idx", idx);
      qm.setProperty("/idByKey", idByKey);
    },

    /** Normaliza MATNR do BAPI → chave comparável ao MaterialCode do Ariba */
    _matKeyFromBapiMaterial(mat) {
      const s = String(mat || "");
      // usa apenas dígitos e tira zeros à esquerda (ex.: 000...726133 → 726133)
      const only = s.replace(/\D/g, "");
      const no0 = only.replace(/^0+/, "");
      return this._normKey(no0 || only || s);
    },

    /** Mapeia o resultado da BAPI para o modelo 'res>/rows' do fragment ResultadoSimulacao */
    _buildResRowsFromBapiResult(result) {
      const qm = this.getView().getModel("qm");
      const idByKey = qm.getProperty("/idByKey") || {};
      const lifnrHeader = (result?.header?.fornecedor || "").toString().padStart(10, "0");
      const currency = result?.header?.moeda || "BRL";

      const rows = (Array.isArray(result?.itens) ? result.itens : []).map((it) => {
        const matKey = this._matKeyFromBapiMaterial(it.material);
        // tenta casar por LIFNR (mais confiável), senão NAME (se disponível)
        const meta = idByKey[`${matKey}|LIFNR:${lifnrHeader}`] || null;

        const originalQty = Number(meta?.masterQty ?? 0) || 0;
        const quantity = Number(it.quantidade || 0) || 0;
        const price = Number(it.netPrice || 0) || 0;
        const total = Number((price * quantity).toFixed(2));

        return {
          supplierName: meta?.supplierName || lifnrHeader,   // exibe nome; se não tiver, mostra LIFNR
          materialCode: meta?.materialCode || it.material,   // mostra como veio do Ariba quando possível
          originalQty: originalQty,
          quantity: quantity,     // “Qtd Simulada” no fragment
          qtyAward: 0,            // usuário preenche depois
          price: price,
          currency: currency,
          icms: null,             // (opcional) se não tiver cálculo, deixa null
          ipi: null,              // (opcional)
          total: total,

          // campos debug/necessários para premiação
          itemId: meta?.itemId ?? null,
          invitationId: meta?.invitationId ?? null,
          invitationEmail: meta?.invitationEmail ?? null,
          lifnr: lifnrHeader
        };
      });

      return rows;
    },

    // --- Extrai LIFNR de uma linha (normaliza e zera à esquerda)
    _getVendorFromRow: function (r) {
      const raw = (r.SupplierCode || r.suppliercode || r.supplierId || r.lifnr || r.VENDOR || r.vendor || "").toString();
      const onlyDigits = raw.replace(/\D/g, "");
      return this._zpad(onlyDigits, 10);
    },

    // --- Agrupa as linhas por fornecedor; se faltar em alguma, usa fallbackVendor do headerBase
    _groupByVendor: function (rows, fallbackVendor) {
      const map = new Map();
      rows.forEach(r => {
        const v = this._getVendorFromRow(r) || fallbackVendor;
        if (!v) throw new Error("Não foi possível resolver o fornecedor (LIFNR) de uma das linhas.");
        if (!map.has(v)) map.set(v, []);
        map.get(v).push(r);
      });
      return map; // Map<LIFNR, Row[]>
    },

    // --- Monta o payload de uma request por fornecedor (header/items/schedules)
    _buildPayloadForVendor: function (vendor, rowsDoVendor, headerBase) {
      const header = { ...headerBase, vendor };

      // itens renumerados 10,20,30… por grupo
      const items = rowsDoVendor.map((r, idx) => this._mapRowToPOItem(r, idx));

      // schedules 1-para-1 com os itens (data vinda do Ariba quando houver)
      const schedules = rowsDoVendor.map((r, i) => ({
        poItem: items[i].poItem,
        schedLine: 1,
        deliveryDate: this._getDeliveryDateFromRow(r),
        quantity: items[i].quantity
      }));

      return { header, items, schedules, testRun: true };
    },


    // Abre o Dialog com o resultado da simulação (usa o fragment acima)
    _openResultadoPO: async function (result) {
      const oView = this.getView();

      if (!this._dlgResultadoPO) {
        // Use um prefixo estável da própria view para o fragment:
        const fragPrefix = oView.createId("resPO"); // gera "viewId--resPO"
        this._dlgResultadoPO = await sap.ui.core.Fragment.load({
          id: fragPrefix, // ⬅️ agora os controles ficam "viewId--resPO--<id>"
          name: "comparativemap.comparativemap.view.fragments.ResultadoSimulacaoPO",
          controller: this
        });
        oView.addDependent(this._dlgResultadoPO);
      }

      // Atualiza o modelo e abre
      this._dlgResultadoPO.setModel(new sap.ui.model.json.JSONModel(result || {}), "simpo");
      this._dlgResultadoPO.open();
    },
    onExit: function () {
      if (this._dlgResultadoPO) {
        this._dlgResultadoPO.destroy(true);
        this._dlgResultadoPO = null;
      }
    },

    // Formatter simples para números (duas casas)
    fmt2: function (v) {
      const n = Number(v);
      return isNaN(n) ? "" : n.toFixed(2);
    },

    // Mostra mensagens da BAPI de forma simples
    _showBapiMessages: function (msgs) {
      const arr = Array.isArray(msgs) ? msgs : [];

      // Sem mensagens → só um toast de sucesso
      if (!arr.length) {
        sap.m.MessageToast.show("Simulação concluída. Sem mensagens da BAPI.");
        return;
      }

      // Monta um texto curtinho por linha
      const line = (m) => {
        const idnum = [m.id, m.number].filter(Boolean).join("/");
        const tag = m.type ? `[${m.type}]` : "[?]";
        return `${tag} ${m.message || ""}${idnum ? ` (${idnum})` : ""}`;
      };
      const text = arr.map(line).join("\n");

      // Escala o ícone/caixa pela severidade
      const hasError = arr.some(m => m.type === "E" || m.type === "A");
      const hasWarning = arr.some(m => m.type === "W");

      if (hasError) {
        sap.m.MessageBox.error(text, { title: "Mensagens da BAPI" });
      } else if (hasWarning) {
        sap.m.MessageBox.warning(text, { title: "Mensagens da BAPI" });
      } else {
        sap.m.MessageBox.success(text, { title: "Mensagens da BAPI" });
      }
    },


    /** ************************************************************
     * HEADER: pega do VM e mapeia Ariba → BAPI
     * - Usa vm>/headerRows[0] (sua tabela de cabeçalho)
     * - Fallback de moeda: usa a do primeiro item se header não tiver
     ************************************************************* */
    _getHeaderFromVM: function (vm) {
      let h = vm.getProperty("/headerRows");
      if (Array.isArray(h)) h = h[0] || {};
      if (!h || !Object.keys(h).length) h = vm.getProperty("/header") || {};
      return h;
    },

    _mapHeaderFromAriba: function (h, firstRow) {
      // Campos que você tem na sua tabela de header:
      // tipoPedido, purchasingOrganization, purchasingGroup, companyCode, incoterms1, incoterms2, paymentTerms
      // (fornecedor e moeda podem não estar no header; por isso tratamos abaixo)

      // Fallback de moeda: se header.moeda não vier, usa do primeiro item selecionado
      const currency = (h.moeda || firstRow?.currency || "BRL").toString().toUpperCase().slice(0, 3);

      // Vendor (LIFNR): tenta header.fornecedor; se vazio, usa SupplierCode da 1ª linha selecionada
      const vendorRaw =
        (h.fornecedor && String(h.fornecedor).trim()) ||
        firstRow?.SupplierCode ||
        firstRow?.suppliercode ||
        firstRow?.supplierId ||
        firstRow?.lifnr;
      const vendor = this._zpad(String(vendorRaw).replace(/\D/g, ""), 10);
      const rawTipo = (h.tipoPedido || "NB").toString().trim();
      const m = rawTipo.match(/([A-Z0-9]{2,4})\s*$/i); // último bloco 2–4 chars
      const docType = (m ? m[1] : rawTipo).toUpperCase().slice(0, 4);

      return {
        docType: docType,
        compCode: (h.companyCode || "").toString().slice(0, 4),
        purchOrg: (h.purchasingOrganization || "").toString().slice(0, 4),
        purchGroup: (h.purchasingGroup || "").toString().slice(0, 3),
        vendor,           // ← já mockado se não veio
        currency,         // ← com fallback do primeiro item
        incoterms1: (h.incoterms1 || "").toString().toUpperCase().slice(0, 3),
        incoterms2: (h.incoterms2 || "").toString().slice(0, 28)
        // paymentTerms: a BAPI_PO_CREATE1 não recebe direto no HEADER; ignoramos aqui
      };
    },

    /** ************************************************************
     * ITEM: mapeia uma linha Ariba (vm>/rows[*]) → POITEM da BAPI
     * - MATERIAL (numérico) vira MATNR com 18 dígitos
     * - Se não houver MATERIAL, usa SHORT_TEXT (40)
     ************************************************************* */
    _mapRowToPOItem: function (r, idx) {
      const poItem = (idx + 1) * 10; // 10,20,30...

      // MATERIAL vs SHORT_TEXT  ✅ pega prefixo numérico no início do MaterialCode
      const matRaw = (r.MaterialCode || "").toString().trim();

      // se começar com dígitos (ex.: "558510 ..."), usa esse prefixo como MATNR
      const m = matRaw.match(/^(\d{4,})\b/);
      const material = m ? this._zpad(m[1], 18) : "";

      // descrição (fallbacks) — mantém como antes
      const desc = (r.itemDEscription || r.itemDescription || r.description || r.ItemDescription || "").toString();
      const shortText = desc.slice(0, 40);

      // Unidade (map simples; ajuste se precisar)
      const unit = this._mapUoM((r.unitOfMeasure || "").toString().toUpperCase());

      // Centro (se vier "C010 - Algo", pega o código à esquerda)
      const plant = this._mapPlant((r.PLANT || "").toString());

      // Categoria do item (Ariba → código interno BAPI)
      const itemCat = this._mapItemCategory((r.ItemCategory || "").toString());

      // Grupo de materiais: até 9
      const matlGroup = (r.grupo_de_materias || "").toString().slice(0, 9);

      // Preço unitário (opcional, mas ajuda na simulação)
      const netPrice = (r.price != null) ? Number(r.price) : null;

      // PREQ_NO: se ItemId for numérico
      const preqNo = /^\d+$/.test(String(r.CodigoRequisicao || "")) ? String(r.CodigoRequisicao).slice(0, 10) : undefined;

      const it = { poItem, plant, material, shortText, quantity: Number(r.quantity || 0), unit, netPrice, itemCat, matlGroup, preqNo };
      // Logs simples de sanidade por item
      if (!it.material && !it.shortText) console.warn(`[ITEM ${String(poItem).padStart(5, '0')}] Sem MATERIAL e SHORT_TEXT`);
      if (!it.unit) console.warn(`[ITEM ${String(poItem).padStart(5, '0')}] Unidade vazia`);
      if (!it.plant) console.warn(`[ITEM ${String(poItem).padStart(5, '0')}] Centro vazio`);
      if (!it.quantity) console.warn(`[ITEM ${String(poItem).padStart(5, '0')}] Quantidade vazia/zero`);

      return it;
    },

    /** ********** Helpers utilitários ********** */

    // Converte vários formatos → 'YYYY-MM-DD' (Edm.Date)
    _normalizeDate: function (val) {
      if (!val) return this._toEdmDate(new Date());
      let s = typeof val === "object" && val.dateValue ? val.dateValue : String(val).trim();

      // 'YYYY-MM-DD'
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

      // 'YYYYMMDD'
      if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

      // ISO '2025-09-29T10:55:00.000+0000' etc.
      const d = new Date(s);
      if (!isNaN(d)) return this._toEdmDate(d);

      throw new Error(`Data inválida: ${val}`);
    },

    // Pega a data do Ariba na linha e normaliza
    _getDeliveryDateFromRow: function (r) {
      const raw = r?.DELIVERY_DATE_RAW?.dateValue || r?.DELIVERY_DATE_RAW || r?.deliveryDate;
      return this._normalizeDate(raw || new Date());
    },


    // Converte Date JS → 'YYYY-MM-DD' (Edm.Date)
    _toEdmDate: function (d) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    },

    // Pad left (zeros à esquerda)
    _zpad: function (val, len) {
      const s = String(val || "");
      return s.length >= len ? s : "0".repeat(len - s.length) + s;
    },

    // UoM: mapeio básico (ajuste conforme sua realidade)
    _mapUoM: function (u) {
      const map = { "UN": "PC", "PC": "PC", "PÇ": "PC", "KG": "KG", "G": "G", "L": "L", "M": "M", "CX": "CX" };
      return map[u] || u.slice(0, 3);
    },

    // PLANT: se vier "C010 - ..." pega "C010"
    _mapPlant: function (p) {
      const code = p.split(/[ -]/)[0].trim();
      return code.slice(0, 4);
    },

    // ItemCategory (externo → interno BAPI)
    _mapItemCategory: function (ext) {
      const x = (ext || "").trim().toUpperCase();

      // Mapas comuns Ariba → SAP (PSTYP interno da BAPI)
      const dict = {
        // Padrão
        "": "0", "STD": "0", "STANDARD": "0", "MATERIAL": "0",

        // Consignado
        "K": "2", "CONSIGNMENT": "2", "CONSIGNADO": "2",

        // Subcontratação
        "L": "3", "SUBCONTRACTING": "3", "SUBCONTRATACAO": "3", "SUBCONTRATAÇÃO": "3",

        // Third-party
        "S": "5", "THIRD-PARTY": "5", "THIRD PARTY": "5", "TERCEIROS": "5",

        // Transferência entre centros
        "U": "7", "STOCK TRANSFER": "7", "TRANSFERENCIA": "7", "TRANSFERÊNCIA": "7",

        // Limites/Serviços aprimorados (se aplicável no seu cenário)
        "E": "A", "ENHANCED LIMITS": "A", "LIMITS": "A"
      };

      return dict[x] || "0"; // default: padrão
    },

    // Logs “bonitinhos”
    _dbg: function (title, obj) {
      console.groupCollapsed("🔎 " + title);
      try { console.log(this._safe(obj)); } catch (e) { console.log(obj); }
      console.groupEnd();
    },
    _safe: function (obj) {
      const cache = new Set();
      const out = JSON.parse(JSON.stringify(obj, (k, v) => {
        if (typeof v === "function") return undefined;
        if (typeof v === "object" && v !== null) { if (cache.has(v)) return; cache.add(v); }
        return v;
      }));
      cache.clear();
      return out;
    }
  });
});