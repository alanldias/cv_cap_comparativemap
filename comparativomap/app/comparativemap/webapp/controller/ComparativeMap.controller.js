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
    /* ========= Setup ========= */
    onInit() {
      const vm = new JSONModel({ rows: [] });
      this.getView().setModel(vm, "vm");

      this._oFilterDialog = null;
      this._oSortDialog = null;
      this._oGroupDialog = null;
      this._groupReset = false;

      this._storage = new Storage(Storage.Type.local, "comparativemap");
      this._prefsKey = "tblDocs-prefs";
      this._prefs = this._loadPrefs(); // { filter:{fornecedor:[], nomeItem:[]}, sort:{key,desc}, group:{key,desc} }

      this.mGroupFunctions = {
        fornecedor: (oCtx) => {
          const v = oCtx.getProperty("fornecedor") || "";
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

    /* ========= Persistência ========= */
    _loadPrefs() {
      try {
        const raw = this._storage.get(this._prefsKey);
        if (raw) return JSON.parse(raw);
      } catch (e) {}
      return {
        filter: { fornecedor: [], nomeItem: [] },
        sort: { key: null, desc: false },
        group: { key: null, desc: false }
      };
    },
    _savePrefs() {
      this._storage.put(this._prefsKey, JSON.stringify(this._prefs));
    },

    /* ========= Helpers ========= */
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
              (v) => new Filter("fornecedor", FilterOperator.EQ, v)
            )
          })
        );
      }
      if (this._prefs.filter.nomeItem?.length) {
        fGroups.push(
          new Filter({
            and: false,
            filters: this._prefs.filter.nomeItem.map(
              (v) => new Filter("nomeItem", FilterOperator.EQ, v)
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

    /* ========= FILTER ========= */
    handleFilterButtonPressed() { this._openFilterDialog(); },

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

      const fiForn = new ViewSettingsFilterItem({ text: "Fornecedor", key: "fornecedor" });
      this._getDistinct("fornecedor").forEach((val) => {
        const it = new ViewSettingsItem({ text: val, key: `fornecedor___EQ___${val}` });
        if (this._prefs.filter.fornecedor?.includes(val)) it.setSelected(true);
        fiForn.addItem(it);
      });
      dlg.addFilterItem(fiForn);

      const fiNome = new ViewSettingsFilterItem({ text: "Nome do item", key: "nomeItem" });
      this._getDistinct("nomeItem").forEach((val) => {
        const it = new ViewSettingsItem({ text: val, key: `nomeItem___EQ___${val}` });
        if (this._prefs.filter.nomeItem?.includes(val)) it.setSelected(true);
        fiNome.addItem(it);
      });
      dlg.addFilterItem(fiNome);

      return dlg;
    },
    handleFilterDialogConfirm(oEvent) {
      const selected = oEvent.getParameters().filterItems || [];
      const grouped = {}; // { fornecedor:[Filter...], nomeItem:[Filter...] }
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

      this._prefs.filter.fornecedor = (grouped.fornecedor || []).map((f) => String(f.oValue1));
      this._prefs.filter.nomeItem   = (grouped.nomeItem   || []).map((f) => String(f.oValue1));
      this._savePrefs();
      this._applyFiltersFromPrefs();
    },
    onFilterSelectAllFornecedor() {
      this._prefs.filter.fornecedor = this._getDistinct("fornecedor");
      this._savePrefs(); this._applyFiltersFromPrefs();
      MessageToast.show("Fornecedor: selecionado tudo.");
    },
    onFilterClearFornecedor() {
      this._prefs.filter.fornecedor = [];
      this._savePrefs(); this._applyFiltersFromPrefs();
      MessageToast.show("Fornecedor: seleção limpa.");
    },
    onFilterSelectAllNomeItem() {
      this._prefs.filter.nomeItem = this._getDistinct("nomeItem");
      this._savePrefs(); this._applyFiltersFromPrefs();
      MessageToast.show("Nome do item: selecionado tudo.");
    },
    onFilterClearNomeItem() {
      this._prefs.filter.nomeItem = [];
      this._savePrefs(); this._applyFiltersFromPrefs();
      MessageToast.show("Nome do item: seleção limpa.");
    },

    /* ========= SORT ========= */
    handleSortButtonPressed() { this._openSortDialog(); },

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
        { text: "Fornecedor", key: "fornecedor" },
        { text: "Nome do item", key: "nomeItem" },
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

    /* ========= GROUP ========= */
    handleGroupButtonPressed() { this._openGroupDialog(); },

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
        { text: "Fornecedor", key: "fornecedor" },
        { text: "Org. Compras", key: "arb_PurchasingOrganization" },
        { text: "Empresa", key: "arb_CompanyCode" }
      ].forEach((g) => this._oGroupDialog.addGroupItem(new ViewSettingsItem(g)));

      if (this._prefs.group.key) {
        this._oGroupDialog.setSelectedGroupItem(this._prefs.group.key);
        this._oGroupDialog.setGroupDescending(!!this._prefs.group.desc);
      }

      this._oGroupDialog.open();
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

     async onBuscar() {
      const oView = this.getView();
      const oOData = oView.getModel(); // default OData V4
      const oVM = oView.getModel("vm");
      const docId = oView.byId("inputDoID").getValue();

      try {
        if (!oOData) throw new Error("Modelo OData V4 não encontrado (verifique o manifest).");

        const oCtx = oOData.bindContext("/GetQuotes(...)");
        if (docId) oCtx.setParameter("docId", docId);

        await oCtx.execute();

        const resultRaw = oCtx.getBoundContext().getObject();
        const list = Array.isArray(resultRaw) ? resultRaw : (resultRaw?.value || []);

        oVM.setProperty("/rows", list);

        // Agrupar por fornecedor
        const oTbl = oView.byId("tblDocs");
        const oBinding = oTbl?.getBinding("items");
        if (oBinding) {
          const sorter = new Sorter("supplierName", false);
          sorter.group = (ctx2) => {
            const name = ctx2.getProperty("supplierName") || "";
            return { key: name, text: name };
          };
          oBinding.sort(sorter);

          if (typeof oTbl.setGroupHeaderFactory === "function") {
            oTbl.setGroupHeaderFactory((g) =>
              new sap.m.GroupHeaderListItem({ title: g.text, upperCase: false })
            );
          }
        }
      } catch (e) {
        MessageBox.error("Falha ao buscar dados: " + (e.message || e));
      }
    },

    async onSimularCompra() {
      const oView = this.getView();
      const oModel = oView.getModel();     // OData V4
      const oTbl = this.byId("tblDocs");

      // 🔹 Coleta TODAS as linhas selecionadas do modelo "vm"
      const selCtx = oTbl.getSelectedContexts("vm") || [];
      const selecionados = selCtx.map(c => c.getObject());
      if (!selecionados.length) {
        sap.m.MessageBox.warning("Selecione ao menos uma linha.");
        return;
      }

      sap.ui.core.BusyIndicator.show(0);
      try {
        // Helper: executa a operação para UMA linha selecionada
        const runOne = async (row) => {
          const { docId, lineNumber, supplierId } = row;
          if (!docId) throw new Error("Linha sem Doc ID.");

          const ctx = oModel.bindContext("/GetQuotes(...)");
          ctx.setParameter("docId", docId);

          // Se a operation aceitar, enviamos parâmetros de item
          if (lineNumber != null) ctx.setParameter("lineNumber", lineNumber);
          if (supplierId) ctx.setParameter("supplierId", supplierId);

          await ctx.execute();

          // Normaliza retorno
          let data = ctx.getBoundContext().getObject();
          let arr = Array.isArray(data) ? data : (data?.value || (data ? [data] : []));

          // Filtro no cliente para manter APENAS o item daquela linha
          arr = arr.filter(it =>
            it.docId === docId &&
            (lineNumber == null || it.lineNumber === lineNumber) &&
            (!supplierId || it.supplierId === supplierId)
          );

          // Marcas auxiliares p/ exibir no fragment
          return arr.map(it => ({
            __docId: docId,
            __lineNumber: lineNumber,
            __supplierId: supplierId,
            ...it
          }));
        };

        // Executa todas as simulações em paralelo
        const settled = await Promise.allSettled(selecionados.map(runOne));
        const okRows = settled.filter(s => s.status === "fulfilled").flatMap(s => s.value);
        const fails = settled.filter(s => s.status === "rejected");

        if (!okRows.length) throw new Error("Nenhum resultado retornado para as seleções.");

        const docIds = [...new Set(selecionados.map(r => r.docId).filter(Boolean))];
        await this._openSimFragment(okRows, docIds);

        if (fails.length) {
          sap.m.MessageToast.show(`${fails.length} item(ns) falharam na simulação.`);
        }
      } catch (e) {
        const msg = e?.message || e?.cause?.message || e?.cause?.error?.message || String(e);
        sap.m.MessageBox.error("Falha ao simular: " + msg);
      } finally {
        sap.ui.core.BusyIndicator.hide();
      }
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

    onCloseSimulacao: function () {
      this._oSimDialog?.close();
      this._oSimDialog?.destroy();
      this._oSimDialog = null;
    }
  });
});
