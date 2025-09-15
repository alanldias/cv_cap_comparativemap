// srv/lib/config.js
const path = require('path');
try { require('dotenv').config() } catch { }

module.exports = {
  HTTP_TIMEOUT_MS: 60000,
  ARIBA_EVENT_ROUND: 1,

  DEST: {
    EVENTS: 'ARIBA_Event_Management_Test',
    PROJECTS: 'ARIBA_Sourcing_Project_Management_Test',
    S4H: 'S4H_QAS_CQ5_MAPA'
  },

  API_PREFIX: {
    EVENTS: '/api/sourcing-event/v2/prod',
    PM: '/api/sourcing-project-management/v2/prod'
  },

  S4: {
    SAP_CLIENT: '300',
    ODATA_PATH: '/sap/opu/odata/sap/API_INFORECORD_PROCESS_SRV/A_PurgInfoRecdOrgPlantData',
    TIMEOUT_MS: 60000
  },

  SOAP: {
    // resolve path *absoluto* para o WSDL (srv/external/...)
    WSDL_PATH: path.join(__dirname, '..', 'external', 'bapi_po_create1.wsdl')
  }
}
