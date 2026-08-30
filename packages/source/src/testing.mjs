// The public testing subpath: what another package's proof may import.
//
// A test that lives outside this package never reaches into src by path; it
// imports "@obversa/source/testing" and gets exactly the internals the proofs
// exercise. This is a proof surface, not API: nothing here carries the
// stability promise of the package root, and an entry leaves when the last
// proof that needs it does.

export { listTrackedFiles } from "./git.mjs";
export { createHighlightRegistry, registryToCss } from "./highlight.mjs";
export { highlightModel } from "./highlight-model.mjs";
export { contextModel } from "./context-model.mjs";
export { navModel } from "./nav-model.mjs";
