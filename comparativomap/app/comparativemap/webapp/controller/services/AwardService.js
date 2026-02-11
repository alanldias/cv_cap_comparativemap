sap.ui.define(["sap/m/MessageBox", "sap/m/MessageToast"], function (
  MessageBox,
  MessageToast
) {
  "use strict";

  function _numItemId(r) { // itemId numérico (aceita itemId/ItemId)
    const n = Number(r?.itemId ?? r?.ItemId);
    return Number.isFinite(n) ? n : NaN;
  }

  function _labelOf(r, fallback) { // label amigável do item
    return (
      r?.itemKey ||
      r?.itemDescription ||
      r?.MaterialCode ||
      r?.materialCode ||
      fallback
    );
  }

  function _origQtyOf(r) { // quantidade “original” (fallback para quantity)
    const n = Number(r?.originalQty ?? r?.original ?? r?.quantityOriginal ?? r?.quantity ?? 0);
    return Number.isFinite(n) ? Math.floor(n) : 0;
  }

  function _awardQtyOf(r) { // qtyAward saneada (>=0, inteiro)
    let q = Math.floor(Number(r?.qtyAward) || 0);
    if (q < 0) q = 0;
    return q;
  }

  function _round3(n) { // 3 casas
    return Math.round(n * 1000) / 1000;
  }

  function _fixTo100(percList) { // corrige rounding para fechar 100%
    let sum = 0;
    for (let i = 0; i < percList.length; i++) sum += percList[i].p;

    const diff = _round3(100 - sum);
    if (Math.abs(diff) < 0.001) return;

    let lastIdx = -1;
    for (let i = percList.length - 1; i >= 0; i--) {
      if (percList[i].p > 0) { lastIdx = percList[i].ix; break; }
    }
    if (lastIdx < 0) lastIdx = percList.length - 1;
    if (lastIdx >= 0) {
      const next = _round3((percList[lastIdx].p || 0) + diff);
      percList[lastIdx].p = Math.max(0, next);
    }
  }

  function validarEMontarPayload(vmRowsAll, selectedRows, ensureInvitationResourceId) {
    const allItems = new Map(); // itemId -> { label, original }

    (vmRowsAll || []).forEach(function (r) {
      const itemId = _numItemId(r);
      if (!Number.isFinite(itemId)) return;

      const label = _labelOf(r, String(itemId));
      const origCand = _origQtyOf(r);

      const prev = allItems.get(itemId) || { label: label, original: 0 };
      const original = Math.max(prev.original, origCand);

      allItems.set(itemId, { label: label, original: original });
    });

    const byItem = new Map(); // itemId -> { label, original, rows[] }
    const faltaIds = [];
    const problemas = [];
    const avisosAcima = [];
    const avisosAbaixo = [];
    const supplierBids = [];

    (selectedRows || []).forEach(function (r) {
      const itemId = _numItemId(r);

      if (!Number.isFinite(itemId)) {
        faltaIds.push(
          `${r.supplierName || "Fornecedor"} / ${
            r.materialCode || r.MaterialCode || r.itemKey || r.itemDescription || "(sem chave)"
          }`
        );
        return;
      }

      const label = _labelOf(r, String(itemId));
      const origCand = _origQtyOf(r);

      if (!byItem.has(itemId)) byItem.set(itemId, { label: label, original: 0, rows: [] });

      const g = byItem.get(itemId);
      if (origCand > g.original) g.original = origCand;
      g.rows.push(r);
    });

    for (const [itemId, gSel] of byItem.entries()) {
      const metaAll = allItems.get(itemId);

      const original = Math.floor(Number((metaAll?.original ?? 0) || gSel.original || 0));
      let sum = 0;

      gSel.rows.forEach(function (r) {
        const q = _awardQtyOf(r);
        r.qtyAward = q; // normaliza na própria linha (UI depende disso)
        sum += q;
      });

      if (sum <= 0) {
        problemas.push(
          `Item #${itemId} (${metaAll?.label || gSel.label}): quantidade premiada total deve ser maior que 0.`
        );
        continue;
      }

      if (Number.isFinite(original) && original > 0) {
        if (sum > original) {
          avisosAcima.push(
            `Item #${itemId} (${metaAll?.label || gSel.label}): quantidade premiada (${sum}) está ACIMA da quantidade indicada (${original}).`
          );
        } else if (sum < original) {
          avisosAbaixo.push(
            `Item #${itemId} (${metaAll?.label || gSel.label}): quantidade premiada (${sum}) está ABAIXO da quantidade indicada (${original}).`
          );
        }
      }
    }

    if (problemas.length) {
      MessageBox.error("Há problemas com as quantidades premiadas:\n\n" + problemas.join("\n"));
      return null;
    }

    for (const [itemId, gSel] of byItem.entries()) {
      const metaAll = allItems.get(itemId);

      const base = gSel.rows.reduce(function (acc, r) {
        return acc + (Number(r.qtyAward) || 0);
      }, 0);
      if (base <= 0) continue;

      let sumPerc = 0;
      const percList = gSel.rows.map(function (r, ix) {
        const p = _round3((Number(r.qtyAward) * 100) / base);
        sumPerc += p;
        return { ix: ix, p: p };
      });

      _fixTo100(percList);

      percList.forEach(function (it) {
        const r = gSel.rows[it.ix];
        if (it.p <= 0) return;

        const fullInvitation = r.invitationId;
        if (!fullInvitation) {
          faltaIds.push(
            `${r.supplierName || "Fornecedor"} / #${itemId} (${metaAll?.label || gSel.label})`
          );
          return;
        }

        supplierBids.push({
          itemId: itemId,
          invitationId: String(fullInvitation),
          bidType: "Primary",
          winningSplitType: 1,
          winningSplitValue: Number(it.p.toFixed(3))
        });
      });
    }

    if (!supplierBids.length || faltaIds.length) {
      MessageBox.error(
        "Itens sem identificação suficiente (itemId/invitationId). Revise a seleção.\n\n" +
          (faltaIds.length ? `Pendentes:\n${faltaIds.join("\n")}` : "")
      );
      return null;
    }

    if (avisosAcima.length || avisosAbaixo.length) {
      let msg;
      if (avisosAcima.length && avisosAbaixo.length) {
        msg = "Há itens com quantidade premiada acima e abaixo da quantidade indicada.";
      } else if (avisosAcima.length) {
        msg = "Há itens com quantidade premiada acima da quantidade indicada.";
      } else {
        msg = "Há itens com quantidade premiada abaixo da quantidade indicada.";
      }
      MessageToast.show(msg, { duration: 5000 });
    }

    return supplierBids;
  }

  return { validarEMontarPayload: validarEMontarPayload };
});
