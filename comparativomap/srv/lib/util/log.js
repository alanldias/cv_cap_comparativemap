// srv/lib/util/log.js
const cds = require("@sap/cds");

function _clip(s, max = 140) { // corta string longa pra não poluir log
  const t = String(s ?? "");
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function kv(obj = {}, opt = {}) { // serializa obj em "k=v" compacto
  const { strMax = 140, arrMax = 5, showKeys = false } = opt;
  if (obj == null || typeof obj !== "object") return String(obj);
  const pairs = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) { pairs.push(`${k}=null`); continue; } // null/undefined
    if (typeof v === "string") pairs.push(`${k}=${JSON.stringify(_clip(v, strMax).replace(/\s+/g, " "))}`); // string normalizada
    else if (typeof v === "number" || typeof v === "boolean") pairs.push(`${k}=${v}`); // primitivos
    else if (Array.isArray(v)) { // array: mostra tamanho + amostra
      const sample = v.slice(0, arrMax).map((x) =>
        typeof x === "string" ? JSON.stringify(_clip(x, 40))
          : x && typeof x === "object" && x.id != null ? `{id:${x.id}}`
            : "{…}"
      ).join(",");
      pairs.push(`${k}=[${v.length}](${sample}${v.length > arrMax ? ",…" : ""})`);
    } else if (v instanceof Date) pairs.push(`${k}=${v.toISOString()}`); // data ISO
    else if (typeof v === "object") { // objeto: mostra id ou chaves (opcional)
      if ("id" in v) pairs.push(`${k}={id:${v.id}}`);
      else pairs.push(`${k}=${showKeys ? `{${Object.keys(v).join(",")}}` : "{…}"}`);
    } else pairs.push(`${k}=${JSON.stringify(v)}`); // fallback
  }
  return pairs.join(" ");
}

function mask(s) { // mascara valor sensível (token, secret etc.)
  if (s == null) return s;
  const t = String(s);
  return t.length <= 6 ? "***" : `${t.slice(0, 4)}***${t.slice(-2)}`;
}

const STRUCT = (cds && cds.log && cds.log("ariba-service")) || console; // logger CAP (fallback console)

const infoL = (tag, data) => console.log(`${tag}${data ? " " + kv(data) : ""}`); // log 1-linha p/ CF
const warnL = (tag, data) => console.warn(`${tag}${data ? " " + kv(data) : ""}`);
const errorL = (tag, data) => console.error(`${tag}${data ? " " + kv(data) : ""}`);

const LOG = { // wrapper: mantém compat com cds.log e adiciona helpers 1-linha
  info: (...a) => (STRUCT.info ? STRUCT.info(...a) : console.log(...a)),
  warn: (...a) => (STRUCT.warn ? STRUCT.warn(...a) : console.warn(...a)),
  error: (...a) => (STRUCT.error ? STRUCT.error(...a) : console.error(...a)),
  infoL, warnL, errorL,
};

function dbg(...args) { // debug opcional via env DEBUG=1
  if (process.env.DEBUG)
    infoL("[dbg]", {
      msg: args.map((x) => (typeof x === "object" ? kv(x, { showKeys: true }) : String(x))).join(" "),
    });
}

module.exports = { LOG, kv, mask, dbg };
