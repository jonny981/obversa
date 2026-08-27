import { test } from "node:test";
import assert from "node:assert/strict";

import { langForPath } from "../src/lang.mjs";

test("maps common extensions to shiki language ids", () => {
  assert.equal(langForPath("src/app.js"), "javascript");
  assert.equal(langForPath("src/app.mjs"), "javascript");
  assert.equal(langForPath("a/b/c.ts"), "typescript");
  assert.equal(langForPath("component.tsx"), "tsx");
  assert.equal(langForPath("data.json"), "json");
  assert.equal(langForPath("README.md"), "markdown");
  assert.equal(langForPath("styles.css"), "css");
  assert.equal(langForPath("script.py"), "python");
  assert.equal(langForPath("main.go"), "go");
  assert.equal(langForPath("deploy.yml"), "yaml");
});

test("recognises known basenames without an extension", () => {
  assert.equal(langForPath("Dockerfile"), "docker");
  assert.equal(langForPath("services/api/Dockerfile"), "docker");
  assert.equal(langForPath("Makefile"), "make");
});

test("falls back to plaintext for unknown or missing extensions", () => {
  assert.equal(langForPath("LICENSE"), "plaintext");
  assert.equal(langForPath("weird.qwerty"), "plaintext");
  assert.equal(langForPath(".gitignore"), "plaintext");
  assert.equal(langForPath(""), "plaintext");
  assert.equal(langForPath(null), "plaintext");
});
