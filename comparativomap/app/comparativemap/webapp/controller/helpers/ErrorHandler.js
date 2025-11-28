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
    
    // 🟢 CORREÇÃO: Define a variável 'lower' aqui para usar mais abaixo
    const lower = msgOriginal.toLowerCase();

    // --- 1. DETECÇÃO DE FALHA DE INFRAESTRUTURA / CONEXÃO (PRODUÇÃO & LOCAL) ---
    // Palavras-chave que indicam que o SAP/BAPI está inacessível
    const isConnectionError = 
        msgOriginal.includes("Could not find service binding") || // Erro local/config
        msgOriginal.includes("destination service is not bound") || // Erro local/config
        msgOriginal.includes("Bad Gateway") ||  // Erro 502 (Cloud Connector off)
        msgOriginal.includes("502") ||          // Erro 502 (Generico)
        msgOriginal.includes("504") ||          // Erro 504 (Timeout/Lentidão)
        msgOriginal.includes("500") ||
        msgOriginal.includes("NetworkError") || // Queda de internet
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
                details: "Erro Técnico Original:\n" + msgOriginal // Opcional: para o suporte ver o erro real
            }
        );
        return;
    }
    // -----------------------------------------------------------------------------

    // --- 2. TRATAMENTO DE SESSÃO EXPIRADA (RELOAD OBRIGATÓRIO) ---
    const isSessionExpired = 
        lower.includes("$batch failed") ||           
        lower.includes("401") ||                      
        msgOriginal.includes("Unauthorized") ||       
        msgOriginal.includes("Could not load metadata"); 

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
    
    // Lista de palavras ou símbolos que indicam "Erro de Negócio" (Dados, Validação, etc)
    const isBusinessError = msgOriginal.includes("⚠️") || 
                            msgOriginal.includes("TaxCode") || 
                            msgOriginal.includes("•");

    // Verifica erros técnicos (Stack trace, JSON...)
    const pareceErroTecnico = !isBusinessError && (
                              msgOriginal.includes("Error:") || 
                              msgOriginal.includes("{") || 
                              msgOriginal.length > 300);

    let text = "";

    if (isBusinessError) {
       // Limpeza visual
       let msgLimpa = msgOriginal
           .replace(/MAT=/g, "Material: ")
           .replace(/Plant=/g, "Centro: ")
           .replace(/POrg=/g, "Org: ")
           .replace(/Supplier=/g, "Fornecedor: ")
           .replace(/\|/g, "   "); 

       // Monta o texto final
       text = sContextMsg ? `${sContextMsg}\n\n${msgLimpa}` : msgLimpa;
    } 
    else if (pareceErroTecnico) {
       const prefixo = sContextMsg ? sContextMsg + ".\n\n" : "Falha ao executar a operação.\n\n";
       text = prefixo + "Detalhes técnicos: " + msgOriginal;
    } 
    else {
       text = sContextMsg ? `${sContextMsg}\n\n${msgOriginal}` : msgOriginal;
    }

    // Exibe
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