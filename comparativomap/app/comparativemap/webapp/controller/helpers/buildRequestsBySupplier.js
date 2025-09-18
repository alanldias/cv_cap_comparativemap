/* controller/helpers/buildRequestsBySupplier.js */
sap.ui.define([
  "comparativemap/comparativemap/controller/helpers/KeyUtils",
  "comparativemap/comparativemap/controller/services/SimulationMapper"
], function (Keys, Map) {
  "use strict";

  function normalizeToPad10(raw) {
    if (raw === undefined || raw === null) return null;
    const s = String(raw).replace(/\D/g, "");
    if (!s) return null;
    return Keys.pad10(s);
  }

  function resolveLifnr(row) {
    // tenta vários campos conhecidos (case-insensitive / variações)
    const candidates = [
      row?.lifnr,
      row?.Lifnr,
      row?.supplierId,
      row?.supplierID,
      row?.SupplierCode,
      row?.supplierCode,
      row?.suppliercode,
      row?.Supplier,
      row?.vendor,
      row?.Vendor
    ];

    for (const c of candidates) {
      const p = normalizeToPad10(c);
      if (p) return p;
    }

    // se nome do fornecedor for apenas números -> usa ele
    const name = row?.supplierName || row?.SupplierName || row?.supplier || row?.Supplier;
    if (name && /^\d+$/.test(String(name).trim())) {
      const p = normalizeToPad10(name);
      if (p) return p;
    }

    return null; // não achou
  }

  function groupByVendor(rows) {
    const groups = {};
    const missing = [];
    (rows || []).forEach((r, idx) => {
      const lifnr = resolveLifnr(r);
      if (!lifnr) {
        // guarda contexto para erro compreensível
        missing.push({
          idx,
          itemId: r?.itemId ?? r?.ItemId ?? null,
          supplierName: r?.supplierName ?? r?.SupplierName ?? null,
          SupplierCode: r?.SupplierCode ?? r?.supplierCode ?? null
        });
        return;
      }
      (groups[lifnr] ||= []).push(r);
    });

    if (missing.length) {
      const lines = missing.map(m => `#${m.idx + 1} itemId=${m.itemId || "(n/a)"} supplierName="${m.supplierName || ""}" SupplierCode="${m.SupplierCode || ""}"`).join("\n");
      throw new Error(
        `Não foi possível resolver LIFNR para ${missing.length} linha(s). Verifique SupplierCode/supplierId nas linhas:\n${lines}`
      );
    }

    return groups;
  }

  function buildRequestsFromSelection(rows, vm) {
    // obtém header bruto do VM (se disponível) via Map.getHeaderFromVM
    const headerRaw = (Map.getHeaderFromVM && typeof Map.getHeaderFromVM === "function")
      ? Map.getHeaderFromVM(vm)
      : (vm && vm.getProperty ? vm.getProperty("/header") : {});

    const groups = groupByVendor(rows);
    const requests = [];

    Object.entries(groups).forEach(([lifnr, arr]) => {
      // monta header baseado no headerRaw e na primeira linha do grupo
      const h0 = (Map.mapHeaderFromAriba && typeof Map.mapHeaderFromAriba === "function")
        ? Map.mapHeaderFromAriba(headerRaw, arr[0])
        : (headerRaw || {});

      const header = {
        ...h0,
        // override garantido com o lifnr encontrado
        vendor: normalizeToPad10(lifnr) || Keys.pad10(String(lifnr || "").replace(/\D/g, "")),
        currency: (arr[0]?.currency || h0?.currency || "BRL").toString().toUpperCase().slice(0, 3)
      };

      // mapear itens usando teu SimulationMapper (idx recomeça no grupo)
      const items = (arr || []).map((r, idx) => {
        if (Map.mapRowToPOItem && typeof Map.mapRowToPOItem === "function") {
          return Map.mapRowToPOItem(r, idx);
        }
        // fallback mínimo
        return {
          poItem: (idx + 1) * 10,
          plant: r.PLANT || r.plant || "",
          shortText: r.itemDescription || r.ItemDescription || r.description || "",
          quantity: Number(r.quantity || 0),
          unit: r.unitOfMeasure || r.unit || ""
        };
      });

      // schedules paralelos aos itens (um schedule por item)
      const schedules = items.map((it, i) => ({
        poItem: it.poItem,
        schedLine: 1,
        deliveryDate: (Map.getDeliveryDateFromRow && typeof Map.getDeliveryDateFromRow === "function")
          ? Map.getDeliveryDateFromRow(arr[i])
          : (arr[i]?.DELIVERY_DATE_RAW?.dateValue || arr[i]?.deliveryDate || new Date()),
        quantity: it.quantity
      }));

      requests.push({ header, items, schedules, testRun: true });
    });

    // DEBUG: mostra resumo fácil
    /* eslint-disable no-console */
    console.table(requests.map(r => ({
      vendor: r.header.vendor,
      items: r.items.length,
      currency: r.header.currency
    })));
    /* eslint-enable no-console */

    return requests;
  }

  return { buildRequestsFromSelection };
});
