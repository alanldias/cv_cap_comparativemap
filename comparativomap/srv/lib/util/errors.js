function clip(s, max = 800) { // corta string grande (log/erro) sem perder contexto
  if (!s) return s;
  return s.length > max ? s.slice(0, max) + ` ... (${s.length - max} chars more)` : s;
}

function safeErr(e = {}) { // normaliza erro (axios/soap/node) em um objeto “logável”
  const info = {
    name: e.name, message: e.message, code: e.code, errno: e.errno, address: e.address, port: e.port,
    statusCode: e.statusCode, // alguns erros node usam isso
    responseStatus: e.response?.status || e.status, // axios/HTTP
    responseBody: // tenta puxar body útil (string) sem explodir log
      e.body || e.response?.data || e.response?.body || e.root
        ? clip(String(e.body || e.response?.data || e.response?.body || JSON.stringify(e.root)))
        : undefined,
    fault: e.fault || e.root?.Envelope?.Body?.Fault, // SOAP fault quando existir
    stack: e.stack ? clip(e.stack, 1200) : undefined, // stack capada
  };
  return info;
}

function formatAribaScenarioError(e) { // mapeia erro do Ariba -> {status, correlationId, userMessage, technical}
  const status = e?.response?.status || 502; // default “gateway”
  const headers = e?.response?.headers || {};
  const body = e?.response?.data || {};
  const correlationId = headers["x-correlation-id"] || headers["x-correlationid"] || null; // trace no Ariba

  const errObj = body?.error || body; // alguns responses vem em body.error
  const code = errObj?.errorCode || errObj?.code || null; // error code comum
  const message = errObj?.message || body?.message || e.message || "Erro desconhecido."; // mensagem base
  const description = (errObj?.description || body?.description || "").toString().trim() || null; // detalhe extra

  // Caso conhecido: título duplicado (mensagem pro usuário fica “limpa”)
  if (/duplicate scenario title/i.test(message)) {
    return { status, correlationId, userMessage: "Cenário já exite.", technical: { status, code, message, description } };
  }

  // Agrega validações em formatos comuns do Ariba (violations/details/errors)
  const validations = [].concat(body?.violations || []).concat(body?.details || []).concat(body?.errors || []);
  const validationText = Array.isArray(validations) && validations.length
    ? validations.slice(0, 10).map((v) => {
        const field = v.field || v.path || v.name || "campo";
        const msg = v.message || v.description || JSON.stringify(v.value);
        return `${field}: ${msg}`;
      }).join(" ; ")
    : null;

  // Monta mensagem amigável mantendo contexto (sem vazar raw gigantesco)
  const parts = [];
  if (description && description !== message) parts.push(`Descrição: ${description}`);
  if (code) parts.push(`Código: ${code}`);
  if (validationText) parts.push(`Validações: ${validationText}`);
  const userMessage = `Falha ao criar cenário no Ariba. ${[message, ...parts].filter(Boolean).join(" ")}`;

  // Raw reduzido para troubleshooting (sem explodir payload em log/response)
  let raw = "";
  try { raw = JSON.stringify(body); } catch {}
  if (raw && raw.length > 2000) raw = raw.slice(0, 2000) + "...";

  return { status, correlationId, userMessage, technical: { status, code, message, description, raw } };
}

module.exports = { clip, safeErr, formatAribaScenarioError };
