import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openSurfaceUrl, runDetached } from "../src/host.mjs";

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

test("the public placement path waits the full five seconds before assuming a lingering command opened the surface", async () => {
  // The default is what ships: through openSurfaceUrl, not the helper, a
  // command that lingers is reported as opened only once five seconds have
  // passed — no sooner, and without waiting for it to exit.
  const directory = mkdtempSync(path.join(os.tmpdir(), "surfacer-host-"));
  const lingering = path.join(directory, "lingering");
  writeFileSync(lingering, "#!/bin/sh\nsleep 8\n");
  chmodSync(lingering, 0o755);
  const started = Date.now();
  const result = await openSurfaceUrl("http://127.0.0.1:1/x", { surfaceBin: lingering, browserCommand: null });
  const elapsed = Date.now() - started;
  assert.deepEqual(result, { opened: true, via: "host" });
  assert.ok(elapsed >= 4_900 && elapsed < 7_500, `reported after the five-second settle, not at the command's exit (${elapsed}ms)`);
});

test("a placement command still alive after the settle is assumed to have opened the surface", async () => {
  // A browser that keeps the tab's process never exits; the session must not
  // wait for it. After settleMs the placement is reported as opened — an
  // assumption, so a command that fails only after the settle is reported as
  // opened too. Both facts are pinned here.
  const directory = mkdtempSync(path.join(os.tmpdir(), "surfacer-host-"));
  const lingering = path.join(directory, "lingering");
  writeFileSync(lingering, "#!/bin/sh\nsleep 2\n");
  chmodSync(lingering, 0o755);
  // The settle is fixed at five seconds in the public path; the internal
  // helper takes it as an argument so this test does not pay the five seconds.
  const started = Date.now();
  assert.equal(await runDetached(lingering, ["http://127.0.0.1:1/x"], 100), true);
  assert.ok(Date.now() - started < 1_500, "reported at the settle, not at the command's exit");

  const lateFailure = path.join(directory, "late-failure");
  writeFileSync(lateFailure, "#!/bin/sh\nsleep 0.5\nexit 1\n");
  chmodSync(lateFailure, 0o755);
  assert.equal(await runDetached(lateFailure, ["http://127.0.0.1:1/y"], 100), true, "a failure after the settle is not observed: the placement was already assumed opened");
});
