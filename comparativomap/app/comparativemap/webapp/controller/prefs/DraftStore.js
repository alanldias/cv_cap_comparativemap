sap.ui.define([
    "sap/ui/util/Storage",
    "sap/m/MessageBox",
    "sap/m/SelectDialog",
    "sap/m/StandardListItem",
    "sap/ui/model/json/JSONModel"
], function (Storage, MessageBox, SelectDialog, StandardListItem, JSONModel) {
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
        vm?.setProperty("/headerRows", Array.isArray(snap.headerRows) ? snap.headerRows : (snap.header ? [snap.header] : []));
        vm?.setProperty("/rows", Array.isArray(snap.rows) ? snap.rows : []);

        // 2) colunas (sem mexer diretamente nas colunas do sap.m.Table)
        if (ui && snap.uiColumns) {
            ui.setProperty("/columns", { ...(snap.uiColumns.map || {}) });

            const orderIds = Array.isArray(snap.uiColumns.order)
                ? snap.uiColumns.order.map(o => o.id)
                : [];

            if (orderIds.length) {
                ui.setProperty("/columnOrder", orderIds);
                try {
                    const Filtros = sap.ui.requireSync("comparativemap/comparativemap/controller/helpers/filtros");
                    Filtros && Filtros.applyColumnOrder(ctrl);
                } catch (e) {
                    console.warn("Não consegui carregar 'filtros' (orderIds):", e);
                }
            }
        }

        try {
            const Filtros = sap.ui.requireSync("comparativemap/comparativemap/controller/helpers/filtros");
            if (Filtros) {
                Filtros.captureColCellMap(ctrl);
                Filtros.applyColumnOrder(ctrl);
            }
        } catch (e) {
            console.warn("Não consegui carregar 'filtros' (capture+apply):", e);
        }
        // Condições compactadas (descarta placeholders que a UI possa ter salvo)
        // Condições compactadas (tira placeholders) e memorizadas como "last good"
        const cleanConds = _compactConditions(snap.conditions || {});
        ctrl._pendingConditions = cleanConds;
        ctrl.__lastAppliedConditions = cleanConds;

        // 3) filtros (aplicando no ConditionModel e na tabela)
        const cm = view.getModel("cm");
        if (cm && typeof cm.setAllConditions === "function") {
            cm.removeAllConditions();
            cm.setAllConditions(cleanConds);
            cm.checkUpdate(true);
        }

        // 4) re-aplica filtros no binding da tabela (FilterType.Application)
        const binding = view.byId("tblDocs")?.getBinding("items");
        if (binding) {
            // converte as condições em UI5 Filters
            const Filter = sap.ui.requireSync("sap/ui/model/Filter");
            const FilterOperator = sap.ui.requireSync("sap/ui/model/FilterOperator");
            const FO = {
                EQ: FilterOperator.EQ, BT: FilterOperator.BT,
                GE: FilterOperator.GE, LE: FilterOperator.LE,
                GT: FilterOperator.GT, LT: FilterOperator.LT,
                Contains: FilterOperator.Contains,
                StartsWith: FilterOperator.StartsWith,
                EndsWith: FilterOperator.EndsWith
            };
            const conds = cleanConds;
            const filters = [];
            Object.keys(conds).forEach(field => {
                (conds[field] || []).forEach(c => {
                    const op = FO[c.operator] || FilterOperator.EQ;
                    if (op === FilterOperator.BT) {
                        filters.push(new Filter(field, op, c.values?.[0], c.values?.[1]));
                    } else {
                        filters.push(new Filter(field, op, c.values?.[0]));
                    }
                });
            });

            binding.filter([], "Control");
            binding.sort(null);
            binding.filter(filters, "Application");
        }

        // 5) sincronia de UI
        sap.ui.getCore().applyChanges();

        // 6) sort e group (via seu ViewSettingsCmp)
        if (ctrl._vs) {
            // injeta no _prefs do controller e aplica
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
            MessageBox.confirm(
                `Encontramos um rascunho de ${only} salvo em ${items[only].savedAt}. Deseja restaurar agora?`,
                {
                    actions: [MessageBox.Action.YES, MessageBox.Action.NO],
                    emphasizedAction: MessageBox.Action.YES,
                    onClose: (act) => { if (act === MessageBox.Action.YES) restore(ctrl, only); }
                }
            );
            return;
        }

        // senão, lista para escolha
        const data = docIds
            .map(d => ({ docId: d, savedAt: items[d].savedAt, rows: items[d].rows }))
            .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));

        const dlg = new SelectDialog({
            title: "Restaurar rascunho",
            items: {
                path: "/",
                template: new StandardListItem({
                    title: "{docId}",
                    description: "{savedAt}",
                    info: "{= ${rows} + ' linha(s)'}"
                })
            },
            confirm: (ev) => {
                const obj = ev.getParameter("selectedItem")?.getBindingContext()?.getObject();
                if (obj?.docId) restore(ctrl, obj.docId);
                setTimeout(() => dlg.destroy(), 0);
            },
            cancel: () => setTimeout(() => dlg.destroy(), 0)
        });
        dlg.setModel(new JSONModel(data));
        view.addDependent(dlg);
        dlg.open();
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
