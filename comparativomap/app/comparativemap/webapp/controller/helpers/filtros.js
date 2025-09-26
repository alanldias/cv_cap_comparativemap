sap.ui.define([
  "sap/ui/mdc/condition/ConditionModel",
  "sap/ui/mdc/FilterField",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/m/Dialog",
  "sap/m/List",
  "sap/m/StandardListItem",
  "sap/m/Button",
  "sap/m/VariantItem",
  "sap/m/MessageToast",
  "sap/ui/core/Fragment"
], function (
  ConditionModel,
  FilterField,
  Filter,
  FilterOperator,
  Dialog,
  List,
  StandardListItem,
  Button,
  VariantItem,
  MessageToast,
  Fragment
) {
  "use strict";

  const VARIANTS_KEY = "comparativemap.variants";

  // -------------------------
  // Campos do QuoteRow
  // -------------------------
  const FIELDS = [
    // String-like
    { key: "poItem",                       label: "PO Item",                   dataType: "sap.ui.model.type.String" },
    { key: "ItemId",                       label: "ItemId",                    dataType: "sap.ui.model.type.String" },
    { key: "itemDescription",              label: "Descrição",                 dataType: "sap.ui.model.type.String" },
    { key: "unitOfMeasure",                label: "Unidade",                   dataType: "sap.ui.model.type.String" },
    { key: "currency",                     label: "Moeda",                     dataType: "sap.ui.model.type.String" },
    { key: "ncm",                          label: "NCM",                       dataType: "sap.ui.model.type.String" },
    { key: "Extrinsic_Origem_do_Material", label: "Origem Material",           dataType: "sap.ui.model.type.String" },
    { key: "PLANT",                        label: "Centro",                    dataType: "sap.ui.model.type.String" },
    { key: "ItemCategory",                 label: "Categoria do Item",         dataType: "sap.ui.model.type.String" },
    { key: "MaterialCode",                 label: "Código Material",           dataType: "sap.ui.model.type.String" },
    { key: "grupo_de_materias",            label: "Grupo de Materiais",        dataType: "sap.ui.model.type.String" },
    { key: "supplierName",                 label: "Fornecedor",                dataType: "sap.ui.model.type.String" },
    { key: "invitationId",                 label: "Invitation ID",             dataType: "sap.ui.model.type.String" },
    { key: "invitationEmail",              label: "Invitation Email",          dataType: "sap.ui.model.type.String" },
    { key: "DELIVERY_DATE_RAW",            label: "Data Entrega (raw)",        dataType: "sap.ui.model.type.String" },
    // Numéricos
    { key: "quantity",                     label: "Quantidade",                dataType: "sap.ui.model.type.Float" },
    { key: "price",                        label: "Preço",                     dataType: "sap.ui.model.type.Float" },
    { key: "mva",                          label: "MVA",                       dataType: "sap.ui.model.type.Float" },
    { key: "Extrinsic_Aliquota_ICMS",      label: "Alíquota ICMS",             dataType: "sap.ui.model.type.Float" },
    { key: "Extrinsic_ICMS_Apurado",       label: "ICMS Apurado",              dataType: "sap.ui.model.type.Float" },
    { key: "Extrinsic_Aliquota_IPI",       label: "Alíquota IPI",              dataType: "sap.ui.model.type.Float" },
    { key: "Extrinsic_IPI_Apurado",        label: "IPI Apurado",               dataType: "sap.ui.model.type.Float" },
    { key: "Extrinsic_Aliquota_PIS",       label: "Alíquota PIS",              dataType: "sap.ui.model.type.Float" },
    { key: "Extrinsic_PIS_Apurado",        label: "PIS Apurado",               dataType: "sap.ui.model.type.Float" },
    { key: "Extrinsic_Aliquota_Cofins",    label: "Alíquota COFINS",           dataType: "sap.ui.model.type.Float" },
    { key: "Extrinsic_Cofins_apurado",     label: "COFINS Apurado",            dataType: "sap.ui.model.type.Float" },
    { key: "Extrinsic_Aliquota_ICMS_Interna", label: "Alíquota ICMS Interna",  dataType: "sap.ui.model.type.Float" },
    { key: "EXTENDEDPRICE",                label: "Preço Estendido",           dataType: "sap.ui.model.type.Float" },
    // { key: "itemId",                       label: "itemId (novo)",             dataType: "sap.ui.model.type.Integer" }
  ];

  const FO_MAP = {
    EQ: FilterOperator.EQ, BT: FilterOperator.BT,
    GE: FilterOperator.GE, LE: FilterOperator.LE,
    GT: FilterOperator.GT, LT: FilterOperator.LT,
    Contains: FilterOperator.Contains,
    StartsWith: FilterOperator.StartsWith,
    EndsWith: FilterOperator.EndsWith
  };

  // -------------------------
  // Utils
  // -------------------------
  function _conditionsToFilters(conds) {
    const filters = [];
    Object.keys(conds || {}).forEach((field) => {
      (conds[field] || []).forEach((c) => {
        const op = FO_MAP[c.operator] || FilterOperator.EQ;
        if (op === FilterOperator.BT) {
          filters.push(new Filter(field, op, c.values?.[0], c.values?.[1]));
        } else {
          filters.push(new Filter(field, op, c.values?.[0]));
        }
      });
    });
    return filters;
  }

  function _activeFiltersText(conds) {
    const parts = [];
    FIELDS.forEach((f) => {
      const arr = conds[f.key];
      if (arr && arr.length) {
        const txt = arr.map((c) => {
          if (c.operator === "BT") return `${f.label} entre ${c.values[0]} e ${c.values[1]}`;
          return `${f.label} ${c.operator} ${c.values[0]}`;
        }).join("; ");
        parts.push(txt);
      }
    });
    return parts.join(" • ");
  }

  function _readStore() {
    try { return JSON.parse(localStorage.getItem(VARIANTS_KEY) || "[]"); }
    catch (e) { return []; }
  }
  function _writeStore(arr) {
    localStorage.setItem(VARIANTS_KEY, JSON.stringify(arr || []));
  }

  function _createFilterField(f) {
    return new FilterField({
      label: f.label,
      dataType: f.dataType,
      maxConditions: -1,
      conditions: "{cm>/conditions/" + f.key + "}"
    });
  }

  // VariantManagement finder (vmg, vmg123 ou o do fragment)
  function _getVM(ctrl) {
    const view = ctrl.getView();
    return view.byId("vmg") || view.byId("vmg123") || view.byId("dlgFilters--vmg") || null;
  }

  function _loadVariantItems(ctrl) {
    const vmg = _getVM(ctrl);
    if (!vmg) return;

    if (typeof vmg.destroyItems === "function") {
      vmg.destroyItems();
    } else if (typeof vmg.destroyVariantItems === "function") {
      vmg.destroyVariantItems();
    }

    const store = _readStore();
    store.forEach((v) => {
      const item = new VariantItem({ key: v.key, text: v.name });
      if (typeof vmg.addItem === "function") vmg.addItem(item);
      else if (typeof vmg.addVariantItem === "function") vmg.addVariantItem(item);
    });
  }

  function _ensureCm(ctrl) {
    const view = ctrl.getView();
    if (!view.getModel("cm")) {
      view.setModel(new ConditionModel(), "cm");
    }
  }

  function _ensureFilterBarBuilt(ctrl) {
    const view = ctrl.getView();
    const fb = view.byId("fb"); // do fragment
    if (!fb) return;
    if (fb.getFilterItems && fb.getFilterItems().length > 0) return; // evita duplicar
    FIELDS.forEach((f) => fb.addFilterItem(_createFilterField(f)));
  }

  // -------------------------
  // API
  // -------------------------
  return {
    /** Chame no onInit do controller principal */
    init(ctrl) {
      _ensureCm(ctrl);
      _loadVariantItems(ctrl); // popula o vmg/vmg123 já na entrada
    },

    /** Abre o diálogo de filtros (Fragment) */
    async openDialog(ctrl) {
      const view = ctrl.getView();

      if (!ctrl._filterDlg) {
        ctrl._filterDlg = await Fragment.load({
          name: "comparativemap.comparativemap.view.fragments.FilterDialog",
          controller: ctrl,
          id: view.getId()
        });
        view.addDependent(ctrl._filterDlg);
      }

      _ensureCm(ctrl);
      _ensureFilterBarBuilt(ctrl);
      _loadVariantItems(ctrl); // garante itens no VariantManagement do fragment (se houver)
      ctrl._filterDlg.open();
    },

    /** Fecha o diálogo de filtros */
    closeDialog(ctrl) {
      ctrl._filterDlg?.close();
    },

    /** Limpa somente as condições do MDC + esconde o resumo */
    clearConditions(ctrl) {
      const view = ctrl.getView();
      view.getModel("cm")?.removeAllConditions();
      view.byId("vsdFilterLabel")?.setText("");
      view.byId("vsdFilterBar")?.setVisible(false);
    },

    /** Aplica filtros na tabela e fecha o diálogo */
    onFilterSearch(ctrl) {
      const view = ctrl.getView();
      const cm = view.getModel("cm");
      const allConds = cm.getAllConditions();

      const filters = _conditionsToFilters(allConds);
      view.byId("tblDocs")?.getBinding("items")?.filter(filters, "Application");

      const txt = _activeFiltersText(allConds);
      view.byId("vsdFilterLabel")?.setText(txt || "Sem filtros");
      view.byId("vsdFilterBar")?.setVisible(!!txt);

      MessageToast.show("Filtros aplicados");
      this.closeDialog(ctrl);
    },

    /** Diálogo simples de seleção de colunas (e atualiza a visão selecionada, se houver) */
    onOpenColumnsDialog(ctrl) {
      if (ctrl._colDlg) { ctrl._colDlg.open(); return; }

      const view = ctrl.getView();
      const tbl = view.byId("tblDocs");
      const cols = tbl.getColumns();

      const list = new List({ mode: "MultiSelect" });
      cols.forEach((c) => {
        const headerText = c.getHeader()?.getText ? c.getHeader().getText() : c.getId();
        const item = new StandardListItem({
          title: headerText,
          selected: c.getVisible(),
          info: c.getId()
        });
        list.addItem(item);
      });

      ctrl._colDlg = new Dialog({
        title: "Selecionar colunas",
        contentWidth: "25rem",
        contentHeight: "30rem",
        content: [list],
        buttons: [
          new Button({ text: "Cancelar", press: () => ctrl._colDlg.close() }),
          new Button({
            text: "Aplicar",
            type: "Emphasized",
            press: () => {
              const selectedIds = list.getSelectedItems().map((it) => it.getInfo());
              cols.forEach((c) => c.setVisible(selectedIds.includes(c.getId())));
              ctrl._colDlg.close();
              MessageToast.show("Colunas atualizadas");

              // Persistir na visão selecionada (se houver)
              const vmg = _getVM(ctrl);
              const selectedKey = vmg?.getSelectedKey?.();
              if (selectedKey) {
                const store = _readStore();
                const v = store.find(s => s.key === selectedKey);
                if (v) {
                  const newCols = {};
                  tbl.getColumns().forEach((c) => { newCols[c.getId()] = c.getVisible(); });
                  v.columns = newCols;
                  _writeStore(store);
                }
              }
            }
          })
        ]
      });

      view.addDependent(ctrl._colDlg);
      ctrl._colDlg.open();
    },

    /** Salvar visão (conditions + colunas) em localStorage */
    onVariantSave(ctrl) {
      const view = ctrl.getView();
      const name = prompt("Nome da visão:");
      if (!name) return;

      const cm = view.getModel("cm");
      const conditions = cm.getAllConditions();

      const tbl = view.byId("tblDocs");
      const cols = {};
      tbl.getColumns().forEach((c) => { cols[c.getId()] = c.getVisible(); });

      const variant = { key: "v_" + Date.now(), name, conditions, columns: cols };

      const store = _readStore();
      store.push(variant);
      _writeStore(store);

      _loadVariantItems(ctrl);

      const vmg = _getVM(ctrl);
      if (vmg?.setSelectedKey) vmg.setSelectedKey(variant.key);

      MessageToast.show("Visão salva");
    },

    /** Aplicar visão selecionada */
    onVariantSelect(ctrl, oEvent) {
      const key = oEvent.getParameter("key") || oEvent.getParameter("variantItem")?.getKey?.();
      if (!key) return;

      const store = _readStore();
      const v = store.find((x) => x.key === key);
      if (!v) return;

      const view = ctrl.getView();
      const cm = view.getModel("cm");
      cm.removeAllConditions();
      cm.setAllConditions(v.conditions);

      const tbl = view.byId("tblDocs");
      tbl.getColumns().forEach((c) => {
        if (Object.prototype.hasOwnProperty.call(v.columns, c.getId())) {
          c.setVisible(!!v.columns[c.getId()]);
        }
      });

      this.onFilterSearch(ctrl);
      MessageToast.show("Visão aplicada: " + v.name);
    },

    /** Gerenciar / excluir visão */
    onVariantManage(ctrl) {
      const store = _readStore();
      const names = store.map((v, i) => `${i + 1}) ${v.name} [${v.key}]`).join("\n");
      const toDel = prompt("Excluir qual visão?\n" + names + "\nInforme a KEY exata (ou cancele)");
      if (!toDel) return;

      const after = store.filter((v) => v.key !== toDel);
      _writeStore(after);
      _loadVariantItems(ctrl);
      MessageToast.show("Visão removida (se existia)");
    },

    /** Reset geral (limpa MDC e filtros aplicados na tabela) */
    reset(ctrl) {
      const view = ctrl.getView();
      const cm = view.getModel("cm");
      if (cm) cm.removeAllConditions();

      view.byId("vsdFilterLabel")?.setText("");
      view.byId("vsdFilterBar")?.setVisible(false);

      const binding = view.byId("tblDocs")?.getBinding("items");
      binding?.filter([], "Application");
    }
  };
});
