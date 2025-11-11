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
  "sap/ui/core/Fragment",
  "sap/ui/core/dnd/DragDropInfo" // 🔹 DnD para reordenar itens da lista
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
  Fragment,
  DragDropInfo
) {
  "use strict";

  // ---------------------------------------------------------------------
  // 🔹 Campos (iguais aos seus; usados para montar FilterBar/labels)
  // ---------------------------------------------------------------------
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

  // ---------------------------------------------------------------------
  // 🔹 Utils de filtros (iguais aos seus originais)
  // ---------------------------------------------------------------------
  function _short(view, longId) {
    const prefix = view.getId() + "--";
    return longId && longId.startsWith(prefix) ? longId.slice(prefix.length) : longId;
  }

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
    // garante caminhos para todos os campos (evita undefined)
    const modelData = cm.getData();
    const conditions = modelData.conditions || {};
    let changed = false;
    FIELDS.forEach(f => {
      if (conditions[f.key] === undefined) {
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

    const visionName = view.getModel("vm")?.getProperty("/appliedVisionName");
    let text = "";
    if (visionName) {
      text = `Visão aplicada: ${visionName}`;
    } else {
      text = _activeFiltersText(cm.getAllConditions());
    }
    view.byId("vsdFilterLabel")?.setText(text || "");
    view.byId("vsdFilterBar")?.setVisible(!!text);
  }

  function _ensureFilterBarBuilt(ctrl) {
    const view = ctrl.getView();
    const fb = view.byId("fb"); // id da sua FilterBar (fragment)
    if (!fb) return;
    if (fb.getFilterItems && fb.getFilterItems().length > 0) return;

    FIELDS.forEach((f) => fb.addFilterItem(new FilterField({
      label: f.label,
      dataType: f.dataType,
      maxConditions: -1,
      conditions: "{cm>/conditions/" + f.key + "}"
    })));
  }

  // ---------------------------------------------------------------------
  // === Reordenação da Tabela (colunas + cells do template) ===
  // ---------------------------------------------------------------------
  function ensureFullOrder(tbl, desiredOrder) {
    const short = id => id.includes("--") ? id.split("--").pop() : id;
    const allShort = (tbl.getColumns() || []).map(c => short(c.getId()));
    const set = new Set(desiredOrder || []);
    const out = Array.from(set);
    allShort.forEach(id => { if (!set.has(id)) out.push(id); });

    console.groupCollapsed("🔧 ensureFullOrder");
    console.log("desiredOrder", desiredOrder);
    console.log("allShort (present in table)", allShort);
    console.log("finalOrder (ensured)", out);
    console.groupEnd();

    return out;
  }

  function mapColIdToCellId(colShortId, ctrl) {
    if (ctrl && ctrl.__col2cellMap && ctrl.__col2cellMap[colShortId]) {
      return ctrl.__col2cellMap[colShortId];
    }
    console.warn("[mapColIdToCellId] Sem mapeamento para", colShortId, "– aguardando captura do template.");
    return null; // <— não chute
  }

  function rebuildTemplateWithNewCellOrder(tbl, order, ctrl, cached) {
    const view = ctrl.getView();
    // ⚠️ use SEMPRE o template ORIGINAL da view
    const baseTpl = view.byId("itemTemplate");
    if (!baseTpl) return;

    const newTpl = baseTpl.clone();
    newTpl.destroyCells();

    // ⚠️ não tente adivinhar; confie no mapa aprendido
    order.forEach(colShortId => {
      const cellId = mapColIdToCellId(colShortId, ctrl);
      if (!cellId) return;
      const cellTpl = ctrl.byId(cellId);
      if (cellTpl) newTpl.addCell(cellTpl.clone());
    });

    const params = {
      path: (typeof cached.path === "string" && cached.path) ? cached.path : "/rows",
      sorter: cached.sorter,
      filters: cached.filters,
      template: newTpl,
      templateShareable: false
    };

    const pathHasModelPrefix = typeof cached.path === "string" && cached.path.includes(">");
    if (!pathHasModelPrefix && cached.model) params.model = cached.model;

    tbl.bindItems(params);

    setTimeout(() => {
      const b = tbl.getBinding("items");
      console.log("len pós-rebind:", b?.getLength?.());
      const t = tbl.getBindingInfo("items")?.template;
      console.log("qtd células no template:", t?.getCells?.().length);
    }, 0);
  }

  function reorderExistingItemCells(tbl, order, ctrl) {
    console.groupCollapsed("🔧 reorderExistingItemCells");
    console.log("order", order);

    (tbl.getItems() || []).forEach((li, rowIdx) => {
      const current = li?.getCells?.() || [];
      if (!current.length) return;

      const pool = new Map();
      current.forEach(c => {
        const shortId = c.getId().split("--").pop();
        pool.set(shortId, c);
      });

      console.groupCollapsed(` row#${rowIdx} pool`);
      console.log("pool keys (cell short IDs):", Array.from(pool.keys()));
      console.groupEnd();

      const newCells = [];
      order.forEach(colShortId => {
        const cellId = mapColIdToCellId(colShortId, ctrl);
        const found = pool.get(cellId);
        console.log(`  map col ${colShortId} -> cell ${cellId}:`, found ? "✅" : "❌");
        if (found) newCells.push(found);
      });

      // mantém quaisquer células não mapeadas no final (defensivo)
      current.forEach(c => { if (!newCells.includes(c)) newCells.push(c); });

      li.removeAllCells();
      newCells.forEach(c => li.addCell(c));
    });

    console.groupEnd();
  }

  function reorderColumns(tbl, order, ctrl) {
    console.groupCollapsed("🔧 reorderColumns");
    console.log("order", order);

    // Mapeia ids curtos -> coluna real
    const view = ctrl.getView();
    const short = (longId) => {
      const prefix = view.getId() + "--";
      return longId.startsWith(prefix) ? longId.slice(prefix.length) : longId;
    };

    const byId = {};
    (tbl.getColumns() || []).forEach(c => { byId[short(c.getId())] = c; });

    // Remove/insere na ordem desejada (apenas as que existem)
    order.forEach((colShortId, idx) => {
      const col = byId[colShortId];
      console.log(` move ${colShortId} -> index ${idx}`, col ? "✅ found" : "❌ not found");
      if (col) {
        tbl.removeColumn(col);
        tbl.insertColumn(col, idx);
      }
    });

    console.groupEnd();
  }

  function applyColumnOrder(ctrl) {
    const view = ctrl.getView();
    const ui = view.getModel("ui");
    const tbl = view.byId("tblDocs");
    if (!tbl || !ui) return;

    // evita reentrância
    if (ctrl.__reordering) return;
    ctrl.__reordering = true;

    let releaseBusy = () => { try { tbl.setBusy(false); } catch (e) { } };

    try {
      // 1) ordem desejada (completa, sem duplicatas)
      let order = ui.getProperty("/columnOrder") || [];
      order = ensureFullOrder(tbl, order);

      // 1.1) ⛳️ EARLY EXIT — se a ordem atual já for exatamente igual
      //      e a gente já tiver refeito o template pelo menos 1x, não faz nada.
      const currentShort = (tbl.getColumns() || []).map(c => {
        const p = view.getId() + "--";
        const id = c.getId();
        return id.startsWith(p) ? id.slice(p.length) : id;
      });
      if (ctrl.__didRebindOnce && JSON.stringify(currentShort) === JSON.stringify(order)) {
        // nada pra fazer (evita unbind/rebind desnecessário e spinner)
        return;
      }

      // 2) cache do binding atual ANTES do unbind
      const bi = tbl.getBindingInfo("items");
      const cached = bi ? {
        model: bi.model,
        path: bi.path,
        sorter: bi.sorter,
        filters: bi.filters,
        template: bi.template || view.byId("itemTemplate")
      } : {
        model: "vm",
        path: "/rows",
        template: view.byId("itemTemplate")
      };

      tbl.setBusy(true);

      // 3) cabeçalhos
      tbl.unbindItems();
      reorderColumns(tbl, order, ctrl);

      // 4) rebind com novo template na NOVA ordem
      rebuildTemplateWithNewCellOrder(tbl, order, ctrl, cached);

      // 5) libera busy quando os dados chegarem (ou por fallback)
      setTimeout(() => {
        const b = tbl.getBinding("items");
        if (b && b.attachDataReceived) {
          const once = () => {
            releaseBusy();
            try { b.detachDataReceived(once); } catch (e) { }
            ctrl.__didRebindOnce = true;        // 👈 marca que já fizemos um rebind “válido”
          };
          b.attachDataReceived(once);
        } else {
          releaseBusy();
          ctrl.__didRebindOnce = true;
        }
      }, 0);

    } catch (err) {
      releaseBusy();
      /* eslint-disable no-console */
      console.error("[applyColumnOrder] erro ao reordenar:", err);
    } finally {
      tbl.setBusy(false); 
      ctrl.__reordering = false;
    }
  }

  function captureColCellMap(ctrl) {
    // 🚫 não refaça o mapa se ele já existe
    if (ctrl.__col2cellMap && Object.keys(ctrl.__col2cellMap).length) return;

    const view = ctrl.getView();
    const tbl = view.byId("tblDocs");
    if (!tbl) return;

    const colShortIds = (tbl.getColumns() || []).map(c => _short(view, c.getId()));
    if (!colShortIds.length) return;

    const originalTpl = view.byId("itemTemplate");
    if (!originalTpl || typeof originalTpl.getCells !== "function") return;

    const norm = (id) => _short(view, id).replace(/-__clone.*/g, "").replace(/-clonedBy.*/g, "");
    const cellShortIds = (originalTpl.getCells() || []).map(c => norm(c.getId()));
    if (!cellShortIds.length) return;

    const n = Math.min(colShortIds.length, cellShortIds.length);
    const map = {};
    for (let i = 0; i < n; i++) map[colShortIds[i]] = cellShortIds[i];

    ctrl.__col2cellMap = map;
  }

  // ---------------------------------------------------------------------
  // 🔹 API pública
  // ---------------------------------------------------------------------
  return {
    // Inicializa o ConditionModel
    init(ctrl) { _ensureCm(ctrl); },

    // Abre o diálogo de filtros (fragment) e garante rebuild da FilterBar
    async openDialog(ctrl) {
      const view = ctrl.getView();
      const cm = view.getModel("cm");

      // aplica condições pendentes (se houver)
      if (ctrl._pendingConditions) {
        const modelData = cm.getData();
        modelData.conditions = ctrl._pendingConditions;
        cm.setData(modelData);
        delete ctrl._pendingConditions;
      }

      if (!ctrl._filterDlg) {
        ctrl._filterDlg = await Fragment.load({
          name: "comparativemap.comparativemap.view.fragments.FilterDialog",
          controller: ctrl,
          id: view.getId()
        });
        view.addDependent(ctrl._filterDlg);

        // força a FilterBar a redesenhar após abrir
        ctrl._filterDlg.attachAfterOpen(() => {
          const dialogCm = view.getModel("cm");
          const filterBar = view.byId("fb");
          if (dialogCm && filterBar) {
            setTimeout(() => {
              dialogCm.checkUpdate(true);
              filterBar.invalidate();
            }, 100);
          }
        });
      }

      _ensureCm(ctrl);
      _ensureFilterBarBuilt(ctrl);
      ctrl._filterDlg.setModel(view.getModel("cm"), "cm");
      ctrl._filterDlg.open();
    },

    // Fecha diálogo de filtros
    closeDialog(ctrl) {
      ctrl._filterDlg?.close();
    },

    // Atualiza a infoToolbar com resumo de filtros / visão aplicada
    updateFilterBarLabel(ctrl) {
      _updateFilterBarLabel(ctrl);
    },

    // Aplica filtros na tabela e fecha
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

    // Limpa filtros e infoToolbar
    reset(ctrl) {
      const view = ctrl.getView();
      ctrl.__allowEmptyFiltersOnce = true;

      const cm = view.getModel("cm");
      view.getModel("vm")?.setProperty("/appliedVisionName", "");

      if (cm) {
        const modelData = cm.getData();
        modelData.conditions = {};
        cm.setData(modelData);
        cm.updateBindings(true);
      }

      view.byId("vsdFilterLabel")?.setText("");
      view.byId("vsdFilterBar")?.setVisible(false);

      const binding = view.byId("tblDocs")?.getBinding("items");
      binding?.filter([], "Application");

      setTimeout(() => { ctrl.__allowEmptyFiltersOnce = false; }, 0);
    },

    // ===== Diálogo "Colunas" (com DnD na lista) =====
    onOpenColumnsDialog(ctrl) {
      if (ctrl._colDlg) { ctrl._colDlg.open(); return; }

      const view = ctrl.getView();
      const ui = view.getModel("ui");
      const colList = ui.getProperty("/columnList") || [];
      const columnsMap = ui.getProperty("/columns") || {};
      const order = ui.getProperty("/columnOrder") || [];

      // ordem que será exibida no diálogo
      const orderedIds = Array.isArray(order) && order.length
        ? order
        : colList.map(o => o.id);

      const byId = new Map(colList.map(o => [o.id, o])); // id -> {id,label}

      const list = new sap.m.List({ mode: "MultiSelect" });

      orderedIds.forEach((id) => {
        const meta = byId.get(id) || { id, label: id };
        list.addItem(new sap.m.StandardListItem({
          title: meta.label,
          selected: !!columnsMap[id],
          info: id
        }));
      });

      // 🔀 habilita drag & drop para reordenar linhas da lista
      list.addDragDropConfig(new DragDropInfo({
        sourceAggregation: "items",
        targetAggregation: "items",
        dropPosition: "Between",
        drop: (ev) => {
          const dragged = ev.getParameter("draggedControl");
          const dropped = ev.getParameter("droppedControl");
          const before = ev.getParameter("dropPosition") === "Before";

          const items = list.getItems();
          const from = items.indexOf(dragged);
          let to = items.indexOf(dropped);
          if (!before) to += 1;

          if (from !== to && from > -1 && to > -1) {
            list.removeItem(dragged);
            list.insertItem(dragged, to);
          }
        }
      }));

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
              // 🧭 Ordem final (como o usuário arrastou)
              const items = list.getItems();
              const orderedIds = items.map(it => it.getInfo());

              // ✅ Seleção final (visibilidade)
              const selectedSet = new Set(list.getSelectedItems().map(it => it.getInfo()));

              // 🔁 Novo mapa (id -> visible) seguindo a nova ordem
              const newMap = {};
              orderedIds.forEach(id => { newMap[id] = selectedSet.has(id); });

              ui.setProperty("/columns", newMap);
              ui.setProperty("/columnOrder", orderedIds);

              const tbl = view.byId("tblDocs");
              if (tbl) {
                // helper local para converter longId->shortId
                const short = (longId) => {
                  const prefix = view.getId() + "--";
                  return longId.startsWith(prefix) ? longId.slice(prefix.length) : longId;
                };

                const byId = {};
                (tbl.getColumns() || []).forEach(c => { byId[short(c.getId())] = c; });

                orderedIds.forEach(id => {
                  const col = byId[id];
                  if (col) col.setVisible(newMap[id]);
                });
              }

              ctrl._colDlg.close();
              MessageToast.show("Colunas atualizadas e reordenadas");

              applyColumnOrder(ctrl);

              setTimeout(() => {
                const tbl = view.byId("tblDocs");
                if (tbl && tbl.getBusy && tbl.getBusy()) tbl.setBusy(false);
              }, 500);


              // 💾 Autosave (seu rascunho)
              sap.ui.require(["comparativemap/comparativemap/controller/prefs/DraftStore"], (Drafts) => {
                Drafts && Drafts.autoSave(ctrl);
              });
            }
          })
        ]
      });

      view.addDependent(ctrl._colDlg);
      ctrl._colDlg.open();
    },

    // Exporta para o controller restaurar na inicialização
    applyColumnOrder,
    captureColCellMap
  };
});
