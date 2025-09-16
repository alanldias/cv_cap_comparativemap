sap.ui.define(
  [
    "sap/m/ViewSettingsDialog",
    "sap/m/ViewSettingsItem",
    "sap/m/ViewSettingsFilterItem",
    "sap/ui/Device",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
  ],
  function (e, t, o, r, s, n) {
    "use strict";
    function i(i, a, l, p) {
      let c = null,
        d = null,
        m = null,
        u = false;
      function f(s) {
        if (c) {
          c.destroy();
          c = null;
        }
        c = new e({ confirm: s });
        if (r.system.desktop) c.addStyleClass("sapUiSizeCompact");
        i.addDependent(c);
        const n = new o({ text: "Fornecedor", key: "supplierName" });
        l("supplierName").forEach((e) => {
          const o = new t({ text: e, key: `supplierName___EQ___${e}` });
          if (a.filter.fornecedor?.includes(e)) o.setSelected(true);
          n.addItem(o);
        });
        c.addFilterItem(n);
        const p = new o({ text: "Nome do item", key: "itemDescription" });
        l("itemDescription").forEach((e) => {
          const o = new t({ text: e, key: `itemDescription___EQ___${e}` });
          if (a.filter.nomeItem?.includes(e)) o.setSelected(true);
          p.addItem(o);
        });
        c.addFilterItem(p);
        c.open();
      }
      function g(o) {
        if (!d) {
          d = new e({ confirm: o });
          if (r.system.desktop) d.addStyleClass("sapUiSizeCompact");
          i.addDependent(d);
        }
        d.destroySortItems();
        [
          { text: "Fornecedor", key: "supplierName" },
          { text: "Nome do item", key: "itemDescription" },
          { text: "Tipo de pedido", key: "arb_Document_Type" },
          { text: "Org. Compras", key: "arb_PurchasingOrganization" },
          { text: "Grp. Compradores", key: "arb_PurchasingGroup" },
          { text: "Empresa", key: "arb_CompanyCode" },
        ].forEach((e) => d.addSortItem(new t(e)));
        if (a.sort.key) {
          d.setSelectedSortItem(a.sort.key);
          d.setSortDescending(!!a.sort.desc);
        }
        d.open();
      }
      function y(o, s) {
        if (!m) {
          m = new e({
            confirm: o,
            reset: () => {
              u = true;
              s?.();
            },
          });
          if (r.system.desktop) m.addStyleClass("sapUiSizeCompact");
          i.addDependent(m);
        }
        m.destroyGroupItems();
        [
          { text: "Fornecedor", key: "supplierName" },
          { text: "Org. Compras", key: "arb_PurchasingOrganization" },
          { text: "Empresa", key: "arb_CompanyCode" },
        ].forEach((e) => m.addGroupItem(new t(e)));
        if (a.group.key) {
          m.setSelectedGroupItem(a.group.key);
          m.setGroupDescending(!!a.group.desc);
        }
        m.open();
      }
      function k() {
        const e = i.byId("tblDocs");
        if (!e) return;
        const t = e.getBinding("items");
        if (!t) return;
        const o = [];
        if (a.filter.fornecedor?.length) {
          o.push(
            new s({
              and: false,
              filters: a.filter.fornecedor.map(
                (e) => new s("supplierName", n.EQ, e),
              ),
            }),
          );
        }
        if (a.filter.nomeItem?.length) {
          o.push(
            new s({
              and: false,
              filters: a.filter.nomeItem.map(
                (e) => new s("itemDescription", n.EQ, e),
              ),
            }),
          );
        }
        t.filter(o);
        const r = i.byId("vsdFilterBar");
        const l = i.byId("vsdFilterLabel");
        if (r && l) {
          if (o.length) {
            r.setVisible(true);
            const e = [
              a.filter.fornecedor?.length
                ? `Fornecedor: ${a.filter.fornecedor.join(", ")}`
                : "",
              a.filter.nomeItem?.length
                ? `Nome do item: ${a.filter.nomeItem.join(", ")}`
                : "",
            ]
              .filter(Boolean)
              .join("  |  ");
            l.setText(e);
          } else {
            r.setVisible(false);
            l.setText("");
          }
        }
      }
      function I() {
        const e = i.byId("tblDocs");
        if (!e) return;
        const t = e.getBinding("items");
        if (!t) return;
        const o = [];
        if (a.group.key)
          o.push(
            new sap.ui.model.Sorter(
              a.group.key,
              !!a.group.desc,
              p[a.group.key],
            ),
          );
        if (a.sort.key)
          o.push(new sap.ui.model.Sorter(a.sort.key, !!a.sort.desc));
        if (o.length) t.sort(o);
      }
      function S(e, t) {
        const o = e.getParameters().filterItems || [];
        const r = {};
        o.forEach((e) => {
          const [t, o, s, n] = e.getKey().split("___");
          (r[t] ||= []).push(
            new sap.ui.model.Filter(
              t,
              sap.ui.model.FilterOperator[o] || o,
              s,
              n,
            ),
          );
        });
        const s = [];
        Object.keys(r).forEach((e) => {
          const t = r[e];
          s.push(
            t.length > 1
              ? new sap.ui.model.Filter({ filters: t, and: false })
              : t[0],
          );
        });
        const n = i.byId("tblDocs");
        n.getBinding("items").filter(s);
        const l = Object.assign({}, a, {
          filter: {
            fornecedor: (r.supplierName || []).map((e) => String(e.oValue1)),
            nomeItem: (r.itemDescription || []).map((e) => String(e.oValue1)),
          },
        });
        t(l);
        k();
      }
      function h(e, t) {
        const o = e.getParameters();
        const r = o.sortItem.getKey();
        const s = o.sortDescending;
        const n = i.byId("tblDocs");
        const l = [];
        if (a.group.key)
          l.push(
            new sap.ui.model.Sorter(
              a.group.key,
              !!a.group.desc,
              p[a.group.key],
            ),
          );
        l.push(new sap.ui.model.Sorter(r, s));
        n.getBinding("items").sort(l);
        t(Object.assign({}, a, { sort: { key: r, desc: !!s } }));
      }
      function D(e, t) {
        const o = e.getParameters();
        const r = i.byId("tblDocs");
        const s = r.getBinding("items");
        if (o.groupItem) {
          const e = o.groupItem.getKey();
          const r = o.groupDescending;
          const n = p[e];
          const i = [new sap.ui.model.Sorter(e, r, n)];
          if (a.sort.key)
            i.push(new sap.ui.model.Sorter(a.sort.key, !!a.sort.desc));
          s.sort(i);
          t(Object.assign({}, a, { group: { key: e, desc: !!r } }));
        } else if (u) {
          if (a.sort.key)
            s.sort([new sap.ui.model.Sorter(a.sort.key, !!a.sort.desc)]);
          else s.sort();
          u = false;
          t(Object.assign({}, a, { group: { key: null, desc: false } }));
        }
      }
      return {
        openFilterDialog: f,
        openSortDialog: g,
        openGroupDialog: y,
        handleFilterDialogConfirm: S,
        handleSortDialogConfirm: h,
        handleGroupDialogConfirm: D,
        applyFiltersFromPrefs: k,
        applyGroupSortFromPrefs: I,
      };
    }
    return { create: i };
  },
);
//# sourceMappingURL=ViewSettings.js.map
