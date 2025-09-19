sap.ui.define(
  [
    "sap/m/ViewSettingsDialog",
    "sap/ui/model/Sorter",
    "sap/m/ViewSettingsItem",
    "sap/m/ViewSettingsFilterItem",
    "sap/ui/Device",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    // custom tab (faixas)
    "sap/m/ViewSettingsCustomTab",
    "sap/ui/layout/form/SimpleForm",
    "sap/m/Label",
    "sap/m/Input",
    "sap/ui/core/format/NumberFormat",
  ],
  function (
    ViewSettingsDialog,
    Sorter,
    ViewSettingsItem,
    ViewSettingsFilterItem,
    Device,
    Filter,
    FilterOperator,
    ViewSettingsCustomTab,
    SimpleForm,
    Label,
    Input,
    NumberFormat
  ) {
    "use strict";

    /**
     * create(view, prefs, getDistinct, mGroupFunctions, findTable?, idsOpts?)
     *  - view: View OU Dialog (qualquer Control com addDependent)
     *  - prefs: { filter:{...}, sort:{key,desc}, group:{key,desc} }
     *  - getDistinct(path): () => string[]
     *  - mGroupFunctions: { key: fn(ctx)->{key,text} }
     *  - findTable: () => sap.m.Table  (quando usado em fragment)
     *  - idsOpts: { filterBarId, filterLabelId }  (ids da infoToolbar)
     */
    function create(view, prefs, getDistinct, mGroupFunctions, findTable, idsOpts) {
      let dlgFilter = null,
        dlgSort = null,
        dlgGroup = null;
      let groupReset = false;
      let sortReset = false;

      // IDs compatíveis com View OU Dialog/Fragment
      const _ownerId = (view && view.getId && view.getId()) || "";
      const _hasCreateId = !!(view && view.createId);
      // idsOpts.fragmentScopeId (quando usado dentro de fragment/dialog)
      const _fragmentScopeId = idsOpts && idsOpts.fragmentScopeId;

      function _id(suf) {
        // se for uma View, use createId
        if (_hasCreateId) return view.createId(`vsd-${suf}`);
        // senão, componha um globalId com o ownerId (Dialog/Fragment)
        return _ownerId ? `${_ownerId}--vsd-${suf}` : `vsd-${suf}`;
      }

      // helpers para achar controles tanto na View quanto no Fragment/Dialog
      function _getByIdAny(id) {
        if (!id) return null;

        // 1) tenta pela própria view (se for uma View)
        if (view.byId) {
          const c = view.byId(id);
          if (c) return c;
        }

        // 2) tenta dentro do fragment/dialog (escopado)
        if (sap.ui.core.Fragment && sap.ui.core.Fragment.byId) {
          // 2.1) se recebemos o scope do fragment, priorize ele
          if (_fragmentScopeId) {
            const c1 = sap.ui.core.Fragment.byId(_fragmentScopeId, id);
            if (c1) return c1;
          }
          // 2.2) senão, tente com o ownerId do Dialog/Fragment
          if (_ownerId) {
            const c2 = sap.ui.core.Fragment.byId(_ownerId, id);
            if (c2) return c2;
          }
        }

        return null;
      }

      function _getTable() {
        const t = (typeof findTable === "function" && findTable());
        return t || (view.byId && view.byId("tblDocs")) || null;
      }
      function _getFilterBar() {
        const id = (idsOpts && idsOpts.filterBarId) || "vsdFilterBar";
        return _getByIdAny(id);
      }
      function _getFilterLabel() {
        const id = (idsOpts && idsOpts.filterLabelId) || "vsdFilterLabel";
        return _getByIdAny(id);
      }
      function _addDependent(ctrl) {
        if (view.addDependent) view.addDependent(ctrl);
      }

      // garante estrutura padrão no prefs.filter
      function _ensureFilterDefaults() {
        prefs.filter = prefs.filter || {};
        prefs.filter.fornecedor ||= [];
        prefs.filter.nomeItem ||= [];
        prefs.filter.moeda ||= [];
        prefs.filter.centro ||= [];
        prefs.filter.grupoMat ||= [];
        prefs.filter.ncm ||= [];
        if (prefs.filter.precoMin === undefined) prefs.filter.precoMin = null;
        if (prefs.filter.precoMax === undefined) prefs.filter.precoMax = null;
      }
      _ensureFilterDefaults();

      // parse respeitando locale
      const nf = NumberFormat.getFloatInstance();
      function parseNumLocalized(v) {
        if (v == null || v === "") return null;
        const n = nf.parse(String(v));
        return Number.isFinite(n) ? n : null;
      }

      /* ==========================
       *   FILTER DIALOG
       * ========================== */
      function openFilterDialog(onConfirm) {
        _ensureFilterDefaults();

        if (dlgFilter) {
          dlgFilter.destroy();
          dlgFilter = null;
        }
        dlgFilter = new ViewSettingsDialog({
          confirm: onConfirm,
          reset: () => {
            dlgFilter.getFilterItems().forEach(fi => fi.getItems().forEach(it => it.setSelected(false)));
            sap.ui.getCore().byId(_id("preco-min"))?.setValue("");
            sap.ui.getCore().byId(_id("preco-max"))?.setValue("");
            const prefsNew = Object.assign({}, prefs, {
              filter: {
                fornecedor: [], nomeItem: [], moeda: [], centro: [], grupoMat: [], ncm: [],
                precoMin: null, precoMax: null
              }
            });
            prefs = prefsNew;
            applyFiltersFromPrefs();
          }
        });
        if (Device.system.desktop) dlgFilter.addStyleClass("sapUiSizeCompact");
        _addDependent(dlgFilter);

        function addFilterGroup({ title, groupKey, distinctKey, selectedValues = [] }) {
          const fi = new ViewSettingsFilterItem({ text: title, key: groupKey, multiSelect: true });
          (getDistinct(distinctKey) || []).forEach((val) => {
            const it = new ViewSettingsItem({ text: val, key: `${groupKey}___EQ___${val}` });
            if (selectedValues?.includes(val)) it.setSelected(true);
            fi.addItem(it);
          });
          dlgFilter.addFilterItem(fi);
        }

        addFilterGroup({ title: "Fornecedor", groupKey: "supplierName", distinctKey: "supplierName", selectedValues: prefs.filter.fornecedor });
        addFilterGroup({ title: "Nome do item", groupKey: "itemDescription", distinctKey: "itemDescription", selectedValues: prefs.filter.nomeItem });
        addFilterGroup({ title: "Moeda", groupKey: "currency", distinctKey: "currency", selectedValues: prefs.filter.moeda });
        addFilterGroup({ title: "Centro", groupKey: "PLANT", distinctKey: "PLANT", selectedValues: prefs.filter.centro });
        addFilterGroup({ title: "Grupo de Materiais", groupKey: "grupo_de_materias", distinctKey: "grupo_de_materias", selectedValues: prefs.filter.grupoMat });
        addFilterGroup({ title: "NCM", groupKey: "ncm", distinctKey: "ncm", selectedValues: prefs.filter.ncm });

        const tabFaixas = new ViewSettingsCustomTab({ key: "faixas", title: "Faixas" });
        const form = new SimpleForm({
          editable: true,
          content: [
            new Label({ text: "Preço (mín)" }),
            new Input(_id("preco-min"), { type: "Number", width: "10rem", value: prefs.filter.precoMin ?? "" }),
            new Label({ text: "Preço (máx)" }),
            new Input(_id("preco-max"), { type: "Number", width: "10rem", value: prefs.filter.precoMax ?? "" }),
          ]
        });
        tabFaixas.addContent(form);
        dlgFilter.addCustomTab(tabFaixas);

        dlgFilter.open();
      }

      function handleFilterDialogConfirm(ev, onSave) {
        _ensureFilterDefaults();

        const selected = ev.getParameters().filterItems || [];
        const grouped = {};
        selected.forEach((item) => {
          const key = String(item.getKey() || "");
          const [path, op, v1, v2] = key.split("___");
          (grouped[path] ||= []).push(new Filter(path, FilterOperator[op] || op, v1, v2));
        });

        const core = sap.ui.getCore();
        const precoMin = parseNumLocalized(core.byId(_id("preco-min"))?.getValue?.());
        const precoMax = parseNumLocalized(core.byId(_id("preco-max"))?.getValue?.());

        const andFilters = [];
        const pushOrGroup = (list, field) => {
          if (!list || !list.length) return;
          andFilters.push(new Filter({ and: false, filters: list.map((v) => new Filter(field, FilterOperator.EQ, v)) }));
        };

        const arrSupplier = (grouped.supplierName || []).map(f => String(f.oValue1));
        const arrItem = (grouped.itemDescription || []).map(f => String(f.oValue1));
        const arrMoeda = (grouped.currency || []).map(f => String(f.oValue1));
        const arrCentro = (grouped.PLANT || []).map(f => String(f.oValue1));
        const arrGrpMat = (grouped.grupo_de_materias || []).map(f => String(f.oValue1));
        const arrNcm = (grouped.ncm || []).map(f => String(f.oValue1));

        pushOrGroup(arrSupplier, "supplierName");
        pushOrGroup(arrItem, "itemDescription");
        pushOrGroup(arrMoeda, "currency");
        pushOrGroup(arrCentro, "PLANT");
        pushOrGroup(arrGrpMat, "grupo_de_materias");
        pushOrGroup(arrNcm, "ncm");

        if (precoMin != null && precoMax != null && precoMin <= precoMax) {
          andFilters.push(new Filter("price", FilterOperator.BT, precoMin, precoMax));
        } else {
          if (precoMin != null) andFilters.push(new Filter("price", FilterOperator.GE, precoMin));
          if (precoMax != null) andFilters.push(new Filter("price", FilterOperator.LE, precoMax));
        }

        const tbl = _getTable();
        const binding = tbl && tbl.getBinding("items");
        if (binding) binding.filter(andFilters, sap.ui.model.FilterType.Application);

        const prefsNew = Object.assign({}, prefs, {
          filter: {
            fornecedor: arrSupplier,
            nomeItem: arrItem,
            moeda: arrMoeda,
            centro: arrCentro,
            grupoMat: arrGrpMat,
            ncm: arrNcm,
            precoMin,
            precoMax
          }
        });
        onSave && onSave(prefsNew);
        prefs = prefsNew;

        applyFiltersFromPrefs();
      }

      function applyFiltersFromPrefs() {
        _ensureFilterDefaults();

        const tbl = _getTable();
        if (!tbl) return;
        const binding = tbl.getBinding("items");
        if (!binding) return;

        const groups = [];
        const pushOr = (list, field) => {
          if (list?.length) {
            groups.push(new Filter({ and: false, filters: list.map(v => new Filter(field, FilterOperator.EQ, v)) }));
          }
        };

        pushOr(prefs.filter.fornecedor, "supplierName");
        pushOr(prefs.filter.nomeItem, "itemDescription");
        pushOr(prefs.filter.moeda, "currency");
        pushOr(prefs.filter.centro, "PLANT");
        pushOr(prefs.filter.grupoMat, "grupo_de_materias");
        pushOr(prefs.filter.ncm, "ncm");

        const hasMin = prefs.filter.precoMin != null;
        const hasMax = prefs.filter.precoMax != null;
        if (hasMin && hasMax && prefs.filter.precoMin <= prefs.filter.precoMax) {
          groups.push(new Filter("price", FilterOperator.BT, prefs.filter.precoMin, prefs.filter.precoMax));
        } else {
          if (hasMin) groups.push(new Filter("price", FilterOperator.GE, prefs.filter.precoMin));
          if (hasMax) groups.push(new Filter("price", FilterOperator.LE, prefs.filter.precoMax));
        }

        binding.filter(groups, sap.ui.model.FilterType.Application);

        const bar = _getFilterBar();
        const label = _getFilterLabel();
        if (bar && label) {
          const pieces = [];
          if (prefs.filter.fornecedor?.length) pieces.push(`Fornecedor (${prefs.filter.fornecedor.length})`);
          if (prefs.filter.nomeItem?.length) pieces.push(`Nome do item (${prefs.filter.nomeItem.length})`);
          if (prefs.filter.moeda?.length) pieces.push(`Moeda (${prefs.filter.moeda.length})`);
          if (prefs.filter.centro?.length) pieces.push(`Centro (${prefs.filter.centro.length})`);
          if (prefs.filter.grupoMat?.length) pieces.push(`Grupo Mat. (${prefs.filter.grupoMat.length})`);
          if (prefs.filter.ncm?.length) pieces.push(`NCM (${prefs.filter.ncm.length})`);
          if (hasMin || hasMax) pieces.push(`Preço ${hasMin ? prefs.filter.precoMin : "-"}..${hasMax ? prefs.filter.precoMax : "-"}`);

          const has = pieces.length > 0;
          bar.setVisible(has);
          label.setText(has ? pieces.join(" | ") : "");
        }
      }

      /* ==========================
       *   SORT / GROUP
       * ========================== */
      function numCompare(a, b) {
        const an = Number(a); const bn = Number(b);
        const ax = isNaN(an) ? 0 : an;
        const bx = isNaN(bn) ? 0 : bn;
        return ax - bx;
      }

      function openSortDialog(onConfirm, onReset) {
        if (!dlgSort) {
          dlgSort = new ViewSettingsDialog({
            confirm: onConfirm,
            reset: () => {
              sortReset = true;
              dlgSort.setSelectedSortItem(null);
              dlgSort.setSortDescending(false);
              onReset && onReset();
            }
          });
          if (Device.system.desktop) dlgSort.addStyleClass("sapUiSizeCompact");
          _addDependent(dlgSort);
        }
        dlgSort.destroySortItems();
        [
          { text: "Fornecedor", key: "supplierName" },
          { text: "Nome do item", key: "itemDescription" },
          { text: "Preço", key: "price" },
          { text: "Preço Estendido", key: "EXTENDEDPRICE" },
          { text: "Quantidade", key: "quantity" },
          { text: "Moeda", key: "currency" },
          { text: "Centro", key: "PLANT" },
          { text: "Grupo Mat.", key: "grupo_de_materias" },
          { text: "NCM", key: "ncm" },
          { text: "MVA", key: "mva" },
          { text: "Código Material", key: "MaterialCode" },
          { text: "Categoria Item", key: "ItemCategory" }
        ].forEach(f => dlgSort.addSortItem(new ViewSettingsItem(f)));

        if (prefs.sort?.key) {
          dlgSort.setSelectedSortItem(prefs.sort.key);
          dlgSort.setSortDescending(!!prefs.sort.desc);
        } else {
          dlgSort.setSelectedSortItem(null);
          dlgSort.setSortDescending(false);
        }
        dlgSort.open();
      }

      function handleSortDialogConfirm(ev, onSave) {
        const m = ev.getParameters();
        const tbl = _getTable();
        const binding = tbl && tbl.getBinding("items");
        const sorters = [];

        if (prefs.group?.key) {
          sorters.push(new Sorter(prefs.group.key, !!prefs.group.desc, mGroupFunctions?.[prefs.group.key] || true));
        }

        if (sortReset || !m.sortItem) {
          binding.sort(sorters.length ? sorters : null);
          const prefsNew = Object.assign({}, prefs, { sort: { key: null, desc: false } });
          onSave && onSave(prefsNew);
          prefs = prefsNew;
          dlgSort.setSelectedSortItem(null);
          dlgSort.setSortDescending(false);
          sortReset = false;
          return;
        }

        const sPath = m.sortItem.getKey();
        const bDesc = m.sortDescending;
        const numericKeys = ["price", "EXTENDEDPRICE", "quantity", "mva"];
        if (numericKeys.includes(sPath)) {
          const s = new Sorter(sPath, bDesc);
          s.fnCompare = numCompare;
          sorters.push(s);
        } else {
          sorters.push(new Sorter(sPath, bDesc));
        }

        binding.sort(sorters);

        const prefsNew = Object.assign({}, prefs, { sort: { key: sPath, desc: !!bDesc } });
        onSave && onSave(prefsNew);
        prefs = prefsNew;
      }

      function openGroupDialog(onConfirm, onReset) {
        if (!dlgGroup) {
          dlgGroup = new ViewSettingsDialog({
            confirm: onConfirm,
            reset: () => {
              groupReset = true;
              dlgGroup.setSelectedGroupItem("");
              dlgGroup.setGroupDescending(false);
              onReset && onReset();
            }
          });
          if (Device.system.desktop) dlgGroup.addStyleClass("sapUiSizeCompact");
          _addDependent(dlgGroup);
        }

        dlgGroup.destroyGroupItems();
        [
          { text: "Fornecedor", key: "supplierName" },
          { text: "Item", key: "itemId" },
          { text: "Centro", key: "PLANT" },
          { text: "Moeda", key: "currency" },
          { text: "Grupo Mat.", key: "grupo_de_materias" },
          { text: "Código Material", key: "MaterialCode" },
          { text: "Categoria Item", key: "ItemCategory" }
        ].forEach(g => dlgGroup.addGroupItem(new ViewSettingsItem(g)));

        if (prefs.group?.key) {
          dlgGroup.setSelectedGroupItem(prefs.group.key);
          dlgGroup.setGroupDescending(!!prefs.group.desc);
        } else {
          dlgGroup.setSelectedGroupItem("");
          dlgGroup.setGroupDescending(false);
        }

        dlgGroup.open();
      }

      function handleGroupDialogConfirm(ev, onSave) {
        const m = ev.getParameters();
        const tbl = _getTable();
        const binding = tbl && tbl.getBinding("items");

        const applyOnlySort = () => {
          const arr = [];
          if (prefs.sort?.key) {
            const numericKeys = ["price", "EXTENDEDPRICE", "quantity", "mva"];
            if (numericKeys.includes(prefs.sort.key)) {
              const s = new Sorter(prefs.sort.key, !!prefs.sort.desc);
              s.fnCompare = numCompare;
              arr.push(s);
            } else {
              arr.push(new Sorter(prefs.sort.key, !!prefs.sort.desc));
            }
          }
          binding.sort(arr.length ? arr : null);
        };

        if (groupReset || !m.groupItem) {
          applyOnlySort();
          const prefsNew = Object.assign({}, prefs, { group: { key: null, desc: false } });
          onSave && onSave(prefsNew);
          prefs = prefsNew;
          dlgGroup.setSelectedGroupItem("");
          dlgGroup.setGroupDescending(false);
          groupReset = false;
          return;
        }

        const sPath = m.groupItem.getKey();
        const bDesc = m.groupDescending;
        const vGroup = mGroupFunctions?.[sPath] || true;

        const arr = [new Sorter(sPath, bDesc, vGroup)];
        if (prefs.sort?.key) {
          const numericKeys = ["price", "EXTENDEDPRICE", "quantity", "mva"];
          if (numericKeys.includes(prefs.sort.key)) {
            const s = new Sorter(prefs.sort.key, !!prefs.sort.desc);
            s.fnCompare = numCompare;
            arr.push(s);
          } else {
            arr.push(new Sorter(prefs.sort.key, !!prefs.sort.desc));
          }
        }
        binding.sort(arr);

        const prefsNew = Object.assign({}, prefs, { group: { key: sPath, desc: !!bDesc } });
        onSave && onSave(prefsNew);
        prefs = prefsNew;
      }

      function applyGroupSortFromPrefs() {
        const tbl = _getTable();
        if (!tbl) return;
        const binding = tbl.getBinding("items");
        if (!binding) return;

        const sorters = [];
        if (prefs.group?.key)
          sorters.push(new Sorter(prefs.group.key, !!prefs.group.desc, mGroupFunctions?.[prefs.group.key] || true));
        if (prefs.sort?.key) {
          if (["price", "EXTENDEDPRICE", "quantity", "mva"].includes(prefs.sort.key)) {
            const s = new Sorter(prefs.sort.key, !!prefs.sort.desc);
            s.fnCompare = numCompare;
            sorters.push(s);
          } else {
            sorters.push(new Sorter(prefs.sort.key, !!prefs.sort.desc));
          }
        }
        if (sorters.length) binding.sort(sorters);
      }

      function setPrefs(newPrefs) {
        prefs = newPrefs || {};
        _ensureFilterDefaults();
      }

      return {
        openFilterDialog,
        openSortDialog,
        openGroupDialog,
        handleFilterDialogConfirm,
        handleSortDialogConfirm,
        handleGroupDialogConfirm,
        applyFiltersFromPrefs,
        applyGroupSortFromPrefs,
        setPrefs
      };
    }

    return { create };
  }
);
