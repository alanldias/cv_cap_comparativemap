sap.ui.define([
    "sap/ui/mdc/TableDelegate",
    "sap/ui/mdc/table/Column",
    "sap/m/Text",
    "sap/m/StepInput",
    "sap/ui/mdc/FilterField",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/ui/model/Sorter",
    "comparativemap/comparativemap/model/PropertyInfo" // <--- SEU NOVO ARQUIVO AQUI
], function (
    TableDelegate,
    TableColumn,
    Text,
    StepInput,
    FilterField,
    Filter,
    FilterOperator,
    Sorter,
    PropertyInfo // <--- Injetado aqui
) {
    "use strict";

    const JSONTableDelegate = Object.assign({}, TableDelegate);

    // ----------------------------------------------------------
    // 1. Fetch Properties (Para o Dialog de Colunas/Filtros)
    // ----------------------------------------------------------
    JSONTableDelegate.fetchProperties = function (oTable) {
        // O MDC exige que isso seja uma Promise que retorna um Array
        // Clonamos o array para evitar mutação acidental
        const aProps = (PropertyInfo || []).map(p => Object.assign({}, p));
        return Promise.resolve(aProps);
    };

    // ----------------------------------------------------------
    // 2. Update Binding (Aplicar Filtros/Sort no JSONModel)
    // ----------------------------------------------------------
    JSONTableDelegate.updateBindingInfo = function (oTable, oBindingInfo) {
        // Apenas chama a implementação padrão se você NÃO quiser controle total
        // TableDelegate.updateBindingInfo.apply(this, arguments); 

        // --- LÓGICA MANUAL PARA JSON MODEL ---
        
        // A) Path
        const oPayload = oTable.getPayload();
        if (oPayload && oPayload.bindingPath) {
            oBindingInfo.path = oPayload.bindingPath;
        }

        // B) Filtros
        const oFilterConditions = oTable.getFilterConditions();
        const aFilters = [];
        const mOp = {
            EQ: FilterOperator.EQ, GT: FilterOperator.GT, GE: FilterOperator.GE,
            LT: FilterOperator.LT, LE: FilterOperator.LE, BT: FilterOperator.BT,
            Contains: FilterOperator.Contains, StartsWith: FilterOperator.StartsWith, EndsWith: FilterOperator.EndsWith
        };

        if (oFilterConditions) {
            for (const sField in oFilterConditions) {
                const aConditions = oFilterConditions[sField];
                if (aConditions && aConditions.length > 0) {
                    // Mapeia cada condição do campo
                    const aFieldFilters = aConditions.map(c => {
                        const sOperator = mOp[c.operator] || FilterOperator.EQ;
                        const v1 = c.values[0];
                        const v2 = c.values.length > 1 ? c.values[1] : null;
                        return new Filter(sField, sOperator, v1, v2);
                    });
                    // Agrupa com OR (mesmo campo = OR)
                    aFilters.push(new Filter({ filters: aFieldFilters, and: false }));
                }
            }
        }

        oBindingInfo.filters = [];
        if (aFilters.length > 0) {
            // Agrupa diferentes campos com AND
            oBindingInfo.filters.push(new Filter({ filters: aFilters, and: true }));
        }

        // C) Sort
        const oSortConditions = oTable.getSortConditions();
        oBindingInfo.sorter = [];
        if (oSortConditions && oSortConditions.sorters && oSortConditions.sorters.length > 0) {
            oBindingInfo.sorter = oSortConditions.sorters.map(s => new Sorter(s.name, s.descending));
        }
    };

    // ----------------------------------------------------------
    // 3. Add Item (Criar as colunas visuais)
    // ----------------------------------------------------------
    JSONTableDelegate.addItem = function (oTable, sPropertyName, mPropertyBag) {
        // Proteção contra chamadas vazias que causam erro 'find'
        if (!sPropertyName) return Promise.resolve(null);

        const oProp = PropertyInfo.find(p => p.name === sPropertyName);
        
        // Se não achou a propriedade, retorna null (evita quebra)
        if (!oProp) {
            console.error(`JSONTableDelegate: Propriedade '${sPropertyName}' não encontrada no PropertyInfo.`);
            return Promise.resolve(null);
        }

        return Promise.resolve().then(function () {
            let oTemplate;

            // Lógica de Template Específica
            if (sPropertyName === "quantity") {
                oTemplate = new StepInput({
                    value: { path: "vm>" + oProp.path, type: oProp.dataType },
                    width: "100%",
                    change: ".onQtyInlineChange"
                });
            } 
            else if (oProp.dataType === "sap.ui.model.type.Float") {
                oTemplate = new Text({
                    text: {
                        path: "vm>" + oProp.path,
                        type: oProp.dataType,
                        formatOptions: { minFractionDigits: 2, maxFractionDigits: 2 }
                    },
                    textAlign: "End",
                    wrapping: false
                });
            } 
            else {
                oTemplate = new Text({
                    text: { path: "vm>" + oProp.path, type: oProp.dataType },
                    wrapping: true,
                    maxLines: 2,
                    tooltip: { path: "vm>" + oProp.path }
                });
            }

            const sId = oTable.getId() + "--col-" + sPropertyName;
            const oColumn = new TableColumn(sId, {
                propertyKey: sPropertyName,
                header: oProp.label,
                template: oTemplate,
                width: "10rem",
                hAlign: (oProp.dataType === "sap.ui.model.type.Float") ? "End" : "Begin"
            });

            return oColumn;
        });
    };

    // ----------------------------------------------------------
    // 4. Filter Delegate (Obrigatório para a engrenagem funcionar)
    // ----------------------------------------------------------
    JSONTableDelegate.getFilterDelegate = function () {
        return {
            addItem: function (oParent, sPropertyName) {
                const oProp = PropertyInfo.find(p => p.name === sPropertyName);
                if (!oProp) return Promise.resolve(null);

                return Promise.resolve().then(function () {
                    const oFilterField = new FilterField({
                        conditions: "{$filters>/conditions/" + sPropertyName + "}",
                        dataType: oProp.dataType,
                        label: oProp.label,
                        maxConditions: oProp.maxConditions !== undefined ? oProp.maxConditions : -1
                    });
                    return oFilterField;
                });
            },
            // CRUCIAL: O FilterDelegate TAMBÉM precisa saber buscar as propriedades
            fetchProperties: function (oTable) {
                const aProps = (PropertyInfo || []).map(p => Object.assign({}, p));
                return Promise.resolve(aProps);
            }
        };
    };

    return JSONTableDelegate;
});