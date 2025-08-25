sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/Sorter",
  "sap/m/MessageBox",
  "sap/ui/core/Fragment",
  "sap/ui/model/json/JSONModel"
], function (Controller, Sorter, MessageBox, Fragment, JSONModel) {
  "use strict";

  return Controller.extend("comparativemap.comparativemap.controller.ComparativeMap", {

    onInit() {
      const vm = new JSONModel({ rows: [] });
      this.getView().setModel(vm, "vm");
    },

    onItemQuickView: function (oEvent) {
      const ctx = oEvent.getSource().getBindingContext("vm").getObject();

      const oQuickView = new sap.m.QuickView({
        pages: [
          new sap.m.QuickViewPage({
            header: "Cod: " + (ctx.materialCode || "-"),
            title: ctx.materialDesc || "-",
            groups: [
              new sap.m.QuickViewGroup({
                heading: "Detalhes",
                elements: [
                  new sap.m.QuickViewGroupElement({ label: "Quantidade", value: ctx.quantity }),
                  new sap.m.QuickViewGroupElement({ label: "Moeda", value: ctx.currency }),
                  new sap.m.QuickViewGroupElement({ label: "Preço", value: ctx.netPrice }),
                  new sap.m.QuickViewGroupElement({ label: "Fornecedor", value: ctx.supplierName }),
                  new sap.m.QuickViewGroupElement({ label: "ID Fornecedor", value: ctx.supplierId })
                ]
              })
            ]
          })
        ]
      });

      oQuickView.openBy(oEvent.getSource());
    },

    async onBuscar() {
      const oView = this.getView();
      const oOData = oView.getModel(); // default OData V4
      const oVM = oView.getModel("vm");
      const docId = oView.byId("inputDoID").getValue();

      try {
        if (!oOData) throw new Error("Modelo OData V4 não encontrado (verifique o manifest).");

        const oCtx = oOData.bindContext("/GetQuotes(...)");
        if (docId) oCtx.setParameter("docId", docId);

        await oCtx.execute();

        const resultRaw = oCtx.getBoundContext().getObject();
        const list = Array.isArray(resultRaw) ? resultRaw : (resultRaw?.value || []);

        oVM.setProperty("/rows", list);

        // Agrupar por fornecedor
        const oTbl = oView.byId("tblDocs");
        const oBinding = oTbl?.getBinding("items");
        if (oBinding) {
          const sorter = new Sorter("supplierName", false);
          sorter.group = (ctx2) => {
            const name = ctx2.getProperty("supplierName") || "";
            return { key: name, text: name };
          };
          oBinding.sort(sorter);

          if (typeof oTbl.setGroupHeaderFactory === "function") {
            oTbl.setGroupHeaderFactory((g) =>
              new sap.m.GroupHeaderListItem({ title: g.text, upperCase: false })
            );
          }
        }
      } catch (e) {
        MessageBox.error("Falha ao buscar dados: " + (e.message || e));
      }
    },

    async onSimularCompra() {
      const oView = this.getView();
      const oModel = oView.getModel();     // OData V4
      const oTbl = this.byId("tblDocs");

      // 🔹 Coleta TODAS as linhas selecionadas do modelo "vm"
      const selCtx = oTbl.getSelectedContexts("vm") || [];
      const selecionados = selCtx.map(c => c.getObject());
      if (!selecionados.length) {
        sap.m.MessageBox.warning("Selecione ao menos uma linha.");
        return;
      }

      sap.ui.core.BusyIndicator.show(0);
      try {
        // Helper: executa a operação para UMA linha selecionada
        const runOne = async (row) => {
          const { docId, lineNumber, supplierId } = row;
          if (!docId) throw new Error("Linha sem Doc ID.");

          const ctx = oModel.bindContext("/GetQuotes(...)");
          ctx.setParameter("docId", docId);

          // Se a operation aceitar, enviamos parâmetros de item
          if (lineNumber != null) ctx.setParameter("lineNumber", lineNumber);
          if (supplierId) ctx.setParameter("supplierId", supplierId);

          await ctx.execute();

          // Normaliza retorno
          let data = ctx.getBoundContext().getObject();
          let arr = Array.isArray(data) ? data : (data?.value || (data ? [data] : []));

          // Filtro no cliente para manter APENAS o item daquela linha
          arr = arr.filter(it =>
            it.docId === docId &&
            (lineNumber == null || it.lineNumber === lineNumber) &&
            (!supplierId || it.supplierId === supplierId)
          );

          // Marcas auxiliares p/ exibir no fragment
          return arr.map(it => ({
            __docId: docId,
            __lineNumber: lineNumber,
            __supplierId: supplierId,
            ...it
          }));
        };

        // Executa todas as simulações em paralelo
        const settled = await Promise.allSettled(selecionados.map(runOne));
        const okRows = settled.filter(s => s.status === "fulfilled").flatMap(s => s.value);
        const fails = settled.filter(s => s.status === "rejected");

        if (!okRows.length) throw new Error("Nenhum resultado retornado para as seleções.");

        const docIds = [...new Set(selecionados.map(r => r.docId).filter(Boolean))];
        await this._openSimFragment(okRows, docIds);

        if (fails.length) {
          sap.m.MessageToast.show(`${fails.length} item(ns) falharam na simulação.`);
        }
      } catch (e) {
        const msg = e?.message || e?.cause?.message || e?.cause?.error?.message || String(e);
        sap.m.MessageBox.error("Falha ao simular: " + msg);
      } finally {
        sap.ui.core.BusyIndicator.hide();
      }
    },

    async _openSimFragment(aRows, docIds) {
      const oView = this.getView();

      const oSimModel = new JSONModel({
        docIds,                 // agora é array (IDs envolvidos)
        total: aRows.length,
        rows: aRows,            // coleção p/ tabela
        first: aRows?.[0] || {} // primeiro item (p/ cabeçalho/resumo)
      });

      if (!this._oSimDialog) {
        this._oSimDialog = await Fragment.load({
          id: oView.getId(), // importante p/ IDs estáveis
          name: "comparativemap.comparativemap.view.fragments.Simulacao", // ajuste ao seu namespace
          type: "XML",
          controller: this
        });
        oView.addDependent(this._oSimDialog);
      }

      this._oSimDialog.setModel(oSimModel, "sim");
      this._oSimDialog.open();
    },

    onCloseSimulacao: function () {
      this._oSimDialog?.close();
      this._oSimDialog?.destroy();
      this._oSimDialog = null;
    }

  });
});
