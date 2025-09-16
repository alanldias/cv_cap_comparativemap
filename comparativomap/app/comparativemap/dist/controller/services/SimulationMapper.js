sap.ui.define(
  ["comparativemap/comparativemap/controller/helpers/KeyUtils"],
  function (t) {
    "use strict";
    function e(t) {
      const e = t.getFullYear(),
        i = String(t.getMonth() + 1).padStart(2, "0"),
        n = String(t.getDate()).padStart(2, "0");
      return `${e}-${i}-${n}`;
    }
    function i(t) {
      if (!t) return e(new Date());
      const i =
        typeof t === "object" && t.dateValue ? t.dateValue : String(t).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(i)) return i;
      if (/^\d{8}$/.test(i))
        return `${i.slice(0, 4)}-${i.slice(4, 6)}-${i.slice(6, 8)}`;
      const n = new Date(i);
      if (!isNaN(n)) return e(n);
      throw new Error("Data inválida: " + t);
    }
    function n(t) {
      const e =
        t?.DELIVERY_DATE_RAW?.dateValue ||
        t?.DELIVERY_DATE_RAW ||
        t?.deliveryDate;
      return i(e || new Date());
    }
    function r(t) {
      let e = t.getProperty("/headerRows");
      if (Array.isArray(e)) e = e[0] || {};
      if (!e || !Object.keys(e).length) e = t.getProperty("/header") || {};
      return e;
    }
    function o(e, i) {
      const n = (e.moeda || i?.currency || "BRL")
        .toString()
        .toUpperCase()
        .slice(0, 3);
      const r =
        (e.fornecedor && String(e.fornecedor).trim()) ||
        i?.SupplierCode ||
        i?.suppliercode ||
        i?.supplierId ||
        i?.lifnr;
      const o = t.zpad(String(r || "").replace(/\D/g, ""), 10);
      const a = (e.tipoPedido || "NB").toString().trim();
      const s = a.match(/([A-Z0-9]{2,4})\s*$/i);
      const c = (s ? s[1] : a).toUpperCase().slice(0, 4);
      return {
        docType: c,
        compCode: (e.companyCode || "").toString().slice(0, 4),
        purchOrg: (e.purchasingOrganization || "").toString().slice(0, 4),
        purchGroup: (e.purchasingGroup || "").toString().slice(0, 3),
        vendor: o,
        currency: n,
        incoterms1: (e.incoterms1 || "").toString().toUpperCase().slice(0, 3),
        incoterms2: (e.incoterms2 || "").toString().slice(0, 28),
      };
    }
    function a(e, i) {
      if (!e || typeof e !== "object") {
        throw new Error(
          `Linha selecionada inválida na posição ${i + 1}. Refaça a seleção.`,
        );
      }
      const n = (i + 1) * 10;
      const r = (e?.MaterialCode || e?.materialCode || "").toString().trim();
      const o = r.match(/^(\d{4,})\b/);
      const a = o ? t.zpad(o[1], 18) : "";
      const s = (
        e.itemDEscription ||
        e.itemDescription ||
        e.description ||
        e.ItemDescription ||
        ""
      ).toString();
      const c = s.slice(0, 40);
      const l = t.mapUoM((e.unitOfMeasure || "").toString().toUpperCase());
      const p = t.mapPlant((e.PLANT || "").toString());
      const m = t.mapItemCategory((e.ItemCategory || "").toString());
      const u = (e.grupo_de_materias || "").toString().slice(0, 9);
      const d = e.price != null ? Number(e.price) : null;
      const g = /^\d+$/.test(String(e.CodigoRequisicao || ""))
        ? String(e.CodigoRequisicao).slice(0, 10)
        : undefined;
      const y = {
        poItem: n,
        plant: p,
        material: a,
        shortText: c,
        quantity: Number(e?.quantity || 0),
        unit: l,
        netPrice: d,
        itemCat: m,
        matlGroup: u,
        preqNo: g,
      };
      if (!y.material && !y.shortText)
        console.warn(
          `[ITEM ${String(n).padStart(5, "0")}] Sem MATERIAL e SHORT_TEXT`,
        );
      if (!y.unit)
        console.warn(`[ITEM ${String(n).padStart(5, "0")}] Unidade vazia`);
      if (!y.plant)
        console.warn(`[ITEM ${String(n).padStart(5, "0")}] Centro vazio`);
      if (!y.quantity)
        console.warn(
          `[ITEM ${String(n).padStart(5, "0")}] Quantidade vazia/zero`,
        );
      return y;
    }
    function s(e, i) {
      const n = {};
      (e || []).filter(Boolean).forEach((e) => {
        const i = t.normKey(t.getItemKey(e));
        const r = t.normKey(e.supplierName || "");
        const o = t.pad10(
          e.lifnr ||
            e.supplierId ||
            (/^\d+$/.test(e.supplierName) ? e.supplierName : ""),
        );
        const a = {
          itemId: e.itemId ?? e.ItemId ?? null,
          invitationId: e.invitationId ?? e._invitationId ?? null,
          invitationEmail: e.invitationEmail ?? null,
          masterQty: Number(e._originalQty || e.quantity) || 0,
          supplierName: e.supplierName || "",
          lifnr: o,
          materialCode: e.MaterialCode || e.materialCode || "",
        };
        n[`${i}|NAME:${r}`] = a;
        if (o) n[`${i}|LIFNR:${o}`] = a;
      });
      i.setProperty("/idByKey", n);
    }
    function c(e, i) {
      const n = i.getProperty("/idByKey") || {};
      const r = i.getProperty("/simSourceRows") || [];
      const o = (e?.header?.fornecedor || "").toString().padStart(10, "0");
      const a = e?.header?.moeda || "BRL";
      const s = Array.isArray(e?.itens) ? e.itens.filter(Boolean) : [];
      return s.map((e, i) => {
        const s = t.matKeyFromBapiMaterial(e?.material);
        let c = n[`${s}|LIFNR:${o}`];
        if (!c) {
          const e = r[i] || {};
          const o = t.normKey(e?.supplierName || "");
          c = n[`${s}|NAME:${o}`];
        }
        if (!c) {
          const i = String(e?.poItem || "");
          if (/^\d+$/.test(i)) {
            const e = Math.max(0, Math.floor(parseInt(i, 10) / 10) - 1);
            const a = r[e] || {};
            const s = t.normKey(t.getItemKey(a));
            const l = t.pad10(a?.lifnr || a?.supplierId || o);
            const p = t.normKey(a?.supplierName || "");
            c = n[`${s}|LIFNR:${l}`] || n[`${s}|NAME:${p}`];
          }
        }
        const l = r[i] || {};
        const p =
          c?.invitationId != null ? c.invitationId : (l.invitationId ?? null);
        const m =
          c?.invitationEmail != null
            ? c.invitationEmail
            : (l.invitationEmail ?? null);
        const u = Number(e?.quantidade || 0) || 0;
        const d = Number(e?.netPrice || 0) || 0;
        const g = Number((d * u).toFixed(2));
        const y = Number(c?.masterQty ?? 0) || 0;
        const f = c?.materialCode || e?.material || t.getItemKey(l) || "";
        return {
          materialCode: f,
          MaterialCode: f,
          supplierName: c?.supplierName || l?.supplierName || o,
          originalQty: y,
          quantity: u,
          qtyAward: 0,
          price: d,
          currency: a,
          icms: null,
          ipi: null,
          total: g,
          itemId: c?.itemId ?? null,
          invitationId: p,
          invitationEmail: m,
          lifnr: o,
          poItem: e?.poItem,
        };
      });
    }
    return {
      toEdmDate: e,
      normalizeDate: i,
      getDeliveryDateFromRow: n,
      getHeaderFromVM: r,
      mapHeaderFromAriba: o,
      mapRowToPOItem: a,
      prepareQMFromSelection: s,
      buildResRowsFromBapiResult: c,
    };
  },
);
//# sourceMappingURL=SimulationMapper.js.map
