import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openSurfaceUrl } from "../src/host.mjs";

function shim(directory, name, exitCode = 0) {
  const record = path.join(directory, `${name}.calls`);
  const file = path.join(directory, name);
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${record}"\nexit ${exitCode}\n`);
  chmodSync(file, 0o755);
  return { file, record };
}

test("the host adapter is tried first, then the browser, then print", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "surfacer-host-"));
  const host = shim(directory, "host-bin");
  const browser = shim(directory, "browser-bin");

  const viaHost = await openSurfaceUrl("http://127.0.0.1:1/x", {
    surfaceBin: host.file,
    browserCommand: [browser.file],
  });
  assert.deepEqual(viaHost, { opened: true, via: "host" });
  assert.match(readFileSync(host.record, "utf8"), /http:\/\/127\.0\.0\.1:1\/x/);

  const failingHost = shim(directory, "failing-host", 1);
  const viaBrowser = await openSurfaceUrl("http://127.0.0.1:1/y", {
    surfaceBin: failingHost.file,
    browserCommand: [browser.file],
  });
  assert.deepEqual(viaBrowser, { opened: true, via: "browser" });

  const captured = [];
  const printed = await openSurfaceUrl("http://127.0.0.1:1/z", {
    surfaceBin: path.join(directory, "missing-a"),
    browserCommand: [path.join(directory, "missing-b")],
    stderr: { write: (text) => captured.push(text) },
  });
  assert.deepEqual(printed, { opened: false, via: "print" });
  assert.match(captured.join(""), /http:\/\/127\.0\.0\.1:1\/z/);
});
