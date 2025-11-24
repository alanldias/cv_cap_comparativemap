sap.ui.define(
  [
    "sap/ui/core/mvc/Controller",
    "comparativemap/comparativemap/model/models",
    "comparativemap/comparativemap/controller/services/ODataService",
    "comparativemap/comparativemap/controller/services/SimulationMapper",
    "comparativemap/comparativemap/controller/services/Dialogs",
    "comparativemap/comparativemap/controller/services/AwardService",
    "comparativemap/comparativemap/controller/helpers/Debug",
    "comparativemap/comparativemap/controller/helpers/Formatters",
    "comparativemap/comparativemap/controller/helpers/ErrorHandler",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/Device",
    "comparativemap/comparativemap/controller/helpers/buildRequestsBySupplier",
    "sap/ui/export/Spreadsheet",
    "sap/ui/export/library",
    "comparativemap/comparativemap/controller/prefs/DraftStore"
  ],
  function (
    Controller,
    Models,
    ODataSvc,
    Mapper,
    Dialogs,
    AwardSvc,
    Debug,
    Fmt,
    ErrorHandler,
    MessageToast,
    MessageBox,
    Device,
    Build,
    Spreadsheet,
    exportLibrary,
    Drafts
  ) {
    "use strict";
    const EdmType = exportLibrary.EdmType;

    return Controller.extend(
      "comparativemap.comparativemap.controller.ComparativeMap",
      {
        formatter: Fmt,

        // ===========================================================
        // 1. INICIALIZAÇÃO
        // ===========================================================
        onInit() {
          // ===== Modelos base =====
          this.getView().setModel(Models.createVM(), "vm");
          this.getView().setModel(Models.createQM(), "qm");

          // Modelo de resultados
          let res = this.getView().getModel("res");
          if (!res) {
            res = new sap.ui.model.json.JSONModel({ header: {}, rows: [], totals: {} });
            this.getView().setModel(res, "res");
          }

          // Layout Compacto
          this.getView().addStyleClass("sapUiSizeCompact");

          // 🟢 Drafts: Registra o estado padrão (XML) antes de qualquer alteração
          Drafts.registerDefaultState(this);

          // Drafts: Pergunta se quer restaurar ao entrar
          Drafts.offerRestoreOnEnter(this);

          // Autosave ao sair/recarregar a página
          this._onUnloadSave = () => { try { Drafts.save(this); } catch (e) { } };
          window.addEventListener("beforeunload", this._onUnloadSave);
        },

        onExit() {
          if (this._dlgRes) {
            this._dlgRes.destroy(true);
            this._dlgRes = null;
          }
          if (this._onUnloadSave) {
            window.removeEventListener("beforeunload", this._onUnloadSave);
            this._onUnloadSave = null;
          }
        },

        // ===========================================================
        // 2. BUSCA PRINCIPAL
        // ===========================================================
        async onBuscar() {
          const view = this.getView();
          const odata = view.getModel();
          const vm = view.getModel("vm");
          const qm = view.getModel("qm");
          const mdcTbl = view.byId("tblDocs");

          const newDocId = (view.byId("inputDoID").getValue() || "").trim();
          const oldDocId = vm.getProperty("/header/docId");

          try {
            if (!odata) throw new Error("Modelo OData V4 não encontrado.");
            if (!newDocId) {
              MessageToast.show("Informe o Doc ID");
              return;
            }

            // 🔵 BUSY GLOBAL + TABELA
            sap.ui.core.BusyIndicator.show(0);   // <<< NOVO
            mdcTbl?.setBusy(true);               // (já existia, eu deixaria aqui em cima)

            // 1. Salva draft anterior se trocar de ID
            if (oldDocId && oldDocId !== newDocId) {
              console.log(`💾 Salvando draft anterior (${oldDocId}) antes de trocar...`);
              Drafts.save(this, true);
            }

            // Limpa UI antiga
            view.byId("vsdFilterBar")?.setVisible(false);
            view.byId("vsdFilterLabel")?.setText("");

            // 2. Reset layout se não houver draft salvo
            const hasSavedDraft = Drafts.hasDraft(newDocId);
            if (!hasSavedDraft) {
              console.log("🧹 Novo DocID detectado. Resetando layout...");
              Drafts.resetToDefault(this);
            }

            // Prepara containers
            qm?.setProperty("/idByKey", {});
            qm?.setProperty("/simSourceRows", []);

            // 3. Busca dados
            const res = await ODataSvc.fetchQuotes(view, newDocId);

            const rows = (Array.isArray(res?.items) ? res.items : []).map(r => ({
              ...r,
              itemId: r.itemId ?? r.ItemId ?? null,
              itemDescription: r.itemDescription,
              price: (r.price !== undefined && r.price !== null) ? Number(r.price) : r.price,
              _originalQty: Number(r.quantity) || 0
            }));

            const header = res?.header || {};
            const headerRows = res?.header ? [res.header] : [];

            // 4. Aplica dados + draft
            if (hasSavedDraft) {
              console.log(`♻️ Draft encontrado para ${newDocId}. Restaurando...`);
              Drafts.restoreWithNewData(this, newDocId, header, headerRows, rows);
            } else {
              vm.setProperty("/header", header);
              vm.setProperty("/headerRows", headerRows);
              vm.setProperty("/rows", rows);

              if (mdcTbl && mdcTbl.isA("sap.ui.mdc.Table")) {
                  mdcTbl.rebind();
              }

              setTimeout(() => {
                console.log(`💾 Salvando estado inicial para ${newDocId}...`);
                Drafts.save(this, true);
              }, 500);
            }

            if (!rows.length) {
              MessageToast.show("Nenhum item retornado para esse Doc ID.");
            }

          } catch (e) {
            ErrorHandler.handle(e, "Erro ao buscar DocID");
          } finally {
            // 🔵 SEMPRE TIRA O BUSY
            mdcTbl?.setBusy(false);
            sap.ui.core.BusyIndicator.hide();
          }
        },

        onQtyInlineChange(ev) {
          const ctx = ev.getSource()?.getBindingContext("vm");
          if (!ctx) return;
          const row = ctx.getObject() || {};
          const max = Number(row._originalQty) || 0;
          let v = Number(row.quantity);
          if (isNaN(v) || v < 0) v = 0;
          if (max && v > max) v = max;
          row.quantity = Math.floor(v);
          ctx.getModel().checkUpdate(true);
          Drafts.autoSave(this);
        },

        onCloseDialog(ev) {
          Dialogs.closeAny(this, ev);
        },

        // ===========================================================
        // 3. SIMULAÇÃO
        // ===========================================================
        async onSimularPress() {
          const view = this.getView();
          const vm = view.getModel("vm");
          const qm = view.getModel("qm");

          const resModel = this.getView().getModel("res");
          if (resModel?.setSizeLimit) resModel.setSizeLimit(5000);
          resModel.setProperty("/header", {});
          resModel.setProperty("/rows", []);
          resModel.setProperty("/totals", {});

          try {
            const mdcTbl = this.byId("tblDocs");
            if (!mdcTbl) throw new Error("Tabela 'tblDocs' não encontrada.");

            // --- Coleta Seleção (Híbrido MDC / sap.m) ---
            let rows = [];
            if (mdcTbl.isA && mdcTbl.isA("sap.ui.mdc.Table")) {
              const inner = mdcTbl.getInnerTable && mdcTbl.getInnerTable();
              if (!inner) throw new Error("Tabela interna do MDC não encontrada.");

              if (inner.isA && inner.isA("sap.m.Table")) {
                rows = inner.getSelectedItems().map(it => it.getBindingContext("vm")?.getObject?.()).filter(Boolean);
              } else if (inner.isA && inner.isA("sap.ui.table.Table")) {
                const idxs = inner.getSelectedIndices() || [];
                rows = idxs.map(i => inner.getContextByIndex(i)).filter(Boolean).map(ctx => ctx.getObject());
              }
            } else if (mdcTbl.isA && mdcTbl.isA("sap.m.Table")) {
              rows = mdcTbl.getSelectedItems().map(it => it.getBindingContext("vm")?.getObject?.()).filter(Boolean);
            }

            if (!rows.length) throw new Error("Selecione pelo menos 1 item para simular.");

            // Validação de integridade
            rows = rows.filter(r => r && (r.MaterialCode || r.materialCode || r.ItemId || r.itemId));

            if (!rows.length) {
              // Limpa seleção se inválida
              if (mdcTbl.isA && mdcTbl.isA("sap.ui.mdc.Table")) {
                const inner = mdcTbl.getInnerTable && mdcTbl.getInnerTable();
                if (inner && typeof inner.clearSelection === "function") inner.clearSelection();
              }
              throw new Error("Seleção inválida: itens sem ID. Faça uma nova seleção.");
            }

            Debug.dbg(`Linhas selecionadas (count=${rows.length})`, rows);

            // --- Preparação BAPI ---
            qm.setProperty("/simSourceRows", rows);
            Mapper.prepareQMFromSelection(rows, qm);
            const requests = Build.buildRequestsFromSelection(rows, vm);

            // Validação Header/Items
            const headerMissing = [];
            const itemMissing = [];
            requests.forEach((req, ridx) => {
              const h = req.header || {};
              const tag = `Req#${ridx + 1} (vendor ${h.vendor || "?"})`;
              if (!h.docType) headerMissing.push(`${tag}: Tipo de Pedido (docType)`);
              if (!h.compCode) headerMissing.push(`${tag}: Empresa (compCode)`);
              if (!h.purchOrg) headerMissing.push(`${tag}: Org. de Compras (purchOrg)`);
              if (!h.purchGroup) headerMissing.push(`${tag}: Grupo de Compras (purchGroup)`);
              if (!h.vendor) headerMissing.push(`${tag}: Fornecedor (vendor/LIFNR)`);
              if (!h.currency) headerMissing.push(`${tag}: Moeda (currency)`);
              (req.items || []).forEach((it, i) => {
                const itTag = `${tag} Item ${String((i + 1) * 10).padStart(5, "0")}`;
                if (!it.plant) itemMissing.push(`${itTag}: Centro (plant)`);
                if (!it.unit) itemMissing.push(`${itTag}: Unidade (unit)`);
                if (!it.quantity || it.quantity <= 0) itemMissing.push(`${itTag}: Quantidade (quantity)`);
                if (!it.material && !it.shortText) itemMissing.push(`${itTag}: MATERIAL ou SHORT_TEXT`);
              });
            });

            if (headerMissing.length || itemMissing.length) {
              const msg = [
                headerMissing.length ? "Cabeçalho faltando:\n- " + headerMissing.join("\n- ") : "",
                itemMissing.length ? "Itens faltando:\n- " + itemMissing.join("\n- ") : ""
              ].filter(Boolean).join("\n\n");
              throw new Error(msg);
            }

            const normVendor = v => (v == null ? "" : String(v).replace(/\D/g, "").padStart(10, "0"));
            const vendorToSrc = new Map((requests || []).map(req => [normVendor(req?.header?.vendor), Array.isArray(req.sourceRows) ? req.sourceRows : []]));
            const payloadRequests = (requests || []).map(({ header, items, schedules, testRun }) => ({ header, items, schedules, testRun }));

            sap.ui.core.BusyIndicator.show(0);

            // Chamada BAPI
            const results = await ODataSvc.simularPO(view, payloadRequests, 4);

            const structuralErrors = (Array.isArray(results) ? results : []).filter(r => r?.error || r?.success === false);
            if (structuralErrors.length) {
              const firstErr = structuralErrors[0];
              ErrorHandler.handle(new Error(firstErr?.message || "Falha ao simular."), "Erro na simulação", { showDetailsPanel: true, details: firstErr });
              return;
            }

            const allMsgs = (Array.isArray(results) ? results : []).flatMap(r => r?.returnMessages || r?.mensagens || []);
            const hasErrorMsg = allMsgs.some(m => m.type === "E" || m.type === "A");
            if (hasErrorMsg) {
              Dialogs.showBapiMessages(allMsgs);
              return;
            }

            const resultsArr = Array.isArray(results) ? results : [];
            let resRows = [];
            try {
              resRows = resultsArr.flatMap(r => {
                const v = normVendor(r?.header?.fornecedor || r?.header?.vendor || "");
                const srcRows = vendorToSrc.get(v) || (qm.getProperty("/simSourceRows") || []);
                return Mapper.buildResRowsFromBapiResult(r, qm, srcRows);
              });
            } catch (err) {
              // Fallback
              const globalSrc = qm.getProperty("/simSourceRows") || [];
              resRows = resultsArr.flatMap(r => Mapper.buildResRowsFromBapiResult(r, qm, globalSrc));
            }

            Dialogs.openResultDialog(view, resRows, this);
            if (allMsgs.length) Dialogs.showBapiMessages(allMsgs);

          } catch (err) {
            ErrorHandler.handle(err, "Erro ao simular pedido", { showDetailsPanel: true, contentWidth: "640px" });
          } finally {
            sap.ui.core.BusyIndicator.hide();
          }
        },

        // ===========================================================
        // 4. PREMIAÇÃO
        // ===========================================================
        onAwardQtyChangeRes(ev) {
          const input = ev.getSource();
          const ctx = input.getBindingContext("res");
          if (!ctx) return;

          const row = ctx.getObject() || {};
          let v = Math.floor(Number(input.getValue()));
          if (!Number.isFinite(v) || v < 0) v = 0;
          row.qtyAward = v;
          ctx.getModel().checkUpdate(true);
          input.setValue(String(row.qtyAward));

          const original = Math.floor(Number(row.originalQty) || 0);
          if (original > 0 && v > original) {
            input.setValueState(sap.ui.core.ValueState.Warning);
            input.setValueStateText(`Quantidade acima da original (${original}).`);
            sap.m.MessageToast.show(`Qtd premiada (${v}) > original (${original}).`);
          } else {
            input.setValueState(sap.ui.core.ValueState.None);
            input.setValueStateText("");
          }
        },

        async onAwardDirect() {
          const view = this.getView();
          const vm = view.getModel("vm");

          const tbl = this._dlgRes?.getContent?.()[0];
          const selected = tbl?.getSelectedContexts("res").map((c) => c.getObject()) || [];
          if (!selected.length) {
            MessageToast.show("Selecione ao menos uma linha para premiar.");
            return;
          }

          const allRows = vm?.getProperty("/rows") || [];
          const supplierBids = AwardSvc.validarEMontarPayload(allRows, selected, this._ensureInvitationResourceId.bind(this));
          if (!supplierBids) return;

          const sEventId = vm.getProperty("/header/docId") || view.getModel("res")?.getProperty("/header/docId");
          if (!sEventId) {
            MessageBox.error("DocID do evento não encontrado no header.");
            return;
          }

          sap.ui.core.BusyIndicator.show(0);
          try {
            const out = await ODataSvc.createScenario(view, {
              eventId: sEventId,
              title: "Premiação via UI (direto)",
              scenarioType: 0,
              supplierBids,
            });

            if (out?.success) {
              MessageBox.success(`Cenário criado com sucesso!\nScenario ID: ${out.scenarioId || "(n/a)"}`);
              this._dlgRes?.close();
            } else {
              MessageBox.warning("CreateScenario executou, porém sem success=true.");
            }
          } catch (e) {
            ErrorHandler.handle(e, "Erro ao criar cenário de premiação", { showDetailsPanel: true, contentWidth: "640px" });
          } finally {
            sap.ui.core.BusyIndicator.hide();
          }
        },

        // ===========================================================
        // 5. HELPERS & EXPORT
        // ===========================================================
        _ensureInvitationResourceId(invId, email) {
          if (!invId) return null;
          const s = String(invId);
          if (s.includes("_")) return s;
          if (email) return `${s}_${String(email)}`;
          return s;
        },

        _collectRowsFromTable(table, modelName, modelFallback, pathFallback) {
          if (!table) return [];

          let selected = [];
          if (typeof table.getSelectedContexts === "function") {
            selected = (table.getSelectedContexts(modelName) || []).map(c => c.getObject());
          } else if (table.isA && table.isA("sap.ui.mdc.Table")) {
            const inner = table.getInnerTable && table.getInnerTable();
            if (inner) {
              if (typeof inner.getSelectedContexts === "function") {
                selected = (inner.getSelectedContexts(modelName) || []).map(c => c.getObject());
              } else if (inner.isA && inner.isA("sap.ui.table.Table")) {
                const idxs = inner.getSelectedIndices() || [];
                selected = idxs.map(i => inner.getContextByIndex(i)).filter(Boolean).map(ctx => ctx.getObject());
              }
            }
          }
          if (selected.length) return selected;

          let binding = null;
          if (typeof table.getRowBinding === "function") binding = table.getRowBinding();
          else if (typeof table.getBinding === "function") binding = table.getBinding("items");

          if (binding && typeof binding.getLength === "function") {
            const len = binding.getLength();
            if (len > 0 && typeof binding.getContexts === "function") {
              const ctxs = binding.getContexts(0, len);
              return ctxs.map(c => c.getObject());
            }
          }

          return modelFallback?.getProperty(pathFallback) || [];
        },

        onExportExcel() {
          const view = this.getView();
          const vm = view.getModel("vm");
          const tbl = view.byId("tblDocs");

          const rows = this._collectRowsFromTable(tbl, "vm", vm, "/rows");
          if (!rows.length) {
            sap.m.MessageToast.show("Nada para exportar.");
            return;
          }
          this._doExport(rows, vm?.getProperty("/header/docId") || "MapaComparativo");
        },

        onExportExcelRes() {
          const view = this.getView();
          const tbl = this._dlgRes?.getContent?.()[0];
          const resModel = view.getModel("res");

          if (!tbl || !resModel) {
            sap.m.MessageToast.show("Janela de resultados não está aberta.");
            return;
          }
          const rows = this._collectRowsFromTable(tbl, "res", resModel, "/rows");
          if (!rows.length) {
            sap.m.MessageToast.show("Nada para exportar.");
            return;
          }
          this._doExport(rows, view.getModel("vm")?.getProperty("/header/docId") || "Simulacao", true);
        },

        _doExport(rows, docId, isResult = false) {
          const toNum = (v) => {
            if (v == null || v === "") return null;
            const n = Number(String(v).replace(/\./g, "").replace(",", "."));
            return Number.isFinite(n) ? n : null;
          };

          const NUMERIC = isResult
            ? ["originalQty", "quantity", "qtyAward", "price", "icms", "ipi", "total", "poItem"]
            : ["quantity", "price", "mva", "Extrinsic_Aliquota_ICMS", "Extrinsic_ICMS_Apurado", "EXTENDEDPRICE", "Extrinsic_Aliquota_IPI"];

          const data = rows.map(r => {
            const out = { ...r };
            NUMERIC.forEach(k => { if (k in out) out[k] = toNum(out[k]); });
            return out;
          });

          const columns = isResult ? [
            { label: "Fornecedor", property: "supplierName", type: EdmType.String, width: 30 },
            { label: "Item", property: "materialCode", type: EdmType.String, width: 16 },
            { label: "Preço", property: "price", type: EdmType.Number, width: 12, scale: 2 },
            // ... adicione o resto das colunas de resultado
          ] : [
            { label: "Doc ID", property: "docId", type: EdmType.String, width: 12 },
            { label: "Fornecedor", property: "supplierName", type: EdmType.String, width: 30 },
            { label: "Item", property: "itemDescription", type: EdmType.String, width: 40 },
            { label: "Qtd", property: "quantity", type: EdmType.Number, width: 12, scale: 0 },
            { label: "Preço", property: "price", type: EdmType.Number, width: 12, scale: 2 },
            // ... adicione o resto das colunas principais
          ];

          const fileName = `${isResult ? "Resultado" : "Comparativo"}_${docId}.xlsx`;
          const sheet = new Spreadsheet({ workbook: { columns }, dataSource: data, fileName, worker: true });
          sheet.build()
            .then(() => sap.m.MessageToast.show(`Exportado: ${data.length} linha(s)`))
            .finally(() => sheet.destroy());
        }
      }
    );
  }
);