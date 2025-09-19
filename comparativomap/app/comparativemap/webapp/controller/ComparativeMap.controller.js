sap.ui.define(
  [
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/Sorter",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "comparativemap/comparativemap/model/models",
    "comparativemap/comparativemap/controller/prefs/PrefsStore",
    "comparativemap/comparativemap/controller/components/ViewSettings",
    "comparativemap/comparativemap/controller/services/ODataService",
    "comparativemap/comparativemap/controller/services/SimulationMapper",
    "comparativemap/comparativemap/controller/services/Dialogs",
    "comparativemap/comparativemap/controller/services/AwardService",
    "comparativemap/comparativemap/controller/helpers/KeyUtils",
    "comparativemap/comparativemap/controller/helpers/Debug",
    "comparativemap/comparativemap/controller/helpers/Formatters",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/Device",
    "comparativemap/comparativemap/controller/helpers/buildRequestsBySupplier"
  ],
  function (
    Controller,
    Sorter,
    Filter,
    FilterOperator,
    Models,
    PrefsStore,
    ViewSettingsCmp,
    ODataSvc,
    Mapper,
    Dialogs,
    AwardSvc,
    Keys,
    Debug,
    Fmt,
    MessageToast,
    MessageBox,
    Device,
    Build
  ) {
    "use strict";

    return Controller.extend(
      "comparativemap.comparativemap.controller.ComparativeMap",
      {
        formatter: Fmt,

        onInit() {
          this.getView().setModel(Models.createVM(), "vm");
          this.getView().setModel(Models.createQM(), "qm");

          this._prefs = PrefsStore.load();
          const allowedGroups = [
            "supplierName", "itemId",
            "PLANT", "currency", "grupo_de_materias", "MaterialCode", "ItemCategory"
          ];
          if (!allowedGroups.includes(this._prefs.group?.key)) {
            this._prefs.group = { key: null, desc: false };
            PrefsStore.save(this._prefs);
          };
          this.mGroupFunctions = {
            supplierName: (ctx) => {
              const v = ctx.getProperty("supplierName") || "";
              const key = v || "__noSupplier__";
              const text = v || "(Sem fornecedor)";
              return { key, text };
            },
            itemId: (ctx) => {
              const raw = ctx.getProperty("itemId") ?? ctx.getProperty("ItemId");
              const v = raw == null ? "" : String(raw);
              const key = v || "__noItemId__";
              const text = v ? `Item ${v}` : "(Sem ItemId)";
              return { key, text };
            },
            PLANT: (ctx) => {
              const v = ctx.getProperty("PLANT") || "";
              return { key: v || "__noPlant__", text: v || "(Sem Centro)" };
            },
            currency: (ctx) => {
              const v = ctx.getProperty("currency") || "";
              return { key: v || "__noCurr__", text: v || "(Sem Moeda)" };
            },
            grupo_de_materias: (ctx) => {
              const v = ctx.getProperty("grupo_de_materias") || "";
              return { key: v || "__noGrpMat__", text: v || "(Sem Grupo Mat.)" };
            },
            MaterialCode: (ctx) => {
              const v = ctx.getProperty("MaterialCode") || "";
              return { key: v || "__noMatCode__", text: v || "(Sem Código Mat.)" };
            },
            ItemCategory: (ctx) => {
              const v = ctx.getProperty("ItemCategory") || "";
              return { key: v || "__noItemCat__", text: v || "(Sem Categoria)" };
            }
          };

          this._vs = ViewSettingsCmp.create(
            this.getView(),
            this._prefs,
            this._getDistinct.bind(this),
            this.mGroupFunctions,
          );
          this._vs.applyFiltersFromPrefs();
          this._vs.applyGroupSortFromPrefs();
        },

        /* ====== BUSCAR ====== */
        async onBuscar() {
          const view = this.getView();
          const odata = view.getModel();
          const vm = view.getModel("vm");
          const qm = view.getModel("qm");
          const tbl = view.byId("tblDocs");
          const docId = (view.byId("inputDoID").getValue() || "").trim();

          try {
            if (!odata) throw new Error("Modelo OData V4 não encontrado.");
            if (!docId) { MessageToast.show("Informe o Doc ID"); return; }

            // 🔄 RESET TOTAL de filtros/sort/agrupamento ANTES de buscar outro DocID
            const binding = tbl?.getBinding("items");
            if (binding) {
              // limpa filtros aplicados por código e por UI
              binding.filter([], sap.ui.model.FilterType.Application);
              binding.filter([], sap.ui.model.FilterType.Control);
              // limpa ordenação
              binding.sort(null);
            }
            // limpa estado visual da barra de filtro (se existir)
            view.byId("vsdFilterBar")?.setVisible(false);
            view.byId("vsdFilterLabel")?.setText("");

            // zera preferências salvas (evita re-aplicar filtros antigos no novo dataset)
            this._prefs = Object.assign({}, this._prefs, {
              filter: {
                fornecedor: [], moeda: [], centro: [], grupoMat: [], ncm: [],
                onlyTax: false, precoMin: null, precoMax: null, qtdMin: null, qtdMax: null
              },
              sort: { key: null, desc: false },
              group: { key: null, desc: false }
            });
            this._vs.setPrefs(this._prefs);
            PrefsStore.save(this._prefs);


            // também limpe seleções e caches
            tbl?.removeSelections(true);
            qm?.setProperty("/idByKey", {});
            qm?.setProperty("/simSourceRows", []);

            tbl?.setBusy(true);

            // ===== segue seu fluxo normal =====
            const res = await ODataSvc.fetchQuotes(view, docId);

            const rows = (Array.isArray(res?.items) ? res.items : []).map(r => ({
              ...r,
              itemId: r.itemId ?? r.ItemId ?? null,
              price: (r.price !== undefined && r.price !== null) ? Number(r.price) : r.price,
              _originalQty: Number(r.quantity) || 0
            }));

            vm.setProperty("/header", res?.header || {});
            vm.setProperty("/rows", rows);
            vm.setProperty("/headerRows", res?.header ? [res.header] : []);

            const distinct = {
              supplierName: this._distinct(rows, "supplierName"),
              currency:     this._distinct(rows, "currency"),
              PLANT:        this._distinct(rows, "PLANT"),
              grupo_de_materias: this._distinct(rows, "grupo_de_materias"),
              ncm:          this._distinct(rows, "ncm"),
            };
            vm.setProperty("/distinct", distinct);

            tbl?.getBinding("items")?.refresh(true);
            sap.ui.getCore().applyChanges();
            tbl?.removeSelections(true);

            if (!rows.length) MessageToast.show("Nenhum item retornado para esse Doc ID.");
          } catch (e) {
            console.error("[onBuscar] ERRO:", e);
            MessageBox.error("Falha ao buscar dados: " + (e.message || e));
          } finally {
            tbl?.setBusy(false);
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
        },

        onCloseDialog(ev) {
          Dialogs.closeAny(this, ev);
        },

        /* ====== SIMULAR ====== */
        async onSimularPress() {
          const view = this.getView();
          const vm = view.getModel("vm");
          const qm = view.getModel("qm");

          // limpa apenas o modelo "res"
          let resModel = view.getModel("res");
          if (!resModel) {
            resModel = new sap.ui.model.json.JSONModel({ rows: [] });
            view.setModel(resModel, "res");
          } else {
            resModel.setData({ rows: [] });
          }

          console.groupCollapsed("[SIMULAR] clique");
          try {
            const tbl = this.byId("tblDocs");
            if (!tbl) throw new Error("Tabela 'tblDocs' não encontrada.");

            // seleção atual (sem contexts “fantasma”)
            const selItems = tbl.getSelectedItems();
            if (!selItems.length) throw new Error("Selecione pelo menos 1 item para simular.");

            const rows = selItems
              .map(it => it.getBindingContext("vm")?.getObject?.())
              .filter(r => r && (r.MaterialCode || r.materialCode || r.ItemId || r.itemId));

            if (!rows.length) {
              tbl.removeSelections(true);
              throw new Error("Seleção inválida: os itens selecionados não existem mais. Faça uma nova seleção e tente novamente.");
            }
            Debug.dbg(`Linhas selecionadas (count=${rows.length})`, rows);

            // índices para casar BAPI → Ariba
            qm.setProperty("/simSourceRows", rows);
            Mapper.prepareQMFromSelection(rows, qm);

            // 🔁 MONTA 1 REQUEST POR FORNECEDOR
            const requests = Build.buildRequestsFromSelection(rows, vm);

            // Validações por request + itens
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

            console.table(requests.map(r => ({
              vendor: r.header.vendor,
              items: r.items.length,
              currency: r.header.currency
            })));

            // ---------------------------
            // Mapa local vendor -> sourceRows e payload sem sourceRows
            // ---------------------------
            const normVendor = v => (v == null ? "" : String(v).replace(/\D/g, "").padStart(10, "0"));

            // guarda localmente as sourceRows por fornecedor (NÃO envie ao backend)
            const vendorToSrc = new Map(
              (requests || []).map(req => [normVendor(req?.header?.vendor), Array.isArray(req.sourceRows) ? req.sourceRows : []])
            );

            // payload limpo (sem sourceRows) para a action do CAP
            const payloadRequests = (requests || []).map(({ header, items, schedules, testRun }) => ({
              header, items, schedules, testRun
            }));

            sap.ui.core.BusyIndicator.show(0);

            // 🔧 chama action e trata ARRAY de resultados (1 por fornecedor)
            const results = await ODataSvc.simularPO(view, payloadRequests, 4);
            Debug.dbg("Resultados da BAPI (array)", results);

            // 1) erro estrutural (em algum request)
            const structuralErrors = (Array.isArray(results) ? results : [])
              .filter(r => r?.error || r?.success === false);
            if (structuralErrors.length) {
              const firstErr = structuralErrors[0];
              if (Dialogs.showError) {
                Dialogs.showError(
                  "Erro na simulação",
                  firstErr?.message || "Falha ao simular.",
                  firstErr
                );
              } else {
                MessageBox.error(firstErr?.message || "Falha ao simular.", {
                  details: JSON.stringify(firstErr, null, 2),
                  contentWidth: "640px",
                });
              }
              console.groupEnd();
              return;
            }

            // 2) mensagens BAPI agregadas (E/A interrompe)
            const allMsgs = (Array.isArray(results) ? results : [])
              .flatMap(r => r?.returnMessages || r?.mensagens || []);
            const hasErrorMsg = allMsgs.some(m => m.type === "E" || m.type === "A");
            if (hasErrorMsg) {
              Dialogs.showBapiMessages(allMsgs);
              console.groupEnd();
              return;
            }

            // 3) monta linhas do fragment a partir de TODOS os fornecedores (com srcRows por fornecedor!)
            const resultsArr = Array.isArray(results) ? results : [];
            let resRows = [];

            try {
              resRows = resultsArr.flatMap(r => {
                const v = normVendor(r?.header?.fornecedor || r?.header?.vendor || "");
                const srcRows = vendorToSrc.get(v) || (qm.getProperty("/simSourceRows") || []);
                return Mapper.buildResRowsFromBapiResult(r, qm, srcRows);
              });
            } catch (err) {
              console.error("[SIMULAR] Erro ao montar resRows:", err);
              // fallback robusto: usa simSourceRows completo
              try {
                const globalSrc = qm.getProperty("/simSourceRows") || [];
                resRows = resultsArr.flatMap(r => Mapper.buildResRowsFromBapiResult(r, qm, globalSrc));
              } catch (err2) {
                console.error("[SIMULAR] Fallback também falhou ao montar resRows:", err2);
                resRows = [];
              }
            }

            Dialogs.openResultDialog(view, resRows, this);

            // mensagens informativas/aviso
            if (allMsgs.length) Dialogs.showBapiMessages(allMsgs);

            console.groupEnd();
          } catch (err) {
            console.error("[SIMULAR] ERRO:", err);
            console.groupEnd();
            const details =
              err?.cause?.response?.body ||
              err?.cause?.message ||
              err?.stack ||
              (typeof err === "object" ? JSON.stringify(err, null, 2) : String(err));

            MessageBox.error(err.message || String(err), {
              details,
              contentWidth: "640px",
            });
          } finally {
            sap.ui.core.BusyIndicator.hide();
          }
        }
        ,

        /* ====== PREMIAÇÃO ====== */
        onAwardQtyChangeRes(ev) {
          const input = ev.getSource();
          const ctx = input.getBindingContext("res");
          const obj = ctx?.getObject() || {};
          let v = Number(input.getValue());
          if (isNaN(v) || v < 0) v = 0;
          const max = Number(obj.originalQty) || 0;
          if (v > max) v = max;
          obj.qtyAward = Math.floor(v);
          ctx.getModel().checkUpdate(true);
          input.setValue(String(obj.qtyAward));
        },

        async onAwardDirect() {
          const view = this.getView();
          const oModel = view.getModel();
          const vm = view.getModel("vm");

          const tbl = this._dlgRes?.getContent?.()[0];
          const selected =
            tbl?.getSelectedContexts("res").map((c) => c.getObject()) || [];
          if (!selected.length) {
            MessageToast.show("Selecione ao menos uma linha para premiar.");
            return;
          }

          const allRows = vm?.getProperty("/rows") || [];
          const supplierBids = AwardSvc.validarEMontarPayload(
            allRows,
            selected,
            this._ensureInvitationResourceId.bind(this),
          );
          if (!supplierBids) return;

          const sEventId =
            vm.getProperty("/header/docId") ||
            view.getModel("res")?.getProperty("/header/docId");
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
            sap.ui.core.BusyIndicator.hide();
            if (out?.success) {
              MessageBox.success(
                `Cenário criado com sucesso!\nScenario ID: ${out.scenarioId || "(n/a)"}\nCorrelation-ID: ${out.correlationId || "(n/a)"}`,
              );
              this._dlgRes?.close();
            } else {
              MessageBox.warning(
                "CreateScenario executou, porém sem success=true.",
              );
            }
          } catch (e) {
            sap.ui.core.BusyIndicator.hide();
            const msg = e?.message || "Falha ao criar cenário.";
            MessageBox.error(msg);
          }
        },

        /* ====== ViewSettings delegações ====== */
        handleFilterButtonPressed() {
          this._vs.openFilterDialog((ev) =>
            this._vs.handleFilterDialogConfirm(ev, (p) => {
              this._prefs = p;
              PrefsStore.save(p);
            }),
          );
        },
        handleSortButtonPressed() {
          this._vs.openSortDialog((ev) =>
            this._vs.handleSortDialogConfirm(ev, (p) => {
              this._prefs = p;
              PrefsStore.save(p);
            }),
          );
        },
        handleGroupButtonPressed() {
          this._vs.openGroupDialog(
            (ev) =>
              this._vs.handleGroupDialogConfirm(ev, (p) => {
                this._prefs = p;
                PrefsStore.save(p);
              }),
            () => { },
          );
        },

        onFilterSelectAllFornecedor() {
          this._prefs.filter.fornecedor = this._getDistinct("supplierName");
          PrefsStore.save(this._prefs);
          this._vs.applyFiltersFromPrefs();
          MessageToast.show("Fornecedor: selecionado tudo.");
        },
        onFilterClearFornecedor() {
          this._prefs.filter.fornecedor = [];
          PrefsStore.save(this._prefs);
          this._vs.applyFiltersFromPrefs();
          MessageToast.show("Fornecedor: seleção limpa.");
        },
        onFilterSelectAllNomeItem() {
          this._prefs.filter.nomeItem = this._getDistinct("itemDescription");
          PrefsStore.save(this._prefs);
          this._vs.applyFiltersFromPrefs();
          MessageToast.show("Nome do item: selecionado tudo.");
        },
        onFilterClearNomeItem() {
          this._prefs.filter.nomeItem = [];
          PrefsStore.save(this._prefs);
          this._vs.applyFiltersFromPrefs();
          MessageToast.show("Nome do item: seleção limpa.");
        },

        /* ====== Helpers “de ponte” ====== */
        _getDistinct(path) {
          const rows = this.getView().getModel("vm").getProperty("/rows") || [];
          const set = new Set();
          rows.forEach((r) => {
            const v = r[path];
            if (v !== undefined && v !== null && v !== "") set.add(String(v));
          });
          return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
        },
        _distinct(list, prop) {
          const set = new Set();
          (list || []).forEach(r => {
            const v = r?.[prop];
            if (v !== undefined && v !== null && v !== "") set.add(String(v));
          });
          return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
        },

        _ensureInvitationResourceId(invId, email) {
          if (!invId) return null;
          const s = String(invId);
          if (s.includes("_")) return s;
          if (email) return `${s}_${String(email)}`;
          return s;
        },

        onExit() {
          if (this._dlgRes) {
            this._dlgRes.destroy(true);
            this._dlgRes = null;
          }
        },
      },
    );
  },
);
