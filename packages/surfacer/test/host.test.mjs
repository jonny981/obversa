import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
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
    stderr: /** @type {any} */ ({ write: (text) => captured.push(text) }),
  });
  assert.deepEqual(printed, { opened: false, via: "print" });
  assert.match(captured.join(""), /http:\/\/127\.0\.0\.1:1\/z/);
});

test("the public placement path assumes a lingering command opened the surface at exactly five seconds", async (t) => {
  // The default is what ships: through openSurfaceUrl, not the helper. The
  // clock is mocked, so the test is exact and instant: one millisecond short
  // of five seconds the placement is still pending; at five seconds it is
  // reported as opened, without waiting for the command to exit.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const directory = mkdtempSync(path.join(os.tmpdir(), "surfacer-host-"));
  const lingering = path.join(directory, "lingering");
  // The public boundary spawns a real command; it lingers a few seconds and
  // is never waited for. The clock is what is mocked.
  writeFileSync(lingering, "#!/bin/sh\nsleep 6\n");
  chmodSync(lingering, 0o755);
  let settled = null;
  const pending = openSurfaceUrl("http://127.0.0.1:1/x", { surfaceBin: lingering, browserCommand: null }).then((result) => { settled = result; return result; });
  // Let the spawn happen and the settle timer be armed.
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(4_999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, null, "one millisecond short of five seconds, still pending");
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, { opened: true, via: "host" });
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

test("a placement command that is not an absolute path is not run: a bare name would be looked up on PATH with the token URL as its argument", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "surfacer-host-"));
  const onPath = shim(directory, "obversa-surface");
  const browser = shim(directory, "browser-bin");
  const captured = [];
  const previousPath = process.env.PATH;
  process.env.PATH = `${directory}${path.delimiter}${previousPath}`;
  try {
    const result = await openSurfaceUrl("http://127.0.0.1:1/x#token", {
      surfaceBin: "obversa-surface",
      browserCommand: [browser.file],
      stderr: /** @type {any} */ ({ write: (text) => captured.push(text) }),
    });
    assert.deepEqual(result, { opened: true, via: "browser" }, "placement falls through to the browser");
    assert.equal(existsSync(onPath.record), false, "the executable on PATH was never run");
    assert.match(captured.join(""), /OBVERSA_SURFACE_BIN is not an absolute path and is not run: obversa-surface/);
    // Unset: no host placement is attempted at all.
    const unset = await openSurfaceUrl("http://127.0.0.1:1/y", { surfaceBin: undefined, browserCommand: [browser.file], stderr: /** @type {any} */ ({ write: () => {} }) });
    assert.deepEqual(unset, { opened: true, via: "browser" });
    assert.equal(existsSync(onPath.record), false);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("a browser command that is not an absolute path is not run either; the URL is printed instead", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "surfacer-host-"));
  const onPath = shim(directory, "open");
  const captured = [];
  const previousPath = process.env.PATH;
  process.env.PATH = `${directory}${path.delimiter}${previousPath}`;
  try {
    const result = await openSurfaceUrl("http://127.0.0.1:1/x#token", { surfaceBin: undefined, browserCommand: ["open"], stderr: /** @type {any} */ ({ write: (text) => captured.push(text) }) });
    assert.deepEqual(result, { opened: false, via: "print" });
    assert.equal(existsSync(onPath.record), false, "the open on PATH was never run");
    assert.match(captured.join(""), /The browser command is not an absolute path and is not run: open/);
    assert.match(captured.join(""), /Open this surface in a browser: http:\/\/127\.0\.0\.1:1\/x#token/);
  } finally {
    process.env.PATH = previousPath;
  }
});
