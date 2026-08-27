// Server-side syntax highlighter for the review surface, derived from grok's
// CSP-verified shiki highlighter (scratch: grok-highlight, proven in headless
// Chrome under script-src 'self'; style-src 'self': zero inline styles, colours
// from a static class sheet). This variant returns TOKENS per line instead of
// HTML strings, so the browser builds each line with createElement + textContent
// and never uses innerHTML. That keeps the original renderer's guarantee — code
// under review can never execute or break out — while adding highlighting.
//
// A whole review is highlighted in many small snippets (one per hunk side), so
// the class ids must stay consistent across every snippet to share one served
// stylesheet. A registry threads that shared (colour -> class) map: highlight
// each snippet with `highlightInto(registry, ...)`, then emit the sheet once
// with `registryToCss(registry)`.
//
// Shiki tokenizes on the server; the browser only paints class spans + the
// static stylesheet. The JavaScript regex engine is required: the default
// Oniguruma engine loads WASM, which script-src 'self' would block.

import { createRequire } from "node:module";
import { createHighlighter } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

const require = createRequire(import.meta.url);
export const SHIKI_VERSION = require("shiki/package.json").version;
export const DEFAULT_THEME = "github-dark-default";

const FONT_ITALIC = 1;
const FONT_BOLD = 2;
const FONT_UNDERLINE = 4;
const FONT_STRIKE = 8;
const PLAIN_LANGS = new Set(["text", "plaintext", "txt", "plain"]);

let highlighterPromise;

function getHighlighter(theme) {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({ langs: [], themes: [theme], engine: createJavaScriptRegexEngine({ forgiving: true }) });
  }
  return highlighterPromise;
}

function normalizeColor(value) {
  return value ? value.toLowerCase() : "";
}

function styleKey(token) {
  return `${normalizeColor(token.color)}|${normalizeColor(token.bgColor)}|${token.fontStyle || 0}`;
}

// A token that paints in the theme's default foreground with no background and
// no font style needs no class: it renders as a bare text node.
function isPlainToken(token, fg) {
  const fontStyle = token.fontStyle || 0;
  if (token.bgColor || fontStyle) return false;
  const color = normalizeColor(token.color);
  return !color || color === fg;
}

function cssDecls(key) {
  const [color, bg, fontRaw] = key.split("|");
  const fontStyle = Number(fontRaw);
  const decls = [];
  if (color) decls.push(`color: ${color}`);
  if (bg) decls.push(`background-color: ${bg}`);
  if (fontStyle & FONT_ITALIC) decls.push("font-style: italic");
  if (fontStyle & FONT_BOLD) decls.push("font-weight: 700");
  const decorations = [];
  if (fontStyle & FONT_UNDERLINE) decorations.push("underline");
  if (fontStyle & FONT_STRIKE) decorations.push("line-through");
  if (decorations.length) decls.push(`text-decoration: ${decorations.join(" ")}`);
  return decls.join("; ");
}

async function resolveLang(highlighter, lang) {
  if (PLAIN_LANGS.has(lang)) return "plaintext";
  if (highlighter.getLoadedLanguages().includes(lang)) return lang;
  try {
    await highlighter.loadLanguage(lang);
    return lang;
  } catch {
    return "plaintext";
  }
}

async function resolveTheme(highlighter, theme) {
  if (highlighter.getLoadedThemes().includes(theme)) return theme;
  try {
    await highlighter.loadTheme(theme);
    return theme;
  } catch {
    return DEFAULT_THEME;
  }
}

/**
 * A style registry shared across every snippet of one review, so the served
 * stylesheet is single and consistent.
 * @returns {{ classByKey: Map<string, number>, fg: string, bg: string }}
 */
export function createHighlightRegistry() {
  return { classByKey: new Map(), fg: "", bg: "" };
}

/**
 * Highlight one snippet into a shared registry.
 * @param {{ classByKey: Map<string, number>, fg: string, bg: string }} registry
 * @param {{ code: string, lang: string, theme?: string }} input
 * @returns {Promise<Array<Array<{ text: string, cls: string | null }>>>} per-line
 *   token arrays; token `text` is raw (the browser escapes via textContent), a
 *   `cls: null` token is a bare text node, otherwise `cls` names a rule that
 *   `registryToCss` will emit. Concatenating a line's token text reproduces the
 *   source line; a blank line is an empty array.
 */
export async function highlightInto(registry, { code, lang, theme = DEFAULT_THEME }) {
  if (typeof code !== "string") throw new TypeError("code must be a string");
  if (typeof lang !== "string" || lang.length === 0) throw new TypeError("lang must be a non-empty string");
  if (typeof theme !== "string" || theme.length === 0) throw new TypeError("theme must be a non-empty string");

  const highlighter = await getHighlighter(theme);
  const resolvedTheme = await resolveTheme(highlighter, theme);
  const resolvedLang = await resolveLang(highlighter, lang);
  const result = highlighter.codeToTokens(code, { lang: resolvedLang, theme: resolvedTheme });
  const fg = normalizeColor(result.fg);
  if (!registry.fg) registry.fg = fg;
  if (!registry.bg) registry.bg = normalizeColor(result.bg);

  return result.tokens.map((lineTokens) => {
    const out = [];
    for (const token of lineTokens) {
      if (!token.content) continue;
      if (isPlainToken(token, fg)) {
        out.push({ text: token.content, cls: null });
        continue;
      }
      const key = styleKey(token);
      let id = registry.classByKey.get(key);
      if (id === undefined) {
        id = registry.classByKey.size;
        registry.classByKey.set(key, id);
      }
      out.push({ text: token.content, cls: `tok-${id}` });
    }
    return out;
  });
}

/**
 * Emit the stylesheet for everything highlighted into the registry. The rules
 * are class-based, so they serve under style-src 'self' with no inline styles.
 */
export function registryToCss(registry) {
  return [
    `/* shiki ${SHIKI_VERSION} fg:${registry.fg} bg:${registry.bg} */`,
    `:root { --hl-fg: ${registry.fg}; --hl-bg: ${registry.bg}; }`,
    ...[...registry.classByKey.entries()].map(([key, id]) => `.tok-${id} { ${cssDecls(key)}; }`),
  ].join("\n") + "\n";
}

/**
 * Convenience: highlight a single snippet with its own registry.
 * @param {{ code: string, lang: string, theme?: string }} input
 * @returns {Promise<{ lines: Array<Array<{ text: string, cls: string | null }>>, css: string }>}
 */
export async function highlightToTokens({ code, lang, theme = DEFAULT_THEME }) {
  const registry = createHighlightRegistry();
  const lines = await highlightInto(registry, { code, lang, theme });
  return { lines, css: registryToCss(registry) };
}
