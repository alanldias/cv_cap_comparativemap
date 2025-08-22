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
            header: ctx.fornecedor,
            title: ctx.nomeItem,
            groups: [
              new sap.m.QuickViewGroup({
                heading: "Detalhes",
                elements: [
                  new sap.m.QuickViewGroupElement({ label: "Tipo Pedido", value: ctx.arb_Document_Type }),
                  new sap.m.QuickViewGroupElement({ label: "Org. Compras", value: ctx.arb_PurchasingOrganization }),
                  new sap.m.QuickViewGroupElement({ label: "Grp. Compradores", value: ctx.arb_PurchasingGroup }),
                  new sap.m.QuickViewGroupElement({ label: "Empresa", value: ctx.arb_CompanyCode }),
                  new sap.m.QuickViewGroupElement({ label: "Incoterms", value: ctx.incoterms }),
                  new sap.m.QuickViewGroupElement({ label: "Local Incoterms", value: ctx.localIncoterms }),
                  new sap.m.QuickViewGroupElement({ label: "Condição de Pagamento", value: ctx.arb_PaymentTerms })
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
      const oOData = oView.getModel(); // default model definido no manifest como OData V4
      const oVM = oView.getModel("vm");
      const docId = oView.byId("inputDoID").getValue();

      try {
        if (!oOData) throw new Error("Modelo OData V4 não encontrado (verifique o manifest).");

        // Function import OData V4 (unbound)
        const oCtx = oOData.bindContext("/GetQuotes(...)");
        if (docId) oCtx.setParameter("docId", docId);

        await oCtx.execute();

        // 👉 o resultado vem do boundContext:
        const resultRaw = oCtx.getBoundContext().getObject();

        // sua function retorna "many AribaQuotes": pode vir como array direto ou dentro de {value: []}
        const list = Array.isArray(resultRaw) ? resultRaw : (resultRaw?.value || []);

        // mapeia para o vm>/rows
        const rows = list.map(it => ({
          fornecedor: it.supplierName,
          nomeItem: it.materialDesc,
          arb_Document_Type: it.arb_Document_Type,
          arb_PurchasingOrganization: it.arb_PurchasingOrganization,
          arb_PurchasingGroup: it.arb_PurchasingGroup,
          arb_CompanyCode: it.arb_CompanyCode,
          incoterms: it.INCOTERMS1,
          localIncoterms: it.INCOTERMS2,
          arb_PaymentTerms: it.arb_PaymentTerms,

          // ➕ campos para payload da simulação
          docId: it.docId,
          supplierId: it.supplierId,
          lineNumber: it.lineNumber,
          quantity: it.quantity,
          uom: it.uom,
          netPrice: it.netPrice,
          currency: it.currency,
          materialCode: it.materialCode
        }));
        oVM.setProperty("/rows", rows);

        // Agrupar por fornecedor
        const oTbl = oView.byId("tblDocs");
        const oBinding = oTbl && oTbl.getBinding("items");
        if (oBinding) {
          const sorter = new Sorter("fornecedor", false);
          sorter.group = function (oCtx2) {
            const name = oCtx2.getProperty("fornecedor") || "";
            // Pode retornar string ou {key, text}; ambos funcionam
            return { key: name, text: name };
          };
          oBinding.sort(sorter);

          // Customiza o header de grupo APENAS se a API existir nesse controle/versão
          if (typeof oTbl.setGroupHeaderFactory === "function") {
            oTbl.setGroupHeaderFactory(function (oGroup) {
              return new sap.m.GroupHeaderListItem({
                title: oGroup.text,
                upperCase: false
              });
            });
          }
        }
      } catch (e) {
        MessageBox.error("Falha ao buscar dados: " + (e.message || e));
      }
    },
    onCloseSimulacao: function () {
      if (this._dlgSim) this._dlgSim.close();
    },

    onAfterCloseSimulacao: function () {
      // opcional: destruir depois de fechar
      if (this._dlgSim) { this._dlgSim.destroy(); this._dlgSim = null; }
    },

    async onSimularCompra() {
  const oView  = this.getView();
  const oModel = oView.getModel(); // OData V4
  const oTbl   = this.byId("tblDocs");

  // 1) tenta pegar da seleção
  const sel = oTbl.getSelectedContexts("vm");
  let numero = sel.length ? sel[0].getObject().docId : null;

  // 2) fallback: pega do input (se o usuário digitou)
  if (!numero) {
    const typed = (oView.byId("inputDoID").getValue() || "").trim();
    if (typed) numero = typed;
  }

  try {
    if (!numero) throw new Error("Informe o Doc ID (selecione uma linha ou preencha o campo).");

    const oCtx = oModel.bindContext("/consultarPedidoECC(...)", undefined, { $$groupId: "$direct" });
    oCtx.setParameter("numero", numero);

    await oCtx.execute();
    const res = oCtx.getBoundContext().getObject(); // { DOC_TYPE, PURCH_ORG, ... }

    sap.m.MessageBox.information(
      `Tipo: ${res.DOC_TYPE}\nOrg: ${res.PURCH_ORG}\nIncoterms: ${res.INCOTERMS1} ${res.INCOTERMS2}`
    );
  } catch (e) {
    sap.m.MessageBox.error("Falha ao simular: " + (e.message || e));
  }
},

    // Utilidade: se o backend ainda não estiver pronto,
    // cria um resultado fake para testar o fragment
    _mockFromItems(itens) {
      const valorTotal = itens.reduce((acc, it) => acc + (Number(it.netPrice) * Number(it.quantity || 1)), 0);
      return {
        totais: { itens: itens.length, valorTotal: valorTotal.toFixed(2), moeda: itens[0]?.currency || "BRL" },
        itens: itens.map(it => ({
          fornecedor: it.fornecedor,
          nomeItem: it.materialDesc || "",
          quantity: it.quantity,
          uom: it.uom,
          netPrice: it.netPrice,
          currency: it.currency,
          totalItem: (Number(it.netPrice) * Number(it.quantity || 1)).toFixed(2)
        }))
      };
    }
  });
});
