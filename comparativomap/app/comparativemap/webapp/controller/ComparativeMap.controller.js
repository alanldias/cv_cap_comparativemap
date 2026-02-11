sap.ui.define(
  [
    "sap/ui/core/mvc/Controller",
    "sap/ui/core/UIComponent",
    "sap/m/MessageToast",
    "sap/m/MessageBox",

    "comparativemap/comparativemap/model/models",
    "comparativemap/comparativemap/controller/services/ODataService",
    "comparativemap/comparativemap/controller/services/SimulationMapper",
    "comparativemap/comparativemap/controller/services/Dialogs",
    "comparativemap/comparativemap/controller/services/AwardService",
    "comparativemap/comparativemap/controller/helpers/Formatters",
    "comparativemap/comparativemap/controller/helpers/ErrorHandler",
    "comparativemap/comparativemap/controller/helpers/buildRequestsBySupplier",
    "comparativemap/comparativemap/controller/prefs/DraftStore",
  ],
  function (
    Controller,
    UIComponent,
    MessageToast,
    MessageBox,
    Models,
    ODataSvc,
    Mapper,
    Dialogs,
    AwardSvc,
    Fmt,
    ErrorHandler,
    Build,
    Drafts,
  ) {
    "use strict";

    const CONCURRENCY_DEFAULT = 4;

    return Controller.extend(
      "comparativemap.comparativemap.controller.ComparativeMap",
      {
        formatter: Fmt,
        // INIT / ROUTE / EXIT
        onInit() {
          const view = this.getView();

          view.setModel(Models.createVM(), "vm");
          view.setModel(Models.createQM(), "qm");

          if (!view.getModel("res")) {
            view.setModel(
              new sap.ui.model.json.JSONModel({ header: {}, rows: [], totals: {} }),
              "res",
            );
          }

          view.addStyleClass("sapUiSizeCompact");

          // Revalida acesso sempre que a rota for ativada
          const router = UIComponent.getRouterFor(this);
          this._fnRouteMatched = this._onRouteMatched.bind(this);
          router
            .getRoute("RouteComparativeMap")
            .attachPatternMatched(this._fnRouteMatched);

          // Autosave dos dados (sem preferências de UI)
          this._onUnloadSave = () => {
            try {
              Drafts.save(this);
            } catch (e) {}
          };
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

          const router = UIComponent.getRouterFor(this);
          if (this._fnRouteMatched) {
            router
              .getRoute("RouteComparativeMap")
              .detachPatternMatched(this._fnRouteMatched);
            this._fnRouteMatched = null;
          }
        },

        async _onRouteMatched() {
          const view = this.getView();
          const router = UIComponent.getRouterFor(this);
          const oModel = view.getModel(); // OData V4 principal

          if (!oModel) {
            MessageBox.error(
              "Não foi possível acessar o modelo de dados para validar seu acesso ao Mapa Comparativo.",
            );
            router.navTo("RouteUnauthorized");
            return;
          }

          // deixa o UI5 dizer a serviceUrl
          let sServiceUrl = oModel.sServiceUrl || "/odata/v4/service/";
          if (!sServiceUrl.endsWith("/")) sServiceUrl += "/";
          const sPingUrl = sServiceUrl + "Ping()";

          try {
            const resp = await fetch(sPingUrl, {
              method: "GET",
              headers: { Accept: "application/json" },
            });

            if (resp.status === 401 || resp.status === 403) {
              router.navTo("RouteUnauthorized");
              return;
            }

            // Oferta de restore (somente dados) ao entrar na tela
            Drafts.offerRestoreOnEnter(this);
          } catch (e) {
            MessageBox.error(
              "Não foi possível validar seu acesso ao Mapa Comparativo. Verifique sua conexão e tente novamente.",
            );
            router.navTo("RouteUnauthorized");
          }
        },
        // BUSCA (DOCID)
        async onBuscar() {
          const view = this.getView();
          const vm = view.getModel("vm");
          const qm = view.getModel("qm");
          const mdcTbl = view.byId("tblDocs");

          const input = view.byId("inputDoID");
          const newDocId = String(input?.getValue?.() || "").trim();
          const oldDocId = String(vm.getProperty("/header/docId") || "").trim();

          if (!newDocId) {
            MessageToast.show("Informe o Doc ID");
            return;
          }

          // Se tem draft pro DocID, pergunta se quer restaurar (dados-only)
          if (Drafts.hasDraft(newDocId)) {
            const wantRestore = await new Promise((resolve) => {
              MessageBox.confirm(`Existe um rascunho salvo para o DocID ${newDocId}. Restaurar?`, {
                actions: [MessageBox.Action.YES, MessageBox.Action.NO],
                emphasizedAction: MessageBox.Action.YES,
                onClose: (act) => resolve(act === MessageBox.Action.YES),
              });
            });

            if (wantRestore) {
              try {
                Drafts.restore(this, newDocId);
              } catch (e) {
                ErrorHandler.handle(e, "Falha ao restaurar rascunho");
              }
              return;
            }

            // se NÃO restaurar, segue buscando do backend e sobrescreve dados
            Drafts.clear(newDocId);
          }

          try {
            const odata = view.getModel();
            if (!odata) throw new Error("Modelo OData V4 não encontrado.");

            sap.ui.core.BusyIndicator.show(0);
            mdcTbl?.setBusy(true);

            // salva draft anterior (dados) antes de trocar doc
            if (oldDocId && oldDocId !== newDocId) {
              try {
                Drafts.save(this, true);
              } catch (e) {}
            }

            // containers usados na simulação
            qm?.setProperty("/idByKey", {});
            qm?.setProperty("/simSourceRows", []);

            const res = await ODataSvc.fetchQuotes(view, newDocId);

            const header = res?.header || {};
            const headerRows = res?.header ? [res.header] : [];
            const rows = (Array.isArray(res?.items) ? res.items : []).map((r) => ({
              ...r,
              itemId: r.itemId ?? r.ItemId ?? null,
              itemDescription: r.itemDescription,
              price:
                r.price !== undefined && r.price !== null ? Number(r.price) : r.price,
              _originalQty: Number(r.quantity) || 0,
            }));

            vm.setProperty("/header", { ...header, docId: newDocId });
            vm.setProperty("/headerRows", headerRows);
            vm.setProperty("/rows", rows);

            if (mdcTbl?.isA?.("sap.ui.mdc.Table")) mdcTbl.rebind();

            // salva estado inicial (dados-only)
            setTimeout(() => {
              try {
                Drafts.save(this, true);
              } catch (e) {}
            }, 300);

            if (!rows.length) MessageToast.show("Nenhum item retornado para esse Doc ID.");
          } catch (e) {
            ErrorHandler.handle(e, "Erro ao buscar DocID");
          } finally {
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
          if (!Number.isFinite(v) || v < 0) v = 0;
          if (max && v > max) v = max;

          row.quantity = Math.floor(v);
          ctx.getModel().checkUpdate(true);

          Drafts.autoSave(this);
        },

        onCloseDialog(ev) {
          Dialogs.closeAny(this, ev);
        },
        // SIMULAÇÃO
        async onSimularPress() {
          const view = this.getView();
          const vm = view.getModel("vm");
          const qm = view.getModel("qm");
          const resModel = view.getModel("res");

          // limpa resultado anterior
          resModel?.setSizeLimit?.(5000);
          resModel?.setProperty("/header", {});
          resModel?.setProperty("/rows", []);
          resModel?.setProperty("/totals", {});

          try {
            const mdcTbl = this.byId("tblDocs");
            if (!mdcTbl) throw new Error("Tabela 'tblDocs' não encontrada.");

            const { rows, selectionSource } = this._collectSelectedRowsFromMdc(mdcTbl, "vm");

            if (!rows.length) {
              MessageBox.warning("Selecione pelo menos 1 item para poder simular o pedido.");
              return;
            }

            // descarta linhas lixo
            const validRows = rows.filter(
              (r) => r && (r.MaterialCode || r.materialCode || r.ItemId || r.itemId),
            );
            if (!validRows.length) {
              throw new Error(
                "Seleção inválida: itens sem Material ou ID. Limpe e selecione novamente.",
              );
            }

            // bloqueia preço zerado
            const zeroPriceRows = validRows.filter((r) => {
              const p = Number(r.price);
              return !p || p <= 0.000001;
            });
            if (zeroPriceRows.length) {
              const lista = zeroPriceRows
                .map((r) => `• ${r.itemDescription || r.materialCode || "Item sem nome"}`)
                .join("\n");
              MessageBox.error(
                "A simulação não pode ser realizada com preços zerados (0,00).",
                { details: "Itens com preço 0,00:\n\n" + lista, contentWidth: "400px" },
              );
              return;
            }

            // prepara cruzamento pra volta
            qm.setProperty("/simSourceRows", validRows);
            Mapper.prepareQMFromSelection(validRows, qm);

            // requests por fornecedor
            const requests = Build.buildRequestsFromSelection(validRows, vm);

            // validações mínimas (mantidas)
            const { headerMissing, itemMissing } = this._validateRequests(
              requests,
              validRows,
            );
            if (headerMissing.length || itemMissing.length) {
              const msg = [
                headerMissing.length
                  ? "⚠️ Cabeçalho:\n- " + headerMissing.join("\n- ")
                  : "",
                itemMissing.length ? "⚠️ Itens:\n- " + itemMissing.join("\n- ") : "",
              ]
                .filter(Boolean)
                .join("\n\n");
              throw new Error(msg);
            }

            // payload sem “peso extra”
            const payloadRequests = (requests || []).map(
              ({ header, items, schedules, testRun }) => ({
                header,
                items,
                schedules,
                testRun,
              }),
            );

            sap.ui.core.BusyIndicator.show(0);

            const results = await ODataSvc.simularPO(
              view,
              payloadRequests,
              CONCURRENCY_DEFAULT,
            );

            const resultsArr = Array.isArray(results) ? results : [];
            const allMsgs = resultsArr.flatMap(
              (r) => r?.returnMessages || r?.mensagens || [],
            );

            // erro estrutural
            const structuralErrors = resultsArr.filter(
              (r) => r?.error || r?.success === false,
            );
            if (structuralErrors.length) {
              const firstErr = structuralErrors[0];
              ErrorHandler.handle(
                new Error(firstErr?.message || "Falha técnica na simulação."),
                "Erro na simulação",
                { showDetailsPanel: true, details: firstErr },
              );
              return;
            }

            // erro de negócio (BAPI)
            const hasErrorMsg = allMsgs.some((m) => m.type === "E" || m.type === "A");
            if (hasErrorMsg) {
              Dialogs.showBapiMessages(allMsgs);
              return;
            }

            // mapeia pra UI
            const globalSrc = qm.getProperty("/simSourceRows") || [];
            const resRows = resultsArr.flatMap((r) =>
              Mapper.buildResRowsFromBapiResult(r, qm, globalSrc),
            );

            resModel?.setProperty("/rows", resRows);
            resModel?.setProperty("/header", resultsArr[0]?.header || {});

            Dialogs.openResultDialog(view, resRows, this);
            if (allMsgs.length) Dialogs.showBapiMessages(allMsgs);
          } catch (err) {
            ErrorHandler.handle(err, "Erro ao simular pedido", {
              showDetailsPanel: true,
              contentWidth: "640px",
            });
          } finally {
            sap.ui.core.BusyIndicator.hide();
          }
        },
        // PREMIAÇÃO
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

          input.setValueState(sap.ui.core.ValueState.None);
          input.setValueStateText("");

          if (original > 0 && v !== original) {
            input.setValueState(sap.ui.core.ValueState.Warning);
            input.setValueStateText(
              v > original
                ? `Aviso: quantidade acima da original (${original}).`
                : `Aviso: quantidade abaixo da original (${original}).`,
            );

            MessageToast.show(
              v > original
                ? `Qtd premiada (${v}) maior que a original (${original}).`
                : `Qtd premiada (${v}) menor que a original (${original}).`,
            );
          }
        },

        async onAwardDirect() {
          const view = this.getView();
          const vm = view.getModel("vm");
          const resModel = view.getModel("res");

          // tenta achar a tabela do fragmento
          let tbl = this.byId("tblRes");
          if (!tbl && this._dlgRes) {
            tbl = this._dlgRes
              .getContent()
              .find((c) => c?.isA?.("sap.ui.mdc.Table"));
          }

          if (!tbl) {
            MessageBox.error("Erro interno: Tabela de resultados (tblRes) não encontrada.");
            return;
          }

          const selected = this._collectRowsFromTable(tbl, "res", resModel, "/rows");
          if (!selected.length) {
            MessageToast.show("Selecione ao menos uma linha para premiar.");
            return;
          }

          const supplierBids = AwardSvc.validarEMontarPayload(
            selected,
            selected,
            this._ensureInvitationResourceId.bind(this),
          );
          if (!supplierBids) return;

          const eventId =
            vm.getProperty("/header/docId") || resModel.getProperty("/header/docId");
          if (!eventId) {
            MessageBox.error("DocID do evento não encontrado no header.");
            return;
          }

          const baseTitle = "Premiação via UI (MDC)";
          const now = new Date();
          const stamp = now.toISOString().slice(0, 19).replace("T", " ");
          const rand = Math.floor(Math.random() * 1000);
          const finalTitle = `${baseTitle} - ${stamp} #${rand}`;

          sap.ui.core.BusyIndicator.show(0);
          try {
            const out = await ODataSvc.createScenario(view, {
              eventId,
              title: finalTitle,
              scenarioType: 0,
              supplierBids,
            });

            if (out?.success) {
              MessageBox.success(
                `Cenário criado com sucesso!\nTítulo: ${finalTitle}\nScenario ID: ${
                  out.scenarioId || "(n/a)"
                }`,
              );
              this._dlgRes?.close();
            } else {
              MessageBox.warning(
                "O cenário foi processado, mas o backend não retornou 'success=true'. Verifique no Ariba.",
              );
            }
          } catch (e) {
            ErrorHandler.handle(e, "Erro ao criar cenário de premiação", {
              showDetailsPanel: true,
              contentWidth: "640px",
            });
          } finally {
            sap.ui.core.BusyIndicator.hide();
          }
        },
        // HELPERS (internos)
        _ensureInvitationResourceId(invId, email) {
          if (!invId) return null;
          const s = String(invId);
          if (s.includes("_")) return s;
          return email ? `${s}_${String(email)}` : s;
        },

        _collectSelectedRowsFromMdc(mdcTbl, modelName) {
          let rows = [];
          let selectionSource = "Nenhuma";

          // 1) API nativa MDC
          if (typeof mdcTbl.getSelectedContexts === "function") {
            const ctxs = mdcTbl.getSelectedContexts();
            if (ctxs) {
              rows = ctxs.map((c) => c.getObject()).filter(Boolean);
              selectionSource = "MDC Direct API";
              return { rows, selectionSource };
            }
          }

          // 2) inner table (fallback)
          if (mdcTbl?.isA?.("sap.ui.mdc.Table")) {
            const inner =
              (typeof mdcTbl.getInnerTable === "function" ? mdcTbl.getInnerTable() : null) ||
              mdcTbl._oTable;

            if (inner?.isA?.("sap.m.Table")) {
              selectionSource = "Inner sap.m.Table";
              rows = inner
                .getSelectedItems()
                .map((it) => it.getBindingContext(modelName)?.getObject?.())
                .filter(Boolean);
              return { rows, selectionSource };
            }

            if (inner?.isA?.("sap.ui.table.Table")) {
              selectionSource = "Inner sap.ui.table.Table (Grid)";

              const hasPlugin =
                inner.getPlugins &&
                inner.getPlugins().some((p) => p.isA("sap.ui.table.plugins.SelectionPlugin"));

              if (!hasPlugin) {
                const idxs = inner.getSelectedIndices() || [];
                rows = idxs
                  .map((i) => inner.getContextByIndex(i))
                  .filter(Boolean)
                  .map((ctx) => ctx.getObject());
              } else {
                rows = [];
              }
              return { rows, selectionSource };
            }
          }

          return { rows, selectionSource };
        },

        _validateRequests(requests, srcRows) {
          const headerMissing = [];
          const itemMissing = [];

          const normVendor = (v) =>
            (v && String(v).replace(/\D/g, "").replace(/^0+/, "")) || "";

          (requests || []).forEach((req, ridx) => {
            const h = req.header || {};
            const vendorCode = normVendor(h.vendor);

            let nomeForn = `Requisição #${ridx + 1}`;
            if (vendorCode) {
              const rowEncontrada = (srcRows || []).find((r) => {
                const cand = [
                  r.lifnr,
                  r.LIFNR,
                  r.supplierId,
                  r.SupplierId,
                  r.supplierID,
                  r.suppliercode,
                  r.supplierCode,
                  r.SupplierCode,
                  r.vendor,
                  r.Vendor,
                  r.vendorId,
                  r.VendorId,
                ].find(Boolean);

                if (!cand) return false;
                const rowCode = normVendor(cand);
                return rowCode === vendorCode;
              });

              nomeForn =
                rowEncontrada?.supplierName ||
                rowEncontrada?.SupplierName ||
                rowEncontrada?.vendorName ||
                rowEncontrada?.VendorName ||
                `Fornecedor ${vendorCode}`;
            }

            const tag = `Fornecedor: ${nomeForn}`;

            if (!h.docType) headerMissing.push(`${tag}: Tipo Pedido (docType)`);
            if (!h.compCode) headerMissing.push(`${tag}: Empresa (compCode)`);
            if (!h.purchOrg) headerMissing.push(`${tag}: Org. Compras`);
            if (!h.vendor) headerMissing.push(`${tag}: Fornecedor`);

            (req.items || []).forEach((it, i) => {
              const itTag = `Fornecedor: ${nomeForn} > Item ${i + 1}`;
              if (!it.plant) itemMissing.push(`${itTag}: Centro (plant) não informado.`);
              if (!it.quantity || it.quantity <= 0) itemMissing.push(`${itTag}: Quantidade inválida.`);
            });
          });

          return { headerMissing, itemMissing };
        },

        _collectRowsFromTable(table, modelName, modelFallback, pathFallback) {
          if (!table) return [];

          let selected = [];
          if (typeof table.getSelectedContexts === "function") {
            selected = (table.getSelectedContexts(modelName) || [])
              .map((c) => c.getObject())
              .filter(Boolean);
          } else if (table?.isA?.("sap.ui.mdc.Table")) {
            const inner = table.getInnerTable && table.getInnerTable();
            if (inner) {
              if (typeof inner.getSelectedContexts === "function") {
                selected = (inner.getSelectedContexts(modelName) || [])
                  .map((c) => c.getObject())
                  .filter(Boolean);
              } else if (inner?.isA?.("sap.ui.table.Table")) {
                const idxs = inner.getSelectedIndices() || [];
                selected = idxs
                  .map((i) => inner.getContextByIndex(i))
                  .filter(Boolean)
                  .map((ctx) => ctx.getObject());
              }
            }
          }
          if (selected.length) return selected;

          // fallback: tudo (usado em award/res)
          let binding = null;
          if (typeof table.getRowBinding === "function") binding = table.getRowBinding();
          else if (typeof table.getBinding === "function") binding = table.getBinding("items");

          if (binding?.getLength && binding?.getContexts) {
            const len = binding.getLength();
            if (len > 0) return binding.getContexts(0, len).map((c) => c.getObject());
          }

          return modelFallback?.getProperty(pathFallback) || [];
        },
      },
    );
  },
);
