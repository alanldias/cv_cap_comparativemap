const cds = require('@sap/cds');
// const soap = require('soap');
const axios = require('axios');
const { getDestination, addDestinationToRequestConfig } = require('@sap-cloud-sdk/connectivity');

/* =========================
 * CONFIG (editar aqui)
 * ========================= */
//  NÃO ALTERAR: nome da action exposta pelo serviço CAP
// const ACTION_NAME = 'consultarPedidoECC';

// // Pode alterar à vontade ↓
// const ROLE_REQUIRED     = process.env.ROLE_REQUIRED     || 'ECCOperator';
// const DESTINATION_NAME  = process.env.DESTINATION_NAME  || 'ECC_SOAP';
// const ECC_WSDL_URL      = process.env.ECC_WSDL_URL      || 'http://<host-interno>:<port>/sap/bc/srt/rfc/sap/ZWS_PO/100?wsdl';
// const SOAP_TIMEOUT_MS   = Number(process.env.SOAP_TIMEOUT_MS || 30000);

// /* =========================
//  * Helper SOAP via Destination
//  * ========================= */
// async function buildSoapHttp(jwt) {
//   const destination = await getDestination({ destinationName: DESTINATION_NAME, jwt });
//   if (!destination) throw new Error(`Destination ${DESTINATION_NAME} não encontrado`);

//   const cfg = await addDestinationToRequestConfig({}, destination);

//   const http = axios.create({
//     httpAgent : cfg.httpAgent,
//     httpsAgent: cfg.httpsAgent,
//     proxy     : false,
//     timeout   : SOAP_TIMEOUT_MS
//   });

//   const soapRequest = (requestOptions, cb) => {
//     http({
//       method : requestOptions.method || 'POST',
//       url    : requestOptions.uri || requestOptions.url,
//       headers: { ...(cfg.headers || {}), ...(requestOptions.headers || {}) },
//       data   : requestOptions.body
//     })
//       .then(res => cb(null, res, res.data))
//       .catch(err => cb(err));
//   };

//   return {
//     soapRequest,
//     wsdlHeaders: cfg.headers || {},
//     wsdlOptions: { agent: cfg.httpAgent || cfg.httpsAgent }
//   };
// }

/* =========================
 * Serviço CAP
 * ========================= */
const ARIBA_BASE_URL = process.env.ARIBA_BASE_URL
  || 'https://openapi.ariba.com/api/sourcing-event/v2/prod';
//https://api.ariba.com/v2

const ARIBA_REALM = process.env.ARIBA_REALM || '744701080-T';
const ARIBA_USER = process.env.ARIBA_USER || 'acopino.consult';
const ARIBA_PASSWORD_ADAPTER = process.env.ARIBA_PASSWORD_ADAPTER || 'ThirdPartyUser';

const ARIBA_API_KEY = process.env.ARIBA_API_KEY || 'Xd7z6z94QDcy0zzcZuy4xWQVk1i8EZuJ';
const ARIBA_BEARER_TOKEN = process.env.ARIBA_BEARER_TOKEN || '<coloque_seu_access_token_aqui>';

const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 30000);

/* =========================
 *  IMPL SERVIÇO
 * ========================= */
module.exports = cds.service.impl(function () {

  this.on('GetQuotes', async (req) => {
    const { docId } = req.data || {};
    if (!docId) return req.error(400, "Parâmetro 'docId' é obrigatório.");

    const url = `${ARIBA_BASE_URL}/events/${encodeURIComponent(docId)}/supplierBids`;

    try {
      const { data } = await axios.get(url, {
        params: {
          realm: ARIBA_REALM,
          user: ARIBA_USER,
          passwordAdapter: ARIBA_PASSWORD_ADAPTER
        },
        headers: {
          apiKey: ARIBA_API_KEY,
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ARIBA_BEARER_TOKEN}`
        },
        timeout: HTTP_TIMEOUT_MS
      });

      // 1) padroniza p/ array
      const rawArray = Array.isArray(data?.payload) ? data.payload
        : Array.isArray(data) ? data
          : (data ? [data] : []);

      // 2) helpers
      const moneyObj = (term) => {
        const mv = term?.value?.moneyValue || term?.value?.supplierValue;
        return mv ? { amount: mv.amount ?? null, currency: mv.currency ?? null } : { amount: null, currency: null };
      };

      // 3) mapeia cada registro
      const normalized = rawArray.map(row => {
        const terms = row?.item?.terms || row?.terms || [];
        const byId = Object.fromEntries(terms.filter(t => t?.fieldId).map(t => [t.fieldId, t]));

        // unit price + currency
        const unit = moneyObj(byId['PRICE']);
        const qv = byId['QUANTITY']?.value?.quantityValue;
        const ext = moneyObj(byId['EXTENDEDPRICE']);

        const ncm = byId['GITASHORTSTRINGIFZ000050']?.value?.simpleValue ?? null;   // NCM
        const mva = byId['GITABIGDECIFZ000003']?.value?.bigDecimalValue ?? null;    // MVA

        const aliquotaICMS = byId['GITABIGDECIFZ000004']?.value?.bigDecimalValue ?? null;
        const icmsApuradoAmount = moneyObj(byId['GITAMONEYIFZ000046']).amount;

        const aliquotaIPI = byId['GITABIGDECIFZ000005']?.value?.bigDecimalValue ?? null;
        const ipiApuradoAmount = moneyObj(byId['GITAMONEYIFZ000047']).amount;

        const aliquotaPIS = byId['GITABIGDECIFZ000029']?.value?.bigDecimalValue ?? null;
        const pisApuradoAmount = moneyObj(byId['GITAMONEYIFZ000048']).amount;

        const aliquotaCOFINS = byId['GITABIGDECIFZ000028']?.value?.bigDecimalValue ?? null;
        const cofinsApuradoAmount = moneyObj(byId['GITAMONEYIFZ000049']).amount;

        const aliquotaICMSInterna = byId['GITABIGDECIFZ000006']?.value?.bigDecimalValue ?? null;
        const origemMaterial = byId['GITASHORTSTRINGIFZ000153']?.value?.simpleValue ?? null;

        const plant = byId['Plant']?.value?.simpleValue ?? null;
        const itemCategory = byId['ItemCategory']?.value?.simpleValue ?? null;
        const grupoMaterias = byId['MaterialGroup']?.value?.simpleValue ?? null;
        const taxCode = byId['GITASHORTSTRINGIFZ000152']?.value?.simpleValue ?? null;

        const itemIdTop = row?.item?.itemId ?? row?.itemId ?? null;
        const materialCode = byId['MaterialCode']?.value?.simpleValue ?? null;

        return {
          // cabeçalho
          ItemId: itemIdTop,                    // certo
          itemDEscription: row?.item?.title ?? null, //certo
          quantity: qv?.amount ?? null, //certo
          unitOfMeasure: qv?.unitOfMeasureCode ?? null,//certo

          // preço unitário + moeda
          price: unit.amount,//certo
          currency: unit.currency,//certo

          // extrinsics principais
          ncm: ncm,//certo
          mva: mva,//certo
          Extrinsic_Aliquota_ICMS: aliquotaICMS,//certo
          Extrinsic_ICMS_Apurado: icmsApuradoAmount,//certo
          Extrinsic_Aliquota_IPI: aliquotaIPI,//certo
          Extrinsic_IPI_Apurado: ipiApuradoAmount,//certo
          Extrinsic_Aliquota_PIS: aliquotaPIS,//certo
          Extrinsic_PIS_Apurado: pisApuradoAmount,//certo
          Extrinsic_Aliquota_Cofins: aliquotaCOFINS,//certo
          Extrinsic_Cofins_apurado: cofinsApuradoAmount,//certo
          Extrinsic_Aliquota_ICMS_Interna: aliquotaICMSInterna,//certo
          Extrinsic_Origem_do_Material: origemMaterial,//certo

          // totals / master data
          EXTENDEDPRICE: ext.amount,//certo
          PLANT: plant,//certo
          ItemCategory: itemCategory,//certo
          IVA: taxCode,//certo

          // específicos
          MaterialCode: materialCode,//certo
          grupo_de_materias: grupoMaterias//certo
        };
      });

      return normalized;

    } catch (e) {
      const status = e.response?.status || 502;
      const msg = e.response?.data?.message || e.response?.data || e.message;
      console.error('[GetQuotes] Erro Ariba:', status, msg);
      return req.error(status, 'Falha ao consultar supplierBids no Ariba.');
    }
  });

  // (Opcional) Hooks de boas práticas — log, validações leves, etc.
  this.before('READ', 'AribaQuotes', (req) => {
    // Ex.: validar formatos, aplicar defaults, auditoria, etc.
    // console.log('READ AribaQuotes', req.query);
  });

  // this.on(ACTION_NAME, async (req) => {
  //   // Reforço de autorização
  //   if (!req.user?.is(ROLE_REQUIRED)) return req.error(403, `Sem permissão (${ROLE_REQUIRED})`);

  //   // JWT encaminhado pelo AppRouter
  //   const rawAuth = req.headers?.authorization || req.http?.req?.headers?.authorization;
  //   const jwt = rawAuth?.replace(/^Bearer\s+/i, '');
  //   if (!jwt) return req.error(401, 'JWT ausente');

  //   const { numero } = req.data;
  //   if (!numero) return req.error(400, "Parâmetro 'numero' é obrigatório");

  //   try {
  //     // 1) Client SOAP usando Destination
  //     const { soapRequest, wsdlHeaders, wsdlOptions } = await buildSoapHttp(jwt);
  //     const client = await soap.createClientAsync(ECC_WSDL_URL, {
  //       request      : soapRequest,
  //       wsdl_headers : wsdlHeaders,
  //       wsdl_options : wsdlOptions,
  //       timeout      : SOAP_TIMEOUT_MS
  //     });

  //     // 2) Ajuste para a operação real do  WSDL + parametro
  //     // Ex.: Z_GET_PO_DETAIL(EBELN)+Async
  //     const [resp] = await client.Z_GET_PO_DETAILAsync({ EBELN: String(numero) });

  //     // 3) Normalização comum
  //     // pega o nome da função gerada pelo node-soap com o nome do WSDL
  //     // algum serviços retornam objeto dentro do response outros jogam tudo no resp
  //     const payload = resp?.Z_GET_PO_DETAILResponse || resp;
  //     // tenta achar e padronizar o resultado se não achar fica o nome que veio mesmo
  //     const header =
  //       payload?.POHEADER ||
  //       payload?.PO_HEADER ||
  //       payload?.E_PO_HEADER ||
  //       payload?.E_HEADER ||
  //       payload;
  //    // helper que pega o primiero campo valido entre sinonimos
  //    //Ex.: pick(header, 'DOC_TYPE', 'BSART') → retorna DOC_TYPE se existir; se não, tenta BSART.
  //     const pick = (obj, ...keys) => {
  //       for (const k of keys) {
  //         const v = obj?.[k];
  //         if (v !== undefined && v !== null && String(v).trim() !== '') return String(v);
  //       }
  //       return null;

  //     };

  //     // 4) Retornar APENAS os campos pedidos
  //     //No fim usa pick(...) pra montar o objeto só com:
  //     //DOC_TYPE, PURCH_ORG, PUR_GROUP, COMP_CODE, INCOTERMS1, INCOTERMS2, PMNTTRMS.
  //     return {
  //       DOC_TYPE   : pick(header, 'DOC_TYPE', 'BSART'),
  //       PURCH_ORG  : pick(header, 'PURCH_ORG', 'EKORG'),
  //       PUR_GROUP  : pick(header, 'PUR_GROUP', 'EKGRP'),
  //       COMP_CODE  : pick(header, 'COMP_CODE', 'BUKRS'),
  //       INCOTERMS1 : pick(header, 'INCOTERMS1', 'INCO1'),
  //       INCOTERMS2 : pick(header, 'INCOTERMS2', 'INCO2'),
  //       PMNTTRMS   : pick(header, 'PMNTTRMS', 'ZTERM')
  //     };

  //   } catch (err) {
  //     console.error('[ECC SOAP] erro:', err?.response?.status, err?.message);
  //     return req.error(502, `Falha na chamada SOAP ECC: ${err.message}`);
  //   }
  // });

});
