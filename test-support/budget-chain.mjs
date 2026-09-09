/**
 * @typedef {readonly [string, number]} BudgetPhase
 * @typedef {{ setup: number, phases: readonly BudgetPhase[], cleanup: number }} BudgetChainDefinition
 * @typedef {{
 *   name: string,
 *   budgetMs: number,
 *   totalMs: number,
 *   allowance: (phase: string) => number,
 *   run: <Value>(phase: string, operation: (signal: AbortSignal) => Value | PromiseLike<Value>) => Promise<Value>,
 * }} BudgetChain
 */

/**
 * Declare one test's sequential timeout path and return the same guards for
 * the waits on that path. The import-time check keeps a stale chain from
 * passing silently after a phase is added.
 *
 * @param {string} name
 * @param {number} budgetMs
 * @param {BudgetChainDefinition} definition
 * @returns {BudgetChain}
 */
export function defineBudgetChain(name, budgetMs, { setup, phases, cleanup }) {
  if (typeof name !== "string" || name.length === 0) throw new TypeError("budget chain name must be non-empty");
  if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0) throw new TypeError(`${name} budget must be a positive safe integer`);

  const entries = [["setup", setup], ...phases, ["cleanup", cleanup]];
  const seen = new Set();
  for (const [phase, allowance] of entries) {
    if (typeof phase !== "string" || phase.length === 0) throw new TypeError(`${name} has an unnamed phase`);
    if (seen.has(phase)) throw new TypeError(`${name} declares phase ${phase} more than once`);
    if (!Number.isSafeInteger(allowance) || allowance <= 0) throw new TypeError(`${name} phase ${phase} must be a positive safe integer`);
    seen.add(phase);
  }

  const totalMs = entries.reduce((total, [, allowance]) => total + allowance, 0);
  if (totalMs >= budgetMs) {
    throw new RangeError(`${name} budget chain exceeds its test budget: ${totalMs}ms >= ${budgetMs}ms`);
  }

  const allowances = new Map(entries);
  return Object.freeze({
    name,
    budgetMs,
    totalMs,
    allowance(phase) {
      const allowance = allowances.get(phase);
      if (allowance === undefined) throw new RangeError(`${name} has no phase named ${phase}`);
      return allowance;
    },
    run(phase, operation) {
      const allowance = allowances.get(phase);
      if (allowance === undefined) throw new RangeError(`${name} has no phase named ${phase}`);
      if (typeof operation !== "function") throw new TypeError(`${name} phase ${phase} needs an operation`);
      const controller = new AbortController();
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          controller.abort();
          settled = true;
          reject(new Error(`${name} phase ${phase} exceeded ${allowance}ms`));
        }, allowance);
        Promise.resolve()
          .then(() => operation(controller.signal))
          .then(
            (value) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve(value);
            },
            (error) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              reject(error);
            },
          );
      });
    },
  });
}
