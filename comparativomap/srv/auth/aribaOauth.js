require('dotenv').config();
const axios = require('axios');

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`[aribaOauth] Variável de ambiente ausente: ${name}`);
  return v;
}

// Carrega e valida envs necessários
const OAUTH_PREFIX = requireEnv('ARIBA_OAUTH_URL_PREFIX')            // ex: https://api.ariba.com
const CLIENT_ID    = requireEnv('ARIBA_OAUTH_CLIENT_ID_EVENTS');
const CLIENT_SEC   = requireEnv('ARIBA_OAUTH_CLIENT_SECRET_EVENTS');

const OAUTH_URL = `${OAUTH_PREFIX.replace(/\/+$/,'')}/v2/oauth/token`;
const BASIC = Buffer.from(`${CLIENT_ID}:${CLIENT_SEC}`).toString('base64');

const SKEW_MS = 120 * 1000;      // renova 2min antes de expirar
const FALLBACK_EXPIRES = 1440;   // seg (~24min), backup se API não mandar expires_in

const state = {
  accessToken : null,
  refreshToken: null,
  expiresAt   : 0,
  inFlight    : null,
};

function buildHeaders() {
  return {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept'      : 'application/json',
    'Authorization': `Basic ${BASIC}`,
  };
}

async function fetchToken(grantType, extra = {}) {
  const body = new URLSearchParams({ grant_type: grantType, ...extra }).toString();
  const { data } = await axios.post(OAUTH_URL, body, {
    headers: buildHeaders(),
    timeout: Number(process.env.HTTP_TIMEOUT_MS) || 30000,
    // Se estiver atrás de proxy corporativo e der erro de túnel, tente: proxy: false
  });
  // Console light para debug — não loga tokens!
  console.log(`[aribaOauth] grant=${grantType} ok; expires_in=${data?.expires_in ?? FALLBACK_EXPIRES}s`);
  const expiresInMs = (data.expires_in ?? FALLBACK_EXPIRES) * 1000;
  state.accessToken  = data.access_token;
  state.refreshToken = data.refresh_token || null;
  state.expiresAt    = Date.now() + expiresInMs;
  return state.accessToken;
}

async function tokenClientCredentials() {
  try {
    // grant oficial do OpenAPI Ariba
    return await fetchToken('openapi_2lo');
  } catch (e) {
    const status = e?.response?.status;
    const payload = e?.response?.data;
    console.warn('[aribaOauth] openapi_2lo falhou:', status, payload || e.message);
    // fallback opcional para alguns tenants/ambientes
    if (status === 400) {
      try {
        return await fetchToken('client_credentials');
      } catch (e2) {
        console.warn('[aribaOauth] client_credentials falhou também:', e2?.response?.status, e2?.response?.data || e2.message);
        throw e2;
      }
    }
    throw e;
  }
}

async function tokenRefresh() {
  if (!state.refreshToken) return tokenClientCredentials();
  try {
    return await fetchToken('refresh_token', { refresh_token: state.refreshToken });
  } catch (e) {
    console.warn('[aribaOauth] refresh falhou, tentando novo 2LO…');
    return tokenClientCredentials();
  }
}

async function getAccessToken() {
  const stillValid = state.accessToken && (Date.now() + SKEW_MS) < state.expiresAt;
  if (stillValid) return state.accessToken;

  if (!state.inFlight) {
    state.inFlight = (state.refreshToken ? tokenRefresh() : tokenClientCredentials())
      .finally(() => { state.inFlight = null; });
  }
  return state.inFlight;
}

module.exports = { getAccessToken };
