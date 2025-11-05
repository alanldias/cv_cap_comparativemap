sap.ui.define(["sap/m/MessageBox"], function (MessageBox) {
  "use strict";

  function validarEMontarPayload(
    vmRowsAll,
    selectedRows,
    ensureInvitationResourceId,
  ) {
    return new Promise((resolve) => {
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
      const avisos = []; // 👈 acumula avisos de excesso
      const supplierBids = [];

      (selectedRows || []).forEach((r) => {
        const itemId = Number(r.itemId ?? r.ItemId);
        if (!Number.isFinite(itemId)) {
          faltaIds.push(
            `${r.supplierName || "Fornecedor"} / ${
              r.materialCode || r.MaterialCode || r.itemKey || r.itemDescription || "(sem chave)"
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
        return resolve(null);
      }

      // validar somas e coletar avisos (sem bloquear excesso ainda)
      for (const [itemId, gSel] of byItem.entries()) {
        const metaAll = allItems.get(itemId);
        const original = Math.floor(
          Number((metaAll?.original ?? 0) || gSel.original || 0),
        );

        let sum = 0;
        gSel.rows.forEach((r) => {
          let q = Math.floor(Number(r.qtyAward) || 0);
          if (q < 0) q = 0;
          // não limitar ao original
          r.qtyAward = q;
          sum += q;
        });

        if (sum <= 0) {
          problemas.push(
            `Item #${itemId} (${metaAll?.label || gSel.label}): quantidade premiada total deve ser maior que 0.`,
          );
          continue;
        }

        // Aviso se estiver acima do original
        if (Number.isFinite(original) && original > 0 && sum > original) {
          avisos.push(
            `Item #${itemId} (${metaAll?.label || gSel.label}): quantidade premiada (${sum}) está ACIMA da quantidade indicada (${original}).`,
          );
        }
      }

      if (problemas.length) {
        MessageBox.error(
          "Há problemas com as quantidades premiadas:\n\n" + problemas.join("\n"),
        );
        return resolve(null);
      }

      // calcular splits e payload
      for (const [itemId, gSel] of byItem.entries()) {
        const metaAll = allItems.get(itemId);

        const base = gSel.rows.reduce((acc, r) => acc + (Number(r.qtyAward) || 0), 0);
        if (base <= 0) continue; // segurança

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
          if (lastIdx >= 0)
            percList[lastIdx].p = Math.max(
              0,
              Math.round((percList[lastIdx].p + diff) * 1000) / 1000,
            );
        }

        // montar supplierBids
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
        return resolve(null);
      }

      // 🔔 Se houver avisos, pedir confirmação antes de continuar
      if (avisos.length) {
        MessageBox.warning(
          "Aviso: há itens com quantidade premiada acima da quantidade indicada.\n\n" +
            avisos.join("\n") +
            "\n\nDeseja continuar mesmo assim?",
          {
            actions: ["Continuar", "Cancelar"],
            emphasizedAction: "Continuar",
            onClose: function (action) {
              if (action === "Continuar") {
                resolve(supplierBids);
              } else {
                resolve(null);
              }
            },
          }
        );
        return; // importante: não continuar fluxo síncrono
      }

      // Sem avisos: seguir direto
      return resolve(supplierBids);
    });
  }

  return { validarEMontarPayload };
});
