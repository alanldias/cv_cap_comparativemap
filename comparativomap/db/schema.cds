namespace comparativemap;

using {
    cuid, 
    managed 
} from '@sap/cds/common';


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

  supplierName               : String(120); // ⬅️ importante!
  currency                   : String(3);
  materialCode               : String(40);
  materialDesc               : String(255);
  quantity                   : Decimal(15,3);
  uom                        : String(8);
  netPrice                   : Decimal(15,2);
}

  @Capabilities.Insertable:true
  entity FilterViews : managed, cuid {
    name          : String(120);
    docId         : String(80);
    userId        : String(255);
    isPublic      : Boolean default true;

    // guardaremos JSON em texto grande (SQLite = TEXT; HANA = CLOB)
    filtersJSON   : LargeString;  // ConditionModel.getAllConditions() (ou equivalente)
    uiSortJSON    : LargeString;  // prefs.sort
    uiGroupJSON   : LargeString;  // prefs.group
    uiColumnsJSON : LargeString;  // { map: /ui/columns, order: /ui/columnList }
  }