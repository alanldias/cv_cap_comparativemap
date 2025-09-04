using comparativemap as comparativemap from '../db/schema';

@path: '/odata/v4/service'
service service {

  // Projeção OData V4 da entidade persistida
  entity AribaQuotes as projection on comparativemap.AribaQuotes;

  /* ==================== Tipos já existentes ==================== */
  type QuoteRow : {
    ItemId                          : String(30);
    itemDEscription                 : String(255);   // mantido como está
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

  type AribaHeader : {
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

  /* ==================== Tipos p/ Simulação BAPI ==================== */

  // Entrada do item na simulação: herda o que vem do Ariba
  // e acrescenta campos usados na sua lógica (PREQ_*).
  // Também expõe "itemDescription" como alias opcional
  // para cobrir o typo "itemDEscription" sem quebrar nada.
  type SimulateItemInput : QuoteRow {
    PREQ_NO    : String(10);
    PREQ_ITEM  : String(5);
    itemDescription : String(255);  // opcional, alias aceito pelo backend
  };

  // Mensagem retornada pela BAPI
  type BapiMessage : {
    type : String(1);      // 'S', 'W', 'E', 'A', ...
    text : String(220);
  };

  // Linha da tabela simulada que você exibe no fragment
  type SimulateItemResult : {
    item           : String(5);
    material       : String(18);
    descricao      : String(255);
    centro         : String(100);
    quantidade     : Decimal(15, 3);
    unidade        : String(12);
    precoUnitario  : Decimal(15, 2);
    precoTotal     : Decimal(15, 2);
    taxCode        : String(10);
    icms           : Decimal(15, 2);
    ipi            : Decimal(15, 2);
    pis            : Decimal(15, 2);
    cofins         : Decimal(15, 2);
    st             : Decimal(15, 2);
    precoBase      : Decimal(15, 2);
    moeda          : String(3);
    grupoMateriais : String(80);
    categoriaItem  : String(40);
    preqNo         : String(10);
    preqItem       : String(5);
  };

  // Payload de retorno completo
  type SimulateBapiResponse : {
    success        : Boolean;
    messages       : many BapiMessage;
    purchaseOrder  : String(20);          // pode vir null em TESTRUN
    tabelaItens    : many SimulateItemResult;
  };

  /* ==================== Action de Simulação (UNBOUND) ==================== */
  action simulateBapiPoCreate(
    header : AribaHeader,
    items  : many SimulateItemInput
  ) returns SimulateBapiResponse;
}
