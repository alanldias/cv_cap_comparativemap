// Arquivo: comparativemap/comparativemap/model/PropertyInfo.js
sap.ui.define([], function () {
    "use strict";

    // Definição centralizada das colunas
    return [
        { name: "supplierName", path: "supplierName", label: "Fornecedor", dataType: "sap.ui.model.type.String", filterable: true, sortable: true, maxConditions: 1 },
        { name: "itemDescription", path: "itemDescription", label: "Nome do Item", dataType: "sap.ui.model.type.String", filterable: true, sortable: true },
        { name: "currency", path: "currency", label: "Moeda", dataType: "sap.ui.model.type.String", filterable: true, sortable: true },
        { name: "ncm", path: "ncm", label: "NCM", dataType: "sap.ui.model.type.String", filterable: true, sortable: true },
        { name: "PLANT", path: "PLANT", label: "Centro", dataType: "sap.ui.model.type.String", filterable: true, sortable: true },
        { name: "Extrinsic_Origem_do_Material", path: "Extrinsic_Origem_do_Material", label: "Origem do Material", dataType: "sap.ui.model.type.String", filterable: true, sortable: true },
        { name: "ItemCategory", path: "ItemCategory", label: "Categoria do Item", dataType: "sap.ui.model.type.String", filterable: true, sortable: true },
        { name: "CodigoRequisicao", path: "CodigoRequisicao", label: "Código da Requisição", dataType: "sap.ui.model.type.String", filterable: true, sortable: true },
        { name: "grupo_de_materias", path: "grupo_de_materias", label: "Grupo de Materiais", dataType: "sap.ui.model.type.String", filterable: true, sortable: true },
        { name: "MaterialCode", path: "MaterialCode", label: "Código Material", dataType: "sap.ui.model.type.String", filterable: true, sortable: true },
        { name: "Incoterms", path: "Incoterms", label: "Incoterms", dataType: "sap.ui.model.type.String", filterable: true, sortable: true },
        { name: "NumeroItensRequisicao", path: "NumeroItensRequisicao", label: "Nº Itens Req.", dataType: "sap.ui.model.type.String", filterable: true, sortable: true },
        { name: "CodigoRFQ", path: "CodigoRFQ", label: "Código da RFQ", dataType: "sap.ui.model.type.String", filterable: true, sortable: true },
        { name: "DeliveryDateNice", path: "DeliveryDateNice", label: "Dt. Entrega Solicitada", dataType: "sap.ui.model.type.String", filterable: true, sortable: true },
        { name: "PrazoEntrega", path: "PrazoEntrega", label: "Prazo de Entrega", dataType: "sap.ui.model.type.String", filterable: true, sortable: true },
        { name: "suppliercode", path: "suppliercode", label: "Supplier Code", dataType: "sap.ui.model.type.String", filterable: true, sortable: true },

        { name: "quantity", path: "quantity", label: "Quantidade", dataType: "sap.ui.model.type.Float", filterable: true, sortable: true },
        { name: "price", path: "price", label: "Preço do Item", dataType: "sap.ui.model.type.Float", filterable: true, sortable: true },
        { name: "EXTENDEDPRICE", path: "EXTENDEDPRICE", label: "Preço Estendido", dataType: "sap.ui.model.type.Float", filterable: true, sortable: true },
        { name: "mva", path: "mva", label: "MVA (%)", dataType: "sap.ui.model.type.Float", filterable: true, sortable: true },
        { name: "Extrinsic_Aliquota_ICMS", path: "Extrinsic_Aliquota_ICMS", label: "Alíquota ICMS (%)", dataType: "sap.ui.model.type.Float", filterable: true, sortable: true },
        { name: "Extrinsic_ICMS_Apurado", path: "Extrinsic_ICMS_Apurado", label: "ICMS Apurado", dataType: "sap.ui.model.type.Float", filterable: true, sortable: true },
        { name: "Extrinsic_Aliquota_IPI", path: "Extrinsic_Aliquota_IPI", label: "Alíquota IPI (%)", dataType: "sap.ui.model.type.Float", filterable: true, sortable: true },
        { name: "Extrinsic_IPI_Apurado", path: "Extrinsic_IPI_Apurado", label: "IPI Apurado", dataType: "sap.ui.model.type.Float", filterable: true, sortable: true },
        { name: "Extrinsic_Aliquota_PIS", path: "Extrinsic_Aliquota_PIS", label: "Alíquota PIS (%)", dataType: "sap.ui.model.type.Float", filterable: true, sortable: true },
        { name: "Extrinsic_PIS_Apurado", path: "Extrinsic_PIS_Apurado", label: "PIS Apurado", dataType: "sap.ui.model.type.Float", filterable: true, sortable: true },
        { name: "Extrinsic_Aliquota_Cofins", path: "Extrinsic_Aliquota_Cofins", label: "Alíquota COFINS (%)", dataType: "sap.ui.model.type.Float", filterable: true, sortable: true },
        { name: "Extrinsic_Cofins_apurado", path: "Extrinsic_Cofins_apurado", label: "COFINS Apurado", dataType: "sap.ui.model.type.Float", filterable: true, sortable: true },
        { name: "Extrinsic_Aliquota_ICMS_Interna", path: "Extrinsic_Aliquota_ICMS_Interna", label: "Alíq. ICMS Interna (%)", dataType: "sap.ui.model.type.Float", filterable: true, sortable: true }
    ];
});