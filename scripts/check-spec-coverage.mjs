import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A spec that no proof chain reaches is a test suite that cannot fail. It
 * reads as cover, it passes review, and it never runs.
 *
 * The first version of this check asked whether a spec was NAMED by any
 * script in the manifest. That is not enough, and a gate found out the hard
 * way: a spec can be named by a script that nothing calls, so it is written
 * down, wired to nothing, and green for ever. What matters is whether a
 * verify chain reaches it.
 *
 * So this walks the `pnpm` calls out from every `verify:` script and asks
 * whether each spec is named by a script the walk arrives at.
 */
const CALL = /pnpm (?:run )?([a-z0-9:_-]+)/g;

/**
 * Specs that are deliberately outside every proof chain, each with the
 * reason. A spec here is a decision someone wrote down; a spec that is
 * simply unreachable fails the build.
 */
const OUTSIDE_THE_CHAIN = [
  // { spec: 'scripts/x.spec.mjs', why: '...' },
];

/** The script every verify chain reaches, so a walk that misses it is broken. */
const CONTROL = 'check:boundaries';

/** Every script a `verify:*` chain reaches, by walking its `pnpm <script>` calls. */
export function reachableScripts(scripts) {
  const calls = new Map(
    Object.entries(scripts).map(([name, body]) => [name, [...body.matchAll(CALL)].map((m) => m[1])]),
  );
  const seen = new Set();
  const stack = Object.keys(scripts).filter((name) => name.startsWith('verify:'));
  while (stack.length) {
    const name = stack.pop();
    if (seen.has(name) || !(name in scripts)) continue;
    seen.add(name);
    stack.push(...(calls.get(name) ?? []));
  }
  return seen;
}

export function checkSpecCoverage(root, { run = defaultRun } = {}) {
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {};
  const reached = reachableScripts(scripts);
  // The control comes before any finding. A walk that arrives nowhere calls
  // every spec unreachable, which is a broken check reporting a full page of
  // faults; that has happened here, so the walk proves itself first.
  if (!reached.has(CONTROL)) {
    throw new Error(`the walk from the verify chains never reached ${CONTROL}, so it cannot be trusted to say what runs`);
  }

  const excused = new Map();
  for (const entry of OUTSIDE_THE_CHAIN) {
    if (!entry.why) throw new Error(`the exemption for ${entry.spec} does not say why it is outside every chain`);
    excused.set(entry.spec, entry);
  }

  const specs = run(['ls-files', 'scripts'], root).split('\n').filter((path) => path.endsWith('.spec.mjs'));
  const failures = [];
  for (const spec of specs) {
    if (excused.has(spec)) continue;
    const naming = Object.entries(scripts).filter(([, body]) => body.includes(spec)).map(([name]) => name);
    if (!naming.length) {
      failures.push(`${spec} is named by no script, so nothing can run it`);
    } else if (!naming.some((name) => reached.has(name))) {
      failures.push(`${spec} is named only by ${naming.join(', ')}, which no verify chain reaches, so it never runs in a proof`);
    }
  }
  return { failures, reached: reached.size, specs: specs.length };
}

function defaultRun(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const { failures, reached, specs } = checkSpecCoverage(process.cwd());
    if (failures.length) {
      for (const failure of failures) console.error(failure);
      process.exitCode = 1;
    } else {
      const excused = OUTSIDE_THE_CHAIN.length;
      console.log(`All ${specs} spec(s) under scripts/ run inside a proof chain${excused ? `, apart from ${excused} named as deliberately outside one` : ''} (the walk reaches ${reached} scripts).`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
