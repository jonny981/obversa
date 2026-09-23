import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";

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
