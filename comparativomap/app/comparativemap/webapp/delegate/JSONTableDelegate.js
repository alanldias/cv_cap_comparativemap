sap.ui.define([
  "sap/ui/mdc/TableDelegate",
  "sap/ui/mdc/table/Column",
  "sap/m/Text",
  "sap/m/StepInput",
  "sap/ui/mdc/FilterField",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/ui/model/Sorter",
  "sap/ui/model/type/String",
  "sap/ui/model/type/Float",
  "sap/ui/model/type/Integer",
  "comparativemap/comparativemap/model/PropertyInfo"
], function (
  TableDelegate,
  TableColumn,
  Text,
  StepInput,
  FilterField,
  Filter,
  FilterOperator,
  Sorter,
  TypeString,
  TypeFloat,
  TypeInteger,
  PropertyInfo
) {
  "use strict";

  const JSONTableDelegate = Object.assign({}, TableDelegate);

  function _splitBindingPath(bindingPath, fallbackModel, fallbackPath) {
    if (!bindingPath) return { model: fallbackModel, path: fallbackPath };

    // aceita "vm>/rows" ou "/rows"
    const s = String(bindingPath);
    const idx = s.indexOf(">");
    if (idx > -1) {
      return {
        model: s.slice(0, idx),
        path: s.slice(idx + 1) || fallbackPath
      };
    }
    return { model: fallbackModel, path: s || fallbackPath };
  }

  function _makeType(dataType, isQty = false) {
    const dt = String(dataType || "");
    if (dt.includes("Integer")) return new TypeInteger();

    if (dt.includes("Float")) {
      // quantidade normalmente sem casas; preços com 2 casas.
      const opts = isQty
        ? { minFractionDigits: 0, maxFractionDigits: 0 }
        : { minFractionDigits: 2, maxFractionDigits: 2 };
      return new TypeFloat(opts);
    }

    return new TypeString();
  }

  function _getController(mPropertyBag) {
    // mPropertyBag.view vem quando o MDC chama o delegate no contexto da View
    const v = mPropertyBag && mPropertyBag.view;
    return v && v.getController ? v.getController() : null;
  }

  JSONTableDelegate.fetchProperties = function () {
    return Promise.resolve((PropertyInfo || []).map(p => ({ ...p })));
  };

  JSONTableDelegate.updateBindingInfo = function (oTable, oBindingInfo) {
    const payload = oTable.getPayload && oTable.getPayload();
    const bp = payload && payload.bindingPath;

    const { model, path } = _splitBindingPath(bp, "vm", "/rows");
    oBindingInfo.model = model;
    oBindingInfo.path = path;

    // -------- FILTERS --------
    const cond = (oTable.getFilterConditions && oTable.getFilterConditions()) || {};
    const aAnd = [];

    const opMap = {
      EQ: FilterOperator.EQ,
      NE: FilterOperator.NE,
      GT: FilterOperator.GT,
      GE: FilterOperator.GE,
      LT: FilterOperator.LT,
      LE: FilterOperator.LE,
      BT: FilterOperator.BT,
      Contains: FilterOperator.Contains,
      StartsWith: FilterOperator.StartsWith,
      EndsWith: FilterOperator.EndsWith
    };

    Object.keys(cond).forEach((field) => {
      const list = cond[field];
      if (!Array.isArray(list) || !list.length) return;

      const aOr = list.map(c => {
        const op = opMap[c.operator] || FilterOperator.EQ;
        const v1 = c.values && c.values.length ? c.values[0] : null;
        const v2 = c.values && c.values.length > 1 ? c.values[1] : null;
        return new Filter(field, op, v1, v2);
      });

      aAnd.push(new Filter({ and: false, filters: aOr }));
    });

    oBindingInfo.filters = aAnd.length ? [new Filter({ and: true, filters: aAnd })] : [];

    // -------- SORT / GROUP --------
    const sortState = (oTable.getSortConditions && oTable.getSortConditions()) || {};
    const sorters = Array.isArray(sortState.sorters) ? sortState.sorters : [];

    oBindingInfo.sorter = sorters.map(s => {
      // alguns builds marcam grouping no sorter (depende da versão)
      const vGroup = !!(s.grouped || s.group || s.isGrouped);
      return new Sorter(s.name, !!s.descending, vGroup);
    });
  };

  JSONTableDelegate.addItem = function (oTable, sPropertyName, mPropertyBag) {
    if (!sPropertyName) return Promise.resolve(null);

    const oProp = (PropertyInfo || []).find(p => p.name === sPropertyName);
    if (!oProp) return Promise.resolve(null);

    const ctrl = _getController(mPropertyBag);

    const payload = oTable.getPayload && oTable.getPayload();
    const bp = payload && payload.bindingPath;
    const { model } = _splitBindingPath(bp, "vm", "/rows");
    const sPath = `${model}>${oProp.path || oProp.name}`;

    return Promise.resolve().then(function () {
      let template;

      // quantity editável (se o usuário recriar a coluna pelo P13N)
      if (sPropertyName === "quantity") {
        const fn = ctrl && typeof ctrl.onQtyInlineChange === "function"
          ? ctrl.onQtyInlineChange.bind(ctrl)
          : null;

        template = new StepInput({
          value: { path: sPath, type: _makeType(oProp.dataType, true) },
          width: "75%",
          textAlign: "Center",
          step: 1,
          change: fn || undefined
        });
      }
      // numéricos
      else if (String(oProp.dataType || "").includes("Float") || String(oProp.dataType || "").includes("Integer")) {
        template = new Text({
          text: { path: sPath, type: _makeType(oProp.dataType, false) },
          wrapping: false,
          textAlign: "End"
        });
      }
      // texto
      else {
        template = new Text({
          text: { path: sPath, type: _makeType(oProp.dataType, false) },
          wrapping: true,
          maxLines: 2,
          tooltip: { path: sPath }
        });
      }

      const col = new TableColumn(oTable.getId() + "--col-" + sPropertyName, {
        propertyKey: sPropertyName,
        header: oProp.label || sPropertyName,
        template: template,
        width: "10rem",
        hAlign: (String(oProp.dataType || "").includes("Float") || String(oProp.dataType || "").includes("Integer")) ? "End" : "Begin"
      });

      // se você usar visible no PropertyInfo
      if (oProp.visible === false && col.setVisible) col.setVisible(false);

      return col;
    });
  };

  JSONTableDelegate.getFilterDelegate = function () {
    return {
      addItem: function (oParent, sPropertyName) {
        const oProp = (PropertyInfo || []).find(p => p.name === sPropertyName);
        if (!oProp) return Promise.resolve(null);

        return Promise.resolve(new FilterField({
          label: oProp.label,
          dataType: oProp.dataType, // aqui pode ser string mesmo
          maxConditions: oProp.maxConditions !== undefined ? oProp.maxConditions : -1,
          conditions: "{$filters>/conditions/" + sPropertyName + "}"
        }));
      },
      fetchProperties: function () {
        return Promise.resolve((PropertyInfo || []).map(p => ({ ...p })));
      }
    };
  };

  return JSONTableDelegate;
});
