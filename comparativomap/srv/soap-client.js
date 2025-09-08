const soap = require('soap')
const client = require('@sap-cloud-sdk/http-client')
const connectivity = require('@sap-cloud-sdk/connectivity')
const cds = require('@sap/cds')

async function getSoapService(serviceKey, wsdl, endpoint, method = 'POST') {
  const definition = cds.env.requires[serviceKey]
  if (!definition) throw new Error(`cds.requires['${serviceKey}'] não encontrado`)
  const dest = await connectivity.getDestination({ destinationName: definition.credentials.destination })
  const base = dest.url.endsWith('/') ? dest.url.slice(0, -1) : dest.url
  endpoint.url = base + (definition.credentials.path || '')
  const httpClient = {
    request: async function (url, data, callback, exheaders, exoptions) {
      client.executeHttpRequest(
        dest,
        { method, url, data, timeout: 300000, headers: exheaders },
        { ...exoptions, fetchCsrfToken: false }
      ).then(result => callback(null, result, result.data))
       .catch(e => callback(e))
    }
  }
  return soap.createClientAsync(wsdl, { httpClient })
}

module.exports = { getSoapService }
