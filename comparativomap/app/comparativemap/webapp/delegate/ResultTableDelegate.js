sap.ui.define([
    "sap/ui/mdc/TableDelegate",
    "sap/ui/mdc/table/Column",
    "sap/m/Text",
    "sap/m/Input", // Usaremos Input simples ou StepInput
    "sap/ui/mdc/FilterField",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/ui/model/Sorter",
    "../model/ResultPropertyInfo" // <--- APONTA PARA O NOVO ARQUIVO
], function (
    TableDelegate,
    TableColumn,
    Text,
    Input,
    FilterField,
    Filter,
    FilterOperator,
    Sorter,
    ResultPropertyInfo // <--- Injetado aqui
) {
    "use strict";

    const ResultTableDelegate = Object.assign({}, TableDelegate);

    // 1. Fetch Properties (Usa o arquivo novo)
    ResultTableDelegate.fetchProperties = function (oTable) {
        const aProps = (ResultPropertyInfo || []).map(p => Object.assign({}, p));
        return Promise.resolve(aProps);
    };

    // 2. Update Binding (Filtros e Sort básicos)
    ResultTableDelegate.updateBindingInfo = function (oTable, oBindingInfo) {
        // Assume sempre o model 'res' e o path '/rows' se não vier no payload
        oBindingInfo.path = oBindingInfo.path || "/rows";
        oBindingInfo.model = "res"; // Força o model res se necessário

        // --- Lógica padrão de Filtros e Sort (Cópia do outro delegate) ---
        const oFilterConditions = oTable.getFilterConditions();
        const aFilters = [];
        const mOp = {
            EQ: FilterOperator.EQ, GT: FilterOperator.GT, GE: FilterOperator.GE,
            LT: FilterOperator.LT, LE: FilterOperator.LE, BT: FilterOperator.BT,
            Contains: FilterOperator.Contains, StartsWith: FilterOperator.StartsWith
        };

        if (oFilterConditions) {
            for (const sField in oFilterConditions) {
                const aConditions = oFilterConditions[sField];
                if (aConditions && aConditions.length > 0) {
                    const aFieldFilters = aConditions.map(c => {
                        const sOperator = mOp[c.operator] || FilterOperator.EQ;
                        return new Filter(sField, sOperator, c.values[0], c.values.length > 1 ? c.values[1] : null);
                    });
                    aFilters.push(new Filter({ filters: aFieldFilters, and: false }));
                }
            }
        }
        oBindingInfo.filters = aFilters.length > 0 ? [new Filter({ filters: aFilters, and: true })] : [];

        const oSortConditions = oTable.getSortConditions();
        if (oSortConditions && oSortConditions.sorters) {
            oBindingInfo.sorter = oSortConditions.sorters.map(s => new Sorter(s.name, s.descending));
        }
    };

    // 3. Add Item (Colunas visuais - MODEL 'res')
    ResultTableDelegate.addItem = function (oTable, sPropertyName, mPropertyBag) {
        const oProp = ResultPropertyInfo.find(p => p.name === sPropertyName);
        if (!oProp) return Promise.resolve(null);

        return Promise.resolve().then(function () {
            // Caminho fixo com 'res>'
            const sPath = "res>" + oProp.path;
            let oTemplate;

            // Campo Editável de Premiação
            if (sPropertyName === "qtyAward") {
                oTemplate = new Input({
                    value: { path: sPath, type: oProp.dataType },
                    type: "Number",
                    change: ".onAwardQtyChangeRes" // Função do controller
                });
            } 
            // Floats (Dinheiro/Qtd)
            else if (oProp.dataType === "sap.ui.model.type.Float") {
                oTemplate = new Text({
                    text: {
                        path: sPath,
                        type: oProp.dataType,
                        formatOptions: { minFractionDigits: 2, maxFractionDigits: 2 }
                    },
                    textAlign: "End"
                });
            } 
            // Padrão Texto
            else {
                oTemplate = new Text({
                    text: { path: sPath, type: oProp.dataType },
                    wrapping: false
                });
            }

            return new TableColumn(oTable.getId() + "--col-" + sPropertyName, {
                propertyKey: sPropertyName,
                header: oProp.label,
                template: oTemplate,
                width: "10rem",
                hAlign: (oProp.dataType === "sap.ui.model.type.Float") ? "End" : "Begin"
            });
        });
    };

    // 4. Filter Delegate
    ResultTableDelegate.getFilterDelegate = function () {
        return {
            addItem: function (oParent, sPropertyName) {
                const oProp = ResultPropertyInfo.find(p => p.name === sPropertyName);
                if (!oProp) return Promise.resolve(null);
                return Promise.resolve(new FilterField({
                    conditions: "{$filters>/conditions/" + sPropertyName + "}",
                    dataType: oProp.dataType,
                    label: oProp.label,
                    maxConditions: -1
                }));
            },
            fetchProperties: function () {
                return Promise.resolve((ResultPropertyInfo || []).map(p => Object.assign({}, p)));
            }
        };
    };

    return ResultTableDelegate;
});