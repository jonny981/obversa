// The frame text claimed with each terminal decision, keyed by the decision
// object itself. Module-private to the surfacer: the server records the
// frame at the claim, the launcher reads it to write it verbatim, and neither
// the public decision nor any public export carries the store.
//
// The store is a plain list read by index, and the record and the read below
// call no method on any prototype — no WeakMap.prototype.get, no
// Array.prototype.push, no Function.prototype.call — because app code running
// after the claim could replace any of those and hand the launcher another
// text. Index access and `length` are the list's own data properties, which
// no prototype change can redirect. One entry is kept per claim made in this
// process; a launcher makes one.
const entries = [];

/** Record the frame text claimed with a decision. */
export function recordFrame(claim, text) {
  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index][0] === claim) {
      entries[index][1] = text;
      return;
    }
  }
  entries[entries.length] = [claim, text];
}

/** The frame text claimed with a decision, or undefined. */
export function frameOf(claim) {
  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index][0] === claim) return entries[index][1];
  }
  return undefined;
}
