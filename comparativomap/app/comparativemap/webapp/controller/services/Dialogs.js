sap.ui.define(["sap/ui/model/json/JSONModel","sap/m/MessageToast","sap/m/MessageBox"], function(JSONModel, MessageToast, MessageBox) {
  "use strict";

  function openResultDialog(view, rows, controller) {
    const resModel = new JSONModel({ rows: rows || [] });
    view.setModel(resModel, "res");

    if (!controller._dlgRes) {
      controller._dlgRes = sap.ui.xmlfragment(
        view.getId(),
        "comparativemap.comparativemap.view.fragments.ResultadoSimulacao",
        controller
      );
      view.addDependent(controller._dlgRes);
      controller._dlgRes.attachAfterClose(() => { controller._dlgRes.destroy(); controller._dlgRes=null; });
    }
    controller._dlgRes.open();
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

  return { openResultDialog, closeAny, showBapiMessages };
});
