import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runSurface } from "../src/launcher.mjs";
import { parseFramedResult } from "../src/handoff.mjs";

test("runSurface runs one session end to end and frames the result", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "launcher-assets-"));
  writeFileSync(path.join(directory, "index.html"), "<!doctype html><title>x</title>");
  let captured = "";
  let session;
  const pending = runSurface({
    app: "launcher-test",
    open: false,
    stdout: { write: (text) => { captured += text; } },
    ready: (info) => { session = info; },
    assets: { directory, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    api: {
      "POST /api/answer": async ({ body, session: s }) => {
        s.complete({ got: body.value });
        return null;
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const token = session.url.split("#")[1];
  const reply = await fetch(`${session.origin}/api/answer`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: session.origin },
    body: JSON.stringify({ value: 7 }),
  }).then((r) => r.json());
  await fetch(`${session.origin}/api/ack`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: session.origin },
    body: JSON.stringify({ operationId: reply.operationId }),
  });
  const { result, placement } = await pending;
  assert.equal(result.status, "completed");
  assert.deepEqual(result.payload, { got: 7 });
  assert.deepEqual(placement, { opened: false, via: "disabled" });
  assert.equal(parseFramedResult(captured, "launcher-test").status, "completed");
  assert.equal(parseFramedResult(captured, "other-app"), null);
});
