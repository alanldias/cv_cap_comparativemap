namespace comparativemap;

entity AribaQuotes {
  key docId                  : String(40);
  key supplierId             : String(40);
  key lineNumber             : Integer;

  arb_Document_Type          : String(4);
  arb_PurchasingOrganization : String(4);
  arb_PurchasingGroup        : String(3);
  arb_CompanyCode            : String(4);
  INCOTERMS1                 : String(3);
  INCOTERMS2                 : String(60);
  arb_PaymentTerms           : String(10);

  supplierName               : String(120); 
  currency                   : String(3);
  materialCode               : String(40);
  materialDesc               : String(255);
  quantity                   : Decimal(15,3);
  uom                        : String(8);
  netPrice                   : Decimal(15,2);
}