sap.ui.define([
  "sap/ui/util/Storage",
  "sap/m/MessageBox",
  "sap/m/SelectDialog",
  "sap/ui/model/json/JSONModel",
  "sap/m/CustomListItem",
  "sap/m/Button",
  "sap/m/HBox",
  "sap/m/VBox",
  "sap/m/Text",
  "sap/m/MessageToast"
], function (
  Storage,
  MessageBox,
  SelectDialog,
  JSONModel,
  CustomListItem,
  Button,
  HBox,
  VBox,
  Text,
  MessageToast
) {
  "use strict";

  const storage = new Storage(Storage.Type.local, "comparativemap");
  const PREFIX = "draft:";
  const INDEX_KEY = "draft:index";
  const VERSION = 4;

  function _now() { return new Date().toISOString(); }

  function _getDocId(ctrl) { // resolve docId do VM ou do input
    const view = ctrl.getView();
    return String(
      (view.getModel("vm")?.getProperty("/header/docId")) ||
      view.byId("inputDoID")?.getValue?.() ||
      ""
    ).trim();
  }

  function _indexGet() { // índice: lastDocId + items{docId:{savedAt,rows}}
    try { return JSON.parse(storage.get(INDEX_KEY) || "{}"); }
    catch (e) { return {}; }
  }

  function _indexPut(idx) {
    try { storage.put(INDEX_KEY, JSON.stringify(idx)); }
    catch (e) { }
  }

  function _key(docId) { return `${PREFIX}${docId}`; }

  function registerDefaultState(ctrl) { // compat: não salvamos mais preferências de UI
    return;
  }

  function resetToDefault(ctrl) { // compat: não mexe mais em colunas/filtros/sorts
    const view = ctrl.getView();
    const mdcTbl = view.byId("tblDocs");
    ctrl.__skipSave = true;
    try { if (mdcTbl && typeof mdcTbl.rebind === "function") mdcTbl.rebind(); } catch (e) { }
    setTimeout(function () { ctrl.__skipSave = false; }, 500);
  }

  function _collectSnapshot(ctrl) { // só dados (sem preferências de interface)
    const view = ctrl.getView();
    const vm = view.getModel("vm");
    const docId = _getDocId(ctrl);

    const header = vm?.getProperty("/header") || {};
    const headerRows = vm?.getProperty("/headerRows") || [];
    const rows = vm?.getProperty("/rows") || [];

    return {
      _version: VERSION,
      savedAt: _now(),
      docId,
      header,
      headerRows,
      rows
    };
  }

  function _restoreSnapshot(ctrl, snap) { // restaura só dados no VM
    if (!snap) return;

    ctrl.__restoringDraft = true;
    ctrl.__skipSave = true;

    const view = ctrl.getView();
    const vm = view.getModel("vm");

    vm?.setProperty("/header", snap.header || {});
    vm?.setProperty("/headerRows",
      Array.isArray(snap.headerRows)
        ? snap.headerRows
        : (snap.header ? [snap.header] : [])
    );
    vm?.setProperty("/rows", Array.isArray(snap.rows) ? snap.rows : []);

    try { sap.ui.getCore().applyChanges(); } catch (e) { }

    ctrl.__restoringDraft = false;
    setTimeout(function () { ctrl.__skipSave = false; }, 300);
  }

  function restoreWithNewData(ctrl, docId, header, headerRows, rows) { // mantém UI standard, só injeta dados novos
    const snap = load(docId);
    if (!snap) return false;

    snap.header = header;
    snap.headerRows = headerRows;
    snap.rows = rows;

    _restoreSnapshot(ctrl, snap);
    return true;
  }

  function save(ctrl, force) { // salva snapshot de dados + atualiza índice
    if (!force && (ctrl.__skipSave || ctrl.__restoringDraft)) return false;

    const snap = _collectSnapshot(ctrl);
    if (!snap.docId) return false;

    try {
      storage.put(_key(snap.docId), JSON.stringify(snap));

      const idx = _indexGet();
      idx.lastDocId = snap.docId;
      idx.items = idx.items || {};

      idx.items[snap.docId] = {
        savedAt: snap.savedAt,
        rows: Array.isArray(snap.rows) ? snap.rows.length : 0
      };

      const entries = Object.entries(idx.items).sort(function (a, b) {
        return new Date(b[1].savedAt).getTime() - new Date(a[1].savedAt).getTime();
      });

      const keep = entries.slice(0, 5);
      const drop = entries.slice(5);

      idx.items = Object.fromEntries(keep);

      drop.forEach(function ([oldDocId]) {
        storage.remove(_key(oldDocId));
        console.log("🗑️ DraftStore: Removendo draft antigo:", oldDocId);
      });

      _indexPut(idx);
      return true;
    } catch (e) {
      console.error("DraftStore erro ao salvar:", e);
      return false;
    }
  }

  let _debounce;
  function autoSave(ctrl, delay) { // debounce simples de save()
    delay = delay == null ? 800 : delay;
    if (ctrl && (ctrl.__restoringDraft || ctrl.__skipSave)) return;

    clearTimeout(_debounce);
    _debounce = setTimeout(function () {
      if (ctrl && (ctrl.__restoringDraft || ctrl.__skipSave)) return;
      try { save(ctrl); } catch (e) { }
    }, delay);
  }

  function hasDraft(docId) {
    if (!docId) return false;
    return !!storage.get(_key(docId));
  }

  function load(docId) { // tolera snapshots antigos com campos extras
    try { return JSON.parse(storage.get(_key(docId)) || ""); }
    catch (e) { return null; }
  }

  function restore(ctrl, docId) { // restaura e reflete docId no input
    const snap = load(docId);
    if (!snap) return false;
    _restoreSnapshot(ctrl, snap);
    ctrl.getView().byId("inputDoID")?.setValue(docId);
    return true;
  }

  function clear(docId) { // remove snapshot + atualiza índice
    try {
      storage.remove(_key(docId));
      const idx = _indexGet();
      if (idx?.items) delete idx.items[docId];
      if (idx?.lastDocId === docId) idx.lastDocId = undefined;
      _indexPut(idx);
    } catch (e) { }
  }

  function _formatSavedAtBR(isoString) { // exibição no diálogo
    if (!isoString) return "";
    try {
      const dt = new Date(isoString);
      return new Intl.DateTimeFormat("pt-BR", {
        timeZone: "America/Sao_Paulo",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      }).format(dt);
    } catch (e) {
      return String(isoString || "");
    }
  }

  function offerRestoreOnEnter(ctrl) { // mesma UI: confirm/SelectDialog + delete
    const view = ctrl.getView();
    registerDefaultState(ctrl);

    const current = _getDocId(ctrl);
    const idx = _indexGet();
    const items = idx?.items || {};

    if (current && hasDraft(current)) {
      MessageBox.confirm(`Existe um rascunho salvo para o DocID ${current}. Restaurar?`, {
        actions: [MessageBox.Action.YES, MessageBox.Action.NO],
        emphasizedAction: MessageBox.Action.YES,
        onClose: function (act) {
          if (act === MessageBox.Action.YES) restore(ctrl, current);
          else resetToDefault(ctrl);
        }
      });
      return;
    }

    const docIds = Object.keys(items);
    if (!docIds.length) return;

    const data = docIds.map(function (d) {
      return {
        docId: d,
        savedAt: items[d].savedAt,
        savedAtBR: _formatSavedAtBR(items[d].savedAt),
        rows: items[d].rows
      };
    }).sort(function (a, b) {
      return String(b.savedAt).localeCompare(String(a.savedAt));
    });

    const mdl = new JSONModel(data);

    const dlg = new SelectDialog({
      title: "Restaurar rascunho",
      search: function (ev) {
        const q = (ev.getParameter("value") || "").toLowerCase();
        const base = data.slice();
        const filtered = q
          ? base.filter(function (d) { return String(d.docId).toLowerCase().includes(q); })
          : base;
        mdl.setData(filtered);
      },
      confirm: function (ev) {
        const obj = ev.getParameter("selectedItem")?.getBindingContext()?.getObject();
        if (obj?.docId) restore(ctrl, obj.docId);
        setTimeout(function () { dlg.destroy(); }, 0);
      },
      cancel: function () { setTimeout(function () { dlg.destroy(); }, 0); }
    });

    dlg.bindAggregation("items", {
      path: "/",
      factory: function (sId, oCtx) {
        const obj = oCtx.getObject();

        const txtDoc = new Text({
          text: obj.docId,
          wrapping: false
        }).addStyleClass("sapMTextStrong sapUiTinyMarginBottom");

        const txtMeta = new Text({
          text: `Salvo em ${obj.savedAtBR} · ${obj.rows} linha(s)`,
          wrapping: false
        });

        const left = new VBox({
          items: [txtDoc, txtMeta],
          width: "100%"
        }).addStyleClass("sapUiSmallMarginBeginEnd sapUiTinyMarginTopBottom");

        const btnDel = new Button({
          icon: "sap-icon://decline",
          type: "Transparent",
          tooltip: "Excluir este rascunho",
          press: function (oEvent) {
            const ctx = oEvent.getSource().getBindingContext();
            const row = ctx && ctx.getObject();
            if (!row || !row.docId) return;

            MessageBox.confirm(
              `Excluir o rascunho do DocID ${row.docId}?`,
              {
                actions: [MessageBox.Action.YES, MessageBox.Action.NO],
                emphasizedAction: MessageBox.Action.YES,
                onClose: function (act) {
                  if (act !== MessageBox.Action.YES) return;
                  try { clear(row.docId); } catch (e) { }

                  const arr = (mdl.getData() || []).filter(function (x) { return x.docId !== row.docId; });
                  mdl.setData(arr);
                  MessageToast.show(`Rascunho ${row.docId} removido.`);
                  if (!arr.length) setTimeout(function () { dlg.close(); }, 0);
                }
              }
            );

            oEvent.preventDefault && oEvent.preventDefault();
            oEvent.cancelBubble = true;
            if (oEvent.stopPropagation) oEvent.stopPropagation();
          }
        }).addStyleClass("sapUiSmallMarginEnd");

        const gap = new HBox({ width: "1rem" });

        const rowHBox = new HBox({
          alignItems: "Center",
          justifyContent: "SpaceBetween",
          fitContainer: true,
          items: [left, gap, btnDel]
        });

        const cli = new CustomListItem({
          content: [rowHBox],
          type: "Active"
        }).addStyleClass("sapUiSmallMarginBottom");

        return cli;
      }
    });

    dlg.setModel(mdl);
    view.addDependent(dlg);
    dlg.open();
  }

  return {
    save: save,
    autoSave: autoSave,
    hasDraft: hasDraft,
    restore: restore,
    load: load,
    clear: clear,
    offerRestoreOnEnter: offerRestoreOnEnter,
    registerDefaultState: registerDefaultState,
    resetToDefault: resetToDefault,
    restoreWithNewData: restoreWithNewData
  };
});
