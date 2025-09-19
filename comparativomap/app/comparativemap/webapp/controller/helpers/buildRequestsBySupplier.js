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
    const headerRaw = (Map.getHeaderFromVM && typeof Map.getHeaderFromVM === "function")
      ? Map.getHeaderFromVM(vm)
      : (vm && vm.getProperty ? vm.getProperty("/header") : {});

    const groups = groupByVendor(rows);
    const requests = [];

    Object.entries(groups).forEach(([lifnr, arr]) => {
      const h0 = (Map.mapHeaderFromAriba && typeof Map.mapHeaderFromAriba === "function")
        ? Map.mapHeaderFromAriba(headerRaw, arr[0])
        : (headerRaw || {});

      const header = {
        ...h0,
        vendor: normalizeToPad10(lifnr) || Keys.pad10(String(lifnr || "").replace(/\D/g, "")),
        currency: (arr[0]?.currency || h0?.currency || "BRL").toString().toUpperCase().slice(0, 3)
      };

      // 👇 Gera poItem sequencial (10,20,30...) por FORNECEDOR e envia ao mapper
      const items = (arr || []).map((r, idx) => {
        const poItemNum = (idx + 1) * 10; // Integer (CDS espera Integer)
        if (Map.mapRowToPOItem && typeof Map.mapRowToPOItem === "function") {
          const it = Map.mapRowToPOItem(r, idx, poItemNum);
          return { ...it, poItem: poItemNum }; // redundância explícita
        }
        // fallback mínimo
        return {
          poItem: poItemNum,
          plant: r.PLANT || r.plant || "",
          shortText: r.itemDescription || r.ItemDescription || r.description || "",
          quantity: Number(r.quantity || 0),
          unit: r.unitOfMeasure || r.unit || ""
        };
      });

      // schedules casadas pelo MESMO poItem
      const schedules = items.map((it, i) => ({
        poItem: it.poItem,  // 👈 mesmo número
        schedLine: 1,
        deliveryDate: (Map.getDeliveryDateFromRow && typeof Map.getDeliveryDateFromRow === "function")
          ? Map.getDeliveryDateFromRow(arr[i])
          : (arr[i]?.DELIVERY_DATE_RAW?.dateValue || arr[i]?.deliveryDate || new Date()),
        quantity: it.quantity
      }));

      requests.push({ header, items, schedules, testRun: true });
    });

    console.table(requests.map(r => ({
      vendor: r.header.vendor,
      items: r.items.length,
      currency: r.header.currency
    })));

    return requests;
  }
  return { buildRequestsFromSelection };
});
