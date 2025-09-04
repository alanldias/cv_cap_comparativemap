using comparativemap as comparativemap from '../db/schema';

@path: '/odata/v4/service'
service service {

  // Projeção OData V4 da entidade persistida
  entity AribaQuotes as projection on comparativemap.AribaQuotes;

  /* ==================== Tipos já existentes ==================== */
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
  };

  type QuotesResponse : {
    header : AribaHeader;
    items  : many QuoteRow;
  };

  function GetQuotes(docId: String) returns QuotesResponse;


  // --------------------------------------
  // Tipos de entrada
  // --------------------------------------
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

  type ExpHeader {
    poNumber : String(10); // EXPHEADER-PO_NUMBER (em TESTRUN tende a vir vazio)
  }

  type SimulacaoPOResult {
    expHeader      : ExpHeader;
    returnMessages : many ReturnMessage;
  }

  action   simularPO(header: POHeader,
                     items: array of POItem,
                     schedules: array of POSchedule,
                     testRun: Boolean default true // enviaremos 'X' no handler quando true
  )                                 returns SimulacaoPOResult;
}
