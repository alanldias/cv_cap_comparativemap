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

function preview(body, len = 2000) {
  if (!body) return "";
  const s = typeof body === "string" ? body : JSON.stringify(body);
  return s.length > len ? s.slice(0, len) + " ...[truncado]" : s;
}

async function getSoapService(service, wsdl, endpoint, method = "POST") {
  const DEBUG = String(process.env.SOAP_DEBUG || "").trim() === "1";
  const DEBUG_XML = String(process.env.SOAP_DEBUG_XML || "").trim() === "1";

  console.log("[getSoapService] ENTER", { service, wsdl });

  // 1) Ler config do cds.env (.cdsrc.json / package.json)
  const definition = cds.env.requires[service];
  if (DEBUG) {
    console.log("[getSoapService] cds.requires[service]=", redact(definition));
  } else {
    console.log("[getSoapService] dest config ok?", {
      ok: !!definition?.credentials?.destination,
      dest: definition?.credentials?.destination,
      path: definition?.credentials?.path,
    });
  }

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
    dest = await getDestination({ destinationName: destName });
  } catch (e) {
    console.timeEnd("[getSoapService] getDestination");
    console.error("[getSoapService] getDestination ERROR:", e?.message || e);
    throw e;
  }
  console.timeEnd("[getSoapService] getDestination");
  if (!dest) throw new Error(`Destination '${destName}' não encontrada`);

  console.log("[getSoapService] destination", {
    name: destName,
    baseUrl: dest?.url,
    authentication: dest?.authentication,
    username: dest?.username || dest?.originalProperties?.User,
  });

  // 3) Montar endpoint final
  const base = dest.url.endsWith("/") ? dest.url.slice(0, -1) : dest.url;
  endpoint.url = base + destPath;
  console.log("[getSoapService] endpoint.url =", endpoint.url);

  // 4) httpClient que usa a Destination (túnel, auth, etc.)
  const httpClient = {
    request: async function (url, data, callback, exheaders, exoptions) {
      if (DEBUG) {
        console.log("[httpClient.request] → OUTBOUND SOAP", {
          method,
          url,
          headers: maskHeaders(exheaders),
          bodyPreview: preview(data, 800),
        });
      }

      try {
        const result = await executeHttpRequest(
          dest,
          { method, url, data, timeout: 300000, headers: exheaders },
          { ...exoptions, fetchCsrfToken: false },
        );

        console.log("[httpClient.request] ← SOAP RESPONSE", {
          status: result?.status,
          // só mostra preview se DEBUG ligado
          ...(DEBUG ? { dataPreview: preview(result?.data, 800) } : {}),
        });

        // Debug do XML bruto (só se habilitar SOAP_DEBUG_XML=1)
        if (DEBUG_XML) {
          const xml = String(result?.data || "");
          const pos = xml.toUpperCase().indexOf("EXTENSIONOUT");
          console.log(">>> [DEBUG_XML] XML length:", xml.length);
          console.log(">>> [DEBUG_XML] contains EXTENSIONOUT?", pos >= 0);
          if (pos >= 0) {
            console.log(">>> [DEBUG_XML] slice around EXTENSIONOUT:");
            console.log(xml.slice(Math.max(0, pos - 300), Math.min(xml.length, pos + 1200)));
          }
          console.log(
            ">>> [DEBUG_XML] EXTENSIONOUT has <item> ?",
            /<\s*EXTENSIONOUT[\s\S]*?<\s*item\b/i.test(xml),
          );
        }

        callback(null, result, result.data);
      } catch (e) {
        const resp = e?.response;
        const cfg = e?.config;

        console.error("=== SOAP HTTP ERROR (httpClient) ===");
        if (cfg) {
          console.error("REQUEST URL:", (cfg.baseURL || "") + (cfg.url || ""));
          console.error("REQUEST METHOD:", cfg.method);
          console.error("REQUEST HEADERS:", maskHeaders(cfg.headers));
          if (DEBUG && cfg.data) {
            console.error("REQUEST BODY (first 800):");
            console.error(preview(cfg.data, 800));
          }
        }

        if (resp) {
          console.error("RESPONSE STATUS:", resp.status, resp.statusText);
          console.error("RESPONSE HEADERS:", maskHeaders(resp.headers));
          if (DEBUG && resp.data) {
            console.error("RESPONSE BODY (first 800):");
            console.error(
              typeof resp.data === "string"
                ? preview(resp.data, 800)
                : preview(JSON.stringify(resp.data, null, 2), 800),
            );
          }
        } else {
          console.error("erro bruto:", e?.message || e);
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
    client = await soap.createClientAsync(wsdl, {
      httpClient,
      endpoint: endpoint.url,
    });
  } catch (e) {
    console.timeEnd("[getSoapService] createClientAsync");
    console.error("[getSoapService] createClientAsync ERROR:", e?.message || e);
    throw e;
  }
  console.timeEnd("[getSoapService] createClientAsync");

  console.log("[getSoapService] RETURN SOAP client ready");
  return client;
}

module.exports = { getSoapService };
