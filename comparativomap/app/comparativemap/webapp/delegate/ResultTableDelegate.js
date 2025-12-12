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
  "comparativemap/comparativemap/model/ResultPropertyInfo"
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
  ResultPropertyInfo
) {
  "use strict";

  const ResultTableDelegate = Object.assign({}, TableDelegate);

  function _splitBindingPath(bindingPath, fallbackModel, fallbackPath) {
    if (!bindingPath) return { model: fallbackModel, path: fallbackPath };

    const s = String(bindingPath);
    const idx = s.indexOf(">");
    if (idx > -1) {
      return { model: s.slice(0, idx), path: s.slice(idx + 1) || fallbackPath };
    }
    return { model: fallbackModel, path: s || fallbackPath };
  }

  function _makeType(dataType, isQty = false) {
    const dt = String(dataType || "");
    if (dt.includes("Integer")) return new TypeInteger();
    if (dt.includes("Float")) {
      const opts = isQty
        ? { minFractionDigits: 0, maxFractionDigits: 0 }
        : { minFractionDigits: 2, maxFractionDigits: 2 };
      return new TypeFloat(opts);
    }
    return new TypeString();
  }

  function _getController(mPropertyBag) {
    const v = mPropertyBag && mPropertyBag.view;
    return v && v.getController ? v.getController() : null;
  }

  ResultTableDelegate.fetchProperties = function () {
    return Promise.resolve((ResultPropertyInfo || []).map(p => ({ ...p })));
  };

  ResultTableDelegate.updateBindingInfo = function (oTable, oBindingInfo) {
    const payload = oTable.getPayload && oTable.getPayload();
    const bp = payload && payload.bindingPath;

    const { model, path } = _splitBindingPath(bp, "res", "/rows");
    oBindingInfo.model = model;
    oBindingInfo.path = path;

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

    const sortState = (oTable.getSortConditions && oTable.getSortConditions()) || {};
    const sorters = Array.isArray(sortState.sorters) ? sortState.sorters : [];
    oBindingInfo.sorter = sorters.map(s => new Sorter(s.name, !!s.descending, !!(s.grouped || s.group || s.isGrouped)));
  };

  ResultTableDelegate.addItem = function (oTable, sPropertyName, mPropertyBag) {
    if (!sPropertyName) return Promise.resolve(null);

    const oProp = (ResultPropertyInfo || []).find(p => p.name === sPropertyName);
    if (!oProp) return Promise.resolve(null);

    const ctrl = _getController(mPropertyBag);
    const payload = oTable.getPayload && oTable.getPayload();
    const bp = payload && payload.bindingPath;
    const { model } = _splitBindingPath(bp, "res", "/rows");
    const sPath = `${model}>${oProp.path || oProp.name}`;

    return Promise.resolve().then(function () {
      let template;

      if (sPropertyName === "qtyAward") {
        const fn = ctrl && typeof ctrl.onAwardQtyChangeRes === "function"
          ? ctrl.onAwardQtyChangeRes.bind(ctrl)
          : null;

        template = new StepInput({
          value: { path: sPath, type: _makeType(oProp.dataType, true) },
          width: "75%",
          textAlign: "Center",
          step: 1,
          change: fn || undefined
        });
      }
      else if (String(oProp.dataType || "").includes("Float") || String(oProp.dataType || "").includes("Integer")) {
        template = new Text({
          text: { path: sPath, type: _makeType(oProp.dataType, false) },
          wrapping: false,
          textAlign: "End"
        });
      } else {
        template = new Text({
          text: { path: sPath, type: _makeType(oProp.dataType, false) },
          wrapping: false,
          tooltip: { path: sPath }
        });
      }

      const col = new TableColumn(oTable.getId() + "--col-" + sPropertyName, {
        propertyKey: sPropertyName,
        header: oProp.label || sPropertyName,
        template,
        width: "10rem",
        hAlign: (String(oProp.dataType || "").includes("Float") || String(oProp.dataType || "").includes("Integer")) ? "End" : "Begin"
      });

      if (oProp.visible === false && col.setVisible) col.setVisible(false);

      return col;
    });
  };

  ResultTableDelegate.getFilterDelegate = function () {
    return {
      addItem: function (oParent, sPropertyName) {
        const oProp = (ResultPropertyInfo || []).find(p => p.name === sPropertyName);
        if (!oProp) return Promise.resolve(null);

        return Promise.resolve(new FilterField({
          label: oProp.label,
          dataType: oProp.dataType,
          maxConditions: -1,
          conditions: "{$filters>/conditions/" + sPropertyName + "}"
        }));
      },
      fetchProperties: function () {
        return Promise.resolve((ResultPropertyInfo || []).map(p => ({ ...p })));
      }
    };
  };

  return ResultTableDelegate;
});
