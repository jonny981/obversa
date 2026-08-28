import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { frameResult } from "../src/handoff.mjs";
import { startSurface } from "../src/server.mjs";

const assetsDir = mkdtempSync(path.join(os.tmpdir(), "surfacer-race-"));
writeFileSync(path.join(assetsDir, "index.html"), "<!doctype html><title>t</title>");

function tokenOf(surface) {
  return surface.url.split("#")[1];
}

function post(surface, pathname, body) {
  return fetch(`${surface.origin}${pathname}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenOf(surface)}`, "Content-Type": "application/json", Origin: surface.origin },
    body: JSON.stringify(body),
  });
}

test("of two racing completions exactly one reports success; the other gets 409", async () => {
  const surface = await startSurface({
    app: "race",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    api: {
      // Both handlers are in flight before either completes.
      "POST /api/answer": async ({ body, session }) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        session.complete({ from: body.from });
        return null;
      },
    },
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    const [first, second] = await Promise.all([post(surface, "/api/answer", { from: "a" }), post(surface, "/api/answer", { from: "b" })]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409], "one winner, one loser");
    const winner = first.status === 200 ? first : second;
    const { operationId } = await winner.json();
    assert.ok(operationId, "the winner receives the operation id to acknowledge");
    const ack = await post(surface, "/api/ack", { operationId });
    assert.equal(ack.status, 200);
    const decision = await surface.waitForDecision();
    assert.equal(decision.status, "completed");
    // The framed result is the winner's payload and nothing else.
    assert.ok(["a", "b"].includes(decision.payload.from));
  } finally {
    await surface.stop();
  }
});

test("a bystander in flight during the winner's completion, and a loser that swallows its 409, both get 409", async () => {
  const surface = await startSurface({
    app: "race2",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    api: {
      "POST /api/answer": async ({ session }) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        session.complete({ from: "winner" });
        return null;
      },
      // Never completes; merely overlaps the winner.
      "POST /api/bystander": async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return null;
      },
      // Tries to complete after the winner, hides its own 409, returns normally.
      "POST /api/swallow": async ({ session }) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        try { session.complete({ from: "loser" }); } catch { /* swallowed on purpose */ }
        return null;
      },
    },
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    const [winner, bystander, swallow] = await Promise.all([
      post(surface, "/api/answer", {}),
      post(surface, "/api/bystander", {}),
      post(surface, "/api/swallow", {}),
    ]);
    assert.equal(winner.status, 200);
    const { operationId } = await winner.json();
    assert.ok(operationId);
    assert.equal(bystander.status, 409, "a request that completed nothing must not report success");
    assert.equal(swallow.status, 409, "a loser that hid its 409 must not report success");
    for (const r of [bystander, swallow]) {
      const body = await r.json();
      assert.equal(body.operationId, undefined, "the winner's operation id never reaches another client");
    }
    await post(surface, "/api/ack", { operationId });
    const decision = await surface.waitForDecision();
    assert.deepEqual(decision.payload, { from: "winner" });
  } finally {
    await surface.stop();
  }
});

// A POST whose JSON body arrives in two pieces over a real socket. The first
// piece goes out at once; the rest waits for release(). The server sees the
// headers, passes its open-session check, and then sits in the body read.
function stalledPost(surface, pathname, [head, tail] = ['{"half":', "true}"]) {
  const url = new URL(`${surface.origin}${pathname}`);
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const done = new Promise((resolve, reject) => {
    const request = http.request({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: { Authorization: `Bearer ${tokenOf(surface)}`, "Content-Type": "application/json", Origin: surface.origin },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") }));
    });
    request.on("error", reject);
    request.write(head, () => { released.then(() => request.end(tail)); });
  });
  return { done, release };
}

test("a request whose body is still arriving when the winner completes is refused before its handler runs", async () => {
  // The open-session check runs when the headers arrive; the body can take
  // longer. A session that closes in that gap must not run app code on a
  // closed session, must not report success, and must never hand over the
  // winner's operation id.
  let bystanderCalls = 0;
  const surface = await startSurface({
    app: "race3",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    api: {
      "POST /api/answer": async ({ session }) => { session.complete({ from: "winner" }); return null; },
      "POST /api/bystander": async () => { bystanderCalls += 1; return { body: { ordinary: true } }; },
    },
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    const stalled = stalledPost(surface, "/api/bystander");
    // Give the loopback server time to take the headers and enter the body read.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const winner = await post(surface, "/api/answer", {});
    assert.equal(winner.status, 200);
    const { operationId } = await winner.json();
    assert.ok(operationId);
    stalled.release();
    const late = await stalled.done;
    assert.equal(late.status, 409, "a body that lands after the session closed is refused");
    assert.equal(late.body.operationId, undefined, "the winner's operation id never reaches the late client");
    assert.equal(late.body.ordinary, undefined, "the late handler's response never reaches the wire");
    assert.equal(bystanderCalls, 0, "app code never runs on a closed session");
    await post(surface, "/api/ack", { operationId });
    const decision = await surface.waitForDecision();
    assert.deepEqual(decision.payload, { from: "winner" });
  } finally {
    await surface.stop();
  }
});

test("a heartbeat whose body lands after the session closed is refused, not renewed", async () => {
  // The built-in heartbeat has the same headers-then-body shape as an app
  // route; a session closed during its body read must answer 409, not 200.
  const surface = await startSurface({
    app: "race4",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    const stalled = stalledPost(surface, "/api/heartbeat", ["{", "}"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const cancel = await post(surface, "/api/cancel", {});
    assert.equal(cancel.status, 200);
    const { operationId } = await cancel.json();
    stalled.release();
    const late = await stalled.done;
    assert.equal(late.status, 409, "a heartbeat cannot succeed on a closed session");
    assert.equal(late.body.operationId, undefined);
    await post(surface, "/api/ack", { operationId });
    const decision = await surface.waitForDecision();
    assert.equal(decision.status, "cancelled");
  } finally {
    await surface.stop();
  }
});

test("a cancelled session carries the app's outcome payload, not null", async () => {
  const surface = await startSurface({
    app: "outcome",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    terminalPayload: (status) => ({ routed: true, status }),
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    const cancel = await post(surface, "/api/cancel", {});
    assert.equal(cancel.status, 200);
    const { operationId } = await cancel.json();
    await post(surface, "/api/ack", { operationId });
    const decision = await surface.waitForDecision();
    assert.equal(decision.status, "cancelled");
    assert.deepEqual(decision.payload, { routed: true, status: "cancelled" });
  } finally {
    await surface.stop();
  }
});

test("an outcome payload is redacted by default and exact with the verbatim opt-in", async () => {
  // A gate id can look like a token to the redactor; a review must be able to
  // keep it exact on every ending, while a generic app keeps the safe default.
  const tokenLike = "ghp_ABCDEFGHIJKLMNOPQRST";
  for (const [verbatim, expected] of [[false, false], [true, true]]) {
    const surface = await startSurface({
      app: "ids",
      assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
      terminalPayload: (status) => ({ gateId: tokenLike, status }),
      terminalPayloadVerbatim: verbatim,
      sessionTimeoutMs: 10_000,
      leaseTimeoutMs: 10_000,
    });
    try {
      const cancel = await post(surface, "/api/cancel", {});
      const { operationId } = await cancel.json();
      await post(surface, "/api/ack", { operationId });
      const decision = await surface.waitForDecision();
      assert.equal(decision.status, "cancelled");
      assert.equal(decision.payload.gateId === tokenLike, expected, `verbatim=${verbatim}: gateId ${decision.payload.gateId}`);
      if (!expected) assert.notEqual(decision.payload.gateId, tokenLike, "the default redacts a token-shaped value");
    } finally {
      await surface.stop();
    }
  }
});

test("a completion the frame cannot carry is refused and the session stays open", async () => {
  // The claim is a promise to frame the result on stdout. A payload JSON
  // cannot serialise must fail here, before the browser is told the session
  // completed, or the caller waits for a frame that never comes.
  const circular = { self: null };
  circular.self = circular;
  // What JSON cannot carry at all, and what it would carry with loss: a
  // function, a symbol, or an undefined value is dropped without a throw, a
  // non-finite number becomes null, a Map or Set becomes {}.
  const lossy = {
    bigint: { x: 1n },
    cycle: circular,
    fn: () => {},
    symbol: Symbol("s"),
    nestedfn: { keep: 1, fn() {} },
    undef: { x: undefined },
    nan: { n: Number.NaN },
    infinity: [1, Number.POSITIVE_INFINITY],
    map: new Map([["k", 1]]),
    set: { s: new Set([1]) },
    symbolkey: Object.assign({ keep: 1 }, { [Symbol.for("hidden")]: 2 }),
    nestedsymbolkey: { a: Object.assign({ keep: 1 }, { [Symbol.for("hidden")]: 2 }) },
    // Not plain: JSON turns each of these into {} or a fragment.
    regexp: /x/,
    error: new Error("e"),
    weakmap: new WeakMap(),
    promise: Promise.resolve(1),
    arraybuffer: new ArrayBuffer(4),
    typedarray: new Uint8Array(2),
    instance: new (class Point { constructor() { this.x = 1; } })(),
    nestedregexp: { keep: 1, exotic: /x/ },
    arrayextra: Object.assign([1], { extra: 2 }),
    hole: [1, , 3],
    nestedhole: { list: [1, , 3] },
    // No payload at all is not a payload; an app that means "nothing" passes null.
    rootundefined: undefined,
    // JSON writes -0 as 0 and skips a non-enumerable property.
    negzero: { n: -0 },
    rootnegzero: -0,
    hiddenprop: Object.defineProperty({ x: 1 }, "hidden", { value: 2, enumerable: false }),
    nestedhiddenprop: { a: Object.defineProperty({ x: 1 }, "hidden", { value: 2, enumerable: false }) },
    hiddensymbol: Object.defineProperty({ x: 1 }, Symbol("hidden"), { value: 2, enumerable: false }),
    // A Proxy may answer the serialiser differently from a check.
    proxy: new Proxy({ x: 1 }, {}),
    nestedproxy: { a: new Proxy({ x: 1 }, {}) },
    proxyarray: new Proxy([1], {}),
  };
  const surface = await startSurface({
    app: "frame",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    api: Object.fromEntries([
      ...Object.entries(lossy).flatMap(([name, payload]) => [
        [`POST /api/${name}`, async ({ session }) => { session.complete(payload); return null; }],
        [`POST /api/${name}-verbatim`, async ({ session }) => { session.complete(payload, { verbatim: true }); return null; }],
      ]),
      ["POST /api/good", async ({ session }) => { session.complete({ ok: 1 }); return null; }],
    ]),
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    for (const name of Object.keys(lossy)) {
      for (const route of [`/api/${name}`, `/api/${name}-verbatim`]) {
        const refused = await post(surface, route, {});
        assert.equal(refused.status, 500, `${route}: a completion the frame cannot carry whole is an error, not a success`);
        const body = await refused.json();
        assert.equal(body.operationId, undefined);
        assert.match(body.error, /cannot be framed/);
      }
    }
    // Nothing was claimed: a frameable completion still succeeds afterwards.
    const good = await post(surface, "/api/good", {});
    assert.equal(good.status, 200, "the session stayed open");
    const { operationId } = await good.json();
    await post(surface, "/api/ack", { operationId });
    const decision = await surface.waitForDecision();
    assert.equal(decision.status, "completed");
    assert.deepEqual(decision.payload, { ok: 1 });
  } finally {
    await surface.stop();
  }
});

// A payload that serialises cleanly once and then not again: stable on the
// first serialisation, a BigInt on every later one. Proving the frame on the
// live object and framing the live object later would pass and then fail.
function shiftyPayload() {
  let calls = 0;
  return {
    toJSON() {
      calls += 1;
      return calls === 1 ? { stable: true } : { later: 1n };
    },
  };
}

test("what is claimed is a snapshot: a payload that serialises differently later cannot break the frame", async () => {
  let getterCalls = 0;
  const shiftyGetter = { get value() { getterCalls += 1; return getterCalls === 1 ? "first" : 1n; } };
  const surface = await startSurface({
    app: "snapshot",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    api: {
      "POST /api/tojson": async ({ session }) => { session.complete(shiftyPayload(), { verbatim: true }); return null; },
      "POST /api/getter": async ({ session }) => { session.complete(shiftyGetter, { verbatim: true }); return null; },
    },
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    const completed = await post(surface, "/api/tojson", {});
    assert.equal(completed.status, 200);
    const { operationId } = await completed.json();
    await post(surface, "/api/ack", { operationId });
    const decision = await surface.waitForDecision();
    // The caller frames exactly what was proven, however the live object
    // answers now.
    assert.deepEqual(decision.payload, { stable: true });
    let frame;
    assert.doesNotThrow(() => { frame = frameResult(decision); });
    assert.match(frame, /"stable":true/);
    assert.doesNotMatch(frame, /later/);
  } finally {
    await surface.stop();
  }
  const second = await startSurface({
    app: "snapshot2",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    api: { "POST /api/getter": async ({ session }) => { session.complete(shiftyGetter, { verbatim: true }); return null; } },
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    const completed = await post(second, "/api/getter", {});
    assert.equal(completed.status, 200);
    const { operationId } = await completed.json();
    await post(second, "/api/ack", { operationId });
    const decision = await second.waitForDecision();
    assert.deepEqual(decision.payload, { value: "first" });
    assert.doesNotThrow(() => frameResult(decision));
  } finally {
    await second.stop();
  }
});

test("hidden state is not data: an object with its prototype removed is carried as its observable own data", async () => {
  // The contract is observable own data. A URL or a Map with its prototype
  // removed keeps its address or entries inside, but that is not data: what
  // is framed is exactly the own enumerable data properties, and the page
  // says so.
  const surface = await startSurface({
    app: "observable",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    api: {
      "POST /api/url": async ({ session }) => {
        session.complete({ a: Object.setPrototypeOf(Object.assign(new URL("https://a.example/one"), { visible: 1 }), null), m: Object.setPrototypeOf(new Map([["k", 1]]), null) }, { verbatim: true });
        return null;
      },
    },
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    const completed = await post(surface, "/api/url", {});
    assert.equal(completed.status, 200);
    const { operationId } = await completed.json();
    await post(surface, "/api/ack", { operationId });
    const decision = await surface.waitForDecision();
    assert.deepEqual(decision.payload, { a: { visible: 1 }, m: {} });
  } finally {
    await surface.stop();
  }
});

test("a callable toJSON takes precedence: the holder — even a Proxy answering it through a trap — is carried as what toJSON returns, and that return is checked", async () => {
  // JSON does Get(value, "toJSON"); this Proxy has no own toJSON at all and
  // answers the get through its trap. What it returns is what is traversed.
  const proxied = (returned) => new Proxy({ hidden: 1 }, { get(t, k, r) { return k === "toJSON" ? () => returned : Reflect.get(t, k, r); } });
  const surface = await startSurface({
    app: "tojson-wins",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    api: {
      "POST /api/bad": async ({ session }) => { session.complete(proxied({ later: 1n })); return null; },
      "POST /api/bad-nested": async ({ session }) => { session.complete({ a: proxied(() => {}) }, { verbatim: true }); return null; },
      "POST /api/good": async ({ session }) => { session.complete({ root: proxied({ visible: 1 }), nested: { p: proxied([1, "two"]) } }, { verbatim: true }); return null; },
    },
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    for (const route of ["/api/bad", "/api/bad-nested"]) {
      const refused = await post(surface, route, {});
      assert.equal(refused.status, 500, `${route}: what toJSON returned is checked by the same rule`);
      assert.equal((await refused.json()).operationId, undefined);
    }
    const completed = await post(surface, "/api/good", {});
    assert.equal(completed.status, 200, "a Proxy holder with toJSON is replaced by what toJSON returned");
    const { operationId } = await completed.json();
    await post(surface, "/api/ack", { operationId });
    const decision = await surface.waitForDecision();
    assert.deepEqual(decision.payload, { root: { visible: 1 }, nested: { p: [1, "two"] } });
  } finally {
    await surface.stop();
  }
  // The outcome hook follows the same precedence.
  const outcome = await startSurface({
    app: "tojson-outcome",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    terminalPayload: () => proxied({ visible: 1 }),
    terminalPayloadVerbatim: true,
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    const decision = outcome.waitForDecision();
    outcome.interrupt("test");
    assert.deepEqual((await decision).payload, { visible: 1 });
  } finally {
    await outcome.stop();
  }
});

test("plain data of any shape is carried, including null-prototype objects and toJSON values", async () => {
  const surface = await startSurface({
    app: "plain",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    api: {
      "POST /api/answer": async ({ session }) => {
        session.complete(Object.assign(Object.create(null), { when: new Date(0), list: [1, "two", null, { deep: true }], text: "ok" }), { verbatim: true });
        return null;
      },
    },
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    const completed = await post(surface, "/api/answer", {});
    assert.equal(completed.status, 200);
    const { operationId } = await completed.json();
    await post(surface, "/api/ack", { operationId });
    const decision = await surface.waitForDecision();
    assert.deepEqual(decision.payload, { when: "1970-01-01T00:00:00.000Z", list: [1, "two", null, { deep: true }], text: "ok" });
  } finally {
    await surface.stop();
  }
});

test("an outcome payload is a snapshot too: the ending frames what the hook first answered", async () => {
  const surface = await startSurface({
    app: "outcome-snapshot",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    terminalPayload: () => shiftyPayload(),
    terminalPayloadVerbatim: true,
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    const decision = surface.waitForDecision();
    surface.interrupt("test");
    const ending = await decision;
    assert.equal(ending.status, "interrupted");
    assert.deepEqual(ending.payload, { stable: true });
    assert.doesNotThrow(() => frameResult(ending));
  } finally {
    await surface.stop();
  }
});

test("an outcome payload the frame cannot carry whole becomes null, and the ending still arrives", async () => {
  const hooks = {
    bigint: () => ({ x: 1n }),
    fn: () => () => {},
    symbol: () => Symbol("s"),
    nestedfn: () => ({ keep: 1, fn() {} }),
    undef: () => ({ x: undefined }),
    map: () => new Map([["k", 1]]),
    symbolkey: () => Object.assign({ keep: 1 }, { [Symbol.for("hidden")]: 2 }),
    regexp: () => /x/,
    error: () => ({ failed: new Error("e") }),
    hiddensymbol: () => Object.defineProperty({ x: 1 }, Symbol("hidden"), { value: 2, enumerable: false }),
    proxy: () => new Proxy({ x: 1 }, {}),
  };
  for (const [name, terminalPayload] of Object.entries(hooks)) {
    for (const verbatim of [false, true]) {
      const surface = await startSurface({
        app: `outcome-${name}`,
        assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
        terminalPayload,
        terminalPayloadVerbatim: verbatim,
        sessionTimeoutMs: 10_000,
        leaseTimeoutMs: 10_000,
      });
      try {
        const decision = surface.waitForDecision();
        surface.interrupt("test");
        const ending = await decision;
        assert.equal(ending.status, "interrupted");
        assert.equal(ending.payload, null, `${name} verbatim=${verbatim}: no outcome is framed as no outcome`);
        assert.ok(Object.hasOwn(ending, "payload"), "the payload key is present, never silently dropped");
        assert.match(frameResult(ending), /"payload":null/);
      } finally {
        await surface.stop();
      }
    }
  }
});

test("the app name is read once at start: an empty one is refused, a changing one cannot break the frame", async () => {
  // frameResult names its markers from the app. A truthy app whose string
  // value is empty has no marker, and must fail before any session exists;
  // punctuation-only names keep the existing rule and collapse to `_`.
  const assets = { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } };
  await assert.rejects(() => startSurface({ app: { toString() { return ""; } }, assets }), /app name/);
  for (const app of ["---", "   ", "my-app.v2"]) {
    const fine = await startSurface({ app, assets, sessionTimeoutMs: 10_000, leaseTimeoutMs: 10_000 });
    await fine.stop();
  }
  // An app object that answers differently after start frames under the name
  // it gave at start, because nothing asks it again.
  let asked = 0;
  const shifty = { toString() { asked += 1; return asked === 1 ? "first" : ""; } };
  const surface = await startSurface({
    app: shifty,
    assets,
    api: { "POST /api/answer": async ({ session }) => { session.complete({ ok: 1 }); return null; } },
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    const completed = await post(surface, "/api/answer", {});
    assert.equal(completed.status, 200);
    const { operationId } = await completed.json();
    await post(surface, "/api/ack", { operationId });
    const decision = await surface.waitForDecision();
    assert.equal(decision.app, "first");
    assert.match(frameResult(decision), /<<<FIRST_RESULT_V1>>>/);
  } finally {
    await surface.stop();
  }
});

test("the claim owns its data: what complete() returns can be mutated without touching the frame", async () => {
  const surface = await startSurface({
    app: "own",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    api: {
      "POST /api/answer": async ({ session }) => {
        const returned = session.complete({ ok: 1, list: [1] }, { verbatim: true });
        // A handler that keeps mutating what it got back.
        returned.payload.ok = 2;
        returned.payload.list.push(2);
        returned.app = "";
        returned.payload = { replaced: true };
        return null;
      },
    },
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    const completed = await post(surface, "/api/answer", {});
    assert.equal(completed.status, 200);
    const { operationId } = await completed.json();
    await post(surface, "/api/ack", { operationId });
    const decision = await surface.waitForDecision();
    assert.deepEqual(decision.payload, { ok: 1, list: [1] });
    assert.equal(decision.app, "own");
    assert.match(frameResult(decision), /<<<OWN_RESULT_V1>>>/);
  } finally {
    await surface.stop();
  }
});

test("nothing that can fail runs after the claim: a failing copy leaves the session unclaimed", async () => {
  // The handler's copy is made before the claim. If it fails, the request
  // errors and the session is still open; a claimed session whose request
  // errored would have no operation id for the browser to acknowledge.
  const original = globalThis.structuredClone;
  const surface = await startSurface({
    app: "copy",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    api: {
      "POST /api/answer": async ({ session }) => {
        globalThis.structuredClone = () => { throw new Error("no copies today"); };
        try {
          session.complete({ ok: 1 });
        } finally {
          globalThis.structuredClone = original;
        }
        return null;
      },
      "POST /api/good": async ({ session }) => { session.complete({ ok: 2 }); return null; },
    },
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    const refused = await post(surface, "/api/answer", {});
    assert.equal(refused.status, 500);
    assert.equal((await refused.json()).operationId, undefined);
    const good = await post(surface, "/api/good", {});
    assert.equal(good.status, 200, "the session was never claimed");
    const { operationId } = await good.json();
    await post(surface, "/api/ack", { operationId });
    const decision = await surface.waitForDecision();
    assert.deepEqual(decision.payload, { ok: 2 });
  } finally {
    globalThis.structuredClone = original;
    await surface.stop();
  }
});

test("once a handler has completed, its response is the fixed acknowledgement whatever it returns", async () => {
  // A body returned after completing is ordinary app output; serialising it
  // could fail after the claim and leave the browser unable to acknowledge.
  const surface = await startSurface({
    app: "ackonly",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    api: {
      "POST /api/bigint-body": async ({ session }) => { session.complete({ delivered: true }); return { body: { cannotSerialize: 1n } }; },
      "POST /api/shaped-body": async ({ session }) => { session.complete({ delivered: true }); return { status: 418, body: { extra: 1 } }; },
    },
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    const completed = await post(surface, "/api/bigint-body", {});
    assert.equal(completed.status, 200, "the claim stands and the browser can acknowledge it");
    const body = await completed.json();
    assert.ok(body.operationId);
    assert.deepEqual(Object.keys(body).sort(), ["ok", "operationId"]);
    await post(surface, "/api/ack", { operationId: body.operationId });
    const decision = await surface.waitForDecision();
    assert.deepEqual(decision.payload, { delivered: true });
  } finally {
    await surface.stop();
  }
  const second = await startSurface({
    app: "ackonly2",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    api: { "POST /api/shaped-body": async ({ session }) => { session.complete({ delivered: true }); return { status: 418, body: { extra: 1 } }; } },
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    const completed = await post(second, "/api/shaped-body", {});
    assert.equal(completed.status, 200, "a status the handler returned after completing is not used");
    const body = await completed.json();
    assert.equal(body.extra, undefined, "a body the handler returned after completing is not merged");
    assert.ok(body.operationId);
    await post(second, "/api/ack", { operationId: body.operationId });
    await second.waitForDecision();
  } finally {
    await second.stop();
  }
});

test("timer inputs are validated at start, never inside a claim", async () => {
  const assets = { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } };
  await assert.rejects(() => startSurface({ app: "t", assets, ackTimeoutMs: 1n }), /ackTimeoutMs must be a positive integer/);
  await assert.rejects(() => startSurface({ app: "t", assets, ackTimeoutMs: Symbol("s") }), /ackTimeoutMs must be a positive integer/);
  await assert.rejects(() => startSurface({ app: "t", assets, sessionTimeoutMs: -1 }), /sessionTimeoutMs must be a positive integer/);
  await assert.rejects(() => startSurface({ app: "t", assets, leaseTimeoutMs: "soon" }), /leaseTimeoutMs must be a positive integer/);
  await assert.rejects(() => startSurface({ app: "t", assets, sessionTimeoutMs: Number.NaN }), /sessionTimeoutMs must be a positive integer/);
  // Node clamps a delay above 2^31 - 1 to 1 ms and truncates a fraction.
  await assert.rejects(() => startSurface({ app: "t", assets, sessionTimeoutMs: 2_147_483_648 }), /sessionTimeoutMs must be a positive integer/);
  await assert.rejects(() => startSurface({ app: "t", assets, leaseTimeoutMs: 1.5 }), /leaseTimeoutMs must be a positive integer/);
  const edge = await startSurface({ app: "t", assets, sessionTimeoutMs: 2_147_483_647, leaseTimeoutMs: 1, ackTimeoutMs: 1 });
  await edge.stop();
});

test("terminalPayload must be a function, and a throwing one yields null", async () => {
  await assert.rejects(() => startSurface({
    app: "bad",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    terminalPayload: "nope",
  }), TypeError);
  const surface = await startSurface({
    app: "throws",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    terminalPayload: () => { throw new Error("boom"); },
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    const decision = surface.waitForDecision();
    surface.interrupt("test");
    assert.equal((await decision).payload, null);
  } finally {
    await surface.stop();
  }
});
