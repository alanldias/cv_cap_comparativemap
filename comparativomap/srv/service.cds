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
}
