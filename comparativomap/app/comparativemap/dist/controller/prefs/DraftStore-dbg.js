sap.ui.define([
    "sap/ui/util/Storage",
    "sap/m/MessageBox",
    "sap/m/SelectDialog",
    "sap/m/StandardListItem",
    "sap/ui/model/json/JSONModel",
    // ↓ adicionados só para o botão "X" dentro do SelectDialog
    "sap/m/CustomListItem",
    "sap/m/Button",
    "sap/m/HBox",
    "sap/m/VBox",
    "sap/m/Text",
    "sap/m/MessageToast"
], function (
    Storage, MessageBox, SelectDialog, StandardListItem, JSONModel,
    CustomListItem, Button, HBox, VBox, Text, MessageToast
) {
    "use strict";

    const storage = new Storage(Storage.Type.local, "comparativemap");
    const PREFIX = "draft:";             // draft:<docId>
    const INDEX_KEY = "draft:index";     // catálogo de drafts (datas, contagem de linhas)
    const VERSION = 1;

    function _now() { return new Date().toISOString(); }

    function _hasValue(v) {
        return v !== undefined && v !== null && String(v) !== "";
    }
    function _isRealCond(c) {
        if (!c || c.isEmpty === true) return false;
        const vals = Array.isArray(c.values) ? c.values : [];
        if (c.operator === "BT") {
            return _hasValue(vals[0]) && _hasValue(vals[1]);
        }
        // operadores de 1 valor (EQ, GE, LE, GT, LT, Contains, etc)
        return _hasValue(vals[0]);
    }
    function _compactConditions(raw) {
        const out = {};
        Object.keys(raw || {}).forEach(k => {
            const kept = (raw[k] || []).filter(_isRealCond);
            if (kept.length) out[k] = kept;
        });
        return out;
    }

    function _shortIdFrom(col, view) {
        const prefix = view.getId() + "--";
        const longId = col.getId();
        return longId.startsWith(prefix) ? longId.slice(prefix.length) : longId;
    }

    function _readColumnsState(ctrl) {
        const view = ctrl.getView();
        const ui = view.getModel("ui");
        const tbl = view.byId("tblDocs");
        if (!ui || !tbl) return { map: {}, order: [] };

        const map = ui.getProperty("/columns") || {};
        const order = (tbl.getColumns() || []).map(c => ({ id: _shortIdFrom(c, view) }));
        return { map, order };
    }

    function _getDocId(ctrl) {
        const view = ctrl.getView();
        return String(
            (view.getModel("vm")?.getProperty("/header/docId")) ||
            view.byId("inputDoID")?.getValue?.() ||
            ""
        ).trim();
    }

    function _indexGet() {
        try { return JSON.parse(storage.get(INDEX_KEY) || "{}"); } catch (e) { return {}; }
    }
    function _indexPut(idx) {
        try { storage.put(INDEX_KEY, JSON.stringify(idx)); } catch (e) { /* ignore */ }
    }
    function _key(docId) { return `${PREFIX}${docId}`; }

    function _collectSnapshot(ctrl) {
        const view = ctrl.getView();
        const vm = view.getModel("vm");
        const cm = view.getModel("cm");
        const prefs = ctrl._prefs || {};

        // 1) pega tudo do CM…
        const rawConds = cm?.getAllConditions ? cm.getAllConditions() : {};
        let conditions = _compactConditions(rawConds);

        const docId = _getDocId(ctrl);
        const header = vm?.getProperty("/header") || {};
        const headerRows = vm?.getProperty("/headerRows") || [];
        const rows = vm?.getProperty("/rows") || [];

        // filtros no formato UI (direto do ConditionModel)

        // 1.1) "grudar" filtros: se ficou vazio e não houve reset explícito,
        //     use o último conjunto válido (do controller ou do draft salvo).
        if (!ctrl?.__allowEmptyFiltersOnce && Object.keys(conditions).length === 0) {
            const prevFromCtrl = ctrl?.__lastAppliedConditions || {};
            const prevFromDraft = load(docId)?.conditions || {};
            const fallback = Object.keys(prevFromCtrl).length ? prevFromCtrl : prevFromDraft;
            if (fallback && Object.keys(fallback).length) {
                conditions = fallback;
            }
        }

        // colunas (visibilidade + ordem)
        const uiColumns = _readColumnsState(ctrl);

        // por padrão, guarda tudo:
        return {
            _version: VERSION,
            savedAt: _now(),
            docId,
            header,
            headerRows,
            rows,
            conditions,
            uiColumns,
            uiSort: prefs.sort || {},
            uiGroup: prefs.group || {}
        };
    }

    function _restoreSnapshot(ctrl, snap) {
        if (!snap) return;
        ctrl.__restoringDraft = true;

        const view = ctrl.getView();
        const vm = view.getModel("vm");
        const ui = view.getModel("ui");

        // 1) header + rows
        vm?.setProperty("/header", snap.header || {});
        vm?.setProperty(
            "/headerRows",
            Array.isArray(snap.headerRows) ? snap.headerRows : (snap.header ? [snap.header] : [])
        );
        vm?.setProperty("/rows", Array.isArray(snap.rows) ? snap.rows : []);

        // 2) colunas
        if (ui && snap.uiColumns) {
            // atualiza o modelo UI e também aplica direto na tabela
            const newMap = { ...(ui.getProperty("/columns") || {}) };
            Object.keys(newMap).forEach(id => { newMap[id] = !!snap.uiColumns.map[id]; });
            ui.setProperty("/columns", newMap);

            const tbl = view.byId("tblDocs");
            if (tbl) {
                const byId = {};
                (tbl.getColumns() || []).forEach(c => byId[_shortIdFrom(c, view)] = c);

                // visibilidade
                Object.keys(snap.uiColumns.map || {}).forEach(id => {
                    const c = byId[id];
                    if (c) c.setVisible(!!snap.uiColumns.map[id]);
                });

                // ordem
                const orderIds = Array.isArray(snap.uiColumns.order)
                    ? snap.uiColumns.order.map(o => o && o.id).filter(Boolean)
                    : [];

                if (orderIds.length) {
                    const doReorder = function () {
                        try {
                            sap.ui.require(
                                ["comparativemap/comparativemap/controller/prefs/PrefsStore"],
                                function (Prefs) {
                                    Prefs?.reorderColumnsAndCells?.(ctrl, orderIds);
                                }
                            );
                        } catch (e) {
                            // fallback: só reordena colunas
                            const present = orderIds.map(id => byId[id]).filter(Boolean);
                            present.forEach((c, i) => { tbl.removeColumn(c); tbl.insertColumn(c, i); });
                        }
                    };

                    // agora + após render dos itens
                    doReorder();
                    tbl.attachEventOnce?.("updateFinished", doReorder);
                }
            }
        }

        // 3) filtros (UI + tabela)
        const cleanConds = _compactConditions(snap.conditions || {});
        ctrl._pendingConditions = cleanConds;
        ctrl.__lastAppliedConditions = cleanConds;

        const cm = view.getModel("cm");
        if (cm && typeof cm.setAllConditions === "function") {
            cm.removeAllConditions();
            cm.setAllConditions(cleanConds);
            cm.checkUpdate(true);
        }

        const binding = view.byId("tblDocs")?.getBinding("items");
        if (binding) {
            const Filter = sap.ui.require("sap/ui/model/Filter");
            const FilterOperator = sap.ui.require("sap/ui/model/FilterOperator");
            const FO = {
                EQ: FilterOperator.EQ, BT: FilterOperator.BT,
                GE: FilterOperator.GE, LE: FilterOperator.LE,
                GT: FilterOperator.GT, LT: FilterOperator.LT,
                Contains: FilterOperator.Contains,
                StartsWith: FilterOperator.StartsWith,
                EndsWith: FilterOperator.EndsWith
            };
            const filters = [];
            Object.keys(cleanConds).forEach(field => {
                (cleanConds[field] || []).forEach(c => {
                    const op = FO[c.operator] || FilterOperator.EQ;
                    filters.push(
                        op === FilterOperator.BT
                            ? new Filter(field, op, c.values?.[0], c.values?.[1])
                            : new Filter(field, op, c.values?.[0])
                    );
                });
            });

            binding.filter([], "Control");
            binding.sort(null);
            binding.filter(filters, "Application");
        }

        // 4) sincronia + sort/group
        sap.ui.getCore().applyChanges();

        if (ctrl._vs) {
            ctrl._prefs = Object.assign({}, ctrl._prefs || {}, {
                sort: snap.uiSort || {},
                group: snap.uiGroup || {}
            });
            ctrl._vs.setPrefs(ctrl._prefs);
            ctrl._vs.applyGroupSortFromPrefs();
        }

        ctrl.__restoringDraft = false;
        try { save(ctrl); } catch (e) { }
    }

    function save(ctrl) {
        const snap = _collectSnapshot(ctrl);
        if (!snap.docId) return false;

        try {
            storage.put(_key(snap.docId), JSON.stringify(snap));
            // atualiza índice
            const idx = _indexGet();
            idx.lastDocId = snap.docId;
            idx.items = idx.items || {};
            idx.items[snap.docId] = {
                savedAt: snap.savedAt,
                rows: Array.isArray(snap.rows) ? snap.rows.length : 0
            };

            // politica de retenção: manter no máx. 5 drafts (mais antigos caem)
            const entries = Object.entries(idx.items).sort((a, b) => String(b[1].savedAt).localeCompare(String(a[1].savedAt)));
            const keep = entries.slice(0, 5);
            const drop = entries.slice(5);
            idx.items = Object.fromEntries(keep);
            drop.forEach(([docId]) => storage.remove(_key(docId)));

            _indexPut(idx);
            return true;
        } catch (e) { return false; }
    }

    let _debounce;
    function autoSave(ctrl, delay = 800) {
        if (ctrl && ctrl.__restoringDraft) return;
        clearTimeout(_debounce);
        _debounce = setTimeout(() => {
            if (ctrl && ctrl.__restoringDraft) return;
            try { save(ctrl); } catch (e) { /* ignore */ }
        }, delay);
    }

    function hasDraft(docId) {
        if (!docId) return false;
        return !!storage.get(_key(docId));
    }

    function load(docId) {
        try { return JSON.parse(storage.get(_key(docId)) || ""); } catch (e) { return null; }
    }

    function restore(ctrl, docId) {
        const snap = load(docId);
        if (!snap) return false;
        _restoreSnapshot(ctrl, snap);
        // coloca o docId no input (qualquer que seja a origem)
        const view = ctrl.getView();
        view.byId("inputDoID")?.setValue(docId);
        return true;
    }

    function clear(docId) {
        try {
            storage.remove(_key(docId));
            const idx = _indexGet();
            if (idx?.items) delete idx.items[docId];
            if (idx?.lastDocId === docId) idx.lastDocId = undefined;
            _indexPut(idx);
        } catch (e) { /* ignore */ }
    }

    function offerRestoreOnEnter(ctrl) {
        const view = ctrl.getView();
        const current = _getDocId(ctrl);
        const idx = _indexGet();
        const items = idx?.items || {};

        // caso 1: tem docId digitado e há draft específico
        if (current && hasDraft(current)) {
            MessageBox.confirm(
                `Existe um rascunho salvo para o DocID ${current}. Deseja restaurar e continuar de onde parou?`,
                {
                    actions: [MessageBox.Action.YES, MessageBox.Action.NO],
                    emphasizedAction: MessageBox.Action.YES,
                    onClose: (act) => { if (act === MessageBox.Action.YES) restore(ctrl, current); }
                }
            );
            return;
        }

        // caso 2: não tem docId digitado, mas há drafts no índice
        const docIds = Object.keys(items);
        if (!docIds.length) return;

        // se só tem um, pergunta direto
        if (docIds.length === 1) {
            const only = docIds[0];
            const savedAtIso = items[only]?.savedAt;
            const savedAtBR = _formatSavedAtBR(savedAtIso); // usa America/Sao_Paulo

            MessageBox.confirm(
                `Encontramos um rascunho de ${only} salvo em ${savedAtBR}. Deseja restaurar agora?`,
                {
                    actions: [MessageBox.Action.YES, MessageBox.Action.NO],
                    emphasizedAction: MessageBox.Action.YES,
                    onClose: (act) => { if (act === MessageBox.Action.YES) restore(ctrl, only); }
                }
            );
            return;
        }

        // ====> SelectDialog (visual igual) + botão "X" por item para excluir
        const data = docIds
            .map(d => ({
                docId: d,
                savedAt: items[d].savedAt,
                savedAtBR: _formatSavedAtBR(items[d].savedAt), // ← hora formatada no BR
                rows: items[d].rows
            }))
            .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));

        const mdl = new JSONModel(data);
        const dlg = new SelectDialog({
            title: "Restaurar rascunho",
            search: function (ev) {
                const q = (ev.getParameter("value") || "").toLowerCase();
                const base = data.slice();
                const filtered = q ? base.filter(d => String(d.docId).toLowerCase().includes(q)) : base;
                mdl.setData(filtered);
            },
            confirm: (ev) => {
                const obj = ev.getParameter("selectedItem")?.getBindingContext()?.getObject();
                if (obj?.docId) restore(ctrl, obj.docId);
                setTimeout(() => dlg.destroy(), 0);
            },
            cancel: () => setTimeout(() => dlg.destroy(), 0)
        });

        // Template via factory para poder aplicar margens e “gap”
        dlg.bindAggregation("items", {
            path: "/",
            factory: function (sId, oCtx) {
                const obj = oCtx.getObject();

                // Linha 1 (DocID) + Linha 2 (data formatada + contagem)
                const txtDoc = new Text({ text: obj.docId, wrapping: false });
                txtDoc.addStyleClass("sapMTextStrong sapUiTinyMarginBottom"); // destaque + respiro

                const txtMeta = new Text({
                    text: `Salvo em ${obj.savedAtBR} · ${obj.rows} linha(s)`,
                    wrapping: false
                });

                const left = new VBox({ items: [txtDoc, txtMeta], width: "100%" });
                // Margem interna (padding visual) no item
                left.addStyleClass("sapUiSmallMarginBeginEnd sapUiTinyMarginTopBottom");

                // Botão “X” (excluir)
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
                                    try { clear(row.docId); } catch (e) { /* ignore */ }
                                    const arr = (mdl.getData() || []).filter(x => x.docId !== row.docId);
                                    mdl.setData(arr);
                                    sap.m.MessageToast.show(`Rascunho ${row.docId} removido.`);
                                    if (!arr.length) setTimeout(() => dlg.close(), 0);
                                }
                            }
                        );

                        // evita “selecionar” o item ao clicar no X
                        oEvent.preventDefault && oEvent.preventDefault();
                        oEvent.cancelBubble = true;
                        oEvent.stopPropagation && oEvent.stopPropagation();
                        oEvent.stopImmediatePropagation && oEvent.stopImmediatePropagation();
                    }
                });
                btnDel.addStyleClass("sapUiSmallMarginEnd"); // respiro na borda direita

                // “Gap” visível entre a coluna de textos e o botão
                const gap = new HBox({ width: "1rem" });

                // Container horizontal com alinhamento e espaçamento
                const row = new HBox({
                    alignItems: "Center",
                    justifyContent: "SpaceBetween",
                    fitContainer: true,
                    items: [left, gap, btnDel]
                });

                // Item selecionável (tocar no item = selecionar)
                const cli = new CustomListItem({ content: [row], type: "Active" });
                // margem inferior pra separar um item do outro
                cli.addStyleClass("sapUiSmallMarginBottom");

                return cli;
            }
        });

        dlg.setModel(mdl);
        view.addDependent(dlg);
        dlg.open();
    }

    function _formatSavedAtBR(isoString) {
        if (!isoString) return "";
        try {
            // Mostra sempre no fuso do Brasil, independente do fuso do navegador
            const dt = new Date(isoString);
            return new Intl.DateTimeFormat("pt-BR", {
                timeZone: "America/Sao_Paulo",
                day: "2-digit", month: "2-digit", year: "numeric",
                hour: "2-digit", minute: "2-digit", second: "2-digit"
            }).format(dt);
        } catch (e) {
            return String(isoString || "");
        }
    }

    return {
        save,
        autoSave,
        hasDraft,
        restore,
        load,
        clear,
        offerRestoreOnEnter
    };
});
