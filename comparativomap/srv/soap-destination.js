const soap = require('soap');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const { getDestination } = require('@sap-cloud-sdk/connectivity');
const cds = require('@sap/cds');

async function getSoapService(service, wsdl, endpoint, method = 'POST') {
  // 1) Ler config do cds.env (.cdsrc.json / package.json)
  const definition = cds.env.requires[service];
  if (!definition?.credentials?.destination) {
    throw new Error(`Destination não configurada em cds.requires['${service}'].credentials.destination`);
  }

  const destName = definition.credentials.destination;
  const destPath = definition.credentials.path || '';

  // 2) Buscar a Destination no BTP
  const dest = await getDestination({ destinationName: destName });
  console.log('[diag] destination ok?', !!dest, 'base=', dest?.url);
  if (!dest) throw new Error(`Destination '${destName}' não encontrada`);

  // 3) Montar endpoint final
  const base = dest.url.endsWith('/') ? dest.url.slice(0, -1) : dest.url;
  endpoint.url = base + destPath;

  // 4) httpClient que usa a Destination (abre túnel OnPremise, auth, etc.)
  const httpClient = {
    request: async function (url, data, callback, exheaders, exoptions) {
      try {
        const result = await executeHttpRequest(
          dest,
          { method, url, data, timeout: 300000, headers: exheaders },
          { ...exoptions, fetchCsrfToken: false }
        );
        callback(null, result, result.data);
      } catch (e) {
        callback(e);
      }
    }
  };

  // 5) Criar client SOAP pelo WSDL usando o httpClient
  const client = await soap.createClientAsync(wsdl, { httpClient });
  // (opcional) já define o endpoint aqui:
  client.setEndpoint(endpoint.url);
  return client;
}

module.exports = { getSoapService };
