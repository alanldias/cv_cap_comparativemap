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
      // Prioriza o campo técnico que já vem do back como "YYYY-MM-DD"
      const raw = r?.DeliveryDateEdm || r?.DeliveryDate || null;
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

    function resolveItemCatFromRow(r) {
      const raw = (r.ItemCategory || r.itemCategory || r.category || "").toString();

      // Normaliza Unicode e remove caracteres invisíveis (zero-width, BOM etc.)
      const cleaned = raw
        .normalize("NFKC")
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
        .replace(/[\u200B-\u200D\uFEFF\u2060]/g, "")
        .replace(/[\u00A0\u202F\u2007]/g, " ")
        .replace(/[\s_-]+/g, " ")
        .trim()
        .toUpperCase();

      if (
        cleaned.startsWith("D") ||
        cleaned.includes("SERVICE") ||
        cleaned.includes("SERVIÇO") ||
        cleaned.includes("SERVICO") ||
        cleaned === "SVC"
      ) {
        return "D";
      }

      if (typeof Keys.mapItemCategory === "function") {
        const mapped = Keys.mapItemCategory(raw);
        if (mapped && mapped !== "0") {
          return mapped;
        }
      }

      const hasMat = !!String(r.MaterialCode || r.material || "").replace(/\D/g, "").replace(/^0+/, "");
      const hasText = !!String(r.itemDescription || r.ItemDescription || r.description || r.ItemDescription || "").trim();

      if (!hasMat && hasText) {
        return "D";
      }
      return "0";
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
      const itemCat = resolveItemCatFromRow(r);
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

    function buildResRowsFromBapiResult(result, qm, srcRowsOverride) {
      const idByKey = qm.getProperty("/idByKey") || {};
      const norm10 = (v) => (v == null ? "" : String(v).replace(/\D/g, "").padStart(10, "0"));
      const normPo = (v) => {
        const s = String(v ?? "").trim();
        if (!s) return null;
        const n = Number(s.replace(/\D/g, ""));
        return Number.isFinite(n) ? n : null;
      };

      // LIFNR vindo do resultado (header)
      const lifnrHeader = norm10(result?.header?.fornecedor || result?.header?.vendor || "");

      // Escolhe as linhas fonte (do mesmo fornecedor)
      const globalSrc = qm.getProperty("/simSourceRows") || [];
      const srcRows = (Array.isArray(srcRowsOverride) && srcRowsOverride.length)
        ? srcRowsOverride
        : globalSrc.filter(r => norm10(r?.lifnr || r?.supplierId || r?.SupplierCode) === lifnrHeader);

      // Índice determinístico: poItem (numérico) -> linha fonte
      const srcByPo = new Map();
      for (const r of srcRows) {
        const n = normPo(r?.poItem ?? r?.PO_ITEM ?? r?.poitem);
        if (n == null) continue;
        if (srcByPo.has(n)) {
          console.warn("[MAP] poItem duplicado em srcRows p/ vendor", lifnrHeader, "poItem=", n);
        } else {
          srcByPo.set(n, r);
        }
      }

      const currency = (result?.header?.moeda || "BRL").toString();
      const itens = Array.isArray(result?.itens) ? result.itens.filter(Boolean) : [];

      return itens.map((it) => {
        const poPadded = String(it?.poItem || "").padStart(5, "0");
        const poNum = normPo(it?.poItem);

        let src = (poNum != null) ? srcByPo.get(poNum) : undefined;

        let meta = null;
        const matKey = Keys.matKeyFromBapiMaterial(it?.material);
        if (!src) {
          meta = idByKey[`${matKey}|LIFNR:${lifnrHeader}`];
          if (!meta) {
            const src0 = srcRows[0] || {};
            const nameKey = Keys.normKey(src0?.supplierName || "");
            meta = idByKey[`${matKey}|NAME:${nameKey}`];
          }
        } else {
          meta = {
            itemId: src.itemId ?? src.ItemId ?? null,
            invitationId: src.invitationId ?? src._invitationId ?? null,
            invitationEmail: src.invitationEmail ?? null,
            masterQty: Number(src._originalQty || src.quantity) || 0,
            supplierName: src.supplierName || "",
            lifnr: norm10(src.lifnr || src.supplierId || lifnrHeader),
            materialCode: src.MaterialCode || src.materialCode || "",
          };
        }

        const invitationId =
          (src && (src.invitationId ?? src._invitationId)) != null
            ? (src.invitationId ?? src._invitationId)
            : (meta?.invitationId ?? null);

        const invitationEmail =
          (src && src.invitationEmail != null)
            ? src.invitationEmail
            : (meta?.invitationEmail ?? null);

        const originalQty =
          (src && Number(src._originalQty || src.quantity))
            ? Number(src._originalQty || src.quantity)
            : (Number(meta?.masterQty ?? 0) || 0);

        const matDisplay =
          (src && (src.MaterialCode || src.materialCode))
            ? (src.MaterialCode || src.materialCode)
            : (meta?.materialCode || it?.material || Keys.getItemKey(src || {}) || "");

        const supplierName =
          (src && src.supplierName) ? src.supplierName :
            (meta?.supplierName || lifnrHeader);

        const itemId =
          (src && (src.itemId ?? src.ItemId) != null)
            ? (src.itemId ?? src.ItemId)
            : (meta?.itemId ?? null);

        const quantity = Number(it?.quantidade || 0) || 0;
        const netPrice = Number(it?.netPrice || 0) || 0;
        const totalLiquido = Number((price * quantity).toFixed(2));
        const grossPrice = (src && src.price != null) ? Number(src.price) : 0;
        const totalBruto = Number((grossPrice * quantity).toFixed(2));

        const descricao = it?.descricao ?? "";
        const ncm = it?.ncm ?? null;
        const taxCode = it?.taxCode ?? null;
        const taxJurCode = it?.taxJurCode ?? null;
        const unidade = it?.unidade ?? it?.poUnit ?? null;
        const priceUnit = Number(it?.priceUnit ?? 1) || 1;
        const priceDate = it?.priceDate ?? null;
        const schedules = Array.isArray(it?.schedules) ? it.schedules : [];

        if (!src) {
          console.warn("[MAP] Sem match por poItem no retorno", { vendor: lifnrHeader, poItem: poPadded, matKey });
        }

        return {
          materialCode: matDisplay,
          MaterialCode: matDisplay,
          supplierName,
          originalQty,
          quantity,
          qtyAward: quantity,
          netPrice,
          grossPrice,
          currency,

          icms: it.icmsValue || 0,
          ipi: it.ipiValue || 0,

          totalLiquido,
          totalBruto,
          itemId,
          invitationId,
          invitationEmail,
          lifnr: lifnrHeader,

          poItem: poPadded,

          descricao,
          ncm,
          taxCode,
          taxJurCode,
          unidade,
          unit: unidade,
          priceUnit,
          priceDate,
          schedules,
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
