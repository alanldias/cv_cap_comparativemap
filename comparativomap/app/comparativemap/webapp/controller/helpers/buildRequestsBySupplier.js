sap.ui.define([
  "comparativemap/comparativemap/controller/helpers/KeyUtils",
  "comparativemap/comparativemap/controller/services/SimulationMapper"
], function (Keys, Map) {
  "use strict";

  function normalizeToPad10(raw) { // normaliza qualquer input -> LIFNR 10 dígitos (só números)
    if (raw === undefined || raw === null) return null;
    const s = String(raw).replace(/\D/g, "");
    if (!s) return null;
    return Keys.pad10(s);
  }

  function resolveLifnr(row) { // tenta resolver fornecedor (LIFNR) a partir de múltiplos campos possíveis
    const candidates = [
      row?.lifnr, row?.Lifnr, row?.supplierId, row?.supplierID,
      row?.SupplierCode, row?.supplierCode, row?.suppliercode,
      row?.Supplier, row?.vendor, row?.Vendor
    ];
    for (const c of candidates) {
      const p = normalizeToPad10(c);
      if (p) return p;
    }
    const name = row?.supplierName || row?.SupplierName || row?.supplier || row?.Supplier; // fallback: nome numérico
    if (name && /^\d+$/.test(String(name).trim())) {
      const p = normalizeToPad10(name);
      if (p) return p;
    }
    return null;
  }

  function groupByVendor(rows) { // agrupa seleção por fornecedor; falha se existir linha sem LIFNR resolvível
    const groups = {};
    const missing = [];
    (rows || []).forEach(function (r, idx) {
      const lifnr = resolveLifnr(r);
      if (!lifnr) {
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
      const lines = missing.map(function (m) {
        return `#${m.idx + 1} itemId=${m.itemId || "(n/a)"} supplierName="${m.supplierName || ""}" SupplierCode="${m.SupplierCode || ""}"`;
      }).join("\n");
      throw new Error(
        `Não foi possível resolver LIFNR para ${missing.length} linha(s). Verifique SupplierCode/supplierId nas linhas:\n${lines}`
      );
    }
    return groups;
  }

  function extractPoItemFromRow(row) { // extrai PO_ITEM (numérico) da linha; sem fallback/geração automática
    const raw = row?.poItem ?? row?.PO_ITEM ?? row?.PoItem ?? row?.poitem;
    if (raw == null) return null;
    const digits = String(raw).replace(/\D/g, "");
    if (!digits) return null;
    const n = Number(digits);
    return Number.isFinite(n) ? n : null;
  }

  function buildRequestsFromSelection(rows, vm) { // monta payload de simulação em lote (1 request por fornecedor)
    const headerRaw =
      (Map.getHeaderFromVM && typeof Map.getHeaderFromVM === "function")
        ? Map.getHeaderFromVM(vm)
        : (vm && vm.getProperty ? vm.getProperty("/header") : {});

    const groups = groupByVendor(rows);
    const requests = [];

    Object.entries(groups).forEach(function ([lifnr, arr]) {
      const h0 =
        (Map.mapHeaderFromAriba && typeof Map.mapHeaderFromAriba === "function")
          ? Map.mapHeaderFromAriba(headerRaw, arr[0])
          : (headerRaw || {});

      const header = { // header por fornecedor (vendor + moeda)
        ...h0,
        vendor: normalizeToPad10(lifnr) || Keys.pad10(String(lifnr || "").replace(/\D/g, "")),
        currency: (arr[0]?.currency || h0?.currency || "BRL").toString().toUpperCase().slice(0, 3)
      };

      const missingPo = [];
      const items = (arr || []).map(function (r, idx) {
        let base = {};
        if (Map.mapRowToPOItem && typeof Map.mapRowToPOItem === "function") {
          base = Map.mapRowToPOItem(r, idx) || {};
          delete base.poItem; // poItem deve vir da tabela (não do mapper)
        } else {
          base = { // fallback mínimo (sem poItem)
            plant: r.PLANT || r.plant || "",
            material: r.material || r.MaterialCode || r.Material || "",
            shortText: r.itemDescription || r.ItemDescription || r.description || r.ShortText || "",
            quantity: Number(r.quantity || r.Quantity || 0),
            unit: r.unitOfMeasure || r.unit || r.Unit || ""
          };
        }

        const po = extractPoItemFromRow(r);
        if (po == null) {
          missingPo.push({
            idx,
            itemId: r?.ItemId ?? r?.itemId ?? null,
            mat: r?.material ?? r?.MaterialCode ?? null,
            desc: r?.itemDescription ?? r?.ItemDescription ?? null
          });
        }
        return { ...base, poItem: po };
      });

      if (missingPo.length) {
        const lines = missingPo.map(function (m) {
          return `Item idx=${m.idx + 1} (itemId=${m.itemId || "(n/a)"} mat=${m.mat || "(n/a)"} desc="${m.desc || ""}")`;
        }).join("\n");
        throw new Error(
          `Existem itens sem poItem na seleção (não geramos mais automaticamente).\n` +
          `Preencha o poItem na tabela e tente novamente.\n\nFaltando em:\n${lines}`
        );
      }

      const seen = new Set(); // bloqueia duplicados de poItem dentro do mesmo fornecedor
      const dups = items.filter(function (it) {
        if (seen.has(it.poItem)) return true;
        seen.add(it.poItem);
        return false;
      });
      if (dups.length) {
        const lst = dups.map(function (d) { return d.poItem; }).join(", ");
        throw new Error(`poItem duplicado no mesmo fornecedor: ${lst}. Ajuste os valores na tabela.`);
      }

      const schedules = items.map(function (it, i) { // 1 schedule-line por item (0001)
        return {
          poItem: it.poItem,
          schedLine: 1,
          deliveryDate:
            (Map.getDeliveryDateFromRow && typeof Map.getDeliveryDateFromRow === "function")
              ? Map.getDeliveryDateFromRow(arr[i])
              : (arr[i]?.DELIVERY_DATE_RAW?.dateValue || arr[i]?.deliveryDate || new Date()),
          quantity: it.quantity
        };
      });

      requests.push({ header, items, schedules, testRun: true });
    });

    return requests;
  }

  return { buildRequestsFromSelection };
});
