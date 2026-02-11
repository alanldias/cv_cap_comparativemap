sap.ui.define([
  "sap/m/MessageBox"
], function (MessageBox) {
  "use strict";

  function _getOriginalMessage(e) { // sempre tenta cair numa string útil pro usuário/log
    if (e && e.message) return String(e.message);
    return String(e || "");
  }

  function _extractDetails(e) { // painel técnico (prioriza body/stack/obj json)
    return e?.cause?.response?.body ||
      e?.cause?.message ||
      e?.stack ||
      (typeof e === "object" ? JSON.stringify(e, null, 2) : String(e));
  }

  function _getHttpStatus(e) { // tenta descobrir status em formatos diferentes (axios/odata/fetch/etc.)
    return e?.statusCode ||
      e?.httpStatusCode ||
      e?.cause?.status ||
      e?.cause?.statusCode ||
      e?.cause?.response?.statusCode ||
      e?.cause?.response?.status;
  }

  function _isForbidden(statusCode, lower) { // 403 / forbidden / missing role/scope
    return statusCode === 403 ||
      lower.includes("forbidden") ||
      lower.includes("insufficient scope") ||
      lower.includes("missing authorization") ||
      lower.includes("not authorized");
  }

  function _isConnectionError(msgOriginal) { // infra/destination/vpn/backend down
    return msgOriginal.includes("Could not find service binding") ||
      msgOriginal.includes("destination service is not bound") ||
      msgOriginal.includes("Bad Gateway") ||
      msgOriginal.includes("502") ||
      msgOriginal.includes("504") ||
      msgOriginal.includes("500") ||
      msgOriginal.includes("NetworkError") ||
      msgOriginal.includes("Failed to fetch") ||
      msgOriginal.includes("Connection refused");
  }

  function _isSessionExpired(statusCode, lower) { // metadata/batch/401 -> recarregar
    return lower.includes("$batch failed") ||
      String(statusCode) === "401" ||
      lower.includes("unauthorized") ||
      lower.includes("could not load metadata");
  }

  function _isBusinessError(msgOriginal) { // heurística: mensagens “limpas” vindas do backend (validação)
    return msgOriginal.includes("⚠️") ||
      msgOriginal.includes("TaxCode") ||
      msgOriginal.includes("•");
  }

  function _looksTechnical(msgOriginal, isBusinessError) { // grande/JSON/stack -> tratamos como técnico
    return !isBusinessError && (
      msgOriginal.includes("Error:") ||
      msgOriginal.includes("{") ||
      msgOriginal.length > 300
    );
  }

  function _prettifyBusinessMessage(msgOriginal) { // deixa msgs de validação mais legíveis no UI
    return msgOriginal
      .replace(/MAT=/g, "Material: ")
      .replace(/Plant=/g, "Centro: ")
      .replace(/POrg=/g, "Org: ")
      .replace(/Supplier=/g, "Fornecedor: ")
      .replace(/\|/g, "   ");
  }

  function handle(e, sContextMsg, mOptions) {
    mOptions = mOptions || {};

    console.error(sContextMsg || "Erro na aplicação:", e);

    const msgOriginal = _getOriginalMessage(e);
    const lower = msgOriginal.toLowerCase();
    const statusCode = _getHttpStatus(e);

    if (_isForbidden(statusCode, lower)) { // 403 / sem role
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
        details: detalhesTecnicos,
        contentWidth: "640px"
      });
      return;
    }

    if (_isConnectionError(msgOriginal)) { // destino/vpn/backend indisponível
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

    if (_isSessionExpired(statusCode, lower)) { // sessão/metadata/batch
      MessageBox.warning(
        "Sua sessão expirou por inatividade.\n\n" +
        "Para continuar, é necessário recarregar a aplicação.",
        {
          title: "Sessão Expirada",
          actions: [MessageBox.Action.OK],
          onClose: function () { location.reload(); }
        }
      );
      return;
    }

    const isBusinessError = _isBusinessError(msgOriginal);
    const pareceErroTecnico = _looksTechnical(msgOriginal, isBusinessError);

    let text = "";
    if (isBusinessError) { // erro de regra/validação (mostrar limpo)
      const msgLimpa = _prettifyBusinessMessage(msgOriginal);
      text = sContextMsg ? `${sContextMsg}\n\n${msgLimpa}` : msgLimpa;
    } else if (pareceErroTecnico) { // erro técnico “cru”
      const prefixo = sContextMsg ? sContextMsg + ".\n\n" : "Falha ao executar a operação.\n\n";
      text = prefixo + "Detalhes técnicos: " + msgOriginal;
    } else { // erro “normal”
      text = sContextMsg ? `${sContextMsg}\n\n${msgOriginal}` : msgOriginal;
    }

    if (!mOptions.showDetailsPanel) { // modo simples (sem painel de detalhes)
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
