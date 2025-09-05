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
     * 1) HANDLERS PRINCIPAIS (públicos) — ciclo de vida, ações de dados e UI
     * ========================================================================= */

    /* ==== Lifecycle ==== */
    onInit() {
      const vm = new sap.ui.model.json.JSONModel({
        header: {
          tipoPedido: "", purchasingOrganization: "", purchasingGroup: "",
          companyCode: "", incoterms1: "", incoterms2: "", paymentTerms: ""
        },
        headerRows: [],
        rows: []
      });
      this.getView().setModel(vm, "vm");

      const qm = new sap.ui.model.json.JSONModel({
        items: [],       // linhas selecionadas com campos qtySim / qtyAward
        perKey: {},      // somatórios por itemKey (para premiação)
        validAward: false,
        _summaryText: ""
      });
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

    /* ==== Ações de dados ==== */
    async onBuscar() {
      const oView = this.getView();
      const oOData = oView.getModel();          // default OData V4 do manifest
      const oVM = oView.getModel("vm");
      const docId = (oView.byId("inputDoID").getValue() || "").trim();
      const tbl = oView.byId("tblDocs");

      try {
        if (!oOData) throw new Error("Modelo OData V4 não encontrado (verifique o manifest).");
        if (!docId) { sap.m.MessageToast.show("Informe o Doc ID"); return; }

        tbl.setBusy(true);

        // Chama a function import que retorna um OBJETO (QuotesResponse)
        const oCtx = oOData.bindContext("/GetQuotes(...)");
        oCtx.setParameter("docId", docId);
        console.log("[onBuscar] GetQuotes(docId) =", docId);
        await oCtx.execute();

        const res = await oCtx.getBoundContext().requestObject();
        console.log("[onBuscar] Retorno GetQuotes =", res);
        try { console.log("[onBuscar] Retorno GetQuotes (JSON) =", JSON.stringify(res, null, 2)); } catch (e) { }

        oVM.setProperty("/header", res?.header || {});
        oVM.setProperty("/rows", Array.isArray(res?.items) ? res.items : []);
        oVM.setProperty("/headerRows", res?.header ? [res.header] : []);

        console.log("[onBuscar] VM.header =", oVM.getProperty("/header"));
        console.log("[onBuscar] VM.rows.length =", oVM.getProperty("/rows")?.length);

        this.byId("tblDocs").getBinding("items")?.refresh(true);

        if (!res?.items?.length) sap.m.MessageToast.show("Nenhum item retornado para esse Doc ID.");
      } catch (e) {
        console.error("[onBuscar] ERRO:", e);
        sap.m.MessageBox.error("Falha ao buscar dados: " + (e.message || e));
      } finally {
        tbl.setBusy(false);
      }
    },


    async onSimularCompra() {
      const oView = this.getView();
      const oTbl = this.byId("tblDocs");

      const selCtx = oTbl.getSelectedContexts("vm") || [];
      console.log("[onSimularCompra] selCtx.length =", selCtx.length);

      const selecionados = selCtx.map(c => c.getObject());
      console.log("[onSimularCompra] selecionados =", selecionados);

      if (!selecionados.length) {
        MessageBox.warning("Selecione ao menos uma linha.");
        return;
      }

      const items = selecionados.map((r, i) => {
        const obj = {
          id: i + 1,
          itemKey: this._getItemKey(r),
          supplierId: r.supplierId,
          supplierName: r.supplierName,

          // material/descrição
          MaterialCode: r.MaterialCode || r.materialCode,
          materialCode: r.MaterialCode || r.materialCode, // se você usa minúsculo em algum binding
          description: r.itemDescription || r.materialDesc || r.itemDEscription,

          // quantidades/preço/moeda
          masterQty: Number(r.quantity) || 0,
          supplierQty: Number(r.quantity) || 0,
          qtySim: Number(r.quantity) || 0,
          price: Number(r.price) || 0,
          currency: r.currency,

          // >>> CAMPOS QUE ESTÃO FALTANDO NA SIMULAÇÃO <<<
          unitOfMeasure: r.unitOfMeasure || r.PO_UNIT || r.unidade || null,
          PLANT: r.PLANT || r.centro || null,
          TAX_CODE: r.TAX_CODE || r.iva || null,
          ItemCategory: r.ItemCategory || r.itemCategory || null,
          grupo_de_materias: r.grupo_de_materias || r.grupoMateriais || r.MaterialGroup || null,
          PREQ_NO: r.PREQ_NO || null,
          PREQ_ITEM: r.PREQ_ITEM || null,

          // identificação
          docId: r.docId,
          lineNumber: r.lineNumber,

          // mantenha o bruto se quiser
          raw: r
        };
        console.log("[onSimularCompra] item QM =", obj);
        return obj;
      });

      const qm = oView.getModel("qm");
      qm.setProperty("/items", items);
      qm.setProperty("/perKey", {});
      qm.setProperty("/validAward", false);
      qm.setProperty("/_summaryText", "");

      try { console.log("[onSimularCompra] QM JSON =", qm.getJSON ? qm.getJSON() : JSON.stringify(qm.getProperty("/"), null, 2)); } catch (e) { }

      await this._openDlgSimQty();
    }
    ,

    // === CHAVE DO "TIPO DE ITEM" (ajuste se for outra combinação, ex.: Material+Centro)
    _getItemKey(row) {
      return String(row.MaterialCode || row.materialCode || row.ItemId || "");
    },

    /* ===================== DIÁLOGO: FRACIONAR SIMULAÇÃO (qtySim) ===================== */
    _openDlgSimQty: function () {
      const oView = this.getView();
      if (!this._dlgSim) {
        // Fragment XML: comparativemap/comparativemap/view/fragments/FracionarSimulacao.fragment.xml
        // (campos: supplierName, materialCode, description, masterQty, supplierQty, Input qtySim)
        this._dlgSim = sap.ui.xmlfragment(oView.getId(),
          "comparativemap.comparativemap.view.fragments.FracionarSimulacao", this);
        oView.addDependent(this._dlgSim);
      }
      this._dlgSim.open();
    },

    onCloseDialog: function (oEvent) {
      oEvent.getSource().getParent().close();
    },

    onSimQtyChange: function (oEvent) {
      const input = oEvent.getSource();
      const ctx = input.getBindingContext("qm");
      const obj = ctx.getObject();

      let v = Number(input.getValue());
      if (isNaN(v) || v < 0) v = 0;
      if (v > obj.supplierQty) v = obj.supplierQty;
      v = Math.floor(v);
      input.setValue(String(v));
    },

    /* ===================== DIÁLOGO: RESULTADO DA SIMULAÇÃO ===================== */
    _openResultDialog: function (result) {
      const oView = this.getView();
      // result: espere algo como { rows: [{supplierName, materialCode, quantity, price, currency, impostos...}] }
      const resModel = new sap.ui.model.json.JSONModel({ rows: result.rows || [] });
      oView.setModel(resModel, "res");

      if (!this._dlgRes) {
        // Fragment XML: comparativemap/comparativemap/view/fragments/ResultadoSimulacao.fragment.xml
        // (tabela simples, mode="MultiSelect", botão "Premiar Fornecedores" -> onOpenAwardDialog)
        this._dlgRes = sap.ui.xmlfragment(oView.getId(),
          "comparativemap.comparativemap.view.fragments.ResultadoSimulacao", this);
        oView.addDependent(this._dlgRes);
      }
      this._dlgRes.open();
    },

    /* ===================== DIÁLOGO: PREMIAÇÃO (qtyAward, deve fechar mestre) ===================== */
    onOpenAwardDialog: function () {
      // pega só os itens selecionados no resultado
      const tbl = this._dlgRes?.getContent()[0]; // primeira Table do fragment Resultado
      const selected = tbl?.getSelectedContexts("res").map(c => c.getObject()) || [];
      if (!selected.length) {
        sap.m.MessageToast.show("Selecione ao menos um item simulado para premiar.");
        return;
      }

      // agrupa por itemKey e prepara somatórios
      const byKey = {};
      const items = [];
      const perKey = {};
      selected.forEach((r) => {
        const key = this._getItemKey(r);
        (byKey[key] ||= []).push(r);
      });

      Object.entries(byKey).forEach(([key, arr]) => {
        // masterQty deve vir do dado original (Ariba). Se no result já veio, use r.masterQty.
        const masterQty = Number(arr[0].masterQty ?? arr[0].quantity ?? 0);
        perKey[key] = { masterQty, currentSum: 0, remaining: masterQty };
        arr.forEach((r) => {
          items.push({
            id: items.length + 1,
            itemKey: key,
            supplierId: r.supplierId,
            supplierName: r.supplierName,
            materialCode: r.materialCode,
            description: r.description || r.itemDescription || "",
            masterQty,
            supplierQty: Number(r.supplierQty ?? r.quantity ?? masterQty), // limite por fornecedor
            qtyAward: 0,
            currency: r.currency,
            price: Number(r.price || 0),
            raw: r
          });
        });
      });

      const qm = this.getView().getModel("qm");
      qm.setProperty("/items", items);
      qm.setProperty("/perKey", perKey);
      this._recalcAwardSummary();

      const oView = this.getView();
      if (!this._dlgAward) {
        // Fragment XML: comparativemap/comparativemap/view/fragments/PremiarQuantidade.fragment.xml
        // (tabela com Input qtyAward, barra de resumo e botão "Premiar" enabled="{qm>/validAward}")
        this._dlgAward = sap.ui.xmlfragment(oView.getId(),
          "comparativemap.comparativemap.view.fragments.PremiarQuantidade", this);
        oView.addDependent(this._dlgAward);
      }
      this._dlgAward.open();
    },

    _recalcAwardSummary: function () {
      const qm = this.getView().getModel("qm");
      const items = qm.getProperty("/items") || [];
      const perKey = qm.getProperty("/perKey") || {};

      // zera somas
      Object.keys(perKey).forEach(k => { perKey[k].currentSum = 0; perKey[k].remaining = perKey[k].masterQty; });

      for (const it of items) {
        const k = it.itemKey;
        const v = Number(it.qtyAward) || 0;
        perKey[k].currentSum += v;
        perKey[k].remaining = perKey[k].masterQty - perKey[k].currentSum;
      }

      const parts = Object.entries(perKey).map(([k, v]) => `${k}: restante ${v.remaining}`);
      qm.setProperty("/_summaryText", parts.join(" | "));

      // válido somente se todos remaining === 0 e nenhuma qty > supplierQty ou < 0
      let valid = true;
      for (const [k, v] of Object.entries(perKey)) {
        if (v.remaining !== 0) { valid = false; break; }
      }
      for (const it of items) {
        const q = Number(it.qtyAward) || 0;
        if (q < 0 || q > (Number(it.supplierQty) || 0)) { valid = false; break; }
      }
      qm.setProperty("/validAward", valid);
    },

    onAwardQtyChange: function (oEvent) {
      const input = oEvent.getSource();
      const ctx = input.getBindingContext("qm");
      const obj = ctx.getObject();

      let v = Number(input.getValue());
      if (isNaN(v) || v < 0) v = 0;
      if (v > obj.supplierQty) v = obj.supplierQty;
      v = Math.floor(v);
      input.setValue(String(v));

      this._recalcAwardSummary();
    },

    onConfirmSimulate: async function () {
      const oView = this.getView();
      const oModel = oView.getModel();
      const qm = oView.getModel("qm");
      const vm = oView.getModel("vm");

      const itemsQM = qm.getProperty("/items") || [];
      console.log("[onConfirmSimulate] QM.items (bruto) =", itemsQM);

      // 1) HEADER (raw)
      const rawHeader = vm.getProperty("/header") || {};
      console.log("[onConfirmSimulate] HEADER (raw) =", rawHeader);

      // 2) ITEMS (payload) — primeiro declare o payload
      const payload = itemsQM
        .filter(it => Number(it.qtySim) > 0)
        .map(it => ({
          MaterialCode: it.MaterialCode ?? it.materialCode ?? null,
          itemDescription: it.itemDescription ?? it.description ?? it.materialDesc ?? it.itemDEscription ?? null,
          quantity: Number(it.qtySim),
          unitOfMeasure: it.unitOfMeasure ?? it.PO_UNIT ?? it.unidade ?? null,
          price: Number(it.price) || 0,
          currency: it.currency ?? null,
          PLANT: it.PLANT ?? it.plant ?? it.centro ?? null,
          TAX_CODE: it.TAX_CODE ?? it.iva ?? null,
          ItemCategory: it.ItemCategory ?? it.itemCategory ?? null,
          grupo_de_materias: it.grupo_de_materias ?? it.grupoMateriais ?? it.MaterialGroup ?? null,
          lifnr: '100573116',// it.lifnr ?? it.supplierId ?? it.VENDOR ?? 3,
          PREQ_NO: it.PREQ_NO ?? null,
          PREQ_ITEM: it.PREQ_ITEM ?? null
        }));

      // 3) Derive moeda sem acessar variável antes de declarar
      const firstCurrency = payload.length ? payload[0].currency : null;

      // 4) HEADER (sanitizado)
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
      console.log("[onConfirmSimulate] HEADER (sanitizado) =", header);

      console.log("[onConfirmSimulate] ITEMS pronto p/ enviar =", payload);

      if (!payload.length) {
        sap.m.MessageToast.show("Informe quantidades maiores que zero para simular.");
        return;
      }

      sap.ui.core.BusyIndicator.show(0);
      try {
        const ctx = oModel.bindContext("/SimulateBapiPoCreate(...)");
        ctx.setParameter("header", header);
        ctx.setParameter("items", payload);

        console.log("[onConfirmSimulate] Executando action /SimulateBapiPoCreate...");
        await ctx.execute();

        const result = await ctx.getBoundContext().requestObject();
        console.log("[onConfirmSimulate] RESULTADO =", result);

        await this._openResultDialog(result);
        this._dlgSim?.close();
      } catch (e) {
        console.error("[onConfirmSimulate] ERRO:", e, e?.message, e?.response);
        sap.m.MessageBox.error("Falha na simulação: " + (e.message || e));
      } finally {
        sap.ui.core.BusyIndicator.hide();
      }
    },

    onCloseSimulacao: function () {
      this._oSimDialog?.close();
      this._oSimDialog?.destroy();
      this._oSimDialog = null;
    },

    /* ==== UI: botões Filter/Sort/Group ==== */
    handleFilterButtonPressed() { this._openFilterDialog(); },
    handleSortButtonPressed() { this._openSortDialog(); },
    handleGroupButtonPressed() { this._openGroupDialog(); },

    /* ==== UI: filtros rápidos (selecionar/limpar) ==== */
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
      this._prefs.filter.nomeItem = this._getDistinct("materialDesc");
      this._savePrefs(); this._applyFiltersFromPrefs();
      MessageToast.show("Nome do item: selecionado tudo.");
    },
    onFilterClearNomeItem() {
      this._prefs.filter.nomeItem = [];
      this._savePrefs(); this._applyFiltersFromPrefs();
      MessageToast.show("Nome do item: seleção limpa.");
    },

    /* ==== Callbacks dos diálogos ViewSettings (Filter/Sort/Group) ==== */
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
      this._prefs.filter.nomeItem = (grouped.materialDesc || []).map((f) => String(f.oValue1));
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

    /* =========================================================================
     * 2) HELPERS / PRIVADOS (começam com “_”) — persistência, filtros e utilitários
     * ========================================================================= */

    /* ========= Persistência ========= */
    _loadPrefs() {
      try {
        const raw = this._storage.get(this._prefsKey);
        if (raw) return JSON.parse(raw);
      } catch (e) { }
      return {
        filter: { supplierName: [], materialDesc: [] },
        sort: { key: null, desc: false },
        group: { key: null, desc: false }
      };
    },
    _savePrefs() {
      this._storage.put(this._prefsKey, JSON.stringify(this._prefs));
    },

    /* ========= Helpers gerais ========= */
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
              (v) => new Filter("materialDesc", FilterOperator.EQ, v)
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
          ]
            .filter(Boolean)
            .join("  |  ");
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

    /* ========= FILTER (internos) ========= */
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
      const dlg = new ViewSettingsDialog({
        confirm: this.handleFilterDialogConfirm.bind(this)
      });
      if (Device.system.desktop) dlg.addStyleClass("sapUiSizeCompact");
      oView.addDependent(dlg);

      const fiForn = new ViewSettingsFilterItem({ text: "Fornecedor", key: "supplierName" });
      this._getDistinct("supplierName").forEach((val) => {
        const it = new ViewSettingsItem({ text: val, key: `supplierName___EQ___${val}` });
        if (this._prefs.filter.fornecedor?.includes(val)) it.setSelected(true);
        fiForn.addItem(it);
      });
      dlg.addFilterItem(fiForn);

      const fiNome = new ViewSettingsFilterItem({ text: "Nome do item", key: "materialDesc" });
      this._getDistinct("materialDesc").forEach((val) => {
        const it = new ViewSettingsItem({ text: val, key: `materialDesc___EQ___${val}` });
        if (this._prefs.filter.nomeItem?.includes(val)) it.setSelected(true);
        fiNome.addItem(it);
      });
      dlg.addFilterItem(fiNome);

      return dlg;
    },

    /* ========= GROUP (internos) ========= */
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

    /* ========= SORT (internos) ========= */
    _openSortDialog() {
      const oView = this.getView();
      if (!this._oSortDialog) {
        this._oSortDialog = new ViewSettingsDialog({
          confirm: this.handleSortDialogConfirm.bind(this)
        });
        if (Device.system.desktop) this._oSortDialog.addStyleClass("sapUiSizeCompact");
        oView.addDependent(this._oSortDialog);
      }

      this._oSortDialog.destroySortItems();
      [
        { text: "Fornecedor", key: "supplierName" },
        { text: "Nome do item", key: "materialDesc" },
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
    }

  });
});
