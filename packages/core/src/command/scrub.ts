/**
 * Best-effort secret scrubbing for text that flows into events / logs / the
 * exit summary (e.g. a subprocess's stderr, which we don't control). Not a
 * security boundary — a guard against accidental credential echo.
 */

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = max > 1 ? '\n…' : '…'.slice(0, Math.max(0, max));
  return `${text.slice(0, Math.max(0, max - marker.length)).trimEnd()}${marker}`;
}

const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic keys
  /\bsk-(?!ant-)[A-Za-z0-9_-]{8,}/g, // OpenAI-style keys
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, // emails
  /\b(api[_-]?key|token|secret|password|authorization|bearer)\b\s*[=:]\s*\S+/gi, // key=value creds
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}

/**
 * Scrub exact occurrences of injected env values from captured output. Shape
 * patterns cannot catch a pinned credential that doesn't look like one (a hex
 * token in an innocently named var, a password inside a `postgres://` URL), but
 * at every capture site the injected record is in scope, so its values are
 * replaced verbatim. Two carve-outs keep diagnostics useful: values under 8
 * chars (a port or flag, too short to be a credential and too common to scrub),
 * and origin-only http(s) URLs (a `BASE_URL` names the preview a gate failed
 * against). The URL carve-out is host-only: anything with a path, query, or
 * fragment is scrubbed, because that is where URL-borne credentials live (a
 * webhook path, a `?token=` link, a presigned signature), and a URL carrying
 * userinfo (`@`) is scrubbed too.
 */
export function redactEnvValues(
  text: string,
  env: Record<string, string> | undefined,
): string {
  if (!env || !text) return text;
  const values = Object.values(env)
    .filter((v) => v.length >= 8)
    .filter((v) => !(/^https?:\/\/[^/?#]+\/?$/i.test(v) && !v.includes('@')))
    // Longest first, so a value that contains another is scrubbed whole
    // rather than leaving its tail behind.
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const v of values) out = out.split(v).join('[redacted]');
  return out;
}

/**
 * Composition for captured text that flows into persisted records (events,
 * `--record` files, error messages, outcome summaries): the injected env values
 * verbatim, then the shape patterns, then the cap. Redaction always runs on the
 * FULL text, before the cut, so a secret split at the truncation boundary cannot
 * survive; every capture site routes through here rather than hand-rolling the
 * order. `max` omitted = no cap.
 */
export function scrubCapture(
  text: string,
  env: Record<string, string> | undefined,
  max?: number,
): string {
  const scrubbed = redactSecrets(redactEnvValues(text, env));
  return max == null ? scrubbed : truncate(scrubbed, max);
}
