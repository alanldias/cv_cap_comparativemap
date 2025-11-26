sap.ui.define(["sap/m/MessageBox"], function (MessageBox) {
  "use strict";

  function validarEMontarPayload(
    vmRowsAll,
    selectedRows,
    ensureInvitationResourceId, // mantido se precisar no futuro
  ) {
    const allItems = new Map(); // itemId -> { label, original }

    // ==========================
    // 1) Mapear todos os itens
    // ==========================
    (vmRowsAll || []).forEach((r) => {
      const itemId = Number(r.itemId ?? r.ItemId);
      if (!Number.isFinite(itemId)) return;

      const label =
        r.itemKey ||
        r.itemDescription ||
        r.MaterialCode ||
        r.materialCode ||
        String(itemId);

      const origCand = Number(
        r.originalQty ?? r.original ?? r.quantityOriginal ?? r.quantity ?? 0,
      );

      const prev = allItems.get(itemId) || { label, original: 0 };
      const original = Number.isFinite(origCand)
        ? Math.max(prev.original, Math.floor(origCand))
        : prev.original;

      allItems.set(itemId, { label, original });
    });

    // ===================================
    // 2) Agrupar seleção por item
    // ===================================
    const byItem = new Map();
    const faltaIds = [];
    const problemas = [];
    const avisos = []; // 👈 acumula avisos (ex.: soma > original)
    const supplierBids = [];

    (selectedRows || []).forEach((r) => {
      const itemId = Number(r.itemId ?? r.ItemId);

      if (!Number.isFinite(itemId)) {
        faltaIds.push(
          `${r.supplierName || "Fornecedor"} / ${
            r.materialCode ||
            r.MaterialCode ||
            r.itemKey ||
            r.itemDescription ||
            "(sem chave)"
          }`,
        );
        return;
      }

      const label =
        r.itemKey ||
        r.itemDescription ||
        r.MaterialCode ||
        r.materialCode ||
        String(itemId);

      const origCand = Number(
        r.originalQty ?? r.original ?? r.quantityOriginal ?? r.quantity ?? 0,
      );

      if (!byItem.has(itemId)) {
        byItem.set(itemId, { label, original: 0, rows: [] });
      }

      const g = byItem.get(itemId);
      if (Number.isFinite(origCand) && origCand > g.original) {
        g.original = Math.floor(origCand);
      }
      g.rows.push(r);
    });

    // ===================================
    // 3) Validar somas e gerar avisos
    // ===================================
    for (const [itemId, gSel] of byItem.entries()) {
      const metaAll = allItems.get(itemId);

      const original = Math.floor(
        Number((metaAll?.original ?? 0) || gSel.original || 0),
      );

      let sum = 0;

      gSel.rows.forEach((r) => {
        let q = Math.floor(Number(r.qtyAward) || 0);
        if (q < 0) q = 0; // ✅ nunca menos que 0
        r.qtyAward = q;
        sum += q;
      });

      if (sum <= 0) {
        problemas.push(
          `Item #${itemId} (${metaAll?.label || gSel.label}): quantidade premiada total deve ser maior que 0.`,
        );
        continue;
      }

      // ✅ Apenas aviso se estiver acima do original (não bloqueia)
      if (Number.isFinite(original) && original > 0 && sum > original) {
        avisos.push(
          `Item #${itemId} (${metaAll?.label || gSel.label}): quantidade premiada (${sum}) está ACIMA da quantidade indicada (${original}).`,
        );
      }
    }

    if (problemas.length) {
      MessageBox.error(
        "Há problemas com as quantidades premiadas:\n\n" +
          problemas.join("\n"),
      );
      return null;
    }

    // ===================================
    // 4) Calcular splits e montar payload
    // ===================================
    for (const [itemId, gSel] of byItem.entries()) {
      const metaAll = allItems.get(itemId);

      // base = soma premiada do item
      const base = gSel.rows.reduce(
        (acc, r) => acc + (Number(r.qtyAward) || 0),
        0,
      );
      if (base <= 0) continue; // já validado, mas por segurança

      let sumPerc = 0;
      const percList = gSel.rows.map((r, ix) => {
        const p = Math.round(((r.qtyAward * 100) / base) * 1000) / 1000;
        sumPerc += p;
        return { ix, p };
      });

      // Ajuste de arredondamento para fechar 100%
      const diff = Math.round((100 - sumPerc) * 1000) / 1000;
      if (Math.abs(diff) >= 0.001) {
        const lastIdx =
          percList.findLast?.((x) => x.p > 0)?.ix ?? percList.length - 1;
        if (lastIdx >= 0) {
          percList[lastIdx].p = Math.max(
            0,
            Math.round((percList[lastIdx].p + diff) * 1000) / 1000,
          );
        }
      }

      // montar supplierBids
      percList.forEach(({ ix, p }) => {
        const r = gSel.rows[ix];
        if (p <= 0) return;

        const fullInvitation = r.invitationId;
        if (!fullInvitation) {
          faltaIds.push(
            `${r.supplierName || "Fornecedor"} / #${itemId} (${
              metaAll?.label || gSel.label
            })`,
          );
          return;
        }

        supplierBids.push({
          itemId,
          invitationId: String(fullInvitation),
          bidType: "Primary",
          winningSplitType: 1,
          winningSplitValue: Number(p.toFixed(3)),
        });
      });
    }

    // ===================================
    // 5) Verificar se deu para montar payload
    // ===================================
    if (!supplierBids.length || faltaIds.length) {
      MessageBox.error(
        "Itens sem identificação suficiente (itemId/invitationId). Revise a seleção.\n\n" +
          (faltaIds.length ? `Pendentes:\n${faltaIds.join("\n")}` : ""),
      );
      return null;
    }

    // ===================================
    // 6) Exibir avisos (sem bloquear operação)
    // ===================================
    if (avisos.length) {
      MessageBox.warning(
        "Foram encontrados os seguintes avisos:\n\n" +
          avisos.join("\n") +
          "\n\nA operação continuará normalmente.",
        {
          title: "Avisos de quantidade",
        },
      );
    }

    // Continua normalmente: controller não precisa mudar nada
    return supplierBids;
  }

  return { validarEMontarPayload };
});
