// The frame text claimed with each terminal decision, keyed by the decision
// object itself. Module-private to the surfacer: the server records the
// frame at the claim, the launcher reads it to write it verbatim, and neither
// the public decision nor any public export carries it. A WeakMap holds no
// reference of its own, so a decision the caller drops takes its frame with
// it.
export const claimFrames = new WeakMap();
