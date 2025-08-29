sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast"
], function (Controller, JSONModel, MessageToast) {
  "use strict";

  return Controller.extend("comparativemap.comparativemap.controller.ComparativeMap", {

    onInit: function () {
      const vm = new JSONModel({
        rows: [],           
        categories: [],
        refId: null,
        origem: null,
        totais: null
      });
      this.getView().setModel(vm, "vm");
    },

    // ---- Ações da View ----
    onBuscar: function () {
      // por enquanto, reaproveita o mock para você ver a tabela renderizar
      this._carregarMock();
      MessageToast.show("Busca mock executada.");
    },

    onSimularCompra: function () {
      MessageToast.show("Simulação de compra (mock).");
    },

    // ---- Helpers ----
    _carregarMock: function () {
      const linhas = [
        {
          fornecedor: "Fornecedor A",
          nomeItem: "Parafuso 10mm",
          arb_Document_Type: "NB",
          arb_PurchasingOrganization: "1000",
          arb_PurchasingGroup: "001",
          arb_CompanyCode: "C001",
          incoterms: "FOB",
          localIncoterms: "Porto de Santos",
          arb_PaymentTerms: "Z030 (30 dias)"
        },
        {
          fornecedor: "Fornecedor B",
          nomeItem: "Madeira MDF 15mm",
          arb_Document_Type: "ZUB",
          arb_PurchasingOrganization: "2000",
          arb_PurchasingGroup: "002",
          arb_CompanyCode: "C002",
          incoterms: "CIF",
          localIncoterms: "Hamburgo",
          arb_PaymentTerms: "Z000 (à vista)"
        },
        {
          fornecedor: "Fornecedor C",
          nomeItem: "Tinta PU Branca",
          arb_Document_Type: "NB",
          arb_PurchasingOrganization: "1000",
          arb_PurchasingGroup: "003",
          arb_CompanyCode: "C003",
          incoterms: "EXW",
          localIncoterms: "Curitiba",
          arb_PaymentTerms: "Z060 (60 dias)"
        }
      ];

      this.getView().getModel("vm").setProperty("/rows", linhas);
    }

  });
});
