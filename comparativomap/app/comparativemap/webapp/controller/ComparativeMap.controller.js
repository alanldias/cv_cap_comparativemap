sap.ui.define([
  "sap/ui/core/mvc/Controller","sap/ui/model/Sorter","sap/ui/model/Filter","sap/ui/model/FilterOperator",
  "comparativemap/comparativemap/model/models",
  "comparativemap/comparativemap/controller/prefs/PrefsStore",
  "comparativemap/comparativemap/controller/components/ViewSettings",
  "comparativemap/comparativemap/controller/services/ODataService",
  "comparativemap/comparativemap/controller/services/SimulationMapper",
  "comparativemap/comparativemap/controller/services/Dialogs",
  "comparativemap/comparativemap/controller/services/AwardService",
  "comparativemap/comparativemap/controller/helpers/KeyUtils",
  "comparativemap/comparativemap/controller/helpers/Debug",
  "comparativemap/comparativemap/controller/helpers/Formatters",
  "sap/m/MessageToast","sap/m/MessageBox","sap/ui/Device"
], function (
  Controller, Sorter, Filter, FilterOperator,
  Models, PrefsStore, ViewSettingsCmp, ODataSvc, Map, Dialogs, AwardSvc, Keys, Debug, Fmt,
  MessageToast, MessageBox, Device
) {
  "use strict";

  return Controller.extend("comparativemap.comparativemap.controller.ComparativeMap", {
    formatter: Fmt,

    onInit() {
      this.getView().setModel(Models.createVM(), "vm");
      this.getView().setModel(Models.createQM(), "qm");

      this._prefs = PrefsStore.load();
      this.mGroupFunctions = {
        supplierName: (ctx) => { const v = ctx.getProperty("supplierName") || ""; return { key:v, text:v }; },
        arb_PurchasingOrganization: (ctx) => { const v = ctx.getProperty("arb_PurchasingOrganization") || ""; return { key:v, text:"Org. Compras " + v }; },
        arb_CompanyCode: (ctx) => { const v = ctx.getProperty("arb_CompanyCode") || ""; return { key:v, text:"Empresa " + v }; }
      };

      this._vs = ViewSettingsCmp.create(this.getView(), this._prefs, this._getDistinct.bind(this), this.mGroupFunctions);
      this._vs.applyFiltersFromPrefs();
      this._vs.applyGroupSortFromPrefs();
    },

    /* ====== BUSCAR ====== */
    async onBuscar() {
      const view = this.getView();
      const vm = view.getModel("vm");
      const docId = (view.byId("inputDoID").getValue() || "").trim();
      const tbl = view.byId("tblDocs");
      try {
        if (!docId) { MessageToast.show("Informe o Doc ID"); return; }
        tbl.setBusy(true);
        const res = await ODataSvc.fetchQuotes(view, docId);

        const rows = (Array.isArray(res?.items) ? res.items : []).map(r => Object.assign({}, r, { _originalQty: Number(r.quantity) || 0 }));
        vm.setProperty("/header", res?.header || {});
        vm.setProperty("/rows", rows);
        vm.setProperty("/headerRows", res?.header ? [res.header] : []);
        view.byId("tblDocs").getBinding("items")?.refresh(true);
        if (!rows.length) MessageToast.show("Nenhum item retornado para esse Doc ID.");
      } catch(e) {
        /* eslint-disable no-console */ console.error("[onBuscar] ERRO:", e);
        MessageBox.error("Falha ao buscar dados: " + (e.message || e));
      } finally { tbl.setBusy(false); }
    },

    onQtyInlineChange(ev) {
      const ctx = ev.getSource()?.getBindingContext("vm");
      if (!ctx) return;
      const row = ctx.getObject() || {};
      const max = Number(row._originalQty) || 0;
      let v = Number(row.quantity);
      if (isNaN(v) || v < 0) v = 0;
      if (max && v > max) v = max;
      row.quantity = Math.floor(v);
      ctx.getModel().checkUpdate(true);
    },

    onCloseDialog(ev){ Dialogs.closeAny(this, ev); },

    /* ====== SIMULAR ====== */
    async onSimularPress() {
      const view = this.getView();
      const vm = view.getModel("vm");
      const qm = view.getModel("qm");

      // limpar res anterior
      (view.getModel("res") || view.getModel("vm")).setData({ rows: [] });

      console.groupCollapsed("[SIMULAR] clique");
      try {
        const headerRaw = Map.getHeaderFromVM(vm); Debug.dbg("Header bruto (vm>/headerRows[0] ou vm>/header)", headerRaw);

        const tbl = this.byId("tblDocs");
        if (!tbl) throw new Error("Tabela 'tblDocs' não encontrada.");
        const selectedCtx = tbl.getSelectedContexts("vm");
        if (!selectedCtx.length) throw new Error("Selecione pelo menos 1 item para simular.");
        const rows = selectedCtx.map(c => c.getObject());
        Debug.dbg(`Linhas selecionadas (count=${rows.length})`, rows);

        qm.setProperty("/simSourceRows", rows);
        Map.prepareQMFromSelection(rows, qm);

        const header = Map.mapHeaderFromAriba(headerRaw, rows[0]);
        const items = rows.map((r, idx) => Map.mapRowToPOItem(r, idx));
        const schedules = rows.map((r, i) => ({ poItem: items[i].poItem, schedLine:1, deliveryDate: Map.getDeliveryDateFromRow(r), quantity: items[i].quantity }));

        const missing = [];
        if (!header.docType) missing.push("Tipo de Pedido (docType)");
        if (!header.compCode) missing.push("Empresa (compCode)");
        if (!header.purchOrg) missing.push("Org. de Compras (purchOrg)");
        if (!header.purchGroup) missing.push("Grupo de Compras (purchGroup)");
        if (!header.vendor) missing.push("Fornecedor (vendor/LIFNR)");
        if (!header.currency) missing.push("Moeda (currency)");
        const missingItems = [];
        items.forEach((it, i) => {
          const tag = `Item ${String((i+1)*10).padStart(5,"0")}`;
          if (!it.plant) missingItems.push(`${tag}: Centro (plant)`);
          if (!it.unit) missingItems.push(`${tag}: Unidade (unit)`);
          if (!it.quantity || it.quantity <= 0) missingItems.push(`${tag}: Quantidade (quantity)`);
          if (!it.material && !it.shortText) missingItems.push(`${tag}: MATERIAL ou SHORT_TEXT`);
        });
        if (missing.length || missingItems.length) {
          const msg = [
            missing.length ? "Cabeçalho faltando:\n- " + missing.join("\n- ") : "",
            missingItems.length ? "Itens faltando:\n- " + missingItems.join("\n- ") : ""
          ].filter(Boolean).join("\n\n");
          throw new Error(msg);
        }

        const requests = [{ header, items, schedules, testRun:true }];

        sap.ui.core.BusyIndicator.show(0);
        const result0 = await ODataSvc.simularPO(view, requests, 4);
        Debug.dbg("Resultado bruto da BAPI (result0)", result0);

        const resRows = Map.buildResRowsFromBapiResult(result0, qm);
        Dialogs.openResultDialog(view, resRows, this);

        this.byId("tblDocs").removeSelections(true);

        const allMsgs = result0?.returnMessages || result0?.mensagens || [];
        Dialogs.showBapiMessages(allMsgs);

        console.groupEnd();
      } catch(err) {
        console.error("[SIMULAR] ERRO:", err); console.groupEnd();
        sap.m.MessageBox.error(err.message || String(err));
      } finally {
        sap.ui.core.BusyIndicator.hide();
      }
    },

    /* ====== PREMIAÇÃO ====== */
    onAwardQtyChangeRes(ev) {
      const input = ev.getSource();
      const ctx = input.getBindingContext("res");
      const obj = ctx?.getObject() || {};
      let v = Number(input.getValue()); if (isNaN(v) || v < 0) v = 0;
      const max = Number(obj.originalQty) || 0;
      if (v > max) v = max;
      obj.qtyAward = Math.floor(v);
      ctx.getModel().checkUpdate(true);
      input.setValue(String(obj.qtyAward));
    },

    async onAwardDirect() {
      const view = this.getView();
      const oModel = view.getModel();
      const vm = view.getModel("vm");

      const tbl = this._dlgRes?.getContent?.()[0];
      const selected = tbl?.getSelectedContexts("res").map(c => c.getObject()) || [];
      if (!selected.length) { sap.m.MessageToast.show("Selecione ao menos uma linha para premiar."); return; }

      const allRows = vm?.getProperty("/rows") || [];
      const supplierBids = AwardSvc.validarEMontarPayload(allRows, selected, this._ensureInvitationResourceId.bind(this));
      if (!supplierBids) return;

      const sEventId = vm.getProperty("/header/docId") || view.getModel("res")?.getProperty("/header/docId");
      if (!sEventId) { sap.m.MessageBox.error("DocID do evento não encontrado no header."); return; }

      sap.ui.core.BusyIndicator.show(0);
      try {
        const out = await ODataSvc.createScenario(view, {
          eventId: sEventId,
          title: "Premiação via UI (direto)",
          scenarioType: 0,
          supplierBids
        });
        sap.ui.core.BusyIndicator.hide();
        if (out?.success) {
          sap.m.MessageBox.success(`Cenário criado com sucesso!\nScenario ID: ${out.scenarioId || "(n/a)"}\nCorrelation-ID: ${out.correlationId || "(n/a)"}`);
          this._dlgRes?.close();
        } else {
          sap.m.MessageBox.warning("CreateScenario executou, porém sem success=true.");
        }
      } catch(e) {
        sap.ui.core.BusyIndicator.hide();
        const msg = e?.message || "Falha ao criar cenário.";
        sap.m.MessageBox.error(msg);
      }
    },

    /* ====== ViewSettings delegações ====== */
    handleFilterButtonPressed(){ this._vs.openFilterDialog(ev => this._vs.handleFilterDialogConfirm(ev, (p)=>{ this._prefs=p; PrefsStore.save(p); })); },
    handleSortButtonPressed(){ this._vs.openSortDialog(ev => this._vs.handleSortDialogConfirm(ev, (p)=>{ this._prefs=p; PrefsStore.save(p); })); },
    handleGroupButtonPressed(){ this._vs.openGroupDialog(
      ev => this._vs.handleGroupDialogConfirm(ev, (p)=>{ this._prefs=p; PrefsStore.save(p); }),
      () => {}); },

    onFilterSelectAllFornecedor(){ this._prefs.filter.fornecedor = this._getDistinct("supplierName"); PrefsStore.save(this._prefs); this._vs.applyFiltersFromPrefs(); sap.m.MessageToast.show("Fornecedor: selecionado tudo."); },
    onFilterClearFornecedor(){ this._prefs.filter.fornecedor = []; PrefsStore.save(this._prefs); this._vs.applyFiltersFromPrefs(); sap.m.MessageToast.show("Fornecedor: seleção limpa."); },
    onFilterSelectAllNomeItem(){ this._prefs.filter.nomeItem = this._getDistinct("itemDescription"); PrefsStore.save(this._prefs); this._vs.applyFiltersFromPrefs(); sap.m.MessageToast.show("Nome do item: selecionado tudo."); },
    onFilterClearNomeItem(){ this._prefs.filter.nomeItem = []; PrefsStore.save(this._prefs); this._vs.applyFiltersFromPrefs(); sap.m.MessageToast.show("Nome do item: seleção limpa."); },

    /* ====== Helpers “de ponte” ====== */
    _getDistinct(path) {
      const rows = this.getView().getModel("vm").getProperty("/rows") || [];
      const set = new Set();
      rows.forEach(r => { const v = r[path]; if (v !== undefined && v !== null && v !== "") set.add(String(v)); });
      return Array.from(set).sort((a,b)=>a.localeCompare(b,"pt-BR"));
    },

    _ensureInvitationResourceId(invId, email) {
      if (!invId) return null;
      const s = String(invId);
      if (s.includes("_")) return s;
      if (email) return `${s}_${String(email)}`;
      return s;
    },

    onExit() {
      if (this._dlgRes) { this._dlgRes.destroy(true); this._dlgRes=null; }
    }
  });
});
