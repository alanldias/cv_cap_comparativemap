const axios = require("axios");
const { getDestination } = require("@sap-cloud-sdk/connectivity");
const { LOG, dbg, mask } = require("../util/log");
const { DEST, API_PREFIX, HTTP_TIMEOUT_MS } = require("../config");

let addDestinationToRequestConfig; // helper do SDK (pode não existir dependendo da versão)
try { addDestinationToRequestConfig = require("@sap-cloud-sdk/connectivity").addDestinationToRequestConfig; }
catch { addDestinationToRequestConfig = null; }

const _destTokenCache = {}; // cache simples de token por tokenUrl|clientId

function _maybePrefixPath(destName, relativePath) { // aplica prefixo de API por destination (events vs pm)
  const rel = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;
  if (destName === DEST.EVENTS && /^\/events(\/|$)/i.test(rel)) return `${API_PREFIX.EVENTS}${rel}`;
  if (destName === DEST.PROJECTS && /^\/projects(\/|$)/i.test(rel)) return `${API_PREFIX.PM}${rel}`;
  return relativePath;
}

function _op(dest) { // normaliza “originalProperties” em um objeto plano (variações do Cloud SDK)
  const op = dest?.originalProperties || {};
  const out = { ...op };

  if (op && typeof op.Properties === "object" && op.Properties) { // v2 style: Properties
    Object.entries(op.Properties).forEach(([k, v]) => { if (out[k] == null) out[k] = v; });
  }
  if (op && typeof op.destinationConfiguration === "object" && op.destinationConfiguration) { // v3 style: destinationConfiguration
    Object.entries(op.destinationConfiguration).forEach(([k, v]) => { if (out[k] == null) out[k] = v; });
  }
  const arr = op.additionalProperties || op.AdditionalProperties; // lista de additional props (key/value)
  if (Array.isArray(arr))
    for (const it of arr) {
      const k = it?.key ?? it?.Key ?? it?.name ?? it?.Name;
      const v = it?.value ?? it?.Value;
      if (k != null && out[k] == null) out[k] = v;
    }
  return out;
}

function _findAdditionalProp(destination, name) { // pega additional prop ignorando case + fallbacks URL.queries.*
  const op = _op(destination);
  const keys = Object.keys(op);
  const hit = keys.find((k) => String(k).toLowerCase() === String(name).toLowerCase());
  if (hit) return op[hit];

  const low = String(name).toLowerCase();
  if (low === "realm") return op["URL.queries.realm"] ?? op["url.queries.realm"] ?? null;
  if (low === "user") return op["URL.queries.user"] ?? op["url.queries.user"] ?? null;
  if (low === "passwordadapter")
    return op["URL.queries.passwordAdapter"] ?? op["url.queries.passwordAdapter"] ?? null;
  if (low === "sap-client") return op["URL.queries.sap-client"] ?? op["url.queries.sap-client"] ?? null;
  return null;
}

function _mergeQueryParamsFromDestination(destination, params = {}) { // injeta URL.queries.* + params “conhecidos”
  const op = _op(destination);
  const out = { ...params };

  for (const [k, v] of Object.entries(op)) { // URL.queries.foo -> out.foo
    const m = /^URL\.queries\.(.+)$/i.exec(k);
    if (m && v != null && v !== "" && out[m[1]] == null) out[m[1]] = String(v);
  }

  for (const k of ["realm", "user", "passwordAdapter", "sap-client"]) { // pega também propriedades diretas
    if (out[k] != null && out[k] !== "") continue;
    const val = _findAdditionalProp(destination, k) ?? op[k] ?? destination[k];
    if (val != null && val !== "") out[k] = String(val);
  }

  return out;
}

function _ensureAribaQueryParams(destName, destination, params) { // garante realm/user/passwordAdapter (Ariba) com fallback env
  if (destName !== DEST.EVENTS && destName !== DEST.PROJECTS) return params;
  const out = { ...params };

  let realm = out.realm ?? _findAdditionalProp(destination, "realm");
  let user = out.user ?? _findAdditionalProp(destination, "user");
  let pad = out.passwordAdapter ?? _findAdditionalProp(destination, "passwordAdapter");

  realm ||= process.env.ARIBA_REALM;
  user ||= process.env.ARIBA_USER;
  pad ||= process.env.ARIBA_PASSWORD_ADAPTER;

  if (realm) out.realm = String(realm).trim();
  if (user) out.user = String(user).trim();
  if (pad) out.passwordAdapter = String(pad).trim();

  return out;
}

function _mergeHeadersFromDestination(destination, headers = {}) { // injeta URL.headers.* + apiKey + headers base
  const op = _op(destination);
  const out = { ...headers };

  for (const [k, v] of Object.entries(op)) { // URL.headers.foo -> out.foo
    const m = /^URL\.headers\.(.+)$/i.exec(k);
    if (m && v != null && v !== "" && out[m[1]] == null) out[m[1]] = String(v);
  }

  for (const name of ["apiKey", "apikey", "APIKey"]) { // tenta herdar apiKey (várias grafias)
    if (out[name] != null && out[name] !== "") continue;
    const val = op[name] ?? destination.headers?.[name];
    if (val != null && val !== "") out[name] = String(val);
  }

  out.Accept ??= "application/json";
  out["Content-Type"] ??= "application/json";
  return out;
}

async function _fetchTokenFromDestination(destination) { // OAuth client_credentials manual quando SDK não injeta token
  const op = destination.originalProperties || {};

  let base =
    destination.tokenServiceUrl ||
    destination.tokenUrl ||
    destination.token_service_url ||
    op.tokenServiceURL ||
    op.TokenServiceURL ||
    op["URL.tokenServiceURL"];

  if (!base) throw new Error("Destination não possui tokenServiceUrl");

  const tokenUrl = /\/oauth\b/i.test(base) ? base.replace(/\/$/, "") : base.replace(/\/$/, "") + "/oauth/token";

  const clientId =
    destination.clientId || destination.clientid || destination.client_id ||
    op.clientId || op.clientid || op.client_id;

  const clientSecret =
    destination.clientSecret || destination.clientsecret || destination.client_secret ||
    op.clientSecret || op.clientsecret || op.client_secret;

  dbg("[HTTP:_fetchToken] tokenUrl =", tokenUrl);
  dbg("[HTTP:_fetchToken] clientId =", mask(clientId));

  if (!clientId || !clientSecret) throw new Error("Faltando clientId/clientSecret no destination");

  const key = tokenUrl + "|" + clientId; // cache key
  const now = Date.now();
  if (_destTokenCache[key] && now < _destTokenCache[key].exp - 60_000) { // renova 60s antes
    dbg("[HTTP:_fetchToken] cache hit (expires at)", new Date(_destTokenCache[key].exp).toISOString());
    return _destTokenCache[key].token;
  }

  dbg("[HTTP:_fetchToken] cache miss -> requisitando token");

  const includeGrantInBody = !/\bgrant_type=/.test(tokenUrl); // se URL já tem grant_type, não repete
  const body = new URLSearchParams();
  if (includeGrantInBody)
    body.append("grant_type", destination.grantType || op.grantType || "client_credentials");
  if (destination.scope || op.scope) body.append("scope", destination.scope || op.scope);

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  try {
    const resp = await axios.post(tokenUrl, body.toString(), {
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      timeout: Number(HTTP_TIMEOUT_MS) || 15000,
    });

    const { access_token, expires_in } = resp.data || {};
    dbg("[HTTP:_fetchToken] token obtido (masked) =", mask(access_token), "expires_in=", expires_in);

    _destTokenCache[key] = { token: access_token, exp: now + (expires_in ?? 3600) * 1000 };
    return access_token;
  } catch (e) {
    LOG.error?.("[HTTP:_fetchToken] erro ao obter token:", e?.message || e);
    dbg("[HTTP:_fetchToken] resp.data (se houver) =", e?.response?.data
      ? (() => { try { return JSON.stringify(e.response.data).slice(0, 2000); } catch { return String(e.response.data); } })()
      : null);
    throw e;
  }
}

async function _buildReqConfig(destination, baseCfg) { // cria config axios com auth/headers vindos do destination
  let reqCfg;

  if (addDestinationToRequestConfig) { // caminho feliz: SDK injeta auth, proxy, etc.
    try {
      reqCfg = await addDestinationToRequestConfig(baseCfg, destination);
      dbg("[HTTP:_buildReqConfig] addDestinationToRequestConfig aplicou configuração SDK");
    } catch (e) {
      LOG.warn?.("[HTTP] addDestinationToRequestConfig falhou; fallback manual:", e.message);
      dbg("[HTTP:_buildReqConfig] fallback manual (SDK helper falhou)");
    }
  }

  if (!reqCfg) { // fallback: monta axios config “na mão”
    reqCfg = {
      baseURL: destination.url,
      ...baseCfg,
      headers: { ...(destination.headers || {}), ...(baseCfg.headers || {}) },
    };

    if (destination.authTokens?.[0]?.value) { // token já resolvido pelo Cloud SDK
      reqCfg.headers.authorization ||= `Bearer ${destination.authTokens[0].value}`;
      dbg("[HTTP:_buildReqConfig] authorization set from destination.authTokens (masked) =", mask(reqCfg.headers.authorization));
    } else if ((destination.authentication || "").toLowerCase() === "oauth2clientcredentials") { // tenta buscar token
      try {
        const token = await _fetchTokenFromDestination(destination);
        if (token) {
          reqCfg.headers.authorization = `Bearer ${token}`;
          dbg("[HTTP:_buildReqConfig] authorization set from fetched token (masked) =", mask(reqCfg.headers.authorization));
        }
      } catch (e) {
        LOG.error?.("[HTTP] erro ao obter token:", e.message);
        dbg("[HTTP:_buildReqConfig] _fetchTokenFromDestination falhou:", e?.message);
      }
    }
  }

  dbg("[HTTP:_buildReqConfig] reqCfg preview -> baseURL:", reqCfg.baseURL, "| url:", reqCfg.url, "| headers keys:", Object.keys(reqCfg.headers));
  return reqCfg;
}

async function destGet(destName, relativePath, { params = {}, headers = {}, timeoutMs = HTTP_TIMEOUT_MS } = {}) { // GET via destination + merges de params/headers
  dbg("[destGet] START", { destName, relativePath });

  const destination = await getDestination({ destinationName: destName, useCache: false }); // resolve dest (sem cache p/ debug)
  if (!destination) throw new Error(`Destination ${destName} não encontrada`);

  const urlPath = _maybePrefixPath(destName, relativePath); // corrige path p/ Ariba prefix

  const baseCfg = {
    method: "get",
    url: urlPath,
    params: { ...params },
    headers: { ...headers },
    timeout: Number(timeoutMs) || 30000,
  };

  baseCfg.params = _mergeQueryParamsFromDestination(destination, baseCfg.params); // URL.queries.*
  baseCfg.params = _ensureAribaQueryParams(destName, destination, baseCfg.params); // realm/user/pad
  baseCfg.headers = _mergeHeadersFromDestination(destination, baseCfg.headers); // URL.headers.*

  const reqCfg = await _buildReqConfig(destination, baseCfg); // injeta auth e baseURL

  const op = _op(destination); // lê apiKey também de URL.headers.api-key
  const keyFromOP = Object.entries(op).find(([k]) => /^URL\.headers\.(api[-_]?key)$/i.test(k))?.[1];

  let apiKey =
    reqCfg.headers?.apiKey || reqCfg.headers?.APIKey || reqCfg.headers?.apikey ||
    reqCfg.headers?.["api-key"] || reqCfg.headers?.["x-api-key"] ||
    destination.headers?.apiKey || destination.headers?.["api-key"] || keyFromOP;

  if (!apiKey) { // fallback por env (separado por API)
    apiKey =
      destName === DEST.EVENTS ? process.env.ARIBA_API_KEY_EVENTS
        : destName === DEST.PROJECTS ? process.env.ARIBA_API_KEY_PROJECTS
          : null;
  }

  if (apiKey) { // força compat de header (Ariba às vezes é chato com nome)
    reqCfg.headers["api-key"] = apiKey;
    reqCfg.headers["apikey"] = apiKey;
    reqCfg.headers["apiKey"] = apiKey;
    reqCfg.headers["APIKey"] = apiKey;
    reqCfg.headers["x-api-key"] = apiKey;
  }

  console.log("[DBG][destGet] DEST =", destName);
  console.log("[DBG][destGet] URL =", reqCfg.baseURL, reqCfg.url);
  console.log("[DBG][destGet] auth =", destination.authentication);
  console.log("[DBG][destGet] params =", reqCfg.params);
  console.log("[DBG][destGet] headers keys =", Object.keys(reqCfg.headers || {}));
  console.log("[DBG][destGet] has Authorization? =", Boolean(reqCfg.headers?.authorization || reqCfg.headers?.Authorization));
  console.log("[DBG][destGet] apiKey candidates =", {
    "api-key": reqCfg.headers?.["api-key"] ? mask(reqCfg.headers["api-key"]) : null,
    apikey: reqCfg.headers?.apikey ? mask(reqCfg.headers.apikey) : null,
    apiKey: reqCfg.headers?.apiKey ? mask(reqCfg.headers.apiKey) : null,
    APIKey: reqCfg.headers?.APIKey ? mask(reqCfg.headers.APIKey) : null,
    "x-api-key": reqCfg.headers?.["x-api-key"] ? mask(reqCfg.headers["x-api-key"]) : null,
  });

  dbg("[destGet] REQUEST =>", { method: reqCfg.method || "GET", baseURL: reqCfg.baseURL, url: reqCfg.url, timeout: reqCfg.timeout });

  try {
    const resp = await axios.request(reqCfg); // executa request
    dbg("[destGet] RESPONSE OK status =", resp.status, "| dataType =", typeof resp.data);
    return resp.data;
  } catch (e) {
    LOG.error?.("[destGet] request error:", e?.message || e);

    console.log("[DBG][destGet] axios error status =", e?.response?.status);
    console.log("[DBG][destGet] axios error headers keys =", Object.keys(e?.response?.headers || {}));
    console.log("[DBG][destGet] axios error data (first 800) =", e?.response?.data
      ? (typeof e.response.data === "string" ? e.response.data.slice(0, 800) : JSON.stringify(e.response.data).slice(0, 800))
      : null);

    dbg("[destGet] request config keys =", { baseURL: reqCfg.baseURL, url: reqCfg.url, headersKeys: Object.keys(reqCfg.headers || {}) });
    throw e;
  }
}

async function destPost(destName, relativePath, body, { params = {}, headers = {}, timeoutMs = HTTP_TIMEOUT_MS } = {}) { // POST via destination + merges de params/headers
  dbg("[destPost] START", { destName, relativePath });

  const destination = await getDestination({ destinationName: destName, useCache: false });
  if (!destination) throw new Error(`Destination ${destName} não encontrada`);

  const urlPath = _maybePrefixPath(destName, relativePath);

  const baseCfg = {
    method: "post",
    url: urlPath,
    data: body,
    params: { ...params },
    headers: { ...headers },
    timeout: Number(timeoutMs) || 30000,
  };

  baseCfg.params = _mergeQueryParamsFromDestination(destination, baseCfg.params);
  baseCfg.params = _ensureAribaQueryParams(destName, destination, baseCfg.params);
  baseCfg.headers = _mergeHeadersFromDestination(destination, baseCfg.headers);

  const reqCfg = await _buildReqConfig(destination, baseCfg);

  const op = _op(destination);
  const keyFromOP = Object.entries(op).find(([k]) => /^URL\.headers\.(api[-_]?key)$/i.test(k))?.[1];

  let apiKey =
    reqCfg.headers?.apiKey || reqCfg.headers?.APIKey || reqCfg.headers?.apikey ||
    reqCfg.headers?.["api-key"] || reqCfg.headers?.["x-api-key"] ||
    destination.headers?.apiKey || destination.headers?.["api-key"] || keyFromOP;

  if (!apiKey) {
    apiKey =
      destName === DEST.EVENTS ? process.env.ARIBA_API_KEY_EVENTS
        : destName === DEST.PROJECTS ? process.env.ARIBA_API_KEY_PROJECTS
          : null;
  }

  if (apiKey) {
    reqCfg.headers["api-key"] = apiKey;
    reqCfg.headers["apikey"] = apiKey;
    reqCfg.headers["apiKey"] = apiKey;
    reqCfg.headers["APIKey"] = apiKey;
    reqCfg.headers["x-api-key"] = apiKey;
  }

  console.log("[DBG][destPost] DEST =", destName);
  console.log("[DBG][destPost] URL =", reqCfg.baseURL, reqCfg.url);
  console.log("[DBG][destPost] auth =", destination.authentication);
  console.log("[DBG][destPost] params =", reqCfg.params);
  console.log("[DBG][destPost] headers keys =", Object.keys(reqCfg.headers || {}));
  console.log("[DBG][destPost] has Authorization? =", Boolean(reqCfg.headers?.authorization || reqCfg.headers?.Authorization));
  console.log("[DBG][destPost] apiKey candidates =", {
    "api-key": reqCfg.headers?.["api-key"] ? mask(reqCfg.headers["api-key"]) : null,
    apikey: reqCfg.headers?.apikey ? mask(reqCfg.headers.apikey) : null,
    apiKey: reqCfg.headers?.apiKey ? mask(reqCfg.headers.apiKey) : null,
    APIKey: reqCfg.headers?.APIKey ? mask(reqCfg.headers.APIKey) : null,
    "x-api-key": reqCfg.headers?.["x-api-key"] ? mask(reqCfg.headers["x-api-key"]) : null,
  });

  dbg("[destPost] REQUEST =>", { method: reqCfg.method || "POST", baseURL: reqCfg.baseURL, url: reqCfg.url, timeout: reqCfg.timeout });

  try {
    const resp = await axios.request(reqCfg);
    dbg("[destPost] RESPONSE OK status =", resp.status);
    return { data: resp.data, headers: resp.headers, status: resp.status }; // mantém headers p/ correlation-id
  } catch (e) {
    LOG.error?.("[destPost] request error:", e?.message || e);

    console.log("[DBG][destPost] axios error status =", e?.response?.status);
    console.log("[DBG][destPost] axios error headers keys =", Object.keys(e?.response?.headers || {}));
    console.log("[DBG][destPost] axios error data (first 800) =", e?.response?.data
      ? (typeof e.response.data === "string" ? e.response.data.slice(0, 800) : JSON.stringify(e.response.data).slice(0, 800))
      : null);

    throw e;
  }
}

module.exports = { // exporta helpers pra reuso/testes
  destGet, destPost,
  _op,
  _mergeQueryParamsFromDestination,
  _mergeHeadersFromDestination,
  _ensureAribaQueryParams,
};
