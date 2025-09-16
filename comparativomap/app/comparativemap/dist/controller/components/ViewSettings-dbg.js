sap.ui.define(
  [
    "sap/m/ViewSettingsDialog",
    "sap/m/ViewSettingsItem",
    "sap/m/ViewSettingsFilterItem",
    "sap/ui/Device",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
  ],
  function (
    ViewSettingsDialog,
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
        dlgGroup = null,
        groupReset = false;

      function openFilterDialog(onConfirm) {
        if (dlgFilter) {
          dlgFilter.destroy();
          dlgFilter = null;
        }
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

      function openSortDialog(onConfirm) {
        if (!dlgSort) {
          dlgSort = new ViewSettingsDialog({ confirm: onConfirm });
          if (Device.system.desktop) dlgSort.addStyleClass("sapUiSizeCompact");
          view.addDependent(dlgSort);
        }
        dlgSort.destroySortItems();
        [
          { text: "Fornecedor", key: "supplierName" },
          { text: "Nome do item", key: "itemDescription" },
          { text: "Tipo de pedido", key: "arb_Document_Type" },
          { text: "Org. Compras", key: "arb_PurchasingOrganization" },
          { text: "Grp. Compradores", key: "arb_PurchasingGroup" },
          { text: "Empresa", key: "arb_CompanyCode" },
        ].forEach((f) => dlgSort.addSortItem(new ViewSettingsItem(f)));

        if (prefs.sort.key) {
          dlgSort.setSelectedSortItem(prefs.sort.key);
          dlgSort.setSortDescending(!!prefs.sort.desc);
        }
        dlgSort.open();
      }

      function openGroupDialog(onConfirm, onReset) {
        if (!dlgGroup) {
          dlgGroup = new ViewSettingsDialog({
            confirm: onConfirm,
            reset: () => {
              groupReset = true;
              onReset?.();
            },
          });
          if (Device.system.desktop) dlgGroup.addStyleClass("sapUiSizeCompact");
          view.addDependent(dlgGroup);
        }
        dlgGroup.destroyGroupItems();
        [
          { text: "Fornecedor", key: "supplierName" },
          { text: "Org. Compras", key: "arb_PurchasingOrganization" },
          { text: "Empresa", key: "arb_CompanyCode" },
        ].forEach((g) => dlgGroup.addGroupItem(new ViewSettingsItem(g)));

        if (prefs.group.key) {
          dlgGroup.setSelectedGroupItem(prefs.group.key);
          dlgGroup.setGroupDescending(!!prefs.group.desc);
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
            new sap.ui.model.Sorter(
              prefs.group.key,
              !!prefs.group.desc,
              mGroupFunctions[prefs.group.key],
            ),
          );
        if (prefs.sort.key)
          sorters.push(
            new sap.ui.model.Sorter(prefs.sort.key, !!prefs.sort.desc),
          );
        if (sorters.length) binding.sort(sorters);
      }

      function handleFilterDialogConfirm(ev, onSave) {
        const selected = ev.getParameters().filterItems || [];
        const grouped = {};
        selected.forEach((item) => {
          const [path, op, v1, v2] = item.getKey().split("___");
          (grouped[path] ||= []).push(
            new sap.ui.model.Filter(
              path,
              sap.ui.model.FilterOperator[op] || op,
              v1,
              v2,
            ),
          );
        });
        const andFilters = [];
        Object.keys(grouped).forEach((path) => {
          const arr = grouped[path];
          andFilters.push(
            arr.length > 1
              ? new sap.ui.model.Filter({ filters: arr, and: false })
              : arr[0],
          );
        });
        const tbl = view.byId("tblDocs");
        tbl.getBinding("items").filter(andFilters);
        // persistir
        const prefsNew = Object.assign({}, prefs, {
          filter: {
            fornecedor: (grouped.supplierName || []).map((f) =>
              String(f.oValue1),
            ),
            nomeItem: (grouped.itemDescription || []).map((f) =>
              String(f.oValue1),
            ),
          },
        });
        onSave(prefsNew);
        applyFiltersFromPrefs();
      }

      function handleSortDialogConfirm(ev, onSave) {
        const m = ev.getParameters();
        const sPath = m.sortItem.getKey();
        const bDesc = m.sortDescending;

        const tbl = view.byId("tblDocs");
        const arr = [];
        if (prefs.group.key)
          arr.push(
            new sap.ui.model.Sorter(
              prefs.group.key,
              !!prefs.group.desc,
              mGroupFunctions[prefs.group.key],
            ),
          );
        arr.push(new sap.ui.model.Sorter(sPath, bDesc));
        tbl.getBinding("items").sort(arr);

        onSave(
          Object.assign({}, prefs, { sort: { key: sPath, desc: !!bDesc } }),
        );
      }

      function handleGroupDialogConfirm(ev, onSave) {
        const m = ev.getParameters();
        const tbl = view.byId("tblDocs");
        const binding = tbl.getBinding("items");

        if (m.groupItem) {
          const sPath = m.groupItem.getKey();
          const bDesc = m.groupDescending;
          const vGroup = mGroupFunctions[sPath];

          const arr = [new sap.ui.model.Sorter(sPath, bDesc, vGroup)];
          if (prefs.sort.key)
            arr.push(
              new sap.ui.model.Sorter(prefs.sort.key, !!prefs.sort.desc),
            );
          binding.sort(arr);

          onSave(
            Object.assign({}, prefs, { group: { key: sPath, desc: !!bDesc } }),
          );
        } else if (groupReset) {
          if (prefs.sort.key)
            binding.sort([
              new sap.ui.model.Sorter(prefs.sort.key, !!prefs.sort.desc),
            ]);
          else binding.sort();
          groupReset = false;
          onSave(
            Object.assign({}, prefs, { group: { key: null, desc: false } }),
          );
        }
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
      };
    }
    return { create };
  },
);
