// The browser client kit, run under node with the few globals it touches
// stubbed: the value it fetches is the string it validated, never the value
// it was handed.
import assert from "node:assert/strict";
import test from "node:test";

import { createSurfaceClient } from "../src/client.mjs";

async function withBrowser(origin, run) {
  const saved = { location: globalThis.location, history: globalThis.history, fetch: globalThis.fetch };
  const fetched = [];
  globalThis.location = /** @type {any} */ ({ origin, hash: "#session-secret", pathname: "/" });
  globalThis.history = /** @type {any} */ ({ replaceState() {} });
  globalThis.fetch = /** @type {any} */ (async (url, init) => {
    fetched.push({ url, init });
    return { ok: true, json: async () => ({ ok: true }) };
  });
  try {
    return await run(fetched);
  } finally {
    globalThis.location = saved.location;
    globalThis.history = saved.history;
    globalThis.fetch = saved.fetch;
  }
}

test("the kit fetches the exact string it validated: a value whose string form changes cannot pass the origin check as one path and be fetched as another", async () => {
  await withBrowser("http://127.0.0.1:4400", async (fetched) => {
    const client = createSurfaceClient({ heartbeatMs: 60_000 });
    try {
      let reads = 0;
      const shifty = { toString: () => (reads++ === 0 ? "/api/model" : "https://attacker.invalid/collect") };
      await client.api(shifty);
      assert.equal(fetched.length, 1);
      assert.equal(fetched[0].url, "http://127.0.0.1:4400/api/model", "the validated absolute URL, not the value");
      assert.equal(fetched[0].init.headers.Authorization, "Bearer session-secret", "the bearer only travels to the validated origin");
      // A plain off-origin value is refused before any fetch.
      await assert.rejects(() => client.api("https://attacker.invalid/x"), /stay on the session origin/);
      await assert.rejects(() => client.api("/\t/evil.invalid/x"), /stay on the session origin|not a valid path/);
      assert.equal(fetched.length, 1, "nothing else was fetched");
    } finally {
      client.dispose?.();
    }
  });
});
