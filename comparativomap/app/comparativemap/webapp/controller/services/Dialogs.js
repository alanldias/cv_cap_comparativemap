sap.ui.define(
  [
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/core/Fragment",
    "comparativemap/comparativemap/controller/components/ViewSettings"
  ],
  function (JSONModel, MessageToast, MessageBox, Fragment, ViewSettingsCmp) {

    "use strict";

    function _pickDialog(root) {
      return Array.isArray(root)
        ? root.find((c) => c && c.isA && c.isA("sap.m.Dialog"))
        : root && root.isA && root.isA("sap.m.Dialog")
          ? root
          : null;
    }

    async function openResultDialog(view, rows, controller) {
      // 1) Modelo "res"
      let resModel = view.getModel("res");
      if (!(resModel instanceof sap.ui.model.json.JSONModel)) {
        resModel = new JSONModel({ header: {}, rows: [], totals: {} });
        view.setModel(resModel, "res");
      }
      if (typeof resModel.setSizeLimit === "function") {
        resModel.setSizeLimit(5000); // idempotente
      }

      // 2) Prepara linhas (mantém sua regra do qtyAward)
      const safeRows = (rows || []).map(r => ({
        ...r,
        qtyAward: (r.qtyAward != null ? r.qtyAward : Number(r.quantity) || 0)
      }));
      // Atualiza só o path necessário (mantém instância + configs)
      resModel.setProperty("/rows", safeRows);

      // 3) Fecha dialog antigo (mantido)
      if (controller._dlgRes && controller._dlgRes.destroy && !controller._dlgRes.bIsDestroyed) {
        try { controller._dlgRes.destroy(); } catch (e) { }
        controller._dlgRes = null;
      }

      // 4) Carrega fragment (mantido)
      const scopeId = view.createId("resDlg-" + Date.now());
      const root = await sap.ui.core.Fragment.load({
        id: scopeId,
        name: "comparativemap.comparativemap.view.fragments.ResultadoSimulacao",
        controller,
      });

      const dlg = _pickDialog(root);
      if (!dlg) {
        throw new Error("O fragmento ResultadoSimulacao não tem um <Dialog> como root.");
      }
      view.addDependent(dlg);
      controller._dlgRes = dlg;

      // 5) ViewSettings no FRAGMENT (mantida sua lógica)
      try {
        controller._prefsRes = {
          filter: { fornecedor: [], nomeItem: [], moeda: [], centro: [], grupoMat: [], ncm: [], precoMin: null, precoMax: null },
          sort: { key: null, desc: false },
          group: { key: null, desc: false }
        };

        function getDistinctRes(path) {
          const rows = view.getModel("res")?.getProperty("/rows") || [];
          const set = new Set();
          rows.forEach(r => {
            const v = r?.[path];
            if (v !== undefined && v !== null && v !== "") set.add(String(v));
          });
          return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
        }

        function findTableInFragment() {
          return sap.ui.core.Fragment.byId(scopeId, "_IDGenTable2"); // mesmo id do seu XML
        }

        const mGroup = controller.mGroupFunctions || {
          supplierName: (ctx) => {
            const v = ctx.getProperty("supplierName") || "";
            return { key: v || "__noSupplier__", text: v || "(Sem fornecedor)" };
          },
          itemId: (ctx) => {
            const raw = ctx.getProperty("itemId") ?? ctx.getProperty("ItemId");
            const v = raw == null ? "" : String(raw);
            return { key: v || "__noItemId__", text: v ? `Item ${v}` : "(Sem ItemId)" };
          }
        };

        controller._vsRes = ViewSettingsCmp.create(
          dlg,
          controller._prefsRes,
          getDistinctRes,
          mGroup,
          findTableInFragment,
          {
            filterBarId: "resVsdFilterBar",
            filterLabelId: "resVsdFilterLabel",
            fragmentScopeId: scopeId
          }
        );

        controller._vsRes.applyFiltersFromPrefs();
        controller._vsRes.applyGroupSortFromPrefs();
      } catch (e) {
        console.warn("[Dialogs] ViewSettings (fragment) não inicializado:", e);
      }

      // (Opcional) se sua <Table> usar growing="true", ajuste o threshold aqui:
      const tbl = sap.ui.core.Fragment.byId(scopeId, "_IDGenTable2");
      if (tbl?.getGrowing && tbl.getGrowing() && tbl.setGrowingThreshold) {
        const desired = Math.max(5000, safeRows.length);
        tbl.setGrowingThreshold(desired);
      }

      dlg.attachAfterClose(() => {
        try { dlg.destroy(); } catch (e) { }
        controller._dlgRes = null;
        controller._vsRes = null;
      });

      dlg.open();
    }


    function closeAny(controller, evt) {
      try {
        let ctrl = evt && evt.getSource ? evt.getSource() : null;
        while (ctrl && ctrl.getParent && !(ctrl.isA && ctrl.isA("sap.m.Dialog"))) ctrl = ctrl.getParent();
        if (ctrl && ctrl.isA && ctrl.isA("sap.m.Dialog")) {
          ctrl.close();
          return;
        }
      } catch (e) { }
      controller._dlgRes && controller._dlgRes.close && controller._dlgRes.close();
      controller._dlgAward && controller._dlgAward.close && controller._dlgAward.close();
      controller._dlgSim && controller._dlgSim.close && controller._dlgSim.close();
      controller._oSimDialog && controller._oSimDialog.close && controller._oSimDialog.close();
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
        contentWidth: "640px",
      });
    }

    return { openResultDialog, closeAny, showBapiMessages, showError };
  }
);
