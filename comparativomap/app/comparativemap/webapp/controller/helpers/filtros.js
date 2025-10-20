sap.ui.define([
  "sap/ui/mdc/condition/ConditionModel",
  "sap/ui/mdc/FilterField",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/m/Dialog",
  "sap/m/List",
  "sap/m/StandardListItem",
  "sap/m/Button",
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
  MessageToast,
  Fragment
) {
  "use strict";

  // -------------------------
  // Campos do QuoteRow
  // -------------------------
  const FIELDS = [
    // String-like
    { key: "poItem", label: "PO Item", dataType: "sap.ui.model.type.String" },
    { key: "ItemId", label: "ItemId", dataType: "sap.ui.model.type.String" },
    { key: "itemDescription", label: "Descrição", dataType: "sap.ui.model.type.String" },
    { key: "unitOfMeasure", label: "Unidade", dataType: "sap.ui.model.type.String" },
    { key: "currency", label: "Moeda", dataType: "sap.ui.model.type.String" },
    { key: "ncm", label: "NCM", dataType: "sap.ui.model.type.String" },
    { key: "Extrinsic_Origem_do_Material", label: "Origem Material", dataType: "sap.ui.model.type.String" },
    { key: "PLANT", label: "Centro", dataType: "sap.ui.model.type.String" },
    { key: "ItemCategory", label: "Categoria do Item", dataType: "sap.ui.model.type.String" },
    { key: "MaterialCode", label: "Código Material", dataType: "sap.ui.model.type.String" },
    { key: "grupo_de_materias", label: "Grupo de Materiais", dataType: "sap.ui.model.type.String" },
    { key: "supplierName", label: "Fornecedor", dataType: "sap.ui.model.type.String" },
    { key: "invitationId", label: "Invitation ID", dataType: "sap.ui.model.type.String" },
    { key: "invitationEmail", label: "Invitation Email", dataType: "sap.ui.model.type.String" },
    { key: "DELIVERY_DATE_RAW", label: "Data Entrega (raw)", dataType: "sap.ui.model.type.String" },
    // Numéricos
    { key: "quantity", label: "Quantidade", dataType: "sap.ui.model.type.Float" },
    { key: "price", label: "Preço", dataType: "sap.ui.model.type.Float" },
    { key: "mva", label: "MVA", dataType: "sap.ui.model.type.Float" },
    { key: "Extrinsic_Aliquota_ICMS", label: "Alíquota ICMS", dataType: "sap.ui.model.type.Float" },
    { key: "Extrinsic_ICMS_Apurado", label: "ICMS Apurado", dataType: "sap.ui.model.type.Float" },
    { key: "Extrinsic_Aliquota_IPI", label: "Alíquota IPI", dataType: "sap.ui.model.type.Float" },
    { key: "Extrinsic_IPI_Apurado", label: "IPI Apurado", dataType: "sap.ui.model.type.Float" },
    { key: "Extrinsic_Aliquota_PIS", label: "Alíquota PIS", dataType: "sap.ui.model.type.Float" },
    { key: "Extrinsic_PIS_Apurado", label: "PIS Apurado", dataType: "sap.ui.model.type.Float" },
    { key: "Extrinsic_Aliquota_Cofins", label: "Alíquota COFINS", dataType: "sap.ui.model.type.Float" },
    { key: "Extrinsic_Cofins_apurado", label: "COFINS Apurado", dataType: "sap.ui.model.type.Float" },
    { key: "Extrinsic_Aliquota_ICMS_Interna", label: "Alíquota ICMS Interna", dataType: "sap.ui.model.type.Float" },
    { key: "EXTENDEDPRICE", label: "Preço Estendido", dataType: "sap.ui.model.type.Float" }
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

  function _ensureCm(ctrl) {
    const view = ctrl.getView();
    let cm = view.getModel("cm");
    if (!cm) {
      cm = new ConditionModel();
      view.setModel(cm, "cm");
    }

    // Garante paths vazias para todos os campos, de forma segura
    const modelData = cm.getData();
    const conditions = modelData.conditions || {};
    let changed = false;
    FIELDS.forEach(f => {
      if (conditions[f.key] === undefined) { // Verifica se a chave não existe
        conditions[f.key] = [];
        changed = true;
      }
    });

    if (changed) {
      modelData.conditions = conditions;
      cm.setData(modelData);
    }
  }

  function _updateFilterBarLabel(ctrl) {
    const view = ctrl.getView();
    const cm = view.getModel("cm");
    if (!cm) return;

    // A gente tenta pegar o nome da visão aplicada, que guardamos num modelo separado
    const visionName = view.getModel("vm")?.getProperty("/appliedVisionName");
    let text = "";

    if (visionName) {
      text = `Visão aplicada: ${visionName}`;
    } else {
      // Se não tiver visão, usa a função que já existia para gerar o texto dos filtros
      text = _activeFiltersText(cm.getAllConditions());
    }

    console.log("Senhor SAP Debug: Sincronizando a label do filtro para:", text);
    view.byId("vsdFilterLabel")?.setText(text || "");
    view.byId("vsdFilterBar")?.setVisible(!!text);
  }

  function _ensureFilterBarBuilt(ctrl) {
    const view = ctrl.getView();
    const fb = view.byId("fb"); // id da FilterBar no fragment
    if (!fb) return;
    // evita duplicar itens
    if (fb.getFilterItems && fb.getFilterItems().length > 0) return;

    FIELDS.forEach((f) => fb.addFilterItem(new FilterField({
      label: f.label,
      dataType: f.dataType,
      maxConditions: -1,
      conditions: "{cm>/conditions/" + f.key + "}"
    })));
  }

  // -------------------------
  // API
  // -------------------------
  return {
    /** Garante o ConditionModel; chame no onInit do controller */
    init(ctrl) {
      _ensureCm(ctrl);
    },

    /** Abre o diálogo de filtros (Fragment) */

    async openDialog(ctrl) {
      const view = ctrl.getView();
      const cm = view.getModel("cm");

      // ✨ AQUI ENTRA A MUDANÇA PRINCIPAL ✨
      // Verificamos se há filtros "pendentes" que foram guardados pelo applyView ou restoreDraft
      if (ctrl._pendingConditions) {
        console.log("Senhor SAP Debug: Aplicando filtros pendentes 'Just-in-Time'!", ctrl._pendingConditions);

        // Usamos a mesma lógica segura do 'setData' para garantir o estado do modelo
        const modelData = cm.getData();
        modelData.conditions = ctrl._pendingConditions;
        cm.setData(modelData);

        // Limpa a variável temporária para não aplicar de novo por engano
        delete ctrl._pendingConditions;
      }

      // O resto do seu código continua como estava. A lógica abaixo serve como um reforço.
      console.log("🚪 Abrindo o diálogo de filtro...");
      console.log("🧐 Instância do ConditionModel em openDialog:", cm?.getId());
      console.log("📋 Condições ATUAIS no modelo ANTES de abrir:", JSON.stringify(cm.getAllConditions()));

      if (!ctrl._filterDlg) {
        console.log("🏗️ Carregando o fragmento do diálogo pela primeira vez...");
        ctrl._filterDlg = await Fragment.load({
          name: "comparativemap.comparativemap.view.fragments.FilterDialog",
          controller: ctrl,
          id: view.getId()
        });
        view.addDependent(ctrl._filterDlg);

        // A lógica de forçar a atualização ainda é uma boa prática, vamos manter!
        ctrl._filterDlg.attachAfterOpen(() => {
          console.log("✅ Diálogo de filtro aberto! Agendando atualização FORÇADA...");
          const view = ctrl.getView();
          const dialogCm = view.getModel("cm");
          const filterBar = view.byId("fb");

          if (dialogCm && filterBar) {
            setTimeout(() => {
              console.log("⏰ Forçando sincronia total entre Modelo e UI...");

              // 1. Força o modelo a empurrar seus dados para os bindings
              dialogCm.checkUpdate(true);

              // 2. Invalida a FilterBar para forçar que ela se redesenhe completamente
              filterBar.invalidate();

              console.log("Sincronia forçada. Os campos agora devem aparecer.");
            }, 100);
          }
        });
      }

      _ensureCm(ctrl);
      _ensureFilterBarBuilt(ctrl);

      ctrl._filterDlg.setModel(view.getModel("cm"), "cm");

      console.log("🚀 Mandando o diálogo abrir agora!");
      ctrl._filterDlg.open();
    },

    /** Fecha o diálogo de filtros */
    closeDialog(ctrl) {
      ctrl._filterDlg?.close();
    },

    updateFilterBarLabel: _updateFilterBarLabel,

    /** Aplica filtros na tabela e fecha o diálogo */
    onFilterSearch(ctrl) {
      const view = ctrl.getView();
      const cm = view.getModel("cm");
      const allConds = cm.getAllConditions();

      // aplica como FilterType.Application
      const filters = _conditionsToFilters(allConds);
      view.byId("tblDocs")?.getBinding("items")?.filter(filters, "Application");

      // resumo na infoToolbar
      const txt = _activeFiltersText(allConds);
      view.byId("vsdFilterLabel")?.setText(txt || "Sem filtros");
      view.byId("vsdFilterBar")?.setVisible(!!txt);

      MessageToast.show("Filtros aplicados");
      this.closeDialog(ctrl);
    },

    reset(ctrl) {
      const view = ctrl.getView();
      ctrl.__allowEmptyFiltersOnce = true;
      const cm = view.getModel("cm");
      view.getModel("vm")?.setProperty("/appliedVisionName", "");
      if (cm) {
        console.log("Senhor SAP Debug: Limpando filtros com o método setData()...");
        const modelData = cm.getData();
        modelData.conditions = {}; // Limpa completamente o objeto de condições
        cm.setData(modelData);
        cm.updateBindings(true); // Força a UI (FilterBar) a limpar também
        console.log("Senhor SAP Debug: ConditionModel foi zerado de forma segura.");
      }

      // Limpa a label de info e o binding da tabela
      view.byId("vsdFilterLabel")?.setText("");
      view.byId("vsdFilterBar")?.setVisible(false);

      const binding = view.byId("tblDocs")?.getBinding("items");
      binding?.filter([], "Application"); // Remove o filtro da tabela
      setTimeout(() => { ctrl.__allowEmptyFiltersOnce = false; }, 0);
    },

    onOpenColumnsDialog(ctrl) {
      if (ctrl._colDlg) { ctrl._colDlg.open(); return; }

      const view = ctrl.getView();
      const ui = view.getModel("ui");
      const colList = ui.getProperty("/columnList") || [];
      const columnsMap = ui.getProperty("/columns") || {};

      const list = new sap.m.List({ mode: "MultiSelect" });
      colList.forEach(({ id, label }) => {
        list.addItem(new sap.m.StandardListItem({
          title: label,
          selected: !!columnsMap[id],   // estado atual vem do modelo
          info: id                      // guardo o id aqui
        }));
      });

      ctrl._colDlg = new sap.m.Dialog({
        title: "Selecionar colunas",
        contentWidth: "25rem",
        contentHeight: "30rem",
        content: [list],
        buttons: [
          new sap.m.Button({ text: "Cancelar", press: () => ctrl._colDlg.close() }),
          new sap.m.Button({
            text: "Aplicar",
            type: "Emphasized",
            press: () => {
              // monta novo mapa só a partir da seleção
              const selectedIds = list.getSelectedItems().map(it => it.getInfo());
              const newMap = { ...ui.getProperty("/columns") };
              Object.keys(newMap).forEach(id => { newMap[id] = selectedIds.includes(id); });

              ui.setProperty("/columns", newMap); // <-- só atualiza o modelo
              ctrl._colDlg.close();
              sap.m.MessageToast.show("Colunas atualizadas");
              sap.ui.require(["comparativemap/comparativemap/controller/prefs/DraftStore"], function (Drafts) {
                Drafts && Drafts.autoSave(ctrl);
              });
            }
          })
        ]
      });

      view.addDependent(ctrl._colDlg);
      ctrl._colDlg.open();
    }
  };
});
