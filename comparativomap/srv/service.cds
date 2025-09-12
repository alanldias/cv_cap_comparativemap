using comparativemap as comparativemap from '../db/schema';

@path: '/odata/v4/service'
service service {

  // ==== Bia ====
  entity AribaQuotes as projection on comparativemap.AribaQuotes;

  type QuoteRow       : {
    ItemId                          : String(30);
    itemDEscription                 : String(255); // mantido como está
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
    // TAX_CODE                        : String(10);
    MaterialCode                    : String(120);
    grupo_de_materias               : String(80);
    supplierName                    : String(255);
    DELIVERY_DATE_RAW               : String(50);
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
    fornecedor             : String(10);
    moeda                  : String(3);
  };

  type QuotesResponse : {
    header : AribaHeader;
    items  : many QuoteRow;
  };

  function GetQuotes(docId: String)                    returns QuotesResponse;

  // ==== Axel ====
  type POHeader {
    docType    : String(4); // DOC_TYPE (ex.: 'NB')
    compCode   : String(4); // COMP_CODE (Empresa)
    purchOrg   : String(4); // PURCH_ORG (Org. Compras)
    purchGroup : String(3); // PUR_GROUP (Grp. Compradores)
    vendor     : String(10); // VENDOR (LIFNR) - preencher com zeros à esquerda no handler
    currency   : String(5); // CURRENCY (recomendado p/ simulação)
    incoterms1 : String(3); // INCOTERMS1
    incoterms2 : String(28); // INCOTERMS2 (lugar)
  }
 
 
  type POItem {
    poItem    : Integer; // PO_ITEM (00010, 00020, ...) - montar no handler
    plant     : String(4); // PLANT (Centro)
    material  : String(18); // MATERIAL (ou usar shortText)
    shortText : String(40); // SHORT_TEXT (se não houver material)
    quantity  : Decimal(13, 3); // QUANTITY
    unit      : String(3); // PO_UNIT
    taxCode   : String(2); // TAX_CODE (IVA)
    netPrice  : Decimal(13, 2); // NET_PRICE (opcional p/ previsibilidade)
    itemCat   : String(1); // ITEM_CAT (categoria do item) se aplicável
    matlGroup : String(9); // MATL_GROUP (grupo de materiais)
    preqNo    : String(10); // PREQ_NO (se vier de requisição)
  }
 
  type POSchedule {
    poItem       : Integer; // PO_ITEM
    schedLine    : Integer; // SCHED_LINE (default '1' no handler)
    deliveryDate : Date; // DELIVERY_DATE
    quantity     : Decimal(13, 3); // QUANTITY (geralmente = do item)
  }
 
  // --------------------------------------
  // Tipos de retorno (para montar tabela de mensagens e header)
  // --------------------------------------
  type SimulacaoPOHeader {
    empresa      : String(4); // EXPHEADER.COMP_CODE
    orgCompras   : String(4); // EXPHEADER.PURCH_ORG
    grupoCompras : String(3); // EXPHEADER.PUR_GROUP
    fornecedor   : String(10); // EXPHEADER.VENDOR
    moeda        : String(5); // EXPHEADER.CURRENCY
    incoterms1   : String(3); // EXPHEADER.INCOTERMS1
    incoterms2   : String(28); // EXPHEADER.INCOTERMS2
    criadoEm     : Date; // EXPHEADER.CREAT_DATE
    criadoPor    : String(20); // EXPHEADER.CREATED_BY
    poNumber     : String(10); // EXPHEADER.PO_NUMBER (vazio em TESTRUN)
  }
 
  type SimulacaoPOSchedule {
    schedLine    : String(4); // SCHED_LINE (mantemos zero-padding)
    deliveryDate : String(10); // DELIVERY_DATE como veio (ex.: 11.09.2025)
    qty          : Decimal(13, 3);
  }
 
  type SimulacaoPOItem {
    poItem     : String(5); // "00010" (com zero-padding)
    material   : String(40); // MATERIAL_LONG ou MATERIAL
    descricao  : String(80); // SHORT_TEXT
    quantidade : Decimal(13, 3); // QUANTITY
    unidade    : String(3); // PO_UNIT
    netPrice   : Decimal(13, 2); // NET_PRICE
    priceUnit  : Decimal(13, 3); // PRICE_UNIT
    taxCode    : String(2); // TAX_CODE
    taxJurCode : String(20); // TAXJURCODE
    ncm        : String(20); // BRAS_NBM
    priceDate  : Date; // PRICE_DATE
    schedules  : array of SimulacaoPOSchedule;
  }
 
  type ReturnMessage {
    type    : String(1); // S, E, W, I, A
    id      : String(20);
    number  : String(3);
    message : String(220);
    logNo   : String(20);
    v1      : String(50);
    v2      : String(50);
    v3      : String(50);
    v4      : String(50);
  }
 
  type SimulacaoPOResult {
    testRun        : Boolean;
    header         : SimulacaoPOHeader;
    itens          : array of SimulacaoPOItem;
    returnMessages : array of ReturnMessage;
  }
 
  action   simularPO(header: POHeader,
                     items: array of POItem,
                     schedules: array of POSchedule,
                     testRun: Boolean default true)    returns SimulacaoPOResult;
};
