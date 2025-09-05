const cds = require('@sap/cds')
const soap = require('soap')
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client')
const { getDestination } = require('@sap-cloud-sdk/connectivity')

/**
 * Cria um client SOAP usando Destination do BTP/ENV (sem montar XML na mão)
 * @param {string} serviceKey - chave em cds.env.requires (ex.: 'BAPI_INFORECORD_GETLIST')
 * @param {string} wsdlPath   - caminho do WSDL (ex.: './srv/external/zbapi_inforecord_getlist.wsdl')
 * @param {{url: string|null}} endpointOut - objeto para receber a URL final do endpoint
 * @param {'POST'|'GET'} method - método HTTP (normalmente POST para SOAP)
 */
async function getSoapService (serviceKey, wsdlPath, endpointOut, method = 'POST') {
  const def = cds.env.requires[serviceKey]
  if (!def) throw new Error(`Service '${serviceKey}' não configurado em cds.requires`)

  // pega a Destination (do env local ou do BTP)
  const dest = await getDestination({ destinationName: def.credentials.destination })
  if (!dest) throw new Error(`Destination '${def.credentials.destination}' não encontrada`)

  const baseUrl = dest.url.endsWith('/') ? dest.url.slice(0, -1) : dest.url
  endpointOut.url = `${baseUrl}${def.credentials.path}`

  console.log(wsdlPath)

  // httpClient que usa o Cloud SDK por trás (e assim respeita a Destination)
  const httpClient = {
    request: async function (url, data, callback, exheaders, exoptions) {
      try {
        const result = await executeHttpRequest(
          dest,
          {
            method,
            url,          // o node-soap passa a URL completa que setarmos no setEndpoint
            data,
            headers: exheaders,
            timeout: exoptions?.timeout || 30000,
            responseType: 'text'
          },
          { fetchCsrfToken: false } // SOAP não precisa do prefetch de CSRF
        )
        // callback(err, res, body)
        callback(null, { statusCode: result.status, headers: result.headers }, result.data)
      } catch (e) {
        callback(e)
      }
    }
  }

  // cria o client SOAP a partir do WSDL (sem WS-Policy)
  return soap.createClientAsync(wsdlPath, { httpClient })
}

module.exports = { getSoapService }
