sap.ui.define(
  [
    "sap/m/ViewSettingsDialog",
    "sap/ui/model/Sorter",
    "sap/m/ViewSettingsItem",
    "sap/m/ViewSettingsFilterItem",
    "sap/ui/Device",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/m/ViewSettingsCustomTab",
    "sap/ui/layout/form/SimpleForm",
    "sap/m/Label",
    "sap/m/Input",
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
    Input
  ) {
    "use strict";

    function create(view, prefs, getDistinct, mGroupFunctions) {
      let dlgFilter = null,
        dlgSort = null,
        dlgGroup = null;
      let groupReset = false;
      let sortReset = false;
      const idBase = view.createId("vsd");
      const _id = (suf) => `${idBase}-${suf}`;

      function _ensureFilterDefaults() {
        prefs.filter = prefs.filter || {};
        prefs.filter.fornecedor ||= [];
        prefs.filter.nomeItem   ||= [];
        prefs.filter.moeda      ||= [];
        prefs.filter.centro     ||= [];
        prefs.filter.grupoMat   ||= [];
        prefs.filter.ncm        ||= [];
        if (prefs.filter.precoMin === undefined) prefs.filter.precoMin = null;
        if (prefs.filter.precoMax === undefined) prefs.filter.precoMax = null;
      }
      _ensureFilterDefaults();

      function openFilterDialog(onConfirm) {
        _ensureFilterDefaults();

        if (dlgFilter) {
          dlgFilter.destroy();
          dlgFilter = null;
        }

        dlgFilter = new ViewSettingsDialog({
          confirm: onConfirm,
          reset: () => {
            prefs.filter = {
              fornecedor: [],
              nomeItem:   [],
              moeda:      [],
              centro:     [],
              grupoMat:   [],
              ncm:        [],
              precoMin:   null,
              precoMax:   null
            };
            const core = sap.ui.getCore();
            core.byId(_id("preco-min"))?.setValue("");
            core.byId(_id("preco-max"))?.setValue("");
            applyFiltersFromPrefs();
          }
        });

        if (Device.system.desktop) dlgFilter.addStyleClass("sapUiSizeCompact");
        view.addDependent(dlgFilter);

        function addFilterGroup({ title, groupKey, distinctKey, selectedValues = [] }) {
          const fi = new ViewSettingsFilterItem({ text: title, key: groupKey, multiSelect: true });
          (getDistinct(distinctKey) || []).forEach((val) => {
            const it = new ViewSettingsItem({
              text: val,
              key: `${groupKey}___EQ___${val}`,
            });
            if (selectedValues?.includes(val)) it.setSelected(true);
            fi.addItem(it);
          });
          dlgFilter.addFilterItem(fi);
        };
        addFilterGroup({
          title: "Fornecedor",
          groupKey: "supplierName",
          distinctKey: "supplierName",
          selectedValues: prefs.filter.fornecedor
        });
        addFilterGroup({
          title: "Nome do item",
          groupKey: "itemDescription",
          distinctKey: "itemDescription",
          selectedValues: prefs.filter.nomeItem
        });
        addFilterGroup({
          title: "Moeda",
          groupKey: "currency",
          distinctKey: "currency",
          selectedValues: prefs.filter.moeda
        });
        addFilterGroup({
          title: "Centro",
          groupKey: "PLANT",
          distinctKey: "PLANT",
          selectedValues: prefs.filter.centro
        });
        addFilterGroup({
          title: "Grupo de Materiais",
          groupKey: "grupo_de_materias",
          distinctKey: "grupo_de_materias",
          selectedValues: prefs.filter.grupoMat
        });
        addFilterGroup({
          title: "NCM",
          groupKey: "ncm",
          distinctKey: "ncm",
          selectedValues: prefs.filter.ncm
        });

        const tabFaixas = new ViewSettingsCustomTab({ key: "faixas", title: "Faixas" });
        const form = new SimpleForm({
          editable: true,
          content: [
            new Label({ text: "Preço (min)" }),
            new Input(_id("preco-min"), { type: "Number", width: "10rem", value: prefs.filter.precoMin ?? "" }),
            new Label({ text: "Preço (max)" }),
            new Input(_id("preco-max"), { type: "Number", width: "10rem", value: prefs.filter.precoMax ?? "" })
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
          (grouped[path] ||= []).push(
            new Filter(path, FilterOperator[op] || op, v1, v2)
          );
        });

        const core = sap.ui.getCore();
        const n = (id) => {
          const raw = core.byId(id)?.getValue?.();
          if (raw === "" || raw == null) return null;
          const num = Number(raw);
          return Number.isFinite(num) ? num : null;
        };
        const precoMin = n(_id("preco-min"));
        const precoMax = n(_id("preco-max"));

        const andFilters = [];
        const pushOrGroup = (list, field) => {
          if (!list || !list.length) return;
          andFilters.push(
            new Filter({
              and: false,
              filters: list.map((v) => new Filter(field, FilterOperator.EQ, v))
            })
          );
        };

        const arrSupplier = (grouped.supplierName || []).map(f => String(f.oValue1));
        const arrItem     = (grouped.itemDescription || []).map(f => String(f.oValue1));
        const arrMoeda    = (grouped.currency || []).map(f => String(f.oValue1));
        const arrCentro   = (grouped.PLANT || []).map(f => String(f.oValue1));
        const arrGrpMat   = (grouped.grupo_de_materias || []).map(f => String(f.oValue1));
        const arrNcm      = (grouped.ncm || []).map(f => String(f.oValue1));

        pushOrGroup(arrSupplier, "supplierName");
        pushOrGroup(arrItem,     "itemDescription");
        pushOrGroup(arrMoeda,    "currency");
        pushOrGroup(arrCentro,   "PLANT");
        pushOrGroup(arrGrpMat,   "grupo_de_materias");
        pushOrGroup(arrNcm,      "ncm");

        if (precoMin != null) andFilters.push(new Filter("price", FilterOperator.GE, precoMin));
        if (precoMax != null) andFilters.push(new Filter("price", FilterOperator.LE, precoMax));

        const tbl = view.byId("tblDocs");
        const binding = tbl && tbl.getBinding("items");
        if (binding) binding.filter(andFilters, sap.ui.model.FilterType.Application);

        const prefsNew = Object.assign({}, prefs, {
          filter: {
            fornecedor: arrSupplier,
            nomeItem:   arrItem,
            moeda:      arrMoeda,
            centro:     arrCentro,
            grupoMat:   arrGrpMat,
            ncm:        arrNcm,
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

        const tbl = view.byId("tblDocs");
        if (!tbl) return;
        const binding = tbl.getBinding("items");
        if (!binding) return;

        const groups = [];
        const pushOr = (list, field) => {
          if (list?.length) {
            groups.push(
              new Filter({
                and: false,
                filters: list.map(v => new Filter(field, FilterOperator.EQ, v))
              })
            );
          }
        };

        pushOr(prefs.filter.fornecedor, "supplierName");
        pushOr(prefs.filter.nomeItem,   "itemDescription");
        pushOr(prefs.filter.moeda,      "currency");
        pushOr(prefs.filter.centro,     "PLANT");
        pushOr(prefs.filter.grupoMat,   "grupo_de_materias");
        pushOr(prefs.filter.ncm,        "ncm");

        if (prefs.filter.precoMin != null)
          groups.push(new Filter("price", FilterOperator.GE, prefs.filter.precoMin));
        if (prefs.filter.precoMax != null)
          groups.push(new Filter("price", FilterOperator.LE, prefs.filter.precoMax));

        binding.filter(groups, sap.ui.model.FilterType.Application);

        const bar = view.byId("vsdFilterBar");
        const label = view.byId("vsdFilterLabel");
        if (bar && label) {
          const pieces = [];
          if (prefs.filter.fornecedor?.length) pieces.push(`Fornecedor (${prefs.filter.fornecedor.length})`);
          if (prefs.filter.nomeItem?.length)   pieces.push(`Nome do item (${prefs.filter.nomeItem.length})`);
          if (prefs.filter.moeda?.length)      pieces.push(`Moeda (${prefs.filter.moeda.length})`);
          if (prefs.filter.centro?.length)     pieces.push(`Centro (${prefs.filter.centro.length})`);
          if (prefs.filter.grupoMat?.length)   pieces.push(`Grupo Mat. (${prefs.filter.grupoMat.length})`);
          if (prefs.filter.ncm?.length)        pieces.push(`NCM (${prefs.filter.ncm.length})`);
          if (prefs.filter.precoMin != null || prefs.filter.precoMax != null)
            pieces.push(`Preço ${prefs.filter.precoMin ?? "-"}..${prefs.filter.precoMax ?? "-"}`);

          const has = pieces.length > 0;
          bar.setVisible(has);
          label.setText(has ? pieces.join(" | ") : "");
        }
      }

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
          view.addDependent(dlgSort);
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
        const tbl = view.byId("tblDocs");
        const binding = tbl.getBinding("items");
        const sorters = [];

        if (prefs.group?.key) {
          sorters.push(new Sorter(
            prefs.group.key,
            !!prefs.group.desc,
            mGroupFunctions?.[prefs.group.key] || true // fallback: agrupamento simples
          ));
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
          view.addDependent(dlgGroup);
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
        const tbl = view.byId("tblDocs");
        const binding = tbl.getBinding("items");

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
        const tbl = view.byId("tblDocs");
        if (!tbl) return;
        const binding = tbl.getBinding("items");
        if (!binding) return;

        const sorters = [];
        if (prefs.group?.key)
          sorters.push(
            new Sorter(
              prefs.group.key,
              !!prefs.group.desc,
              mGroupFunctions?.[prefs.group.key] || true
            ),
          );
        if (prefs.sort?.key) {
          const numericKeys = ["price", "EXTENDEDPRICE", "quantity", "mva"];
          if (numericKeys.includes(prefs.sort.key)) {
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
