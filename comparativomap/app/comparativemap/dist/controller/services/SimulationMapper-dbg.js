sap.ui.define(
  ["comparativemap/comparativemap/controller/helpers/KeyUtils"],
  function (Keys) {
    "use strict";

    function toEdmDate(d) {
      const y = d.getFullYear(),
        m = String(d.getMonth() + 1).padStart(2, "0"),
        day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    }
    function normalizeDate(val) {
      if (!val) return toEdmDate(new Date());
      const s =
        typeof val === "object" && val.dateValue
          ? val.dateValue
          : String(val).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      if (/^\d{8}$/.test(s))
        return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
      const d = new Date(s);
      if (!isNaN(d)) return toEdmDate(d);
      throw new Error("Data inválida: " + val);
    }
    function getDeliveryDateFromRow(r) {
      const raw =
        r?.DELIVERY_DATE_RAW?.dateValue ||
        r?.DELIVERY_DATE_RAW ||
        r?.deliveryDate;
      return normalizeDate(raw || new Date());
    }

    function getHeaderFromVM(vm) {
      let h = vm.getProperty("/headerRows");
      if (Array.isArray(h)) h = h[0] || {};
      if (!h || !Object.keys(h).length) h = vm.getProperty("/header") || {};
      return h;
    }

    function mapHeaderFromAriba(h, firstRow) {
      const currency = (h.moeda || firstRow?.currency || "BRL")
        .toString()
        .toUpperCase()
        .slice(0, 3);
      const vendorRaw =
        (h.fornecedor && String(h.fornecedor).trim()) ||
        firstRow?.SupplierCode ||
        firstRow?.suppliercode ||
        firstRow?.supplierId ||
        firstRow?.lifnr;
      const vendor = Keys.zpad(String(vendorRaw || "").replace(/\D/g, ""), 10);
      const rawTipo = (h.tipoPedido || "NB").toString().trim();
      const m = rawTipo.match(/([A-Z0-9]{2,4})\s*$/i);
      const docType = (m ? m[1] : rawTipo).toUpperCase().slice(0, 4);

      return {
        docType,
        compCode: (h.companyCode || "").toString().slice(0, 4),
        purchOrg: (h.purchasingOrganization || "").toString().slice(0, 4),
        purchGroup: (h.purchasingGroup || "").toString().slice(0, 3),
        vendor,
        currency,
        incoterms1: (h.incoterms1 || "").toString().toUpperCase().slice(0, 3),
        incoterms2: (h.incoterms2 || "").toString().slice(0, 28),
      };
    }

    function mapRowToPOItem(r, idx) {
      if (!r || typeof r !== "object") {
        throw new Error(
          `Linha selecionada inválida na posição ${idx + 1}. Refaça a seleção.`,
        );
      }

      const poItem = (idx + 1) * 10;
      const matRaw = (r?.MaterialCode || r?.materialCode || "")
        .toString()
        .trim();
      const m = matRaw.match(/^(\d{4,})\b/);
      const material = m ? Keys.zpad(m[1], 18) : "";
      const desc = (
        r.itemDEscription ||
        r.itemDescription ||
        r.description ||
        r.ItemDescription ||
        ""
      ).toString();
      const shortText = desc.slice(0, 40);
      const unit = Keys.mapUoM(
        (r.unitOfMeasure || "").toString().toUpperCase(),
      );
      const plant = Keys.mapPlant((r.PLANT || "").toString());
      const itemCat = Keys.mapItemCategory((r.ItemCategory || "").toString());
      const matlGroup = (r.grupo_de_materias || "").toString().slice(0, 9);
      const netPrice = r.price != null ? Number(r.price) : null;
      const preqNo = /^\d+$/.test(String(r.CodigoRequisicao || ""))
        ? String(r.CodigoRequisicao).slice(0, 10)
        : undefined;

      const it = {
        poItem,
        plant,
        material,
        shortText,
        quantity: Number(r?.quantity || 0),
        unit,
        netPrice,
        itemCat,
        matlGroup,
        preqNo,
      };

      if (!it.material && !it.shortText)
        console.warn(
          `[ITEM ${String(poItem).padStart(5, "0")}] Sem MATERIAL e SHORT_TEXT`,
        );
      if (!it.unit)
        console.warn(`[ITEM ${String(poItem).padStart(5, "0")}] Unidade vazia`);
      if (!it.plant)
        console.warn(`[ITEM ${String(poItem).padStart(5, "0")}] Centro vazio`);
      if (!it.quantity)
        console.warn(
          `[ITEM ${String(poItem).padStart(5, "0")}] Quantidade vazia/zero`,
        );

      return it;
    }

    function prepareQMFromSelection(rows, qm) {
      const idByKey = {};
      (rows || []).filter(Boolean).forEach((r) => {
        const matKey = Keys.normKey(Keys.getItemKey(r));
        const nameKey = Keys.normKey(r.supplierName || "");
        const lifnr = Keys.pad10(
          r.lifnr ||
            r.supplierId ||
            (/^\d+$/.test(r.supplierName) ? r.supplierName : ""),
        );
        const meta = {
          itemId: r.itemId ?? r.ItemId ?? null,
          invitationId: r.invitationId ?? r._invitationId ?? null,
          invitationEmail: r.invitationEmail ?? null,
          masterQty: Number(r._originalQty || r.quantity) || 0,
          supplierName: r.supplierName || "",
          lifnr: lifnr,
          materialCode: r.MaterialCode || r.materialCode || "",
        };
        idByKey[`${matKey}|NAME:${nameKey}`] = meta;
        if (lifnr) idByKey[`${matKey}|LIFNR:${lifnr}`] = meta;
      });
      qm.setProperty("/idByKey", idByKey);
    }

    function buildResRowsFromBapiResult(result, qm) {
      const idByKey = qm.getProperty("/idByKey") || {};
      const srcRows = qm.getProperty("/simSourceRows") || [];
      const lifnrHeader = (result?.header?.fornecedor || "")
        .toString()
        .padStart(10, "0");
      const currency = result?.header?.moeda || "BRL";
      const itens = Array.isArray(result?.itens)
        ? result.itens.filter(Boolean)
        : [];

      return itens.map((it, idx) => {
        const matKey = Keys.matKeyFromBapiMaterial(it?.material);
        let meta = idByKey[`${matKey}|LIFNR:${lifnrHeader}`];

        if (!meta) {
          const srcByIdx = srcRows[idx] || {};
          const nameKey = Keys.normKey(srcByIdx?.supplierName || "");
          meta = idByKey[`${matKey}|NAME:${nameKey}`];
        }

        if (!meta) {
          const po = String(it?.poItem || "");
          if (/^\d+$/.test(po)) {
            const n = Math.max(0, Math.floor(parseInt(po, 10) / 10) - 1);
            const src = srcRows[n] || {};
            const mk2 = Keys.normKey(Keys.getItemKey(src));
            const lif2 = Keys.pad10(
              src?.lifnr || src?.supplierId || lifnrHeader,
            );
            const nm2 = Keys.normKey(src?.supplierName || "");
            meta =
              idByKey[`${mk2}|LIFNR:${lif2}`] || idByKey[`${mk2}|NAME:${nm2}`];
          }
        }

        const src = srcRows[idx] || {};
        const invitationId =
          meta?.invitationId != null
            ? meta.invitationId
            : (src.invitationId ?? null);
        const invitationEmail =
          meta?.invitationEmail != null
            ? meta.invitationEmail
            : (src.invitationEmail ?? null);
        const quantity = Number(it?.quantidade || 0) || 0;
        const price = Number(it?.netPrice || 0) || 0;
        const total = Number((price * quantity).toFixed(2));
        const originalQty = Number(meta?.masterQty ?? 0) || 0;
        const matDisplay =
          meta?.materialCode || it?.material || Keys.getItemKey(src) || "";

        return {
          materialCode: matDisplay,
          MaterialCode: matDisplay,
          supplierName: meta?.supplierName || src?.supplierName || lifnrHeader,
          originalQty,
          quantity,
          qtyAward: 0,
          price,
          currency,
          icms: null,
          ipi: null,
          total,
          itemId: meta?.itemId ?? null,
          invitationId,
          invitationEmail,
          lifnr: lifnrHeader,
          poItem: it?.poItem,
        };
      });
    }

    return {
      toEdmDate,
      normalizeDate,
      getDeliveryDateFromRow,
      getHeaderFromVM,
      mapHeaderFromAriba,
      mapRowToPOItem,
      prepareQMFromSelection,
      buildResRowsFromBapiResult,
    };
  },
);
