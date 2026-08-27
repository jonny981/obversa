// Map a file path to a shiki language id for highlighting. Unknown extensions
// fall back to "plaintext"; the highlighter also falls back safely if a returned
// id turns out to be unloadable, so this map can be generous.

const BY_EXT = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  json: "json", jsonc: "json", json5: "json5",
  md: "markdown", markdown: "markdown", mdx: "mdx",
  css: "css", scss: "scss", sass: "sass", less: "less",
  html: "html", htm: "html", xml: "xml", svg: "xml", vue: "vue", svelte: "svelte", astro: "astro",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", scala: "scala",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", cs: "csharp",
  sh: "bash", bash: "bash", zsh: "bash", fish: "fish", ps1: "powershell",
  yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini", env: "dotenv",
  sql: "sql", graphql: "graphql", gql: "graphql", proto: "proto",
  php: "php", swift: "swift", lua: "lua", r: "r", pl: "perl", ex: "elixir", exs: "elixir",
  hs: "haskell", clj: "clojure", elm: "elm", dart: "dart", zig: "zig",
};

const BY_BASENAME = {
  dockerfile: "docker",
  makefile: "make",
  ".gitignore": "plaintext",
  ".npmrc": "ini",
};

export function langForPath(path) {
  if (typeof path !== "string" || path.length === 0) return "plaintext";
  const base = path.split("/").pop().toLowerCase();
  if (Object.hasOwn(BY_BASENAME, base)) return BY_BASENAME[base];
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "plaintext"; // no extension, or a dotfile with no type
  return BY_EXT[base.slice(dot + 1)] || "plaintext";
}
