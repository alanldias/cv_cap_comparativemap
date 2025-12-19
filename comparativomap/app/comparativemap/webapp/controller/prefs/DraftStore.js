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
    const VERSION = 3;

    let _defaultColumnOrder = null;

    function _now() { return new Date().toISOString(); }

    function _getDocId(ctrl) {
        const view = ctrl.getView();
        return String(
            (view.getModel("vm")?.getProperty("/header/docId")) ||
            view.byId("inputDoID")?.getValue?.() ||
            ""
        ).trim();
    }

    function _indexGet() {
        try { return JSON.parse(storage.get(INDEX_KEY) || "{}"); }
        catch (e) { return {}; }
    }

    function _indexPut(idx) {
        try { storage.put(INDEX_KEY, JSON.stringify(idx)); }
        catch (e) { }
    }

    function _key(docId) { return `${PREFIX}${docId}`; }

    // ===========================================================
    // REGISTRO DO ESTADO PADRÃO (ordem de colunas)
    // ===========================================================
    function registerDefaultState(ctrl) {
        if (_defaultColumnOrder !== null) return;

        const mdcTbl = ctrl.getView().byId("tblDocs");
        if (mdcTbl && mdcTbl.isA("sap.ui.mdc.Table")) {
            _defaultColumnOrder = mdcTbl.getColumns().map(col => col.getPropertyKey());
        }
    }

    // ===========================================================
    // RESET PARA O PADRÃO (sem largura, só ordem/visíveis)
    // ===========================================================
    function resetToDefault(ctrl) {
        const mdcTbl = ctrl.getView().byId("tblDocs");
        if (!mdcTbl || !mdcTbl.isA("sap.ui.mdc.Table")) return;

        console.log("🧹 DraftStore: Resetando para o padrão (Bloqueando salvamento)...");

        // 🔒 BLOQUEIA O SAVE ENQUANTO RESETAMOS
        ctrl.__skipSave = true;

        if (typeof mdcTbl.setFilterConditions === "function") {
            mdcTbl.setFilterConditions({}); // sem filtros
        }

        if (typeof mdcTbl.setSortConditions === "function") {
            mdcTbl.setSortConditions({ sorters: [] }); // sem ordenação
        }

        const finishReset = () => {
            mdcTbl.rebind();
            // 🔓 DESBLOQUEIA O SAVE depois de um tempo
            setTimeout(() => {
                ctrl.__skipSave = false;
            }, 1500);
        };

        if (_defaultColumnOrder && Array.isArray(_defaultColumnOrder)) {
            _restoreColumnsAsync(mdcTbl, _defaultColumnOrder).then(finishReset);
        } else {
            finishReset();
        }
    }

    // ===========================================================
    // SNAPSHOT: O QUE VAI PRO LOCALSTORAGE
    // ===========================================================
    function _collectSnapshot(ctrl) {
        const view = ctrl.getView();
        const vm = view.getModel("vm");
        const docId = _getDocId(ctrl);

        const header = vm?.getProperty("/header") || {};
        const headerRows = vm?.getProperty("/headerRows") || [];
        const rows = vm?.getProperty("/rows") || [];

        let mdcColumnOrder = [];
        let mdcFilterConditions = {};
        let mdcSortConditions = { sorters: [] };

        const mdcTbl = view.byId("tblDocs");

        if (mdcTbl && mdcTbl.isA("sap.ui.mdc.Table")) {
            const cols = mdcTbl.getColumns();
            mdcColumnOrder = cols.map(col => col.getPropertyKey());

            if (typeof mdcTbl.getFilterConditions === "function") {
                mdcFilterConditions = mdcTbl.getFilterConditions() || {};
            }

            if (typeof mdcTbl.getSortConditions === "function") {
                const oSortState = mdcTbl.getSortConditions();
                if (oSortState && Array.isArray(oSortState.sorters)) {
                    mdcSortConditions = oSortState;
                }
            }
        }

        return {
            _version: VERSION,
            savedAt: _now(),
            docId,
            header,
            headerRows,
            rows,
            mdcColumnOrder,
            mdcFilterConditions,
            mdcSortConditions
        };
    }

    // ===========================================================
    // RESTORE DO SNAPSHOT
    // ===========================================================
    function _restoreSnapshot(ctrl, snap) {
        if (!snap) return;

        ctrl.__restoringDraft = true;
        ctrl.__skipSave = true;

        const view = ctrl.getView();
        const vm = view.getModel("vm");
        const mdcTbl = view.byId("tblDocs");

        vm?.setProperty("/header", snap.header || {});
        vm?.setProperty("/headerRows",
            Array.isArray(snap.headerRows)
                ? snap.headerRows
                : (snap.header ? [snap.header] : [])
        );
        vm?.setProperty("/rows", Array.isArray(snap.rows) ? snap.rows : []);

        if (mdcTbl && mdcTbl.isA("sap.ui.mdc.Table")) {

            if (typeof mdcTbl.setFilterConditions === "function") {
                mdcTbl.setFilterConditions(snap.mdcFilterConditions || {});
            }

            if (typeof mdcTbl.setSortConditions === "function") {
                const oSortState = snap.mdcSortConditions;
                if (oSortState && Array.isArray(oSortState.sorters)) {
                    mdcTbl.setSortConditions(oSortState);
                } else {
                    mdcTbl.setSortConditions({ sorters: [] });
                }
            }

            if (Array.isArray(snap.mdcColumnOrder) && snap.mdcColumnOrder.length > 0) {
                _restoreColumnsAsync(mdcTbl, snap.mdcColumnOrder).then(() => {
                    mdcTbl.rebind();
                    ctrl.__restoringDraft = false;
                    setTimeout(() => { ctrl.__skipSave = false; }, 500);
                });
            } else {
                mdcTbl.rebind();
                ctrl.__restoringDraft = false;
                setTimeout(() => { ctrl.__skipSave = false; }, 500);
            }
        } else {
            ctrl.__restoringDraft = false;
            ctrl.__skipSave = false;
        }

        sap.ui.getCore().applyChanges();
    }

    // ===========================================================
    // RECRIA COLUNAS NA ORDEM SALVA (sem largura)
    // ===========================================================
    async function _restoreColumnsAsync(mdcTbl, desiredOrder) {
        const delegate = await mdcTbl.getControlDelegate();
        const existingCols = mdcTbl.getColumns();

        const colMap = new Map();
        existingCols.forEach(c => colMap.set(c.getPropertyKey(), c));

        const finalColumns = [];

        for (const propKey of desiredOrder) {
            let col = colMap.get(propKey);

            if (!col) {
                // Em caso de coluna ainda não criada, pede pro delegate
                try {
                    col = await delegate.addItem(mdcTbl, propKey);
                } catch (err) {
                    // Se der erro pra uma coluna específica, só ignora ela
                }
            }

            if (col) {
                finalColumns.push(col);
                colMap.delete(propKey);
            }
        }

        // Remove todas as colunas atuais e adiciona na ordem final
        mdcTbl.removeAllColumns();
        finalColumns.forEach(c => mdcTbl.addColumn(c));

        return true;
    }

    // ===========================================================
    // RESTORE COM NOVOS DADOS (quando troca DocID)
    // ===========================================================
    function restoreWithNewData(ctrl, docId, header, headerRows, rows) {
        const snap = load(docId);
        if (!snap) return false;

        snap.header = header;
        snap.headerRows = headerRows;
        snap.rows = rows;

        _restoreSnapshot(ctrl, snap);
        return true;
    }

    // ===========================================================
    // SAVE / AUTOSAVE
    // ===========================================================
    function save(ctrl, force = false) {
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

            const entries = Object.entries(idx.items).sort((a, b) => {
                return new Date(b[1].savedAt).getTime() - new Date(a[1].savedAt).getTime();
            });

            const keep = entries.slice(0, 5);
            const drop = entries.slice(5);

            idx.items = Object.fromEntries(keep);

            drop.forEach(([docId]) => {
                storage.remove(_key(docId));
                console.log("🗑️ DraftStore: Removendo draft antigo:", docId);
            });

            _indexPut(idx);
            return true;
        } catch (e) {
            console.error("DraftStore erro ao salvar:", e);
            return false;
        }
    }

    let _debounce;
    function autoSave(ctrl, delay = 800) {
        if (ctrl && (ctrl.__restoringDraft || ctrl.__skipSave)) return;

        clearTimeout(_debounce);
        _debounce = setTimeout(() => {
            if (ctrl && (ctrl.__restoringDraft || ctrl.__skipSave)) return;
            try { save(ctrl); } catch (e) { }
        }, delay);
    }

    // ===========================================================
    // OPERAÇÕES DE GERÊNCIA
    // ===========================================================
    function hasDraft(docId) {
        if (!docId) return false;
        return !!storage.get(_key(docId));
    }

    function load(docId) {
        try { return JSON.parse(storage.get(_key(docId)) || ""); }
        catch (e) { return null; }
    }

    function restore(ctrl, docId) {
        const snap = load(docId);
        if (!snap) return false;
        _restoreSnapshot(ctrl, snap);
        ctrl.getView().byId("inputDoID")?.setValue(docId);
        return true;
    }

    function clear(docId) {
        try {
            storage.remove(_key(docId));
            const idx = _indexGet();
            if (idx?.items) delete idx.items[docId];
            if (idx?.lastDocId === docId) idx.lastDocId = undefined;
            _indexPut(idx);
        } catch (e) { }
    }

    // ===========================================================
    // DIÁLOGO DE RESTORE
    // ===========================================================
    function _formatSavedAtBR(isoString) {
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

    function offerRestoreOnEnter(ctrl) {
        const view = ctrl.getView();
        registerDefaultState(ctrl);

        const current = _getDocId(ctrl);
        const idx = _indexGet();
        const items = idx?.items || {};

        if (current && hasDraft(current)) {
            MessageBox.confirm(`Existe um rascunho salvo para o DocID ${current}. Restaurar?`, {
                actions: [MessageBox.Action.YES, MessageBox.Action.NO],
                emphasizedAction: MessageBox.Action.YES,
                onClose: (act) => {
                    if (act === MessageBox.Action.YES) restore(ctrl, current);
                    else resetToDefault(ctrl);
                }
            });
            return;
        }

        const docIds = Object.keys(items);
        if (!docIds.length) return;

        const data = docIds.map(d => ({
            docId: d,
            savedAt: items[d].savedAt,
            savedAtBR: _formatSavedAtBR(items[d].savedAt),
            rows: items[d].rows
        })).sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));

        const mdl = new JSONModel(data);

        const dlg = new SelectDialog({
            title: "Restaurar rascunho",
            search: function (ev) {
                const q = (ev.getParameter("value") || "").toLowerCase();
                const base = data.slice();
                const filtered = q
                    ? base.filter(d => String(d.docId).toLowerCase().includes(q))
                    : base;
                mdl.setData(filtered);
            },
            confirm: (ev) => {
                const obj = ev.getParameter("selectedItem")?.getBindingContext()?.getObject();
                if (obj?.docId) restore(ctrl, obj.docId);
                setTimeout(() => dlg.destroy(), 0);
            },
            cancel: () => setTimeout(() => dlg.destroy(), 0)
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
                                onClose: (act) => {
                                    if (act !== MessageBox.Action.YES) return;
                                    try { clear(row.docId); } catch (e) { }

                                    const arr = (mdl.getData() || []).filter(x => x.docId !== row.docId);
                                    mdl.setData(arr);
                                    MessageToast.show(`Rascunho ${row.docId} removido.`);
                                    if (!arr.length) setTimeout(() => dlg.close(), 0);
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

    // ===========================================================
    // EXPORTA A API
    // ===========================================================
    return {
        save,
        autoSave,
        hasDraft,
        restore,
        load,
        clear,
        offerRestoreOnEnter,
        registerDefaultState,
        resetToDefault,
        restoreWithNewData
    };
});
