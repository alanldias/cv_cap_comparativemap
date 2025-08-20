const cds  = require('@sap/cds');
const soap = require('soap');
const axios = require('axios');
const { getDestination, addDestinationToRequestConfig } = require('@sap-cloud-sdk/connectivity');

/* =========================
 * CONFIG (editar aqui)
 * ========================= */
//  NÃO ALTERAR: nome da action exposta pelo serviço CAP
const ACTION_NAME = 'consultarPedidoECC';

// Pode alterar à vontade ↓
const ROLE_REQUIRED     = process.env.ROLE_REQUIRED     || 'ECCOperator';
const DESTINATION_NAME  = process.env.DESTINATION_NAME  || 'ECC_SOAP';
const ECC_WSDL_URL      = process.env.ECC_WSDL_URL      || 'http://<host-interno>:<port>/sap/bc/srt/rfc/sap/ZWS_PO/100?wsdl';
const SOAP_TIMEOUT_MS   = Number(process.env.SOAP_TIMEOUT_MS || 30000);

/* =========================
 * Helper SOAP via Destination
 * ========================= */
async function buildSoapHttp(jwt) {
  const destination = await getDestination({ destinationName: DESTINATION_NAME, jwt });
  if (!destination) throw new Error(`Destination ${DESTINATION_NAME} não encontrado`);

  const cfg = await addDestinationToRequestConfig({}, destination);

  const http = axios.create({
    httpAgent : cfg.httpAgent,
    httpsAgent: cfg.httpsAgent,
    proxy     : false,
    timeout   : SOAP_TIMEOUT_MS
  });

  const soapRequest = (requestOptions, cb) => {
    http({
      method : requestOptions.method || 'POST',
      url    : requestOptions.uri || requestOptions.url,
      headers: { ...(cfg.headers || {}), ...(requestOptions.headers || {}) },
      data   : requestOptions.body
    })
      .then(res => cb(null, res, res.data))
      .catch(err => cb(err));
  };

  return {
    soapRequest,
    wsdlHeaders: cfg.headers || {},
    wsdlOptions: { agent: cfg.httpAgent || cfg.httpsAgent }
  };
}

/* =========================
 * Serviço CAP
 * ========================= */
module.exports = cds.service.impl(function () {

  this.on(ACTION_NAME, async (req) => {
    // Reforço de autorização
    if (!req.user?.is(ROLE_REQUIRED)) return req.error(403, `Sem permissão (${ROLE_REQUIRED})`);

    // JWT encaminhado pelo AppRouter
    const rawAuth = req.headers?.authorization || req.http?.req?.headers?.authorization;
    const jwt = rawAuth?.replace(/^Bearer\s+/i, '');
    if (!jwt) return req.error(401, 'JWT ausente');

    const { numero } = req.data;
    if (!numero) return req.error(400, "Parâmetro 'numero' é obrigatório");

    try {
      // 1) Client SOAP usando Destination
      const { soapRequest, wsdlHeaders, wsdlOptions } = await buildSoapHttp(jwt);
      const client = await soap.createClientAsync(ECC_WSDL_URL, {
        request      : soapRequest,
        wsdl_headers : wsdlHeaders,
        wsdl_options : wsdlOptions,
        timeout      : SOAP_TIMEOUT_MS
      });

      // 2) Ajuste para a operação real do seu WSDL
      // Ex.: Z_GET_PO_DETAIL(EBELN)+Async
      const [resp] = await client.Z_GET_PO_DETAILAsync({ EBELN: String(numero) });

      // 3) Normalização comum
      const payload = resp?.Z_GET_PO_DETAILResponse || resp;
      const header =
        payload?.POHEADER ||
        payload?.PO_HEADER ||
        payload?.E_PO_HEADER ||
        payload?.E_HEADER ||
        payload;

      const pick = (obj, ...keys) => {
        for (const k of keys) {
          const v = obj?.[k];
          if (v !== undefined && v !== null && String(v).trim() !== '') return String(v);
        }
        return null;
      };

      // 4) Retornar APENAS os campos pedidos
      return {
        DOC_TYPE   : pick(header, 'DOC_TYPE', 'BSART'),
        PURCH_ORG  : pick(header, 'PURCH_ORG', 'EKORG'),
        PUR_GROUP  : pick(header, 'PUR_GROUP', 'EKGRP'),
        COMP_CODE  : pick(header, 'COMP_CODE', 'BUKRS'),
        INCOTERMS1 : pick(header, 'INCOTERMS1', 'INCO1'),
        INCOTERMS2 : pick(header, 'INCOTERMS2', 'INCO2'),
        PMNTTRMS   : pick(header, 'PMNTTRMS', 'ZTERM')
      };

    } catch (err) {
      console.error('[ECC SOAP] erro:', err?.response?.status, err?.message);
      return req.error(502, `Falha na chamada SOAP ECC: ${err.message}`);
    }
  });

});
