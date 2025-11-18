sap.ui.define([
    "sap/ui/mdc/TableDelegate"
], function (TableDelegate) {
    "use strict";

    // Clona o TableDelegate base
    const JSONTableDelegate = Object.assign({}, TableDelegate);

    // 1) Diz pro MDC quais propriedades existem na nossa tabela
    JSONTableDelegate.fetchProperties = function (oTable) {
        return Promise.resolve([
            {
                name: "supplierName",
                label: "Fornecedor",
                dataType: "String",
                sortable: true,
                filterable: true,
                groupable: true,
                maxConditions: -1 // permite vários filtros
            },
            {
                name: "itemName",
                label: "Nome do Item",
                dataType: "String",
                sortable: true,
                filterable: true
            },
            {
                name: "quantity",
                label: "Quantidade",
                dataType: "Decimal",
                sortable: true,
                filterable: true
            },
            {
                name: "price",
                label: "Preço do Item",
                dataType: "Decimal",
                sortable: true,
                filterable: true
            }
            // 👉 aqui você vai listando TODAS as props que existem em vm>/rows:
            // currency, ncm, mva, Extrinsic_Aliquota_ICMS, PLANT etc.
        ]);
    };

    // 2) Diz como o binding das linhas é montado (usa o payload.bindingPath)
    JSONTableDelegate.updateBindingInfo = function (oTable, oBindingInfo) {
        const oPayload = oTable.getDelegate().payload || {};
        const sPath = oPayload.bindingPath || "vm>/rows";

        // padrão '<modelo>><caminho>' igual ao do tutorial (ex: 'vm>/rows')
        const aParts = sPath.split(">");
        if (aParts.length === 2) {
            oBindingInfo.model = aParts[0];    // "vm"
            oBindingInfo.path = aParts[1];     // "/rows"
        } else {
            oBindingInfo.path = sPath;
        }
    };

    return JSONTableDelegate;
});
