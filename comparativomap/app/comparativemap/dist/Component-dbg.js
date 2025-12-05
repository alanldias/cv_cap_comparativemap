sap.ui.define(
  [
    "sap/ui/core/UIComponent",
    "sap/m/MessageBox",
    "comparativemap/comparativemap/model/models"
  ],
  (UIComponent, MessageBox, models) => {
    "use strict";

    return UIComponent.extend("comparativemap.comparativemap.Component", {
      metadata: {
        manifest: "json",
        interfaces: ["sap.ui.core.IAsyncContentCreation"],
      },

      init() {
        // chama o init padrão do UIComponent
        UIComponent.prototype.init.apply(this, arguments);

        // set do device model (como já estava)
        this.setModel(models.createDeviceModel(), "device");

        // inicializa o router
        const oRouter = this.getRouter();
        oRouter.initialize();

        // valida acesso ao mapa
        this._checkAccess();
      },

      /**
       * Checa se o usuário tem acesso chamando o serviço CAP.
       * Se o CAP responder 403 (forbidden), navega para a rota de 'RouteUnauthorized'.
       */
      _checkAccess() {
        const oRouter = this.getRouter();

        // chamada leve: pega só 1 registro, sem count
        fetch("/odata/v4/service/AribaQuotes?$top=1&$count=false", {
          method: "GET",
          headers: {
            Accept: "application/json",
          },
        })
          .then((oResponse) => {
            if (oResponse.status === 403) {
              // usuário NÃO tem o scope MapViewer → manda para tela de acesso negado
              oRouter.navTo("RouteUnauthorized");
            } else if (!oResponse.ok) {
              // erro técnico (500, 502, etc.) → avisa, mas não é erro de permissão
              MessageBox.error(
                "Falha técnica ao validar seu acesso ao Mapa Comparativo. Tente novamente ou contate o suporte."
              );
            }
            // se deu 2xx, segue o fluxo normal na rota principal
          })
          .catch(() => {
            // erro de rede / indisponibilidade
            MessageBox.error(
              "Não foi possível validar seu acesso ao Mapa Comparativo. Verifique sua conexão e tente novamente."
            );
            oRouter.navTo("RouteUnauthorized");
          });
      },
    });
  },
);
