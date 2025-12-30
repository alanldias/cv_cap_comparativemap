sap.ui.define(
  [
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/core/Fragment"
  ],
  function (JSONModel, MessageToast, MessageBox, Fragment) {
    "use strict";

    function _pickDialog(root) {
      return Array.isArray(root)
        ? root.find((c) => c && c.isA && c.isA("sap.m.Dialog"))
        : root && root.isA && root.isA("sap.m.Dialog")
          ? root
          : null;
    }

    function _findParentDialog(ctrl) {
      try {
        let c = ctrl;
        while (c && c.getParent && !(c.isA && c.isA("sap.m.Dialog"))) {
          c = c.getParent();
        }
        return c && c.isA && c.isA("sap.m.Dialog") ? c : null;
      } catch (e) {
        return null;
      }
    }

    async function openResultDialog(view, rows, controller) {
      // 1) garante model "res"
      let resModel = view.getModel("res");
      if (!(resModel instanceof JSONModel)) {
        resModel = new JSONModel({ header: {}, rows: [], totals: {} });
        view.setModel(resModel, "res");
      }

      const safeRows = (rows || []).map(r => ({
        ...r,
        qtyAward: r.qtyAward ?? Number(r.quantity)
      }));

      resModel.setSizeLimit(Math.max(10000, safeRows.length || 0));
      resModel.setProperty("/rows", safeRows);
      resModel.refresh(true);

      // 2) cria um scopeId FIXO (nada de Date.now)
      //    Isso vira algo tipo: <viewId>--resDlg--tblRes (sempre igual)
      const scopeId = controller._resDlgScopeId || (controller._resDlgScopeId = view.createId("resDlg"));

      // 3) carrega UMA vez e reaproveita
      if (!controller._dlgRes || controller._dlgRes.bIsDestroyed) {
        const root = await Fragment.load({
          id: scopeId,
          name: "comparativemap.comparativemap.view.fragments.ResultadoSimulacao",
          controller
        });

        const dlg = _pickDialog(root);
        if (!dlg) throw new Error("O fragmento ResultadoSimulacao não tem um <Dialog> como root.");

        view.addDependent(dlg);
        controller._dlgRes = dlg;

        // (opcional) rebind ao abrir — mas registra UMA vez só
        dlg.attachAfterOpen(() => {
          try {
            const tblRes = Fragment.byId(scopeId, "tblRes");
            tblRes?.rebind?.();
          } catch (e) { }
        });

        // 🚫 não destrói no close (senão você se ferra com variant de novo)
        // dlg.attachAfterClose(() => { ...destroy... });
      }

      controller._dlgRes.open();
    }

    function closeAny(controller, evt) {
      // tenta fechar o dialog do botão clicado
      try {
        const src = evt && evt.getSource ? evt.getSource() : null;
        const dlg = _findParentDialog(src);
        if (dlg) return dlg.close();
      } catch (e) { }

      // fallback: fecha conhecidos
      controller._dlgRes?.close?.();
      controller._dlgAward?.close?.();
      controller._dlgSim?.close?.();
      controller._oSimDialog?.close?.();
    }

    function showBapiMessages(msgs) {
      const arr = Array.isArray(msgs) ? msgs : [];
      if (!arr.length) {
        MessageToast.show("Simulação concluída. Sem mensagens da BAPI.");
        return;
      }

      const line = (m) => {
        const idnum = [m.id, m.number].filter(Boolean).join("/");
        const tag = m.type ? `[${m.type}]` : "[?]";
        return `${tag} ${m.message || ""}${idnum ? ` (${idnum})` : ""}`;
      };

      const text = arr.map(line).join("\n");
      const hasError = arr.some((m) => m.type === "E" || m.type === "A");
      const hasWarning = arr.some((m) => m.type === "W");

      if (hasError) MessageBox.error(text, { title: "Mensagens da BAPI" });
      else if (hasWarning) MessageBox.warning(text, { title: "Mensagens da BAPI" });
      else MessageBox.success(text, { title: "Mensagens da BAPI" });
    }

    function showError(title, text, details) {
      const detailStr = typeof details === "string" ? details : JSON.stringify(details, null, 2);
      MessageBox.error(text || "Ocorreu um erro.", {
        title: title || "Erro",
        details: detailStr,
        contentWidth: "640px"
      });
    }

    return { openResultDialog, closeAny, showBapiMessages, showError };
  }
);
