sap.ui.define(["sap/m/MessageBox"], function (MessageBox) {
  "use strict";

  function validarEMontarPayload(
    vmRowsAll,
    selectedRows,
    ensureInvitationResourceId,
  ) {
    const allItems = new Map(); // itemId -> { label, original }
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

    const byItem = new Map();
    const faltaIds = [];
    const problemas = [];
    const supplierBids = [];

    selectedRows.forEach((r) => {
      const itemId = Number(r.itemId ?? r.ItemId);
      if (!Number.isFinite(itemId)) {
        faltaIds.push(
          `${r.supplierName || "Fornecedor"} / ${r.materialCode || r.MaterialCode || r.itemKey || r.itemDescription || "(sem chave)"}`,
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
      if (!byItem.has(itemId))
        byItem.set(itemId, { label, original: 0, rows: [] });
      const g = byItem.get(itemId);
      if (Number.isFinite(origCand) && origCand > g.original)
        g.original = Math.floor(origCand);
      g.rows.push(r);
    });

    // todos os itens representados
    const faltando = [];
    for (const [id, meta] of allItems.entries()) {
      if (!byItem.has(id)) faltando.push(`#${id} (${meta.label})`);
    }
    if (faltando.length) {
      MessageBox.error(
        "Para concluir a premiação, TODOS os itens do evento devem estar selecionados.\n\nItens não selecionados:\n" +
          faltando.join("\n"),
      );
      return null;
    }

    // soma por item fecha original
    for (const [itemId, gSel] of byItem.entries()) {
      const metaAll = allItems.get(itemId);
      const original = Math.floor(
        Number((metaAll?.original ?? 0) || gSel.original || 0),
      );
      if (original <= 0) {
        problemas.push(
          `Item #${itemId} (${metaAll?.label || gSel.label}): quantidade ORIGINAL inválida.`,
        );
        continue;
      }
      let sum = 0;
      gSel.rows.forEach((r) => {
        let q = Math.floor(Number(r.qtyAward) || 0);
        if (q < 0) q = 0;
        if (q > original) q = original;
        r.qtyAward = q;
        sum += q;
      });
      if (sum !== original) {
        problemas.push(
          `Item #${itemId} (${metaAll?.label || gSel.label}): restante ${original - sum} (a soma deve fechar ${original}).`,
        );
      }
    }
    if (problemas.length) {
      MessageBox.error(
        "As quantidades por item precisam fechar com a quantidade ORIGINAL:\n\n" +
          problemas.join("\n"),
      );
      return null;
    }

    // calcular splits e payload
    for (const [itemId, gSel] of byItem.entries()) {
      const metaAll = allItems.get(itemId);
      const original = Math.floor(
        Number((metaAll?.original ?? 0) || gSel.original || 0),
      );
      let sumPerc = 0;
      const percList = gSel.rows.map((r, ix) => {
        const p = Math.round(((r.qtyAward * 100) / original) * 1000) / 1000;
        sumPerc += p;
        return { ix, p };
      });
      const diff = Math.round((100 - sumPerc) * 1000) / 1000;
      if (Math.abs(diff) >= 0.001) {
        const lastIdx =
          percList.findLast?.((x) => x.p > 0)?.ix ?? percList.length - 1;
        if (lastIdx >= 0)
          percList[lastIdx].p = Math.max(
            0,
            Math.round((percList[lastIdx].p + diff) * 1000) / 1000,
          );
      }
      percList.forEach(({ ix, p }) => {
        const r = gSel.rows[ix];
        if (p <= 0) return;
        const fullInvitation = ensureInvitationResourceId(
          r.invitationId,
          r.invitationEmail,
        );
        if (!fullInvitation) {
          faltaIds.push(
            `${r.supplierName || "Fornecedor"} / #${itemId} (${metaAll?.label || gSel.label})`,
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

    if (!supplierBids.length || faltaIds.length) {
      MessageBox.error(
        "Itens sem identificação suficiente (itemId/invitationId). Revise a seleção.\n\n" +
          (faltaIds.length ? `Pendentes:\n${faltaIds.join("\n")}` : ""),
      );
      return null;
    }
    return supplierBids;
  }

  return { validarEMontarPayload };
});
