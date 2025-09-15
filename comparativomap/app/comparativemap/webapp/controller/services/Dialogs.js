// controller/services/Dialogs.js
sap.ui.define([
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox",
  "sap/ui/core/Fragment"
], function(JSONModel, MessageToast, MessageBox, Fragment) {
  "use strict";

  function _pickDialog(root) {
    return Array.isArray(root)
      ? root.find(c => c && c.isA && c.isA("sap.m.Dialog"))
      : (root && root.isA && root.isA("sap.m.Dialog") ? root : null);
  }

  async function openResultDialog(view, rows, controller) {
    // 1) Atualiza/garante o modelo "res"
    const resModel = view.getModel("res") || new JSONModel({ rows: [] });
    resModel.setData({ rows: rows || [] });
    view.setModel(resModel, "res");

    // 2) Se ainda existe um Dialog antigo, destrói antes de recriar (fail-safe)
    if (controller._dlgRes && controller._dlgRes.destroy && !controller._dlgRes.bIsDestroyed) {
      try { controller._dlgRes.destroy(); } catch(e) {}
      controller._dlgRes = null;
    }

    // 3) Escopo único por instância (evita _IDGen* duplicar)
    const scopeId = view.createId("resDlg-" + Date.now());

    const root = await Fragment.load({
      id: scopeId, // <<< escopo único
      name: "comparativemap.comparativemap.view.fragments.ResultadoSimulacao",
      controller
    });

    const dlg = _pickDialog(root);
    if (!dlg) {
      throw new Error("O fragmento ResultadoSimulacao não tem um <Dialog> como root.");
    }

    view.addDependent(dlg);
    controller._dlgRes = dlg;

    dlg.attachAfterClose(() => {
      try { dlg.destroy(); } catch(e){}
      controller._dlgRes = null;
    });

    dlg.open();
  }

  function closeAny(controller, evt) {
    try {
      let ctrl = evt && evt.getSource ? evt.getSource() : null;
      while (ctrl && ctrl.getParent && !(ctrl.isA && ctrl.isA("sap.m.Dialog"))) ctrl = ctrl.getParent();
      if (ctrl && ctrl.isA && ctrl.isA("sap.m.Dialog")) { ctrl.close(); return; }
    } catch (e) {}
    controller._dlgRes && controller._dlgRes.close && controller._dlgRes.close();
    controller._dlgAward && controller._dlgAward.close && controller._dlgAward.close();
    controller._dlgSim && controller._dlgSim.close && controller._dlgSim.close();
    controller._oSimDialog && controller._oSimDialog.close && controller._oSimDialog.close();
  }

  function showBapiMessages(msgs) {
    const arr = Array.isArray(msgs) ? msgs : [];
    if (!arr.length) { MessageToast.show("Simulação concluída. Sem mensagens da BAPI."); return; }
    const line = m => {
      const idnum = [m.id, m.number].filter(Boolean).join("/");
      const tag = m.type ? `[${m.type}]` : "[?]";
      return `${tag} ${m.message || ""}${idnum ? ` (${idnum})` : ""}`;
    };
    const text = arr.map(line).join("\n");
    const hasError = arr.some(m => m.type === "E" || m.type === "A");
    const hasWarning = arr.some(m => m.type === "W");
    if (hasError) MessageBox.error(text, { title:"Mensagens da BAPI" });
    else if (hasWarning) MessageBox.warning(text, { title:"Mensagens da BAPI" });
    else MessageBox.success(text, { title:"Mensagens da BAPI" });
  }
  
  function showError(title, text, details) {
    const detailStr = typeof details === "string"
      ? details
      : JSON.stringify(details, null, 2);

    MessageBox.error(text || "Ocorreu um erro.", {
      title: title || "Erro",
      details: detailStr,
      contentWidth: "640px"
    });
  }

  return { openResultDialog, closeAny, showBapiMessages, showError };
});
