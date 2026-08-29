// The frame text claimed with each terminal decision, keyed by the decision
// object itself. Module-private to the surfacer: the server records the
// frame at the claim, the launcher reads it to write it verbatim, and neither
// the public decision nor any public export carries the store. A WeakMap
// holds no reference of its own, so a decision the caller drops takes its
// frame with it — a launcher proof carries a multi-megabyte frame, and a
// process that runs session after session must not keep every one.
//
// The store's get and set are bound to it here, at module load, before any
// app code runs: a handler that later replaces WeakMap.prototype.get or .set
// changes nothing, because the record and the read call the bound functions
// captured now and never look either up again. The WeakMap itself is not
// exported; only these two functions are.
const frames = new WeakMap();
const getFrame = frames.get.bind(frames);
const setFrame = frames.set.bind(frames);

/** Record the frame text claimed with a decision. */
export function recordFrame(claim, text) {
  setFrame(claim, text);
}

/** The frame text claimed with a decision, or undefined. */
export function frameOf(claim) {
  return getFrame(claim);
}
