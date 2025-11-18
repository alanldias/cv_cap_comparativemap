const soap = require("soap");
const { executeHttpRequest } = require("@sap-cloud-sdk/http-client");
const { getDestination } = require("@sap-cloud-sdk/connectivity");
const cds = require("@sap/cds");

// helper para esconder segredos nos logs
function redact(obj) {
  if (!obj) return obj;
  const clone = JSON.parse(JSON.stringify(obj));
  if (clone?.username) clone.username = "***";
  if (clone?.password) clone.password = "***";
  if (clone?.authTokens) clone.authTokens = "***";
  return clone;
}

function maskHeaders(headers = {}) {
  const h = { ...headers };
  for (const k of Object.keys(h)) {
    const key = k.toLowerCase();
    if (key === "authorization" || key === "proxy-authorization") {
      h[k] = "***";
    }
  }
  return h;
}

function preview(body, len = 500) {
  if (!body) return "";
  const s = typeof body === "string" ? body : JSON.stringify(body);
  return s.length > len ? s.slice(0, len) + " ...[truncado]" : s;
}

async function getSoapService(service, wsdl, endpoint, method = "POST") {
  console.log("[getSoapService] ENTER", { service, wsdl });

  // 1) Ler config do cds.env (.cdsrc.json / package.json)
  const definition = cds.env.requires[service];
  console.log("[getSoapService] cds.requires[service]=", redact(definition));

  if (!definition?.credentials?.destination) {
    throw new Error(
      `Destination não configurada em cds.requires['${service}'].credentials.destination`,
    );
  }

  const destName = definition.credentials.destination;
  const destPath = definition.credentials.path || "";

  // 2) Buscar a Destination no BTP (ou env local)
  console.time("[getSoapService] getDestination");
  let dest;
  try {
    console.log("[getSoapService] getDestination START", { destName });
    dest = await getDestination({ destinationName: destName });

    console.log("[getSoapService] getDestination OK?", {
      ok: !!dest,
      baseUrl: dest?.url,
      authentication: dest?.authentication,
      // cuidado: só o user, nunca a senha
      username: dest?.username || dest?.originalProperties?.User,
    });
  } catch (e) {
    console.error("[getSoapService] getDestination ERROR:", e?.message || e);
    throw e;
  } finally {
    console.timeEnd("[getSoapService] getDestination");
  }
  if (!dest) throw new Error(`Destination '${destName}' não encontrada`);

  // 3) Montar endpoint final
  const base = dest.url.endsWith("/") ? dest.url.slice(0, -1) : dest.url;
  endpoint.url = base + destPath;
  console.log("[getSoapService] endpoint.url =", endpoint.url);

  // 4) httpClient que usa a Destination (túnel, auth, etc.)
  const httpClient = {
    request: async function (url, data, callback, exheaders, exoptions) {
      // IMPORTANTE: 'url' aqui é o path relativo que o 'soap' manda,
      // o SDK vai resolver usando o 'dest' (base já veio da Destination).
      console.log("[httpClient.request] → OUTBOUND SOAP", {
        method,
        url,
        soapHeaders: exheaders,                    // só o que o node-soap passou
        bodyPreview: preview(data, 600),           // pedaço do XML que vai pra BAPI
      });

      try {
        const result = await executeHttpRequest(
          dest,
          { method, url, data, timeout: 300000, headers: exheaders },
          { ...exoptions, fetchCsrfToken: false },
        );

        console.log("[httpClient.request] ← SOAP RESPONSE", {
          status: result?.status,
          dataPreview: preview(result?.data, 400),
        });

        callback(null, result, result.data);
      } catch (e) {
        const resp = e?.response;
        const cfg = e?.config;

        console.error("=== SOAP HTTP ERROR (httpClient) ===");
        if (cfg) {
          console.error("REQUEST URL:", (cfg.baseURL || "") + (cfg.url || ""));
          console.error("REQUEST METHOD:", cfg.method);
          console.error("REQUEST HEADERS:", maskHeaders(cfg.headers));
          if (cfg.data) {
            console.error("REQUEST BODY (first 800):");
            console.error(preview(cfg.data, 800));
          }
        } else {
          console.error("sem cfg no erro (não parece Axios).");
        }

        if (resp) {
          console.error("RESPONSE STATUS:", resp.status, resp.statusText);
          console.error("RESPONSE HEADERS:", maskHeaders(resp.headers));
          if (resp.data) {
            console.error("RESPONSE BODY (first 800):");
            console.error(
              typeof resp.data === "string"
                ? preview(resp.data, 800)
                : preview(JSON.stringify(resp.data, null, 2), 800),
            );
          }
        } else {
          console.error("sem resp.data, erro bruto:");
          console.error(e);
        }
        console.error("=== END SOAP HTTP ERROR (httpClient) ===");

        callback(e);
      }
    },
  };

  // 5) Criar client SOAP pelo WSDL usando o httpClient
  console.time("[getSoapService] createClientAsync");
  let client;
  try {
    console.log("[getSoapService] createClientAsync START", { wsdl });
    client = await soap.createClientAsync(wsdl, {
      httpClient,
      endpoint: endpoint.url,
    });
    console.log("[getSoapService] createClientAsync OK");
  } catch (e) {
    console.error("[getSoapService] createClientAsync ERROR:", e?.message || e);
    throw e;
  } finally {
    console.timeEnd("[getSoapService] createClientAsync");
  }

  console.log("[getSoapService] RETURN SOAP client ready");
  return client;
}

module.exports = { getSoapService };
