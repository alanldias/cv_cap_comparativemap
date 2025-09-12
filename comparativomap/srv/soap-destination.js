const soap = require('soap');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const { getDestination } = require('@sap-cloud-sdk/connectivity');
const cds = require('@sap/cds');

// helper para esconder segredos nos logs
function redact(obj) {
  if (!obj) return obj;
  const clone = JSON.parse(JSON.stringify(obj));
  if (clone?.username) clone.username = '***';
  if (clone?.password) clone.password = '***';
  if (clone?.authTokens) clone.authTokens = '***';
  return clone;
}

async function getSoapService(service, wsdl, endpoint, method = 'POST') {
  console.log('[getSoapService] ENTER', { service, wsdl });

  // 1) Ler config do cds.env (.cdsrc.json / package.json)
  const definition = cds.env.requires[service];
  console.log('[getSoapService] cds.requires[service]=', redact(definition));

  if (!definition?.credentials?.destination) {
    throw new Error(`Destination não configurada em cds.requires['${service}'].credentials.destination`);
  }

  const destName = definition.credentials.destination;
  const destPath = definition.credentials.path || '';

  // 2) Buscar a Destination no BTP (ou env local)
  console.time('[getSoapService] getDestination');
  let dest;
  try {
    console.log('[getSoapService] getDestination START', { destName });
    dest = await getDestination({ destinationName: destName });
    console.log('[getSoapService] getDestination OK?', !!dest, 'base=', dest?.url);
  } catch (e) {
    console.error('[getSoapService] getDestination ERROR:', e?.message || e);
    throw e;
  } finally {
    console.timeEnd('[getSoapService] getDestination');
  }
  if (!dest) throw new Error(`Destination '${destName}' não encontrada`);

  // 3) Montar endpoint final
  const base = dest.url.endsWith('/') ? dest.url.slice(0, -1) : dest.url;
  endpoint.url = base + destPath;
  console.log('[getSoapService] endpoint.url =', endpoint.url);

  // 4) httpClient que usa a Destination (túnel, auth, etc.)
  const httpClient = {
    request: async function (url, data, callback, exheaders, exoptions) {
      // IMPORTANTE: 'url' aqui é o path relativo que o 'soap' manda,
      // o SDK vai resolver usando o 'dest' (base já veio da Destination).
      console.log('[httpClient.request] →', { method, url, headers: exheaders });
      try {
        const result = await executeHttpRequest(
          dest,
          { method, url, data, timeout: 300000, headers: exheaders },
          { ...exoptions, fetchCsrfToken: false }
        );
        console.log('[httpClient.request] ← status:', result?.status, 'len:', JSON.stringify(result?.data)?.length);
        callback(null, result, result.data);
      } catch (e) {
        console.error('[httpClient.request] ERROR:', e?.message || e);
        callback(e);
      }
    }
  };

  // 5) Criar client SOAP pelo WSDL usando o httpClient
  console.time('[getSoapService] createClientAsync');
  let client;
  try {
    console.log('[getSoapService] createClientAsync START', { wsdl });
    client = await soap.createClientAsync(wsdl, { httpClient, endpoint: endpoint.url });
    console.log('[getSoapService] createClientAsync OK');
  } catch (e) {
    console.error('[getSoapService] createClientAsync ERROR:', e?.message || e);
    throw e;
  } finally {
    console.timeEnd('[getSoapService] createClientAsync');
  }

  // (opcional) se não passou endpoint acima, poderia fazer:
  // client.setEndpoint(endpoint.url);

  console.log('[getSoapService] RETURN SOAP client ready');
  return client;
}

module.exports = { getSoapService };
