sap.ui.define(
  ["sap/ui/model/json/JSONModel", "sap/ui/Device", "sap/ui/model/BindingMode"],
  function (JSONModel, Device, BindingMode) {
    "use strict";

    function createDeviceModel() {
      const oModel = new JSONModel(Device);
      // boa prática: usar o enum em vez de string
      oModel.setDefaultBindingMode(BindingMode.OneWay);
      return oModel;
    }

    // === VM: dados principais do comparativo / cabeçalho + itens ===
    function createVM() {
      const vm = new JSONModel({
        header: {
          tipoPedido: "",
          purchasingOrganization: "",
          purchasingGroup: "",
          companyCode: "",
          incoterms1: "",
          incoterms2: "",
          paymentTerms: "",
          docId: "",
          moeda: "",
          fornecedor: "",
        },
        headerRows: [],
        rows: [], // itens preenchidos no onBuscar (com _originalQty)
      });
      vm.setSizeLimit(10000);
      vm.setDefaultBindingMode(BindingMode.TwoWay);
      return vm;
    }

    // === QM: estado da simulação/premiação (seleção, índices, etc.) ===
    function createQM() {
      const qm = new JSONModel({
        items: [], // linhas selecionadas para simulação
        perKey: {}, // somatórios por itemKey (se precisar)
        validAward: false,
        _summaryText: "",
        idx: {}, // índice auxiliar
        idByKey: {}, // chave material+LIFNR/NOME → meta (itemId, invitationId, etc.)
        simSourceRows: [], // linhas selecionadas na tabela (fonte da simulação)
      });
      qm.setSizeLimit(10000);
      // OneWay é suficiente aqui (o controller usa setProperty/checkUpdate quando necessário)
      // qm.setDefaultBindingMode(BindingMode.OneWay);
      return qm;
    }

    return {
      createDeviceModel,
      createVM,
      createQM,
    };
  },
);
