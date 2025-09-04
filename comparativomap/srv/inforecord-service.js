const cds = require('@sap/cds')
const path = require('path')
const soap = require('soap')

/** Helper: acolchoa à esquerda */
const lpad = (v = '', len = 1, char = '0') => (v ?? '').toString().padStart(len, char)

/** Helper: normaliza tabela SOAP (pode vir obj único ou array ou undefined) */
const normalizeArray = (maybeArr) => {
  if (!maybeArr) return []
  if (Array.isArray(maybeArr)) return maybeArr
  return [ maybeArr ]
}

module.exports = cds.service.impl(async function () {
  const Srv = this

  /** Action para buscar o TAX_CODE */
  Srv.on('getTaxCode', async (req) => {
    // Defaults “mockados” (usar os do req se vierem)
    const VENDOR             = (req.data.VENDOR            ?? '1000034808')
    const MATERIAL_RAW       = (req.data.MATERIAL          ?? '84363')
    const PURCH_ORG          = (req.data.PURCH_ORG         ?? 'C001')
    const PURCHASINGINFOREC  = (req.data.PURCHASINGINFOREC ?? '5300000217')

    // Material em SAP costuma ser MATNR(18) com zeros à esquerda
    const MATERIAL = lpad(MATERIAL_RAW, 18, '0')

    // Caminho do WSDL local ao projeto CAP
    const wsdlPath = path.join(__dirname, 'external', 'zbapi_inforecord_getlist.wsdl')

    // Endpoint: pode deixar o do WSDL ou sobrescrever via env
    const endpointOverride = process.env.ECC_SOAP_ENDPOINT // ex: 'http://host:port/sap/bc/srt/scs/sap/zbapi_inforecord_getlist?sap-client=300'

    // Cria client SOAP
    const client = await soap.createClientAsync(wsdlPath)
    if (endpointOverride) client.setEndpoint(endpointOverride)

    // Auth básica opcional (se necessário)
    if (process.env.ECC_SOAP_USER && process.env.ECC_SOAP_PASSWORD) {
      client.setSecurity(new soap.BasicAuthSecurity(process.env.ECC_SOAP_USER, process.env.ECC_SOAP_PASSWORD))
    }

    // Monta request: campos do element BAPI_INFORECORD_GETLIST
    // Sinalizadores:
    //  - GENERAL_DATA='X' e PURCHORG_DATA='X' pedem o retorno das tabelas correspondentes
    //  - PURCHORG_VEND='X' costuma habilitar recorte por org/vendedor
    const args = {
      DELETED_INFORECORDS : '',   // opcional
      GENERAL_DATA        : 'X',
      INFO_TYPE           : '',   // opcional
      MATERIAL            : MATERIAL,
      MATERIAL_EVG        : { /* vazio */ },
      MATERIAL_LONG       : '',   // opcional
      MAT_GRP             : '',   // opcional
      PLANT               : '',   // se quiser filtrar também por centro
      PURCHASINGINFOREC   : PURCHASINGINFOREC,
      PURCHORG_DATA       : 'X',
      PURCHORG_VEND       : 'X',
      PURCH_ORG           : PURCH_ORG,
      PUR_GROUP           : '',   // opcional
      // As tabelas de entrada geralmente ficam vazias em GETLIST
      INFORECORD_GENERAL  : { item: [] },
      INFORECORD_PURCHORG : { item: [] },
      INFORECORD_SEGMENT  : { item: [] },
      RETURN              : { item: [] },
      VENDOR              : VENDOR,
      VEND_MAT            : '',
      VEND_MATG           : '',
      VEND_PART           : ''
    }

    // Chama a operação (document/literal): método = nome da operação
    let result
    try {
      const [resp] = await client.BAPI_INFORECORD_GETLISTAsync(args)
      result = resp?.BAPI_INFORECORD_GETLISTResponse ?? resp
    } catch (e) {
      req.warn(`SOAP call failed: ${e.message}`)
      throw req.error(500, 'Erro ao chamar BAPI_INFORECORD_GETLIST')
    }

    // Mensagens de retorno
    const retTab = normalizeArray(result?.RETURN?.item)
    const hasError = retTab.some(r => (r.TYPE === 'E' || r.TYPE === 'A'))
    if (hasError) {
      // Junta mensagens para facilitar
      const msg = retTab.map(r => `${r.TYPE || ''} ${r.CODE || ''} ${r.MESSAGE || ''}`.trim()).join(' | ')
      throw req.error(502, `BAPI retornou erro: ${msg}`)
    }

    // Percorre INFORECORD_PURCHORG e filtra por INFO_REC + VENDOR + PURCH_ORG
    const purchOrgItems = normalizeArray(result?.INFORECORD_PURCHORG?.item)
    const matches = purchOrgItems.filter(it =>
      (it.INFO_REC === PURCHASINGINFOREC) &&
      (it.VENDOR   === VENDOR) &&
      (it.PURCH_ORG === PURCH_ORG)
    )

    if (!matches.length) {
      return {
        taxCode: null,
        infoRecord: PURCHASINGINFOREC,
        vendor: VENDOR,
        purchOrg: PURCH_ORG,
        matchedCount: 0,
        rawItem: null,
        returnMessages: JSON.stringify(retTab)
      }
    }

    const hit = matches[0]
    const tax = hit.TAX_CODE || null

    return {
      taxCode: tax,
      infoRecord: hit.INFO_REC,
      vendor: hit.VENDOR,
      purchOrg: hit.PURCH_ORG,
      matchedCount: matches.length,
      rawItem: JSON.stringify(hit),
      returnMessages: JSON.stringify(retTab)
    }
  })
})
