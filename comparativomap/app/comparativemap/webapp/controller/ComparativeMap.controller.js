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
      if (!this.getView().getModel("vm")) {
        this.getView().setModel(new JSONModel({ rows: [], headerRows: [] }), "vm");
      }

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
      const oView  = this.getView();
      const oOData = oView.getModel();          // default OData V4 do manifest
      const oVM    = oView.getModel("vm");
      const docId  = (oView.byId("inputDoID").getValue() || "").trim();
      const tbl    = oView.byId("tblDocs");

      try {
        if (!oOData) throw new Error("Modelo OData V4 não encontrado (verifique o manifest).");
        if (!docId)  { MessageToast.show("Informe o Doc ID"); return; }

        tbl.setBusy(true);

        // Chama a function/action import via OData V4
        const oCtx = oOData.bindContext("/GetQuotes(...)");
        oCtx.setParameter("docId", docId);
        await oCtx.execute();

        // ⚠️ Em OData V4 o retorno pode vir como array direto, ou dentro de value / $Return
        const opResult = await oCtx.getBoundContext().requestObject();
        let list = [];
        if (Array.isArray(opResult)) list = opResult;
        else if (Array.isArray(opResult?.value)) list = opResult.value;
        else if (Array.isArray(opResult?.$Return)) list = opResult.$Return;
        else if (opResult) list = [opResult];

        // Se quiser ver no console:
        console.log("GetQuotes ->", list);

        // Preenche a tabela (vm>/rows) — seu XML já está mapeado pra esses nomes
        oVM.setProperty("/rows", list);

        // (opcional) header de cima: usa só o doc digitado
        oVM.setProperty("/headerRows", [{
          docId,
          arb_Document_Type: "",            // preencha se tiver esses dados
          arb_PurchasingOrganization: "",
          arb_PurchasingGroup: "",
          arb_CompanyCode: "",
          INCOTERMS1: "",
          INCOTERMS2: "",
          arb_PaymentTerms: ""
        }]);

        // Evite filtrar por docId nos itens: o objeto de itens NÃO tem docId.
        // Se você quiser aplicar algum filtro inicial, comente a linha abaixo:
        // this._filterItemsByDoc(docId);  // <- remova/ajuste se esse método filtra por vm>docId

        // (opcional) força atualização da tabela
        oView.byId("tblDocs").getBinding("items")?.refresh(true);

        if (!list.length) MessageToast.show("Nenhum item retornado para esse Doc ID.");

      } catch (e) {
        console.error(e);
        MessageBox.error("Falha ao buscar dados: " + (e.message || e));
      } finally {
        tbl.setBusy(false);
      }
    },

    onHeaderSelect(e) {
      const item = e.getParameter("listItem");
      const ctx = item?.getBindingContext("vm");
      const docId = ctx?.getProperty("docId");
      this._filterItemsByDoc(docId);
    },

    async onSimularCompra() {
      const oView = this.getView();
      const oModel = oView.getModel();     // OData V4
      const oTbl = this.byId("tblDocs");

      // 🔹 Coleta TODAS as linhas selecionadas do modelo "vm"
      const selCtx = oTbl.getSelectedContexts("vm") || [];
      const selecionados = selCtx.map(c => c.getObject());
      if (!selecionados.length) {
        MessageBox.warning("Selecione ao menos uma linha.");
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
          MessageToast.show(`${fails.length} item(ns) falharam na simulação.`);
        }
      } catch (e) {
        const msg = e?.message || e?.cause?.message || e?.cause?.error?.message || String(e);
        MessageBox.error("Falha ao simular: " + msg);
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
