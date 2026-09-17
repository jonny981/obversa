const SECRET_ASSIGNMENT = /\b((?:[A-Za-z0-9_.-]*(?:api[_-]?key|token|password|secret|credential|database[_-]?url|dsn|private[_-]?key|access[_-]?key|connection[_-]?string)[A-Za-z0-9_.-]*)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi;
const SECRET_KEYS = new Set([
  "apikey",
  "accesstoken",
  "authtoken",
  "authorization",
  "cookie",
  "setcookie",
  "sessionid",
  "refreshtoken",
  "clientsecret",
  "credential",
  "credentials",
  "databaseurl",
  "dsn",
  "password",
  "privatekey",
  "secret",
  "token",
]);

export function redactText(value) {
  return String(value)
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/gi, "$1[REDACTED]@")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]")
    .replace(/\b(Basic\s+)[A-Za-z0-9+\/=]{8,}/gi, "$1[REDACTED]")
    .replace(SECRET_ASSIGNMENT, "$1[REDACTED]")
    .replace(/\bgh[opsu]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\bxox[a-z]-[A-Za-z0-9-]{8,}\b/gi, "[REDACTED_SLACK_TOKEN]")
    .replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, "[REDACTED_NPM_TOKEN]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED_GOOGLE_KEY]");
}

export function sanitizeValue(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return "[REDACTED_CYCLE]";
  seen.add(value);

  if (Array.isArray(value)) {
    const sanitized = value.map((item) => sanitizeValue(item, seen));
    seen.delete(value);
    return sanitized;
  }

  const sanitized = {};
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    const clean = SECRET_KEYS.has(normalizedKey) ? "[REDACTED]" : sanitizeValue(item, seen);
    // defineProperty keeps a literal "__proto__" key as an own property
    // instead of hitting the prototype setter and vanishing.
    Object.defineProperty(sanitized, key, { value: clean, enumerable: true, writable: true, configurable: true });
  }
  seen.delete(value);
  return sanitized;
}

export function safeText(value, maxLength = 500) {
  return redactText(value).replace(/[\r\n]+/g, " ").slice(0, maxLength);
}
