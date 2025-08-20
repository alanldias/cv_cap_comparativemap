using comparativemap as comparativemap from '../db/schema';

// srv/ecc-service.cds
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
}
