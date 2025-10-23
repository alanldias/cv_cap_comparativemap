sap.ui.define([
  "sap/ui/util/Storage",
  "sap/m/MessageToast",
  "sap/m/Dialog",
  "sap/m/Label",
  "sap/m/Input",
  "sap/m/Button",
  "sap/m/SelectDialog",
  "sap/m/StandardListItem",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator"
], function (
  Storage, MessageToast, Dialog, Label, Input, Button,
  SelectDialog, StandardListItem, UI5Filter, UI5FilterOperator
) {
  "use strict";

  // =========================================================
  // 1) Compat: prefs locais (controller já usa)
  // =========================================================
  const KEY = "tblDocs-prefs";
  const storage = new Storage(Storage.Type.local, "comparativemap");

  const NUMERIC_KEYS = [
    "quantity", "price", "mva", "Extrinsic_Aliquota_ICMS", "Extrinsic_ICMS_Apurado",
    "Extrinsic_Aliquota_IPI", "Extrinsic_IPI_Apurado", "Extrinsic_Aliquota_PIS",
    "Extrinsic_PIS_Apurado", "Extrinsic_Aliquota_Cofins", "Extrinsic_Cofins_apurado",
    "Extrinsic_Aliquota_ICMS_Interna", "EXTENDEDPRICE"
  ];

  function _compactForBackend(raw) {
    const out = {};
    Object.keys(raw || {}).forEach(k => {
      const kept = (raw[k] || []).filter(c => {
        if (!c || c.isEmpty === true) return false;
        const v = Array.isArray(c.values) ? c.values : [];
        return c.operator === "BT"
          ? (v[0] !== "" && v[0] != null && v[1] !== "" && v[1] != null)
          : (v[0] !== "" && v[0] != null);
      }).map(c => {
        const vals = Array.isArray(c.values) ? c.values.slice() : [];
        const values = NUMERIC_KEYS.includes(k)
          ? vals.map(v => (v === "" || v == null) ? v : Number(v))
          : vals;
        // Removemos 'validated' pra reduzir ruído
        return { operator: c.operator || "EQ", values };
      });
      if (kept.length) out[k] = kept;
    });
    return out;
  }

  function load() {
    try {
      const raw = storage.get(KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return {
      filter: { fornecedor: [], nomeItem: [] },
      sort: { key: null, desc: false },
      group: { key: null, desc: false }
    };
  }
  function save(prefs) {
    try { storage.put(KEY, JSON.stringify(prefs || {})); } catch (e) { }
  }

  // =========================================================
  // 2) Salvar VISÃO no backend (já implementado)
  // =========================================================
  function _collectPayload(ctrl) {
    const view = ctrl.getView();
    const cm = view.getModel("cm"); // ConditionModel (módulo Filtros)
    const ui = view.getModel("ui"); // columns/columnList
    const prefs = ctrl._prefs || {};
    const vm = view.getModel("vm");

    const conditions = _compactForBackend(cm?.getAllConditions?.() || {});
    const columnsMap = ui?.getProperty("/columns") || {};
    const columnList = ui?.getProperty("/columnList") || [];
    const docId =
      (vm?.getProperty("/header/docId")) ||
      view.byId("inputDoID")?.getValue?.() || "";

    return {
      docId: String(docId || ""),
      filtersJSON: JSON.stringify(conditions),
      uiSortJSON: JSON.stringify(prefs.sort || {}),
      uiGroupJSON: JSON.stringify(prefs.group || {}),
      uiColumnsJSON: JSON.stringify({ map: columnsMap, order: columnList })
    };
  }

  async function _saveViewToBackend(ctrl, name) {
    if (!name) throw new Error("Nome da visão é obrigatório.");
    const payload = _collectPayload(ctrl);

    const oModel = ctrl.getView().getModel(); // mesmo model que você usou pra salvar (já funcionou)
    if (!oModel || !oModel.bindContext) throw new Error("Modelo OData V4 não encontrado.");

    const ctx = oModel.bindContext("/SaveView(...)");
    ctx.setParameter("name", name);
    ctx.setParameter("docId", payload.docId);
    ctx.setParameter("filtersJSON", payload.filtersJSON);
    ctx.setParameter("uiSortJSON", payload.uiSortJSON);
    ctx.setParameter("uiGroupJSON", payload.uiGroupJSON);
    ctx.setParameter("uiColumnsJSON", payload.uiColumnsJSON);

    await ctx.execute();
    return ctx.getBoundContext()?.getObject?.();
  }

  async function openSaveViewDialog(ctrl) {
    const dlg = new Dialog({
      title: "Salvar visão",
      contentWidth: "28rem",
      content: [
        new Label({ text: "Nome da visão", labelFor: ctrl.getView().createId("inpVisionName") }),
        new Input(ctrl.getView().createId("inpVisionName"), { placeholder: "Ex.: ICMS>10 + Centro PR01", width: "100%" })
      ],
      buttons: [
        new Button({ text: "Cancelar", press: () => dlg.close() }),
        new Button({
          text: "Salvar",
          type: "Emphasized",
          press: async () => {
            const name = sap.ui.getCore().byId(ctrl.getView().createId("inpVisionName"))?.getValue?.().trim();
            if (!name) { MessageToast.show("Informe um nome."); return; }
            try {
              dlg.setBusy(true);
              const out = await _saveViewToBackend(ctrl, name);
              MessageToast.show(`Visão "${out?.name || name}" salva.`);
              dlg.close();
            } catch (e) {
              dlg.setBusy(false);
              MessageToast.show(e.message || "Falha ao salvar a visão.");
            }
          }
        })
      ],
      afterClose: function () { dlg.destroy(); }
    });
    ctrl.getView().addDependent(dlg);
    dlg.open();
  }

  // =========================================================
  // 3) Listar visões do backend e escolher/aplicar
  // =========================================================

  async function listViews(ctrl, { docId, onlyMine = false } = {}) {
    const oModel = ctrl.getView().getModel();
    if (!oModel || !oModel.bindList) throw new Error("Modelo OData V4 não encontrado.");

    const aFilters = [];
    if (docId) aFilters.push(new UI5Filter("docId", UI5FilterOperator.EQ, String(docId)));
    if (onlyMine) aFilters.push(new UI5Filter("userId", UI5FilterOperator.EQ, ctrl.getOwnerComponent()?.getCurrentUser?.()?.id || "anonymous"));
    // (Se preferir, remova onlyMine e liste tudo; o backend pode filtrar por tenant/roles)

    const list = oModel.bindList("/FilterViews", null, null, null, { $orderby: "modifiedAt desc" });
    if (aFilters.length) list.filter(aFilters);

    const ctxs = await list.requestContexts(0, Infinity);
    return ctxs.map(c => c.getObject());
  }

  function applyConditionsToCM(cm, conditions) {
    if (!cm || typeof cm.setAllConditions !== "function") return false;
    cm.removeAllConditions();
    cm.setAllConditions(conditions || {});
    return true;
  }

  function _shortIdFrom(col, view) {
    const prefix = view.getId() + "--";
    const longId = col.getId();
    return longId.startsWith(prefix) ? longId.slice(prefix.length) : longId;
  }


  function applyColumnsToTable(ctrl, columnsPayload) {
    if (!columnsPayload) return;
    const view = ctrl.getView();
    const ui = view.getModel("ui");
    const tbl = view.byId("tblDocs");
    if (!ui || !tbl) return;

    const map = columnsPayload.map || {};
    const order = Array.isArray(columnsPayload.order) ? columnsPayload.order.map(o => o.id) : [];

    // 1) Atualiza o modelo UI (para quem está ligado via binding)
    const newMap = { ...(ui.getProperty("/columns") || {}) };
    Object.keys(newMap).forEach(id => { newMap[id] = !!map[id]; });
    ui.setProperty("/columns", newMap);

    // 2) Aplica visibilidade diretamente na tabela (garante efeito mesmo se não houver binding)
    const cols = tbl.getColumns();
    const byId = {};
    cols.forEach(c => byId[_shortIdFrom(c, view)] = c);
    Object.keys(map).forEach(id => {
      const c = byId[id];
      if (c) c.setVisible(!!map[id]);
    });

    // 3) Reordenar colunas conforme "order"
    if (order.length) {
      // Mover somente as que existem
      const present = order.map(id => byId[id]).filter(Boolean);
      // Remove e re-insere nessa ordem
      present.forEach((c, i) => {
        tbl.removeColumn(c);
        tbl.insertColumn(c, i);
      });
      // As que não estavam no "order" ficam no fim, na ordem atual
    }
  }

  function _applyFiltersNowOrWhenReady(ctrl, conds) {
    const view = ctrl.getView();
    const tbl = view.byId("tblDocs");
    const arr = _filtersFromConditions(conds, UI5Filter, UI5FilterOperator);

    const doApply = () => {
      const b = tbl?.getBinding("items");
      if (!b) return false;                    // ainda não tem binding/dados
      b.filter([], "Control");
      b.sort(null);
      b.filter(arr, "Application");

      // Atualiza a barra/label dos filtros sem quebrar caso o módulo ainda não esteja carregado
      try {
        sap.ui.require(
          ["comparativemap/comparativemap/controller/helpers/filtros"],
          (Filtros) => Filtros?.updateFilterBarLabel?.(ctrl)
        );
      } catch (e) { }
      return true;
    };

    // tenta agora; se não deu, aplica quando a tabela terminar de atualizar
    if (!doApply()) {
      const once = () => { if (doApply()) tbl.detachUpdateFinished(once); };
      tbl.attachUpdateFinished(once);
    }
  }

  function applyView(ctrl, viewObj) {
    if (!viewObj) return;

    const view = ctrl.getView();
    view.getModel("vm").setProperty("/appliedVisionName", viewObj.name);

    // garante que o ConditionModel exista
    let cm = view.getModel("cm");
    if (!cm?.getData) {
      try {
        sap.ui.require(
          ["comparativemap/comparativemap/controller/helpers/filtros"],
          (Filtros) => Filtros?.init?.(ctrl)
        );
      } catch (e) { }
      cm = view.getModel("cm"); // re-pega após init
    }

    // normaliza e injeta condições
    const rawConds = JSON.parse(viewObj.filtersJSON || "{}");
    const conds = _normalizeConditionsForUI(rawConds);

    ctrl._pendingConditions = conds;
    ctrl.__lastAppliedConditions = conds;  // memoriza "último bom"
    _setAllConditionsCompat(cm, conds);
    cm?.checkUpdate?.(true);
    cm?.updateBindings?.(true);
    sap.ui.getCore().applyChanges();

    // aplica no binding de forma robusta a timing
    _applyFiltersNowOrWhenReady(ctrl, conds);

    // Sort/Group
    const sort = JSON.parse(viewObj.uiSortJSON || "{}");
    const group = JSON.parse(viewObj.uiGroupJSON || "{}");
    ctrl._prefs = Object.assign({}, ctrl._prefs || {}, { sort, group });
    ctrl._vs.setPrefs(ctrl._prefs);
    ctrl._vs.applyGroupSortFromPrefs();

    // Colunas
    const cols = JSON.parse(viewObj.uiColumnsJSON || "{}");
    applyColumnsToTable(ctrl, cols);

    // autosave
    sap.ui.require(["comparativemap/comparativemap/controller/prefs/DraftStore"], function (Drafts) {
      Drafts && Drafts.autoSave(ctrl);
    });

    MessageToast.show(`Visão aplicada: ${viewObj.name}`);
  }

  function _filtersFromConditions(conds, UI5Filter, UI5FilterOperator) {
    const FO_MAP = {
      EQ: UI5FilterOperator.EQ, BT: UI5FilterOperator.BT,
      GE: UI5FilterOperator.GE, LE: UI5FilterOperator.LE,
      GT: UI5FilterOperator.GT, LT: UI5FilterOperator.LT,
      Contains: UI5FilterOperator.Contains,
      StartsWith: UI5FilterOperator.StartsWith,
      EndsWith: UI5FilterOperator.EndsWith
    };

    const filters = [];
    Object.keys(conds || {}).forEach((field) => {
      (conds[field] || []).forEach((c) => {
        const op = FO_MAP[c.operator] || UI5FilterOperator.EQ;
        if (op === UI5FilterOperator.BT) {
          filters.push(new UI5Filter(field, op, c.values?.[0], c.values?.[1]));
        } else {
          filters.push(new UI5Filter(field, op, c.values?.[0]));
        }
      });
    });
    return filters;
  }

  async function openChooseViewDialog(ctrl, { docScoped = true } = {}) {
    const currentDocId =
      ctrl.getView().getModel("vm")?.getProperty("/header/docId") ||
      ctrl.getView().byId("inputDoID")?.getValue() || null;

    const views = await listViews(ctrl, { docId: docScoped ? currentDocId : undefined });

    const dlg = new SelectDialog({
      title: "Escolher visão",
      items: {
        path: "/",
        template: new StandardListItem({
          title: "{name}",
          description: "{= ${docId} ? 'DocID: ' + ${docId} : '' }",
          info: "{= ${modifiedAt} || ${createdAt} }"
        })
      },
      search: function (ev) {
        const q = (ev.getParameter("value") || "").toLowerCase();
        const binding = dlg.getBinding("items");
        binding.filter(q ? [new UI5Filter("name", UI5FilterOperator.Contains, q)] : []);
      },
      confirm: (ev) => {
        const obj = ev.getParameter("selectedItem")?.getBindingContext()?.getObject();
        if (obj) applyView(ctrl, obj);
        // deixa o SelectDialog fechar sozinho; depois destrói
        setTimeout(() => dlg.destroy(), 0);
      },
      cancel: () => {
        setTimeout(() => dlg.destroy(), 0);
      }
    });

    const json = new sap.ui.model.json.JSONModel(views);
    dlg.setModel(json);
    ctrl.getView().addDependent(dlg);
    dlg.open();
  }



  function _normalizeConditionsForUI(rawConds) {
    const ConditionValidated = sap.ui.require("sap/ui/mdc/condition/ConditionValidated");
    const VALIDATED = ConditionValidated ? ConditionValidated.Validated : "Validated";

    const out = {};
    Object.keys(rawConds || {}).forEach((field) => {
      const arr = Array.isArray(rawConds[field]) ? rawConds[field] : [];
      out[field] = arr.map((c) => {
        const op = c?.operator || "EQ";
        let vals = Array.isArray(c?.values) ? c.values.slice() : [];
        if (NUMERIC_KEYS.includes(field)) {
          vals = vals.map(v => (v === "" || v == null) ? v : Number(v));
        }
        return { operator: op, values: vals, isEmpty: null, validated: VALIDATED };
      });
    });
    return out;
  }

  function _setAllConditionsCompat(cm, allConditions) {
    if (!cm) {
      return;
    }

    // 1. Pega todo o objeto de dados do modelo
    const modelData = cm.getData();
    // Limpa completamente o objeto de condições para começar do zero.
    modelData.conditions = {};

    // 2. Agora, vamos reconstruir o objeto de condições apenas com os filtros da visão
    if (allConditions) {
      Object.keys(allConditions).forEach(key => {
        const conditions = allConditions[key];
        // Só adiciona se realmente tiver alguma condição para aquele campo
        if (conditions && Array.isArray(conditions) && conditions.length > 0) {
          modelData.conditions[key] = conditions;
        }
      });
    }

    // 3. Com o objeto de dados limpo e reconstruído, usamos setData() para substituir TUDO de uma vez.
    // Esta é uma operação atômica e segura.
    cm.setData(modelData);

    // 4. Por fim, forçamos a UI a se atualizar com os novos dados
    cm.updateBindings(true);
  }

  return {
    load, save,

    // salvar visão no backend
    openSaveViewDialog,

    // listar/escolher/aplicar
    listViews,
    openChooseViewDialog,
    applyView,

    // util exposto (se quiser usar direto)
    applyColumnsToTable,
    applyConditionsToCM
  };
});
