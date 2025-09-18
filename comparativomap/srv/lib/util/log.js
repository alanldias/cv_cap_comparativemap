// srv/lib/util/log.js
const cds = require("@sap/cds");

function _clip(s, max = 140) {
  const t = String(s ?? "");
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function kv(obj = {}, opt = {}) {
  const { strMax = 140, arrMax = 5, showKeys = false } = opt;
  if (obj == null || typeof obj !== "object") return String(obj);
  const pairs = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) {
      pairs.push(`${k}=null`);
      continue;
    }
    if (typeof v === "string")
      pairs.push(
        `${k}=${JSON.stringify(_clip(v, strMax).replace(/\s+/g, " "))}`,
      );
    else if (typeof v === "number" || typeof v === "boolean")
      pairs.push(`${k}=${v}`);
    else if (Array.isArray(v)) {
      const sample = v
        .slice(0, arrMax)
        .map((x) =>
          typeof x === "string"
            ? JSON.stringify(_clip(x, 40))
            : x && typeof x === "object" && x.id != null
              ? `{id:${x.id}}`
              : "{…}",
        )
        .join(",");
      pairs.push(
        `${k}=[${v.length}](${sample}${v.length > arrMax ? ",…" : ""})`,
      );
    } else if (v instanceof Date) pairs.push(`${k}=${v.toISOString()}`);
    else if (typeof v === "object") {
      if ("id" in v) pairs.push(`${k}={id:${v.id}}`);
      else
        pairs.push(
          `${k}=${showKeys ? `{${Object.keys(v).join(",")}}` : "{…}"}`,
        );
    } else pairs.push(`${k}=${JSON.stringify(v)}`);
  }
  return pairs.join(" ");
}

function mask(s) {
  if (s == null) return s;
  const t = String(s);
  return t.length <= 6 ? "***" : `${t.slice(0, 4)}***${t.slice(-2)}`;
}

// Structured (se você ainda quiser)
const STRUCT = (cds && cds.log && cds.log("ariba-service")) || console;

// UMA LINHA via console.* (sempre “bonito” no CF)
const infoL = (tag, data) => console.log(`${tag}${data ? " " + kv(data) : ""}`);
const warnL = (tag, data) =>
  console.warn(`${tag}${data ? " " + kv(data) : ""}`);
const errorL = (tag, data) =>
  console.error(`${tag}${data ? " " + kv(data) : ""}`);

// Ficam aqui caso ainda queira usar logs estruturados em algum ponto:
const LOG = {
  info: (...a) => (STRUCT.info ? STRUCT.info(...a) : console.log(...a)),
  warn: (...a) => (STRUCT.warn ? STRUCT.warn(...a) : console.warn(...a)),
  error: (...a) => (STRUCT.error ? STRUCT.error(...a) : console.error(...a)),
  infoL,
  warnL,
  errorL,
};

function dbg(...args) {
  if (process.env.DEBUG)
    infoL("[dbg]", {
      msg: args
        .map((x) =>
          typeof x === "object" ? kv(x, { showKeys: true }) : String(x),
        )
        .join(" "),
    });
}

module.exports = { LOG, kv, mask, dbg };
