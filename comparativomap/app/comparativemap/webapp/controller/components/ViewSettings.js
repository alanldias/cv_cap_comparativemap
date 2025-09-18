sap.ui.define(
  [
    "sap/m/ViewSettingsDialog",
    "sap/ui/model/Sorter",
    "sap/m/ViewSettingsItem",
    "sap/m/ViewSettingsFilterItem",
    "sap/ui/Device",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
  ],
  function (
    ViewSettingsDialog,
    Sorter,
    ViewSettingsItem,
    ViewSettingsFilterItem,
    Device,
    Filter,
    FilterOperator,
  ) {
    "use strict";

    function create(view, prefs, getDistinct, mGroupFunctions) {
      let dlgFilter = null,
        dlgSort = null,
        dlgGroup = null;
      let groupReset = false;
      let sortReset = false;

      function openFilterDialog(onConfirm) {
        if (dlgFilter) {
          dlgFilter.destroy();
          dlgFilter = null;
        };
        dlgFilter = new ViewSettingsDialog({ confirm: onConfirm });
        if (Device.system.desktop) dlgFilter.addStyleClass("sapUiSizeCompact");
        view.addDependent(dlgFilter);

        const fiForn = new ViewSettingsFilterItem({
          text: "Fornecedor",
          key: "supplierName",
        });
        getDistinct("supplierName").forEach((val) => {
          const it = new ViewSettingsItem({
            text: val,
            key: `supplierName___EQ___${val}`,
          });
          if (prefs.filter.fornecedor?.includes(val)) it.setSelected(true);
          fiForn.addItem(it);
        });
        dlgFilter.addFilterItem(fiForn);

        const fiNome = new ViewSettingsFilterItem({
          text: "Nome do item",
          key: "itemDescription",
        });
        getDistinct("itemDescription").forEach((val) => {
          const it = new ViewSettingsItem({
            text: val,
            key: `itemDescription___EQ___${val}`,
          });
          if (prefs.filter.nomeItem?.includes(val)) it.setSelected(true);
          fiNome.addItem(it);
        });
        dlgFilter.addFilterItem(fiNome);

        dlgFilter.open();
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
          { text: "Preço", key: "price" }
        ].forEach(f => dlgSort.addSortItem(new ViewSettingsItem(f)));

        if (prefs.sort.key) {
          dlgSort.setSelectedSortItem(prefs.sort.key);
          dlgSort.setSortDescending(!!prefs.sort.desc);
        } else {
          dlgSort.setSelectedSortItem(null);
          dlgSort.setSortDescending(false);
        }
        dlgSort.open();
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
          { text: "Item", key: "itemId" }
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

      function applyFiltersFromPrefs() {
        const tbl = view.byId("tblDocs");
        if (!tbl) return;
        const binding = tbl.getBinding("items");
        if (!binding) return;

        const groups = [];
        if (prefs.filter.fornecedor?.length) {
          groups.push(
            new Filter({
              and: false,
              filters: prefs.filter.fornecedor.map(
                (v) => new Filter("supplierName", FilterOperator.EQ, v),
              ),
            }),
          );
        }
        if (prefs.filter.nomeItem?.length) {
          groups.push(
            new Filter({
              and: false,
              filters: prefs.filter.nomeItem.map(
                (v) => new Filter("itemDescription", FilterOperator.EQ, v),
              ),
            }),
          );
        }
        binding.filter(groups);

        const bar = view.byId("vsdFilterBar");
        const label = view.byId("vsdFilterLabel");
        if (bar && label) {
          if (groups.length) {
            bar.setVisible(true);
            const legend = [
              prefs.filter.fornecedor?.length
                ? `Fornecedor: ${prefs.filter.fornecedor.join(", ")}`
                : "",
              prefs.filter.nomeItem?.length
                ? `Nome do item: ${prefs.filter.nomeItem.join(", ")}`
                : "",
            ]
              .filter(Boolean)
              .join("  |  ");
            label.setText(legend);
          } else {
            bar.setVisible(false);
            label.setText("");
          }
        }
      }

      function applyGroupSortFromPrefs() {
        const tbl = view.byId("tblDocs");
        if (!tbl) return;
        const binding = tbl.getBinding("items");
        if (!binding) return;

        const sorters = [];
        if (prefs.group.key)
          sorters.push(
            new Sorter(
              prefs.group.key,
              !!prefs.group.desc,
              mGroupFunctions[prefs.group.key],
            ),
          );
        if (prefs.sort.key) {
          if (prefs.sort.key === "price") {
            const s = new Sorter("price", !!prefs.sort.desc);
            s.fnCompare = numCompare; // ✅
            sorters.push(s);
          } else {
            sorters.push(new Sorter(prefs.sort.key, !!prefs.sort.desc));
          }
        }
        if (sorters.length) binding.sort(sorters);
      }
      function handleFilterDialogConfirm(ev, onSave) {
        const selected = ev.getParameters().filterItems || [];

        const grouped = {};
        selected.forEach((item) => {
          const [path, op, v1, v2] = String(item.getKey() || "").split("___");
          (grouped[path] ||= []).push(
            new Filter(path, FilterOperator[op] || op, v1, v2)
          );
        });

        const andFilters = Object.keys(grouped).map((path) => {
          const arr = grouped[path];
          return arr.length > 1 ? new Filter({ filters: arr, and: false }) : arr[0];
        });

        const tbl = view.byId("tblDocs");
        const binding = tbl && tbl.getBinding("items");
        if (binding) binding.filter(andFilters);

        const prefsNew = Object.assign({}, prefs, {
          filter: {
            fornecedor: (grouped.supplierName || []).map((f) => String(f.oValue1)),
            nomeItem: (grouped.itemDescription || []).map((f) => String(f.oValue1))
          }
        });

        onSave && onSave(prefsNew);

        prefs = prefsNew;

        applyFiltersFromPrefs();
      }

      function numCompare(a, b) {
        const an = Number(a); const bn = Number(b);
        const ax = isNaN(an) ? 0 : an;
        const bx = isNaN(bn) ? 0 : bn;
        return ax - bx;
      }


      function handleSortDialogConfirm(ev, onSave) {
        const m = ev.getParameters();
        const tbl = view.byId("tblDocs");
        const binding = tbl.getBinding("items");
        const sorters = [];

        if (prefs.group.key) {
          sorters.push(new Sorter(
            prefs.group.key,
            !!prefs.group.desc,
            mGroupFunctions[prefs.group.key]
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

        if (sPath === "price") {
          const s = new Sorter("price", bDesc);
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

      function handleGroupDialogConfirm(ev, onSave) {
        const m = ev.getParameters();
        const tbl = view.byId("tblDocs");
        const binding = tbl.getBinding("items");

        const applyOnlySort = () => {
          const arr = [];
          if (prefs.sort?.key) {
            if (prefs.sort.key === "price") {
              const s = new Sorter("price", !!prefs.sort.desc);
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
        const vGroup = mGroupFunctions[sPath];

        const arr = [new Sorter(sPath, bDesc, vGroup)];
        if (prefs.sort?.key) {
          if (prefs.sort.key === "price") {
            const s = new Sorter("price", !!prefs.sort.desc);
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

      function setPrefs(newPrefs) { prefs = newPrefs; }

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
  },
);
