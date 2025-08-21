using comparativemap as comparativemap from '../db/schema';

@path: '/odata/v4/service'

service service {

  @requires: 'ECCOperator' // manter alinhado com ROLE_REQUIRED 
  action consultarPedidoECC(numero: String) returns {
    DOC_TYPE   : String;
    PURCH_ORG  : String;
    PUR_GROUP  : String;
    COMP_CODE  : String;
    INCOTERMS1 : String;
    INCOTERMS2 : String;
    PMNTTRMS   : String;
  };
    // Projeção OData V4 da entidade persistida
  entity AribaQuotes as projection on comparativemap.AribaQuotes;

  // (Opcional) Function para consulta "estilo REST" por parâmetros
  function GetQuotes(
    docId      : String,
    supplierId : String,
    lineNumber : Integer
  ) returns many AribaQuotes;
}
