sap.ui.define([
  "sap/m/MessageBox"
], function (MessageBox) {
  "use strict";

  function _getOriginalMessage(e) {
    if (e && e.message) return String(e.message);
    return String(e || "");
  }

  function _extractDetails(e) {
    return e?.cause?.response?.body ||
      e?.cause?.message ||
      e?.stack ||
      (typeof e === "object" ? JSON.stringify(e, null, 2) : String(e));
  }

  function handle(e, sContextMsg, mOptions) {
    mOptions = mOptions || {};

    /* eslint-disable no-console */
    console.error(sContextMsg || "Erro na aplicação:", e);

    const msgOriginal = _getOriginalMessage(e);
    const lower = msgOriginal.toLowerCase();

    // 👇 tenta descobrir o status HTTP real
    const statusCode =
      e?.statusCode ||
      e?.httpStatusCode ||
      e?.cause?.status ||
      e?.cause?.statusCode ||
      e?.cause?.response?.statusCode;

    // -------------------------------------------------------------------------
    // 0. ERRO DE AUTORIZAÇÃO (403 / FORBIDDEN / ROLE)
    // -------------------------------------------------------------------------
    const isForbidden =
      statusCode === 403 ||
      lower.includes("forbidden") ||
      lower.includes("insufficient scope") ||
      lower.includes("missing authorization") ||
      lower.includes("not authorized");

    if (isForbidden) {
      // mensagem amigável pro usuário
      const textoUsuario =
        "Você não tem permissão para acessar esta funcionalidade.\n\n" +
        "Se você precisa desse acesso, entre em contato com o suporte " +
        "ou com o responsável pelo sistema informando a role necessária.";

      const detalhesTecnicos =
        mOptions.details ||
        _extractDetails(e) ||
        `Erro técnico original: ${msgOriginal}`;

      MessageBox.error(textoUsuario, {
        title: "Acesso não permitido",
        details: detalhesTecnicos,      // 👈 aqui aparece o Forbidden / 403
        contentWidth: "640px"
      });
      return;
    }

    // --- 1. DETECÇÃO DE FALHA DE INFRAESTRUTURA / CONEXÃO (PRODUÇÃO & LOCAL) ---
    const isConnectionError = 
        msgOriginal.includes("Could not find service binding") ||
        msgOriginal.includes("destination service is not bound") ||
        msgOriginal.includes("Bad Gateway") ||
        msgOriginal.includes("502") ||
        msgOriginal.includes("504") ||
        msgOriginal.includes("500") ||
        msgOriginal.includes("NetworkError") ||
        msgOriginal.includes("Failed to fetch") ||
        msgOriginal.includes("Connection refused");

    if (isConnectionError) {
        MessageBox.error(
            "Falha de Comunicação com o Sistema SAP\n\n" +
            "Não foi possível conectar ao servidor backend.\n" +
            "Possíveis causas:\n" +
            "• O sistema SAP ECC/S4 está indisponível no momento.\n" +
            "• Falha na conexão de rede ou VPN (Cloud Connector).\n" +
            "• Erro de configuração no ambiente (Destination).\n\n" +
            "Por favor, tente novamente em alguns instantes ou contate o suporte de TI.",
            { 
                title: "Sistema Indisponível",
                details: "Erro Técnico Original:\n" + msgOriginal
            }
        );
        return;
    }

    // --- 2. TRATAMENTO DE SESSÃO EXPIRADA (RELOAD OBRIGATÓRIO) ---
    const isSessionExpired = 
        lower.includes("$batch failed") ||
        String(statusCode) === "401" ||
        lower.includes("unauthorized") ||
        lower.includes("could not load metadata");

    if (isSessionExpired) {
      MessageBox.warning(
        "Sua sessão expirou por inatividade.\n\n" +
        "Para continuar, é necessário recarregar a aplicação.",
        { 
            title: "Sessão Expirada",
            actions: [MessageBox.Action.OK],
            onClose: () => location.reload() 
        }
      );
      return;
    }

    // --- 3. MENSAGENS LIMPAS (VALIDAÇÕES DE NEGÓCIO) ---
    const isBusinessError = msgOriginal.includes("⚠️") || 
                            msgOriginal.includes("TaxCode") || 
                            msgOriginal.includes("•");

    const pareceErroTecnico = !isBusinessError && (
                              msgOriginal.includes("Error:") || 
                              msgOriginal.includes("{") || 
                              msgOriginal.length > 300);

    let text = "";

    if (isBusinessError) {
       let msgLimpa = msgOriginal
           .replace(/MAT=/g, "Material: ")
           .replace(/Plant=/g, "Centro: ")
           .replace(/POrg=/g, "Org: ")
           .replace(/Supplier=/g, "Fornecedor: ")
           .replace(/\|/g, "   "); 

       text = sContextMsg ? `${sContextMsg}\n\n${msgLimpa}` : msgLimpa;
    } 
    else if (pareceErroTecnico) {
       const prefixo = sContextMsg ? sContextMsg + ".\n\n" : "Falha ao executar a operação.\n\n";
       text = prefixo + "Detalhes técnicos: " + msgOriginal;
    } 
    else {
       text = sContextMsg ? `${sContextMsg}\n\n${msgOriginal}` : msgOriginal;
    }

    if (!mOptions.showDetailsPanel) {
      MessageBox.error(text, mOptions.messageBoxSettings || {});
      return;
    }

    const details = mOptions.details || _extractDetails(e);
    const settings = Object.assign({
      details,
      contentWidth: mOptions.contentWidth || "640px"
    }, mOptions.messageBoxSettings || {});

    MessageBox.error(text, settings);
  }

  return { handle: handle };
});
