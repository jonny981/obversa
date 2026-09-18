import assert from "node:assert/strict";
import { test } from "node:test";
import { ICONS, KNOWN_EXTS, iconFor } from "../assets/icons.mjs";

const FORBIDDEN = /<script|onload=|onerror=|onclick=|javascript:|xlink:href|href\s*=\s*["'](?:https?:|\/\/)/i;

function assertSafeSvg(svg, label) {
  assert.equal(typeof svg, "string", label);
  assert.match(svg, /^<svg[\s>]/, `${label} must be a single-root svg`);
  assert.match(svg, /<\/svg>$/, `${label} must close the svg root`);
  assert.match(svg, /viewBox="0 0 16 16"/, `${label} must be 16x16`);
  assert.doesNotMatch(svg, FORBIDDEN, `${label} must not carry script, handlers, or external href`);
  assert.equal(svg.indexOf("<svg"), 0);
  assert.equal(svg.lastIndexOf("</svg>"), svg.length - "</svg>".length);
}

test("iconFor returns a safe svg for every known extension", () => {
  for (const ext of KNOWN_EXTS) {
    const svg = iconFor(`src/module.${ext}`);
    assertSafeSvg(svg, ext);
    assert.equal(svg, ICONS[ext]);
  }
});

test("unknown files use the generic file icon", () => {
  const fallback = iconFor("notes.unknown");
  assertSafeSvg(fallback, "file");
  assert.equal(fallback, ICONS.file);
  assert.equal(iconFor("Makefile"), ICONS.file);
  assert.equal(iconFor(""), ICONS.file);
});

test("folders use the generic folder icon", () => {
  assert.equal(iconFor("src/", "folder"), ICONS.folder);
  assert.equal(iconFor("src/"), ICONS.folder);
  assertSafeSvg(ICONS.folder, "folder");
});

test("the map only contains single-root svgs with no external refs", () => {
  for (const [name, svg] of Object.entries(ICONS)) {
    assertSafeSvg(svg, name);
  }
});

test("language icons use Pierre palette colours", () => {
  assert.match(iconFor("a.js"), /#ffd452/);
  assert.match(iconFor("a.ts"), /#68cdf2/);
  assert.match(iconFor("a.css"), /#9d6afb/);
  assert.match(iconFor("a.html"), /#ffa359/);
  assert.match(iconFor("a.py"), /#69b1ff/);
  assert.match(iconFor("a.py"), /#ffd452/);
  assert.match(iconFor("a.sh"), /#5ecc71/);
  assert.match(iconFor("a.go"), /#68cdf2/);
  assert.match(iconFor("a.rs"), /#ffa359/);
  assert.equal(iconFor("a.js"), iconFor("a.mjs"));
  assert.equal(iconFor("a.jsx"), iconFor("a.js"));
  assert.equal(iconFor("a.tsx"), iconFor("a.ts"));
  assert.equal(iconFor("a.scss"), iconFor("a.css"));
});
