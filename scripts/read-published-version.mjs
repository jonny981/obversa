import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";

const TEN_MINUTES_MS = 10 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 5_000;

// Read the version document directly: package-wide metadata can lag a publish.
// The deadline covers both headers and body. Public reads send no credentials.
export async function readPublishedVersion(registry, name, version) {
  let timer;
  try {
    const url = new URL(`${encodeURIComponent(name)}/${encodeURIComponent(version)}`, registry.endsWith("/") ? registry : `${registry}/`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      return { published: false, reason: "registry must be an HTTP(S) URL without credentials" };
    }
    const response = await new Promise((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsGet : httpGet)(url, { agent: false }, resolve);
      request.on("error", reject);
      timer = setTimeout(() => request.destroy(new Error("registry request timed out")), 5_000);
    });
    if (response.statusCode !== 200) {
      response.destroy();
      return { published: false, reason: `HTTP ${response.statusCode}` };
    }
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    const document = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (document?.name !== name || document?.version !== version) {
      return { published: false, reason: "registry document does not match the requested name and version" };
    }
    return { published: true };
  } catch (error) {
    return { published: false, reason: `registry request failed (${error.name})` };
  } finally {
    clearTimeout(timer);
  }
}

// `changeset publish` can take minutes to show a version on the registry.
// Retries the plain read on a fixed interval up to a total deadline, so a
// same-morning publish-then-tag no longer fails on a still-propagating 404.
export async function readPublishedVersionWithRetry(registry, name, version, {
  totalMs = TEN_MINUTES_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
} = {}) {
  const deadline = now() + totalMs;
  let attempts = 0;
  let last;
  for (;;) {
    attempts += 1;
    last = await readPublishedVersion(registry, name, version);
    if (last.published) return last;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }
  const waitedSeconds = Math.round(totalMs / 1000);
  return { published: false, reason: `${last.reason}, waited ${waitedSeconds}s across ${attempts} attempt(s)` };
}
