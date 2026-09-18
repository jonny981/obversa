/**
 * @typedef {readonly [string, number]} BudgetPhase
 * @typedef {{ setup: number, phases: readonly BudgetPhase[], cleanup: number }} BudgetChainDefinition
 * @typedef {{
 *   name: string,
 *   budgetMs: number,
 *   totalMs: number,
 *   allowance: (phase: string) => number,
 *   span: (name: string, phases: readonly string[]) => number,
 *   run: <Value>(phase: string, operation: (signal: AbortSignal) => Value | PromiseLike<Value>) => Promise<Value>,
 * }} BudgetChain
 */

/**
 * Declare one test's sequential timeout path and return the same guards for
 * the waits on that path. Each phase names one wait and carries a ceiling for
 * it; reaching that ceiling means the thing waited for did not happen, and the
 * failure names the phase. The import-time check keeps a stale chain from
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

  // A phase allowance is a ceiling on one wait, and the test's own timeout is
  // what bounds the whole run. Requiring the allowances to SUM inside the test
  // budget treated worst cases as if they happened together, which squeezed
  // every ceiling until an ordinary slow moment tripped one: the browser
  // proof's phases summed to 179s against a 180s budget, and a loaded machine
  // cost a gate round on a ten-second wait for a browser target. So the sum is
  // reported and not ruled on, while a single phase that reaches the test
  // budget is still refused, because such a phase could never fail before the
  // test did and its name would never reach the reader.
  const totalMs = entries.reduce((total, [, allowance]) => total + allowance, 0);
  for (const [phase, allowance] of entries) {
    if (allowance >= budgetMs) {
      throw new RangeError(`${name} phase ${phase} reaches its test budget: ${allowance}ms >= ${budgetMs}ms`);
    }
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
    span(spanName, phases) {
      if (typeof spanName !== "string" || spanName.length === 0) throw new TypeError(`${name} span name must be non-empty`);
      if (!Array.isArray(phases) || phases.length === 0) throw new TypeError(`${name} span ${spanName} needs phases`);
      const seenPhases = new Set();
      return phases.reduce((total, phase) => {
        if (typeof phase !== "string" || phase.length === 0) throw new TypeError(`${name} span ${spanName} has an unnamed phase`);
        if (seenPhases.has(phase)) throw new TypeError(`${name} span ${spanName} names phase ${phase} more than once`);
        const allowance = allowances.get(phase);
        if (allowance === undefined) throw new RangeError(`${name} span ${spanName} has no phase named ${phase}`);
        seenPhases.add(phase);
        return total + allowance;
      }, 0);
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
