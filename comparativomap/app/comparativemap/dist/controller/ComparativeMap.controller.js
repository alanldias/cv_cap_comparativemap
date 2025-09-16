sap.ui.define(
  [
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/Sorter",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "comparativemap/comparativemap/model/models",
    "comparativemap/comparativemap/controller/prefs/PrefsStore",
    "comparativemap/comparativemap/controller/components/ViewSettings",
    "comparativemap/comparativemap/controller/services/ODataService",
    "comparativemap/comparativemap/controller/services/SimulationMapper",
    "comparativemap/comparativemap/controller/services/Dialogs",
    "comparativemap/comparativemap/controller/services/AwardService",
    "comparativemap/comparativemap/controller/helpers/KeyUtils",
    "comparativemap/comparativemap/controller/helpers/Debug",
    "comparativemap/comparativemap/controller/helpers/Formatters",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/Device",
  ],
  function (e, t, r, o, s, a, i, n, c, l, p, m, d, u, h, g, f) {
    "use strict";
    return e.extend("comparativemap.comparativemap.controller.ComparativeMap", {
      formatter: u,
      onInit() {
        this.getView().setModel(s.createVM(), "vm");
        this.getView().setModel(s.createQM(), "qm");
        this._prefs = a.load();
        this.mGroupFunctions = {
          supplierName: (e) => {
            const t = e.getProperty("supplierName") || "";
            return { key: t, text: t };
          },
          arb_PurchasingOrganization: (e) => {
            const t = e.getProperty("arb_PurchasingOrganization") || "";
            return { key: t, text: "Org. Compras " + t };
          },
          arb_CompanyCode: (e) => {
            const t = e.getProperty("arb_CompanyCode") || "";
            return { key: t, text: "Empresa " + t };
          },
        };
        this._vs = i.create(
          this.getView(),
          this._prefs,
          this._getDistinct.bind(this),
          this.mGroupFunctions,
        );
        this._vs.applyFiltersFromPrefs();
        this._vs.applyGroupSortFromPrefs();
      },
      async onBuscar() {
        const e = this.getView();
        const t = e.getModel();
        const r = e.getModel("vm");
        const o = e.getModel("qm");
        const s = (e.byId("inputDoID").getValue() || "").trim();
        const a = e.byId("tblDocs");
        try {
          if (!t) throw new Error("Modelo OData V4 não encontrado.");
          if (!s) {
            sap.m.MessageToast.show("Informe o Doc ID");
            return;
          }
          a.removeSelections(true);
          o?.setProperty("/idByKey", {});
          o?.setProperty("/simSourceRows", []);
          a.setBusy(true);
          const i = await n.fetchQuotes(e, s);
          const c = (Array.isArray(i?.items) ? i.items : []).map((e) =>
            Object.assign({}, e, { _originalQty: Number(e.quantity) || 0 }),
          );
          r.setProperty("/header", i?.header || {});
          r.setProperty("/rows", c);
          r.setProperty("/headerRows", i?.header ? [i.header] : []);
          this.byId("tblDocs").getBinding("items")?.refresh(true);
          sap.ui.getCore().applyChanges();
          a.removeSelections(true);
          if (!c.length) h.show("Nenhum item retornado para esse Doc ID.");
        } catch (e) {
          console.error("[onBuscar] ERRO:", e);
          g.error("Falha ao buscar dados: " + (e.message || e));
        } finally {
          a.setBusy(false);
        }
      },
      onQtyInlineChange(e) {
        const t = e.getSource()?.getBindingContext("vm");
        if (!t) return;
        const r = t.getObject() || {};
        const o = Number(r._originalQty) || 0;
        let s = Number(r.quantity);
        if (isNaN(s) || s < 0) s = 0;
        if (o && s > o) s = o;
        r.quantity = Math.floor(s);
        t.getModel().checkUpdate(true);
      },
      onCloseDialog(e) {
        l.closeAny(this, e);
      },
      async onSimularPress() {
        const e = this.getView();
        const t = e.getModel("vm");
        const r = e.getModel("qm");
        let o = e.getModel("res");
        if (!o) {
          o = new sap.ui.model.json.JSONModel({ rows: [] });
          e.setModel(o, "res");
        } else {
          o.setData({ rows: [] });
        }
        console.groupCollapsed("[SIMULAR] clique");
        try {
          const o = c.getHeaderFromVM(t);
          d.dbg("Header bruto (vm>/headerRows[0] ou vm>/header)", o);
          const s = this.byId("tblDocs");
          if (!s) throw new Error("Tabela 'tblDocs' não encontrada.");
          const a = s.getSelectedItems();
          if (!a.length)
            throw new Error("Selecione pelo menos 1 item para simular.");
          const i = a
            .map((e) => e.getBindingContext("vm")?.getObject?.())
            .filter(
              (e) =>
                e && (e.MaterialCode || e.materialCode || e.ItemId || e.itemId),
            );
          if (!i.length) {
            s.removeSelections(true);
            throw new Error(
              "Seleção inválida: os itens selecionados não existem mais. Faça uma nova seleção e tente novamente.",
            );
          }
          d.dbg(`Linhas selecionadas (count=${i.length})`, i);
          r.setProperty("/simSourceRows", i);
          c.prepareQMFromSelection(i, r);
          const p = c.mapHeaderFromAriba(o, i[0]);
          const m = i.map((e, t) => c.mapRowToPOItem(e, t));
          const u = i.map((e, t) => ({
            poItem: m[t].poItem,
            schedLine: 1,
            deliveryDate: c.getDeliveryDateFromRow(e),
            quantity: m[t].quantity,
          }));
          const h = [];
          if (!p.docType) h.push("Tipo de Pedido (docType)");
          if (!p.compCode) h.push("Empresa (compCode)");
          if (!p.purchOrg) h.push("Org. de Compras (purchOrg)");
          if (!p.purchGroup) h.push("Grupo de Compras (purchGroup)");
          if (!p.vendor) h.push("Fornecedor (vendor/LIFNR)");
          if (!p.currency) h.push("Moeda (currency)");
          const f = [];
          m.forEach((e, t) => {
            const r = `Item ${String((t + 1) * 10).padStart(5, "0")}`;
            if (!e.plant) f.push(`${r}: Centro (plant)`);
            if (!e.unit) f.push(`${r}: Unidade (unit)`);
            if (!e.quantity || e.quantity <= 0)
              f.push(`${r}: Quantidade (quantity)`);
            if (!e.material && !e.shortText)
              f.push(`${r}: MATERIAL ou SHORT_TEXT`);
          });
          if (h.length || f.length) {
            const e = [
              h.length ? "Cabeçalho faltando:\n- " + h.join("\n- ") : "",
              f.length ? "Itens faltando:\n- " + f.join("\n- ") : "",
            ]
              .filter(Boolean)
              .join("\n\n");
            throw new Error(e);
          }
          const y = [{ header: p, items: m, schedules: u, testRun: true }];
          sap.ui.core.BusyIndicator.show(0);
          const v = await n.simularPO(e, y, 4);
          d.dbg("Resultado bruto da BAPI (result0)", v);
          if (v?.error || v?.success === false) {
            if (l.showError) {
              l.showError(
                "Erro na simulação",
                v?.message || "Falha ao simular a compra.",
                v,
              );
            } else {
              g.error(v?.message || "Falha ao simular a compra.", {
                details: JSON.stringify(v, null, 2),
                contentWidth: "640px",
              });
            }
            console.groupEnd();
            return;
          }
          const w = v?.returnMessages || v?.mensagens || [];
          const I =
            Array.isArray(w) && w.some((e) => e.type === "E" || e.type === "A");
          if (I) {
            l.showBapiMessages(w);
            console.groupEnd();
            return;
          }
          const _ = c.buildResRowsFromBapiResult(v, r);
          l.openResultDialog(e, _, this);
          if (Array.isArray(w) && w.length) {
            l.showBapiMessages(w);
          }
          console.groupEnd();
        } catch (e) {
          console.error("[SIMULAR] ERRO:", e);
          console.groupEnd();
          const t =
            e?.cause?.response?.body ||
            e?.cause?.message ||
            e?.stack ||
            (typeof e === "object" ? JSON.stringify(e, null, 2) : String(e));
          g.error(e.message || String(e), {
            details: t,
            contentWidth: "640px",
          });
        } finally {
          sap.ui.core.BusyIndicator.hide();
        }
      },
      onAwardQtyChangeRes(e) {
        const t = e.getSource();
        const r = t.getBindingContext("res");
        const o = r?.getObject() || {};
        let s = Number(t.getValue());
        if (isNaN(s) || s < 0) s = 0;
        const a = Number(o.originalQty) || 0;
        if (s > a) s = a;
        o.qtyAward = Math.floor(s);
        r.getModel().checkUpdate(true);
        t.setValue(String(o.qtyAward));
      },
      async onAwardDirect() {
        const e = this.getView();
        const t = e.getModel();
        const r = e.getModel("vm");
        const o = this._dlgRes?.getContent?.()[0];
        const s = o?.getSelectedContexts("res").map((e) => e.getObject()) || [];
        if (!s.length) {
          h.show("Selecione ao menos uma linha para premiar.");
          return;
        }
        const a = r?.getProperty("/rows") || [];
        const i = p.validarEMontarPayload(
          a,
          s,
          this._ensureInvitationResourceId.bind(this),
        );
        if (!i) return;
        const c =
          r.getProperty("/header/docId") ||
          e.getModel("res")?.getProperty("/header/docId");
        if (!c) {
          g.error("DocID do evento não encontrado no header.");
          return;
        }
        sap.ui.core.BusyIndicator.show(0);
        try {
          const t = await n.createScenario(e, {
            eventId: c,
            title: "Premiação via UI (direto)",
            scenarioType: 0,
            supplierBids: i,
          });
          sap.ui.core.BusyIndicator.hide();
          if (t?.success) {
            g.success(
              `Cenário criado com sucesso!\nScenario ID: ${t.scenarioId || "(n/a)"}\nCorrelation-ID: ${t.correlationId || "(n/a)"}`,
            );
            this._dlgRes?.close();
          } else {
            g.warning("CreateScenario executou, porém sem success=true.");
          }
        } catch (e) {
          sap.ui.core.BusyIndicator.hide();
          const t = e?.message || "Falha ao criar cenário.";
          g.error(t);
        }
      },
      handleFilterButtonPressed() {
        this._vs.openFilterDialog((e) =>
          this._vs.handleFilterDialogConfirm(e, (e) => {
            this._prefs = e;
            a.save(e);
          }),
        );
      },
      handleSortButtonPressed() {
        this._vs.openSortDialog((e) =>
          this._vs.handleSortDialogConfirm(e, (e) => {
            this._prefs = e;
            a.save(e);
          }),
        );
      },
      handleGroupButtonPressed() {
        this._vs.openGroupDialog(
          (e) =>
            this._vs.handleGroupDialogConfirm(e, (e) => {
              this._prefs = e;
              a.save(e);
            }),
          () => {},
        );
      },
      onFilterSelectAllFornecedor() {
        this._prefs.filter.fornecedor = this._getDistinct("supplierName");
        a.save(this._prefs);
        this._vs.applyFiltersFromPrefs();
        h.show("Fornecedor: selecionado tudo.");
      },
      onFilterClearFornecedor() {
        this._prefs.filter.fornecedor = [];
        a.save(this._prefs);
        this._vs.applyFiltersFromPrefs();
        h.show("Fornecedor: seleção limpa.");
      },
      onFilterSelectAllNomeItem() {
        this._prefs.filter.nomeItem = this._getDistinct("itemDescription");
        a.save(this._prefs);
        this._vs.applyFiltersFromPrefs();
        h.show("Nome do item: selecionado tudo.");
      },
      onFilterClearNomeItem() {
        this._prefs.filter.nomeItem = [];
        a.save(this._prefs);
        this._vs.applyFiltersFromPrefs();
        h.show("Nome do item: seleção limpa.");
      },
      _getDistinct(e) {
        const t = this.getView().getModel("vm").getProperty("/rows") || [];
        const r = new Set();
        t.forEach((t) => {
          const o = t[e];
          if (o !== undefined && o !== null && o !== "") r.add(String(o));
        });
        return Array.from(r).sort((e, t) => e.localeCompare(t, "pt-BR"));
      },
      _ensureInvitationResourceId(e, t) {
        if (!e) return null;
        const r = String(e);
        if (r.includes("_")) return r;
        if (t) return `${r}_${String(t)}`;
        return r;
      },
      onExit() {
        if (this._dlgRes) {
          this._dlgRes.destroy(true);
          this._dlgRes = null;
        }
      },
    });
  },
);
//# sourceMappingURL=ComparativeMap.controller.js.map
