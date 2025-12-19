sap.ui.define(
  [
    "sap/ui/core/UIComponent",
    "comparativemap/comparativemap/model/models"
  ],
  (UIComponent, models) => {
    "use strict";

    return UIComponent.extend("comparativemap.comparativemap.Component", {
      metadata: {
        manifest: "json",
        interfaces: ["sap.ui.core.IAsyncContentCreation"],
      },

      init() {
        // chama o init padrão do UIComponent
        UIComponent.prototype.init.apply(this, arguments);

        // set do device model
        this.setModel(models.createDeviceModel(), "device");

        // inicializa o router
        this.getRouter().initialize();
      }
    });
  },
);
