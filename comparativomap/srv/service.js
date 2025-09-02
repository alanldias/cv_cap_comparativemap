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

const ARIBA_REALM = process.env.ARIBA_REALM || '';
const ARIBA_USER = process.env.ARIBA_USER || 'acopino.consult';
const ARIBA_PASSWORD_ADAPTER = process.env.ARIBA_PASSWORD_ADAPTER || '';

const ARIBA_API_KEY = process.env.ARIBA_API_KEY || '';
const ARIBA_BEARER_TOKEN = process.env.ARIBA_BEARER_TOKEN || '';

const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 30000);

/* =========================
 *  IMPL SERVIÇO
 * ========================= */
module.exports = cds.service.impl(function () {

  this.on('GetQuotes', async (req) => {
    const { docId, onlyParentProjectId  } = req.data || {};
    if (!docId) return req.error(400, "Parâmetro 'docId' é obrigatório.");

    const url = `${ARIBA_BASE_URL}/events/${encodeURIComponent(docId)}/supplierBids`;

    try {
      const { data } = await axios.get(url, {
        params: { realm: ARIBA_REALM, user: ARIBA_USER, passwordAdapter: ARIBA_PASSWORD_ADAPTER },
        headers: { apiKey: ARIBA_API_KEY, 'Content-Type': 'application/json', Authorization: `Bearer ${ARIBA_BEARER_TOKEN}` },
        timeout: HTTP_TIMEOUT_MS
      });


      // Padroniza p/ array
      const rows = Array.isArray(data?.payload) ? data.payload
        : Array.isArray(data) ? data
          : (data ? [data] : []);

      if (!rows.length) return [];

      // 1) Junta todas as listas de itemsWithBid que existirem no payload
      const itemsWithBid = [...new Set(
        rows.flatMap(r => Array.isArray(r?.itemsWithBid) ? r.itemsWithBid : [])
      )].map(String); // garante string

      // 2) Decide qual itemId abrir
      const chosenItemId =
        itemsWithBid[0] ||
        // fallbacks:
        (rows.find(r => r?.bidRank === 1)?.item?.itemId ?? rows.find(r => r?.bidRank === 1)?.itemId) ||
        (rows[0]?.item?.itemId ?? rows[0]?.itemId);

      if (!chosenItemId) {
        return req.error(404, `Não foi possível determinar um itemId alvo para o evento ${docId}.`);
      }

      // 3) Encontra a linha do item escolhido
      const targetRow = rows.find(r => String(r?.item?.itemId ?? r?.itemId) === String(chosenItemId));
      if (!targetRow) {
        return req.error(404, `ItemId ${chosenItemId} não encontrado no evento ${docId}.`);
      }

      // --- Helpers ---
      const termsFrom = (row) => (row?.item?.terms || row?.terms || []);
      const byFieldId = (row) =>
        Object.fromEntries(termsFrom(row).filter(t => t?.fieldId).map(t => [t.fieldId, t]));

      const moneyObj = (term) => {
        const mv = term?.value?.moneyValue || term?.value?.supplierValue;
        return mv ? { amount: mv.amount ?? null, currency: mv.currency ?? null }
          : { amount: null, currency: null };
      };

      // 4) Extrai valores do item alvo
      const byId = byFieldId(targetRow);

      const unit = moneyObj(byId['PRICE']);
      const qv = byId['QUANTITY']?.value?.quantityValue;
      const ext = moneyObj(byId['EXTENDEDPRICE']);

      const ncm = byId['GITASHORTSTRINGIFZ000050']?.value?.simpleValue ?? null;
      const mva = byId['GITABIGDECIFZ000003']?.value?.bigDecimalValue ?? null;

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
      const materialCode = byId['MaterialCode']?.value?.simpleValue ?? null;

      const result = {
        // Cabeçalho
        ItemId: targetRow?.item?.itemId ?? targetRow?.itemId ?? null,
        itemDescription: targetRow?.item?.title ?? null,

        // Quantidade / UoM
        quantity: qv?.amount ?? null,
        unitOfMeasure: qv?.unitOfMeasureCode ?? null,

        // Preço unitário + moeda
        price: unit.amount,
        currency: unit.currency,

        // Extrinsics principais
        ncm, mva,
        Extrinsic_Aliquota_ICMS: aliquotaICMS,
        Extrinsic_ICMS_Apurado: icmsApuradoAmount,
        Extrinsic_Aliquota_IPI: aliquotaIPI,
        Extrinsic_IPI_Apurado: ipiApuradoAmount,
        Extrinsic_Aliquota_PIS: aliquotaPIS,
        Extrinsic_PIS_Apurado: pisApuradoAmount,
        Extrinsic_Aliquota_Cofins: aliquotaCOFINS,
        Extrinsic_Cofins_apurado: cofinsApuradoAmount,
        Extrinsic_Aliquota_ICMS_Interna: aliquotaICMSInterna,
        Extrinsic_Origem_do_Material: origemMaterial,

        // Totais / dados mestre
        EXTENDEDPRICE: ext.amount,
        PLANT: plant,
        ItemCategory: itemCategory,
        TAX_CODE: taxCode,
        MaterialCode: materialCode,
        grupo_de_materias: grupoMaterias
      };

      let parentProjectId = null;
      try {
        parentProjectId = await fetchParentProjectId(docId);
      } catch (err) {
        console.warn('[GetQuotes] identifiers falhou:', err?.response?.status, err?.response?.data || err.message);
      }

      if (onlyParentProjectId) {
        if (!parentProjectId) return req.error(404, `parentProjectId não encontrado para ${docId}.`);
        return { parentProjectId };
      }

      console.log(parentProjectId)

      return [{ ...result, parentProjectId }];

    } catch (e) {
      const status = e.response?.status || 502;
      const msg = e.response?.data?.message || e.response?.data || e.message;
      console.error('[GetQuotes] Erro Ariba:', status, msg);
      return req.error(status, 'Falha ao consultar supplierBids no Ariba.');
    }
  });

  async function fetchParentProjectId(docId) {
    const url = `${ARIBA_BASE_URL}/events/identifiers`;

    const params = {
      realm: ARIBA_REALM,
      user: ARIBA_USER,
      passwordAdapter: ARIBA_PASSWORD_ADAPTER,
      // filtro pedido (puxa tudo no período)
      $filter: '(createDateFrom gt 01082025000000 and createDateTo lt 31122025000000)',
    };

    const { data } = await axios.get(url, {
      params,
      headers: {
        apiKey: ARIBA_API_KEY,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ARIBA_BEARER_TOKEN}`,
      },
      timeout: HTTP_TIMEOUT_MS,
    });

    // padroniza p/ array
    const arr = Array.isArray(data?.payload) ? data.payload
      : Array.isArray(data) ? data
        : (data ? [data] : []);

    // encontra o mesmo internalId == docId
    const row = arr.find(x => String(x?.internalId) === String(docId));

    return row?.parentProjectId ?? null;
  }

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
