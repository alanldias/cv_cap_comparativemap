sap.ui.define(
  [
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/core/Fragment",
  ],
  function (e, s, o, t) {
    "use strict";
    function a(e) {
      return Array.isArray(e)
        ? e.find((e) => e && e.isA && e.isA("sap.m.Dialog"))
        : e && e.isA && e.isA("sap.m.Dialog")
          ? e
          : null;
    }
    async function n(s, o, n) {
      const l = s.getModel("res") || new e({ rows: [] });
      l.setData({ rows: o || [] });
      s.setModel(l, "res");
      if (n._dlgRes && n._dlgRes.destroy && !n._dlgRes.bIsDestroyed) {
        try {
          n._dlgRes.destroy();
        } catch (e) {}
        n._dlgRes = null;
      }
      const r = s.createId("resDlg-" + Date.now());
      const i = await t.load({
        id: r,
        name: "comparativemap.comparativemap.view.fragments.ResultadoSimulacao",
        controller: n,
      });
      const c = a(i);
      if (!c) {
        throw new Error(
          "O fragmento ResultadoSimulacao não tem um <Dialog> como root.",
        );
      }
      s.addDependent(c);
      n._dlgRes = c;
      c.attachAfterClose(() => {
        try {
          c.destroy();
        } catch (e) {}
        n._dlgRes = null;
      });
      c.open();
    }
    function l(e, s) {
      try {
        let e = s && s.getSource ? s.getSource() : null;
        while (e && e.getParent && !(e.isA && e.isA("sap.m.Dialog")))
          e = e.getParent();
        if (e && e.isA && e.isA("sap.m.Dialog")) {
          e.close();
          return;
        }
      } catch (e) {}
      e._dlgRes && e._dlgRes.close && e._dlgRes.close();
      e._dlgAward && e._dlgAward.close && e._dlgAward.close();
      e._dlgSim && e._dlgSim.close && e._dlgSim.close();
      e._oSimDialog && e._oSimDialog.close && e._oSimDialog.close();
    }
    function r(e) {
      const t = Array.isArray(e) ? e : [];
      if (!t.length) {
        s.show("Simulação concluída. Sem mensagens da BAPI.");
        return;
      }
      const a = (e) => {
        const s = [e.id, e.number].filter(Boolean).join("/");
        const o = e.type ? `[${e.type}]` : "[?]";
        return `${o} ${e.message || ""}${s ? ` (${s})` : ""}`;
      };
      const n = t.map(a).join("\n");
      const l = t.some((e) => e.type === "E" || e.type === "A");
      const r = t.some((e) => e.type === "W");
      if (l) o.error(n, { title: "Mensagens da BAPI" });
      else if (r) o.warning(n, { title: "Mensagens da BAPI" });
      else o.success(n, { title: "Mensagens da BAPI" });
    }
    function i(e, s, t) {
      const a = typeof t === "string" ? t : JSON.stringify(t, null, 2);
      o.error(s || "Ocorreu um erro.", {
        title: e || "Erro",
        details: a,
        contentWidth: "640px",
      });
    }
    return {
      openResultDialog: n,
      closeAny: l,
      showBapiMessages: r,
      showError: i,
    };
  },
);
//# sourceMappingURL=Dialogs.js.map
