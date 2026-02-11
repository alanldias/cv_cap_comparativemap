using comparativemap as comparativemap from '../db/schema';

@path: '/odata/v4/service'
// @requires: 'MAP_VIEWER'
service service {

  entity AribaQuotes as projection on comparativemap.AribaQuotes;

  type QuoteRow : {
    poItem                          : String(5);      // ex.: 01000, 01010, 01020...
    ItemId                          : String(30);
    itemDescription                 : String(255);
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
    MaterialCode                    : String(120);
    grupo_de_materias               : String(80);
    Incoterms                       : String;

    supplierName                    : String(255);
    itemId                          : Integer64;      // opcional (compat)
    invitationId                    : String(200);
    invitationEmail                 : String(200);

    NumeroItensRequisicao           : Integer;
    CodigoRFQ                       : Integer;
    CodigoRequisicao                : Integer;
    PrazoEntrega                    : String;
    DeliveryDate                    : String(50);
  };

  type AribaHeader : {
    docId                  : String;
    tipoPedido             : String;
    purchasingOrganization : String;
    purchasingGroup        : String;
    companyCode            : String;
    incoterms1             : String;
    incoterms2             : String;
    paymentTerms           : String;
    fornecedor             : String(10);
    moeda                  : String(3);
  };

  type QuotesResponse : {
    header : AribaHeader;
    items  : many QuoteRow;
  };

  function GetQuotes(docId: String) returns QuotesResponse;

  type SupplierBidInput : {
    itemId            : Integer64;     // ID do item do evento (ex.: 4094721049)
    invitationId      : String(200);   // "NNNNNNNNN_email@domínio.com"
    winningSplitType  : Integer;       // 1 = percentual
    winningSplitValue : Decimal(9, 3); // ex.: 100
    bidType           : String(20);    // ex.: 'Primary'
  };

  @odata.draft.enabled
  action CreateScenario(
    eventId      : String,
    title        : String,
    scenarioType : Integer,                 // ex.: 0 (manual)
    supplierBids : many SupplierBidInput
  ) returns {
    success       : Boolean;
    scenarioId    : String;
    aribaResponse : LargeString;
    correlationId : String;
  };

  type POHeader : {
    docType    : String(4);   // DOC_TYPE (ex.: 'NB')
    compCode   : String(4);   // COMP_CODE
    purchOrg   : String(4);   // PURCH_ORG
    purchGroup : String(3);   // PUR_GROUP
    vendor     : String(10);  // VENDOR (LIFNR) - zeros à esquerda no handler
    currency   : String(5);   // CURRENCY
    incoterms1 : String(3);   // INCOTERMS1
    incoterms2 : String(28);  // INCOTERMS2
  };

  type POItem : {
    poItem    : Integer;        // PO_ITEM
    plant     : String(4);      // PLANT
    material  : String(18);     // MATERIAL
    shortText : String(40);     // SHORT_TEXT
    quantity  : Decimal(13, 3); // QUANTITY
    unit      : String(3);      // PO_UNIT
    netPrice  : Decimal(13, 2); // NET_PRICE
    itemCat   : String(1);      // ITEM_CAT
    matlGroup : String(9);      // MATL_GROUP
    preqNo    : String(10);     // PREQ_NO
  };

  type POSchedule : {
    poItem       : Integer;        // PO_ITEM
    schedLine    : Integer;        // SCHED_LINE
    deliveryDate : Date;           // DELIVERY_DATE
    quantity     : Decimal(13, 3); // QUANTITY
  };

  type SimulacaoPOHeader : {
    empresa      : String(4);   // EXPHEADER.COMP_CODE
    orgCompras   : String(4);   // EXPHEADER.PURCH_ORG
    grupoCompras : String(3);   // EXPHEADER.PUR_GROUP
    fornecedor   : String(10);  // EXPHEADER.VENDOR
    moeda        : String(5);   // EXPHEADER.CURRENCY
    incoterms1   : String(3);   // EXPHEADER.INCOTERMS1
    incoterms2   : String(28);  // EXPHEADER.INCOTERMS2
    criadoEm     : Date;        // EXPHEADER.CREAT_DATE
    criadoPor    : String(20);  // EXPHEADER.CREATED_BY
    poNumber     : String(10);  // EXPHEADER.PO_NUMBER
  };

  type SimulacaoPOSchedule : {
    schedLine    : String(4);      // SCHED_LINE (zero-padding)
    deliveryDate : String(10);     // DELIVERY_DATE (ex.: 11.09.2025)
    qty          : Decimal(13, 3);
  };

  type SimulacaoPOItem : {
    poItem     : String(5);        // "00010"
    material   : String(40);       // MATERIAL_LONG/MATERIAL
    descricao  : String(80);       // SHORT_TEXT
    quantidade : Decimal(13, 3);   // QUANTITY
    unidade    : String(3);        // PO_UNIT
    netPrice   : Decimal(13, 2);   // NET_PRICE
    priceUnit  : Decimal(13, 3);   // PRICE_UNIT
    taxCode    : String(2);        // TAX_CODE
    taxJurCode : String(20);       // TAXJURCODE
    ncm        : String(20);       // BRAS_NBM
    priceDate  : Date;             // PRICE_DATE
    schedules  : array of SimulacaoPOSchedule;
    icmsValue  : Decimal(15, 2);
    ipiValue   : Decimal(15, 2);
  };

  type ReturnMessage : {
    type    : String(1);   // S, E, W, I, A
    id      : String(20);
    number  : String(3);
    message : String(220);
    logNo   : String(20);
  };

  type SimulacaoPOResult : {
    testRun        : Boolean;
    header         : SimulacaoPOHeader;
    itens          : array of SimulacaoPOItem;
    returnMessages : array of ReturnMessage;
  };

  type SimulacaoPORequest : {
    header    : POHeader;
    items     : array of POItem;
    schedules : array of POSchedule;
    testRun   : Boolean;
  };

  action simularPO(
    requests    : array of SimulacaoPORequest,
    concurrency : Integer default 4
  ) returns array of SimulacaoPOResult;

  function Ping() returns String;

}
