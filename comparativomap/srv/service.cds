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


  // Linha normalizada que o backend está devolvendo
  type QuoteRow : {
    // Cabeçalho do item
    ItemId                          : String(30);
    itemDEscription                 : String(255);
    quantity                        : Decimal(15, 3);
    unitOfMeasure                   : String(12);

    // Preço unitário
    price                           : Decimal(15, 2);
    currency                        : String(3);

    // Extrinsics (nomes aproximados com underscore)
    ncm                             : String(40); // GITASHORTSTRINGIFZ000050
    mva                             : Decimal(15, 3); // GITABIGDECIFZ000003

    Extrinsic_Aliquota_ICMS         : Decimal(15, 3); // GITABIGDECIFZ000004
    Extrinsic_ICMS_Apurado          : Decimal(15, 2); // GITAMONEYIFZ000046 (amount)
    Extrinsic_Aliquota_IPI          : Decimal(15, 3); // GITABIGDECIFZ000005
    Extrinsic_IPI_Apurado           : Decimal(15, 2); // GITAMONEYIFZ000047 (amount)
    Extrinsic_Aliquota_PIS          : Decimal(15, 3); // GITABIGDECIFZ000029
    Extrinsic_PIS_Apurado           : Decimal(15, 2); // GITAMONEYIFZ000048 (amount)
    Extrinsic_Aliquota_Cofins       : Decimal(15, 3); // GITABIGDECIFZ000028
    Extrinsic_Cofins_apurado        : Decimal(15, 2); // GITAMONEYIFZ000049 (amount)
    Extrinsic_Aliquota_ICMS_Interna : Decimal(15, 3); // GITABIGDECIFZ000006
    Extrinsic_Origem_do_Material    : String(20); // GITASHORTSTRINGIFZ000153

    // Totais / dados mestre
    EXTENDEDPRICE                   : Decimal(15, 2); // amount de EXTENDEDPRICE
    PLANT                           : String(100); // Plant (simpleValue)
    ItemCategory                    : String(40); // ItemCategory (simpleValue)
    TAX_CODE                        : String(10); // IVA -> TAX_CODE
    MaterialCode                    : String(120); // Term "MaterialCode" (simpleValue)
    grupo_de_materias               : String(80); // MaterialGroup (simpleValue)
  }

  type AribaHeader : {
    tipoPedido             : String;
    purchasingOrganization : String;
    purchasingGroup        : String;
    companyCode            : String;
    incoterms1             : String;
    incoterms2             : String;
    paymentTerms           : String;
  };

  function aribaHeader(projectId : String) returns AribaHeader;

  function GetQuotes(docId : String) returns many QuoteRow;
};
