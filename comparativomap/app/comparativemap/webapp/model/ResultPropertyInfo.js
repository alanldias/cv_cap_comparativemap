sap.ui.define([], function () {
    "use strict";

    return [
        { name: "supplierName", label: "Fornecedor", dataType: "sap.ui.model.type.String", path: "supplierName" },
        { name: "materialCode", label: "Material", dataType: "sap.ui.model.type.String", path: "materialCode" },

        // Numéricos
        { name: "originalQty", label: "Qtd Original", dataType: "sap.ui.model.type.Float", path: "originalQty" },
        { name: "quantity", label: "Qtd Simulada", dataType: "sap.ui.model.type.Float", path: "quantity" },
        { name: "qtyAward", label: "Qtd Premiar", dataType: "sap.ui.model.type.Integer", path: "qtyAward" }, // Editável

        // Financeiro
        { name: "netPrice", label: "Preço Liquido", dataType: "sap.ui.model.type.Float", path: "netPrice" },
        { name: "grossPrice", label: "Preço Bruto", dataType: "sap.ui.model.type.Float", path: "grossPrice" },
        { name: "currency", label: "Moeda", dataType: "sap.ui.model.type.String", path: "currency" },
        { name: "icms", label: "icms", dataType: "sap.ui.model.type.Float", path: "icms" },
        { name: "ipi", label: "ipi", dataType: "sap.ui.model.type.Float", path: "ipi" },
        { name: "totalLiquido", label: "Total Liquido", dataType: "sap.ui.model.type.Float", path: "totalLiquido" },
        { name: "totalBruto", label: "Total Bruto", dataType: "sap.ui.model.type.Float", path: "totalBruto" },

        // Outros
        { name: "ncm", label: "NCM", dataType: "sap.ui.model.type.String", path: "ncm" },
        { name: "poItem", label: "Item PO", dataType: "sap.ui.model.type.String", path: "poItem" },
        { name: "taxCode", label: "IVA", dataType: "sap.ui.model.type.String", path: "taxCode" },

        // Campos ocultos (úteis para payload de premiação)
        { name: "itemId", label: "Item ID", dataType: "sap.ui.model.type.String", path: "itemId", visible: false },
        { name: "invitationId", label: "Invitation ID", dataType: "sap.ui.model.type.String", path: "invitationId", visible: false },

    ];
});