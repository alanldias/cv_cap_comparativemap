using comparativemap as comparativemap from '../db/schema';

@path: '/odata/v4/service'

service service {
    // Projeção OData V4 da entidade persistida
  entity AribaQuotes as projection on comparativemap.AribaQuotes;

  // (Opcional) Function para consulta "estilo REST" por parâmetros
  function GetQuotes(
    docId      : String,
    supplierId : String,
    lineNumber : Integer
  ) returns many AribaQuotes;


  // status forte (evita string solta)
  type ItemStatus : String enum { OK; ERROR; }

  // entrada do item (o que o front manda)
  type PedidoInput : {
    docId   : String;
    produto : String;
    unidade : String;
  };

  // saída (mesmo item + extras)
  type PedidoOut : {
    // ecoa o input
    docId     : String;
    produto   : String;
    unidade   : String;

    // header ECC
    docType   : String;
    org       : String;
    group     : String;
    company   : String;
    incoterm1 : String;
    incoterm2 : String;
    pagamento : String;
    moeda     : String(3);           // se quiser, deixa só String

    // valores (se quiser em número, troque para Decimal)
    precoTotal    : String;          // ou Decimal(15,2)

    // item retornado
    produtoRet    : String;
    unidadeRet    : String;
    precoUnitario : String;          // ou Decimal(15,5)
    quantidade    : String;          // ou Decimal(15,3)

    // controle
    _index   : Integer;
    _status  : ItemStatus;
    _errors  : array of String;
  };

  @requires: 'ECCOperator'
  action consultarPedidoECC(itens : array of PedidoInput) returns array of PedidoOut;
}
