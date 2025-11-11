sap.ui.define([
  "sap/m/MessageBox"
], function (MessageBox) {
  "use strict";

  function _getOriginalMessage(e) {
    if (e && e.message) {
      return String(e.message);
    }
    return String(e || "");
  }

  // Extrai um "detalhe" mais técnico do erro (stack, body da resposta, etc.)
  function _extractDetails(e) {
    return e?.cause?.response?.body ||
      e?.cause?.message ||
      e?.stack ||
      (typeof e === "object" ? JSON.stringify(e, null, 2) : String(e));
  }

  /**
   * Tratamento padrão de erro da aplicação.
   *
   * @param {Error|any} e           Erro capturado no catch
   * @param {string} [sContextMsg]  Mensagem de contexto ("Erro ao buscar DocID", "Erro ao simular pedido", etc.)
   * @param {object} [mOptions]     Opções extras:
   *   - showDetailsPanel {boolean} se true, abre o painel de detalhes
   *   - details {string}           texto de detalhes (se não passar, ele tenta extrair)
   *   - contentWidth {string}      largura do popup de detalhes (default "640px")
   *   - messageBoxSettings {object} merge extra de settings do MessageBox.error
   */
  function handle(e, sContextMsg, mOptions) {
    mOptions = mOptions || {};

    /* eslint-disable no-console */
    console.error(sContextMsg || "Erro na aplicação:", e);

    const msgOriginal = _getOriginalMessage(e);
    const lower = msgOriginal.toLowerCase();
    const isBatchFailed = lower.includes("http request was not processed because $batch failed");

    // Caso especial: sessão / batch estourado
    if (isBatchFailed) {
      MessageBox.warning(
        "Sua sessão expirou ou a conexão com o servidor foi perdida.\n\n" +
        "Clique em OK para recarregar a aplicação.",
        {
          onClose: function () {
            location.reload();
          }
        }
      );
      return;
    }

    const prefixo = sContextMsg ? sContextMsg + ".\n\n" : "Falha ao executar a operação.\n\n";
    const text = prefixo + "Detalhes técnicos: " + msgOriginal;

    // Sem painel de detalhes → MessageBox simples
    if (!mOptions.showDetailsPanel) {
      MessageBox.error(text, mOptions.messageBoxSettings || {});
      return;
    }

    // Com painel de detalhes
    const details = mOptions.details || _extractDetails(e);
    const settings = Object.assign({
      details,
      contentWidth: mOptions.contentWidth || "640px"
    }, mOptions.messageBoxSettings || {});

    MessageBox.error(text, settings);
  }

  return {
    handle: handle
  };
});
