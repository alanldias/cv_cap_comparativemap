using comparativemap as comparativemap from '../db/schema';

@path: '/odata/v4/service'

service service {

  @requires: 'ECCOperator' // manter alinhado com ROLE_REQUIRED
  action   consultarPedidoECC(numero: String) returns {
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


  type QuoteRow       : {
    ItemId                          : String(30);
    itemDEscription                 : String(255);
    quantity                        : Decimal(15, 3);
    unitOfMeasure                   : String(12);
    price                           : Decimal(15, 2);
    currency                        : String(3);
    ncm                             : String(40);
    mva                             : Decimal(15, 3);
    Extrinsic_Aliquota_ICMS         : Decimal(15, 3);
    Extrinsic_ICMS_Apurado          : Decimal(15, 2);
    Extrinsic_Aliquota_IPI          : Decimal(15, 3);
    Extrinsic_IPI_Apurado           : Decimal(15, 2);
    Extrinsic_Aliquota_PIS          : Decimal(15, 3);
    Extrinsic_PIS_Apurado           : Decimal(15, 2);
    Extrinsic_Aliquota_Cofins       : Decimal(15, 3);
    Extrinsic_Cofins_apurado        : Decimal(15, 2);
    Extrinsic_Aliquota_ICMS_Interna : Decimal(15, 3);
    Extrinsic_Origem_do_Material    : String(20);
    EXTENDEDPRICE                   : Decimal(15, 2);
    PLANT                           : String(100);
    ItemCategory                    : String(40);
    TAX_CODE                        : String(10);
    MaterialCode                    : String(120);
    grupo_de_materias               : String(80);
    supplierName                    : String(255);
  }

  type AribaHeader    : {
    docId                  : String;
    tipoPedido             : String;
    purchasingOrganization : String;
    purchasingGroup        : String;
    companyCode            : String;
    incoterms1             : String;
    incoterms2             : String;
    paymentTerms           : String;
  }

  type QuotesResponse : {
    header : AribaHeader; // cabeçalho do projeto
    items  : many QuoteRow; // linhas de cotação
  }

  function GetQuotes(docId: String)           returns QuotesResponse;
};
