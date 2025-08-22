const cds  = require('@sap/cds');
const soap = require('soap');
const axios = require('axios');
const { getDestination, addDestinationToRequestConfig } = require('@sap-cloud-sdk/connectivity');

/* =========================
 * Serviço CAP
 * ========================= */
module.exports = cds.service.impl(function () {
  const { AribaQuotes } = this.entities;

  // Function import "GetQuotes" - consulta por parâmetros (docId, supplierId, lineNumber)
  this.on('GetQuotes', async (req) => {
    const { docId, supplierId, lineNumber } = req.data;

    // Monta SELECT dinâmico com AND implícito
    let q = SELECT.from(AribaQuotes);
    const where = {};

    if (docId) where.docId = docId;
    if (supplierId) where.supplierId = supplierId;

    if (lineNumber !== undefined && lineNumber !== null) {
      const n = Number(lineNumber);
      if (Number.isNaN(n)) return req.reject(400, 'lineNumber inválido');
      where.lineNumber = n;
    }

    if (Object.keys(where).length) q = q.where(where);
    return await cds.run(q);
  });

  // (Opcional) Hooks de boas práticas — log, validações leves, etc.
  this.before('READ', 'AribaQuotes', (req) => {
    // Ex.: validar formatos, aplicar defaults, auditoria, etc.
    // console.log('READ AribaQuotes', req.query);
  });

  ///////////////////////////////////  ///////////////////////////////////  ///////////////////////////////////  ///////////////////////////////////
/**
 * Versão minimalista (WSDL conhecido):
 * - Operação única: Z_GET_PO_DETAIL
 * - Request: { EBELN }
 * - Response: { Z_GET_PO_DETAILResponse: { E_HEADER:{...}, E_ITEMS:[...] } }
 * - Retorna MESMO array + campos extras, preservando ordem/tamanho.
 */
/* =========================
 * CONFIG
 * ========================= */
const ACTION_NAME       = process.env.CAP_ACTION       || 'consultarPedidoECC'; // action no .cds
const ROLE_REQUIRED     = process.env.ROLE_REQUIRED    || 'ECCOperator';
const DESTINATION_NAME  = process.env.DESTINATION_NAME || 'ECC_SOAP';
const ECC_WSDL_URL      = process.env.ECC_WSDL_URL     || 'http://<host>:<port>/sap/bc/srt/rfc/sap/ZWS_PO/100?wsdl';
const SOAP_TIMEOUT_MS   = Number(process.env.SOAP_TIMEOUT_MS || 30000);

/** Operação fixa (mundo ideal) */
const DEFAULT_OP         = 'Z_GET_PO_DETAIL';
const METHOD_NAME_ASYNC  = `${DEFAULT_OP}Async`;

/* =========================
 * FLAGS DE COMPORTAMENTO
 * ========================= */
// STRICT_MATCH_DOCID
// true  → garante consistência: o EBELN (docId) do header da BAPI TEM que ser igual ao que foi enviado.
// false → não valida essa igualdade (usa o que a BAPI devolver).
const STRICT_MATCH_DOCID   = true;   
// REQUIRE_PROD_IF_SENT
// true  → se o input veio com `produto`, esse produto PRECISA existir na lista de itens retornados; senão marca erro no item.
// false → se não achar o produto, segue com o primeiro item retornado (não erra).
const REQUIRE_PROD_IF_SENT = true;  
// ERROR_FILL_VALUE
// Valor usado para preencher os campos "extras" quando ocorre erro no item.
// Coloque 'ERRO' para ficar visual no front, ou `null` se preferir campos vazios.
const ERROR_FILL_VALUE     = 'ERRO';
// EXTRA_FIELDS
// Lista dos campos "extras" que enriquecemos no sucesso.
// Quando dá erro, esses campos são preenchidos com ERROR_FILL_VALUE para manter o mesmo shape no retorno.
const EXTRA_FIELDS = [
  'docType','org','group','company','incoterm1','incoterm2','pagamento','moeda','precoTotal',
  'produtoRet','unidadeRet','precoUnitario','quantidade'
];

/* =========================
 * Transporte SOAP via Destination
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

  // Função de request que o node-soap usa
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
  this.on(ACTION_NAME, async (req) => {
    // 1) Segurança
    if (!req.user?.is(ROLE_REQUIRED)) return req.error(403, `Sem permissão (${ROLE_REQUIRED})`);

    const rawAuth = req.headers?.authorization || req.http?.req?.headers?.authorization;
    const jwt = rawAuth?.replace(/^Bearer\s+/i, '');
    if (!jwt) return req.error(401, 'JWT ausente');

    // 2) Entrada esperada: { itens: [ { docId, produto?, unidade? }, ... ] }
    const { itens } = req.data || {};
    if (!Array.isArray(itens) || itens.length === 0) {
      return req.error(400, "Parâmetro 'itens' (array) é obrigatório");
    }

    // 3) Client SOAP (cria 1x)
    let client;
    try {
      const { soapRequest, wsdlHeaders, wsdlOptions } = await buildSoapHttp(jwt);
      client = await soap.createClientAsync(ECC_WSDL_URL, {
        request      : soapRequest,
        wsdl_headers : wsdlHeaders,
        wsdl_options : wsdlOptions,
        timeout      : SOAP_TIMEOUT_MS
      });
    } catch (err) {
      console.error('[ECC SOAP] falha criando client:', err?.message);
      return req.error(502, `Falha criando client SOAP: ${err.message}`);
    }

    // 4) Processamento sequencial (BAPI 1 por vez)
    const results = [];

    for (let index = 0; index < itens.length; index++) {
      const input   = itens[index];
      const baseOut = { ...input, _index: index, _status: 'ERROR', _errors: [] };

      // helper para montar saída de erro, mantendo shape e preenchendo extras
      const asError = (codes) => {
        const out = { ...baseOut, _errors: Array.isArray(codes) ? codes : [codes] };
        for (const f of EXTRA_FIELDS) out[f] = ERROR_FILL_VALUE;
        return out;
      };

      // Validação mínima (garante 1 resposta por item)
      if (!input || (!input.docId && !input.numero)) {
        results.push(asError('DOC_ID_AUSENTE'));
        continue;
      }

      try {
        const methodAsync = client?.[METHOD_NAME_ASYNC]; // ex.: Z_GET_PO_DETAILAsync
        if (typeof methodAsync !== 'function') {
          results.push(asError(`OPERACAO_INEXISTENTE:${DEFAULT_OP}`));
          continue;
        }

        // ===== CHAMADA DA BAPI =====
        const EBELN = String(input.docId || input.numero);
        const [rawResp] = await methodAsync({ EBELN });

        // ===== Mapeamento direto (WSDL estável) =====
        const resp    = rawResp?.Z_GET_PO_DETAILResponse || rawResp;
        const header  = resp?.E_HEADER || {};
        // Coerção leve para array (se vier um único item "nu", embrulha)
        const itensRetRaw = resp?.E_ITEMS;
        const itensRet = Array.isArray(itensRetRaw)
          ? itensRetRaw
          : (itensRetRaw ? [itensRetRaw] : []);

        // Valida docId bateu (opcional via flag)
        if (STRICT_MATCH_DOCID && header.EBELN && String(header.EBELN) !== EBELN) {
          results.push(asError('DOC_ID_DIVERGENTE'));
          continue;
        }

        // Precisa ter itens
        if (!itensRet.length) {
          results.push(asError('SEM_ITENS_NO_PEDIDO'));
          continue;
        }

        // Seleciona item para enriquecer: se input trouxe produto e flag exige, ele deve existir
        let itemSel = itensRet[0];
        if (input.produto) {
          const found = itensRet.find(it => String(it?.MATNR) === String(input.produto));
          if (found) itemSel = found;
          else if (REQUIRE_PROD_IF_SENT) {
            results.push(asError('PRODUTO_NAO_ENCONTRADO_NA_BAPI'));
            continue;
          }
        }

        // ===== Enriquecimento (mesmo item + extras) =====
        const enriched = {
          ...input,
          // header
          docId        : EBELN,
          docType      : header.BSART ?? null,
          org          : header.EKORG ?? null,
          group        : header.EKGRP ?? null,
          company      : header.BUKRS ?? null,
          incoterm1    : header.INCO1 ?? null,
          incoterm2    : header.INCO2 ?? null,
          pagamento    : header.ZTERM ?? null,
          moeda        : header.WAERS ?? null,
          precoTotal   : header.NETWR ?? null,
          // item
          produtoRet    : itemSel.MATNR ?? null,
          unidadeRet    : itemSel.MEINS ?? null,
          precoUnitario : itemSel.NETPR ?? null,
          quantidade    : itemSel.MENGE ?? null,
          // controle
          _index   : index,
          _status  : 'OK',
          _errors  : []
        };

        results.push(enriched);

      } catch (err) {
        console.error(`[ECC SOAP][item ${index}]`, err?.response?.status, err?.message);
        results.push(asError(`SOAP_FAIL:${err.message}`));
      }
    }

    // 5) Mesmo tamanho/ordem do input; cada item com _status/_errors
    return results;
  });

});

