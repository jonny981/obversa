import { test } from "node:test";
import assert from "node:assert/strict";

import {
  highlightToTokens,
  createHighlightRegistry,
  highlightInto,
  registryToCss,
  SHIKI_VERSION,
  DEFAULT_THEME,
} from "../src/highlight.mjs";

test("pins shiki 4.4.3", () => {
  assert.equal(SHIKI_VERSION, "4.4.3");
});

test("returns per-line token arrays that round-trip to the source", async () => {
  const code = 'const x = 1; // hi\nconst s = "<b>";';
  const { lines } = await highlightToTokens({ code, lang: "javascript" });
  assert.equal(lines.length, 2);
  const rebuilt = lines.map((tokens) => tokens.map((t) => t.text).join("")).join("\n");
  assert.equal(rebuilt, code);
});

test("token text is raw, not HTML-escaped (the browser escapes via textContent)", async () => {
  const { lines } = await highlightToTokens({ code: 'const s = "<script>";', lang: "javascript" });
  const text = lines[0].map((t) => t.text).join("");
  assert.match(text, /<script>/); // literal, not &lt;script&gt;
});

test("every non-null class has a css rule; plain tokens carry no class", async () => {
  const { lines, css } = await highlightToTokens({ code: "export function add(a, b) {\n  return a + b;\n}", lang: "js" });
  const used = new Set();
  for (const tokens of lines) for (const t of tokens) if (t.cls) used.add(t.cls);
  assert.ok(used.size > 0);
  for (const cls of used) assert.match(css, new RegExp(`\\.${cls} \\{`));
  // css carries the theme foreground/background as variables
  assert.match(css, /--hl-fg:/);
  assert.match(css, /--hl-bg:/);
});

test("css never contains a style attribute and tokens are plain objects", async () => {
  const { lines, css } = await highlightToTokens({ code: "const x = 1", lang: "javascript" });
  assert.doesNotMatch(css, /\sstyle\s*=/i);
  for (const tokens of lines) for (const t of tokens) {
    assert.equal(typeof t.text, "string");
    assert.ok(t.cls === null || typeof t.cls === "string");
  }
});

test("blank and whitespace-only lines round-trip", async () => {
  const { lines } = await highlightToTokens({ code: "const x = 1\n\n  \n", lang: "javascript" });
  const rebuilt = lines.map((tokens) => tokens.map((t) => t.text).join("")).join("\n");
  assert.equal(rebuilt, "const x = 1\n\n  \n");
});

test("unknown lang falls back to plaintext without throwing", async () => {
  const { lines } = await highlightToTokens({ code: "hello <world>", lang: "not-a-real-language" });
  const text = lines.map((tokens) => tokens.map((t) => t.text).join("")).join("\n");
  assert.equal(text, "hello <world>");
});

test("rejects a non-string code and an empty lang", async () => {
  await assert.rejects(() => highlightToTokens({ code: /** @type {any} */ (123), lang: "javascript" }), TypeError);
  await assert.rejects(() => highlightToTokens({ code: "x", lang: "" }), TypeError);
});

test("default theme is the dark surface theme", () => {
  assert.equal(DEFAULT_THEME, "github-dark-default");
});

test("a registry shares class ids across snippets and emits one consistent sheet", async () => {
  const registry = createHighlightRegistry();
  const a = await highlightInto(registry, { code: "const x = 1", lang: "js" });
  const b = await highlightInto(registry, { code: "function f() { return 2; }", lang: "js" });
  const css = registryToCss(registry);

  const used = new Set();
  for (const tokens of [...a, ...b]) for (const t of tokens) if (t.cls) used.add(t.cls);
  assert.ok(used.size > 0);
  for (const cls of used) assert.match(css, new RegExp(`\\.${cls} \\{`));

  // Each class id is defined exactly once (no cross-snippet collision).
  for (const cls of used) {
    const count = css.split(`.${cls} {`).length - 1;
    assert.equal(count, 1, `${cls} should have exactly one rule`);
  }
  // One :root variable block for the whole review.
  assert.equal(css.split(":root {").length - 1, 1);
});
