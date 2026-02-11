sap.ui.define(
  [
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/core/Fragment",
  ],
  function (JSONModel, MessageToast, MessageBox, Fragment) {
    "use strict";

    function _pickDialog(root) {
      // Fragment.load pode retornar o Dialog direto ou um array; aqui pegamos o primeiro Dialog válido
      if (Array.isArray(root)) return root.find((c) => c?.isA?.("sap.m.Dialog")) || null;
      return root?.isA?.("sap.m.Dialog") ? root : null;
    }

    function _findParentDialog(ctrl) {
      // Sobe na árvore de parents até achar um sap.m.Dialog
      try {
        let c = ctrl;
        while (c?.getParent && !c?.isA?.("sap.m.Dialog")) c = c.getParent();
        return c?.isA?.("sap.m.Dialog") ? c : null;
      } catch (e) {
        return null;
      }
    }

    async function openResultDialog(view, rows, controller) {
      // Model "res" (results) usado pelo fragmento
      let resModel = view.getModel("res");
      if (!(resModel instanceof JSONModel)) {
        resModel = new JSONModel({ header: {}, rows: [], totals: {} });
        view.setModel(resModel, "res");
      }

      // Garante qtyAward (fallback na quantity) pra UI não quebrar
      const safeRows = (rows || []).map((r) => ({
        ...r,
        qtyAward: r.qtyAward ?? Number(r.quantity),
      }));

      resModel.setSizeLimit(Math.max(10000, safeRows.length || 0));
      resModel.setProperty("/rows", safeRows);
      resModel.refresh(true);

      // ID fixo pro fragment (evita recriar IDs e quebrar coisas tipo state/variant)
      const scopeId =
        controller._resDlgScopeId || (controller._resDlgScopeId = view.createId("resDlg"));

      // Carrega 1x e reaproveita (não destruir no close)
      if (!controller._dlgRes || controller._dlgRes.bIsDestroyed) {
        const root = await Fragment.load({
          id: scopeId,
          name: "comparativemap.comparativemap.view.fragments.ResultadoSimulacao",
          controller,
        });

        const dlg = _pickDialog(root);
        if (!dlg) throw new Error("Fragmento ResultadoSimulacao precisa ter <Dialog> como root.");

        view.addDependent(dlg);
        controller._dlgRes = dlg;

        // Rebind do table após abrir (caso o MDC table precise do DOM pronto)
        dlg.attachAfterOpen(() => {
          try {
            const tblRes = Fragment.byId(scopeId, "tblRes");
            tblRes?.rebind?.();
          } catch (e) {}
        });
      }

      controller._dlgRes.open();
    }

    function closeAny(controller, evt) {
      // Fecha o Dialog “mais próximo” do botão clicado
      try {
        const src = evt?.getSource?.();
        const dlg = _findParentDialog(src);
        if (dlg) return dlg.close();
      } catch (e) {}

      // Fallback: fecha diálogos conhecidos
      controller._dlgRes?.close?.();
      controller._dlgAward?.close?.();
      controller._dlgSim?.close?.();
      controller._oSimDialog?.close?.();
    }

    function showBapiMessages(msgs) {
      // Mostra retorno da BAPI em bloco único (erro/warn/success)
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
      // Painel de detalhes sempre útil quando vier stack/response do backend
      const detailStr =
        typeof details === "string" ? details : JSON.stringify(details, null, 2);

      MessageBox.error(text || "Ocorreu um erro.", {
        title: title || "Erro",
        details: detailStr,
        contentWidth: "640px",
      });
    }

    return { openResultDialog, closeAny, showBapiMessages, showError };
  }
);
