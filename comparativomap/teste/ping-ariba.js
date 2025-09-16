require("@sap/xsenv").loadEnv();
require("dotenv").config(); // não faz mal se o BAS ignorar
const { executeHttpRequest } = require("@sap-cloud-sdk/http-client");

(async () => {
  try {
    const res = await executeHttpRequest(
      { destinationName: "ARIBA_SOURCING" },
      {
        method: "GET",
        url: `/projects/${encodeURIComponent("WS1639759115")}`,
        params: {
          realm: process.env.ARIBA_REALM || "744701080-T",
          user: process.env.ARIBA_USER || "acopino.consult",
          passwordAdapter: process.env.ARIBA_PWD_ADAPTER || "ThirdPartyUser",
        },
      },
    );
    console.log("OK", res.status);
    console.log(JSON.stringify(res.data, null, 2));
  } catch (e) {
    console.error("Falhou:", e.response?.status, e.response?.data || e.message);
  }
})();
