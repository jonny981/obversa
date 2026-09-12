#!/usr/bin/env node
/**
 * Two shapes a documentation page must not have.
 *
 * A page with no example. A reader who wants to do the thing gets prose and
 * a promise that the code is somewhere else. Seven pages were like this when
 * the check was written, including one titled as an example.
 *
 * A page that opens by defining the word in its own title. "A forge is a code
 * host." "A workflow is the shape of the work." The reader already read the
 * title; the first line should say what they can now do, and the definition
 * can follow.
 */
import { execFileSync } from 'node:child_process';

import { CONSUMER_EXAMPLES, REAL_ENGINE_EXAMPLES } from './consumer-examples.mjs';
import { reachableScripts } from './check-spec-coverage.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { stageBranches } from './stage-merge.mjs';

/**
 * An example is code the reader can read and copy, not a command that runs
 * something written elsewhere. A page whose only block is `pnpm example:x`
 * is the shape this check exists to catch: it tells the reader to run a file
 * it never shows them.
 */
const EXAMPLE = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'json', 'text']);

/**
 * The pages where a command really is the content. Each one is named, so
 * adding to this list is a decision someone made rather than a default.
 */
const COMMANDS_ARE_THE_CONTENT = new Set(['get-started/installation.mdx']);

/**
 * Known debt, with a name on every line.
 *
 * A page here fails the shape rules today and is not this stage's to fix. The
 * entry says which fault it hides and which stage owns the repair, so the list
 * reads as work that is queued rather than as a rule quietly switched off, and
 * it shrinks as those stages land. A page that is not on this list fails the
 * build.
 *
 * `fault` is `example`, `opening` or `wholefile`, matching the three rules below. An entry
 * with no owner is refused: the point of the list is that every exemption has
 * someone's name against it.
 */
const KNOWN_DEBT = [
  {
    page: 'plugins.mdx', fault: 'example', owner: 'D35',
    why: 'a list of the tools we ship with nothing to copy; the package-page rewrite gives it one engine binding a reader can paste',
  },
  {
    page: 'hosts/cmux.mdx', fault: 'example', owner: 'D35',
    why: 'the page tells a reader which commands to run and never shows the configuration they run against',
  },
  {
    page: 'hosts/cmux.mdx', fault: 'opening', owner: 'D35',
    why: 'it opens by saying what Obversa is, to a reader who came to set up a host',
  },
  {
    page: 'recording/node-attempts.mdx', fault: 'opening', owner: 'D35',
    why: 'it opens by defining a safe node attempt rather than by saying what the reader can now do',
  },
  {
    page: 'workflows/forge-helper.mdx', fault: 'opening', owner: 'D35',
    why: 'it opens by defining a forge; the everyday case, you have a reviewed change and want it merged, comes first',
  },
  {
    page: 'packages/engine-agent-sdk.mdx', fault: 'wholefile', owner: 'D35',
    why: 'two fragments: a binding and a call, with no run around them',
  },
  {
    page: 'packages/engine-anthropic-api.mdx', fault: 'wholefile', owner: 'D35',
    why: 'one fragment: the binding alone',
  },
  {
    page: 'packages/engine-claude-cli.mdx', fault: 'wholefile', owner: 'D35',
    why: 'one fragment: the binding alone',
  },
  {
    page: 'packages/engine-codex.mdx', fault: 'wholefile', owner: 'D35',
    why: 'one fragment: the binding alone',
  },
  {
    page: 'packages/engine-grok-cli.mdx', fault: 'wholefile', owner: 'D35',
    why: 'one fragment: the binding alone',
  },
  {
    page: 'packages/engine-opencode-cli.mdx', fault: 'wholefile', owner: 'D35',
    why: 'one fragment: the binding alone',
  },
  {
    page: 'packages/memory-git.mdx', fault: 'wholefile', owner: 'D35',
    why: 'one fragment: openGitMemory called with nothing run against it',
  },
  {
    page: 'packages/memory-simple.mdx', fault: 'wholefile', owner: 'D35',
    why: 'one fragment: createSimpleMemory called with nothing run against it',
  },
  {
    page: 'packages/surfacer.mdx', fault: 'wholefile', owner: 'D35',
    why: 'names examples/hello-surface.mjs twice, a file that does not exist; the package page gets a whole file that runs',
  },
  {
    page: 'packages/memory.mdx', fault: 'wholefile', owner: 'D35',
    why: 'quotes memory.ts whole, but the clean consumer does not compile it; the package-page stage adds it to the list',
  },
  {
    page: 'concepts/orders.mdx', fault: 'wholefile', owner: 'D47',
    why: 'a span of feature-delivery.ts: the order alone, its imports elsewhere',
  },
  {
    page: 'concepts/surfaces.mdx', fault: 'wholefile', owner: 'D47',
    why: 'its block names examples/hello-surface.mjs, a file that does not exist; the surfaces page gets a whole file that runs',
  },
  {
    page: 'graphs/contract.mdx', fault: 'wholefile', owner: 'D47',
    why: 'the second block is the contract types imported and unused; custom-graph.ts already shows the whole',
  },
  {
    page: 'graphs/pipeline.mdx', fault: 'wholefile', owner: 'D47',
    why: 'one fragment: an import with nothing after it',
  },
  {
    page: 'memory/adapters.mdx', fault: 'wholefile', owner: 'D47',
    why: 'four fragments: two constructions and two calls, no file',
  },
  {
    page: 'memory/index.mdx', fault: 'wholefile', owner: 'D47',
    why: 'seven memory.execute fragments, one per command; one whole file runs them all',
  },
  {
    page: 'memory/mechanics.mdx', fault: 'wholefile', owner: 'D47',
    why: 'three fragments of consolidate and its result',
  },
  {
    page: 'reviewing/review-loop.mdx', fault: 'wholefile', owner: 'D47',
    why: 'one fragment: an import with nothing after it; review-loop.ts exists and runs',
  },
  {
    page: 'workflows/team-conversation.mdx', fault: 'wholefile', owner: 'D47',
    why: 'three spans of team-conversation.ts beside the whole file; the spans go, the whole stays',
  },
  {
    page: 'workspace/contract.mdx', fault: 'wholefile', owner: 'D47',
    why: 'one fragment: the provider constructed and never used',
  },
  {
    page: 'graphs/plan-admission.mdx', fault: 'example', owner: 'D35',
    why: 'a reference page with no quotable call, which is the fault a reference can least afford',
  },
];

/**
 * Whether a stage has already landed on main.
 *
 * An entry whose owner has landed is exactly as silent as an entry with no
 * owner: the stage it is waiting for is finished, so the fault it hides is
 * nobody's and stays forgiven for ever. A stage with no branch yet is a stage
 * still to come, which is what an entry here is for.
 */
export function assertDebtOwnersAreOpen(root, run = defaultRun) {
  const landed = landedStages(root, run);
  buildDebtIndex(KNOWN_DEBT, { landed });
}

function landedStages(root, run = defaultRun) {
  const landed = new Set();
  let main;
  try {
    main = run(['rev-parse', '--verify', 'main'], root).trim();
  } catch {
    // Better to say the list cannot be checked than to pass a list nobody read.
    throw new Error('main cannot be resolved here, so the allowlist owners cannot be checked');
  }
  for (const [stage, branch] of Object.entries(stageBranches)) {
    try {
      run(['merge-base', '--is-ancestor', branch, main], root);
      landed.add(stage);
    } catch {
      // Either the branch does not exist yet or it is not on main. Both mean
      // the stage has not landed, which is the state an entry expects.
    }
  }
  return landed;
}

function defaultRun(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

export function buildDebtIndex(entries = KNOWN_DEBT, { landed } = {}) {
  const index = new Map();
  for (const entry of entries) {
    if (!entry.owner) throw new Error(`the allowlist entry for ${entry.page} names no stage that owns the fix`);
    if (!entry.why) throw new Error(`the allowlist entry for ${entry.page} does not say what it hides`);
    if (landed?.has(entry.owner)) {
      throw new Error(`the allowlist entry for ${entry.page} names ${entry.owner}, which has landed, so nobody owns this fault any more`);
    }
    index.set(`${entry.page}::${entry.fault}`, entry);
  }
  return index;
}

function pages(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? pages(join(dir, e.name)) : e.name.endsWith('.mdx') ? [join(dir, e.name)] : []);
}

function frontmatterTitle(text) {
  const block = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!block) return undefined;
  const line = block[1].match(/^title:\s*"?([^"\n]+)"?\s*$/m);
  return line?.[1]?.trim();
}

function firstProseLine(text) {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;          // a heading
    if (trimmed.startsWith('{/*')) continue;         // an authoring note
    if (trimmed.startsWith('<')) continue;           // a component
    if (trimmed.startsWith('```')) return undefined; // the page opens with code, which is fine
    return trimmed;
  }
  return undefined;
}

/** The words in the title, lowercased, singular enough to match the prose. */
function titleWords(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3)
    .map((word) => word.replace(/s$/, ''));
}

/**
 * The examples are files. Prose that names one as if it were a feature, "the
 * offline review workflow", "this recipe", "the workflow bank", tells a reader
 * to pay attention to something that is forty lines of TypeScript, and
 * undersells the product at the same time. The list is every example stem
 * in words, plus the shapes such a name takes.
 */
const EXAMPLE_NOUNS = 'workflow|line|example|program|helper|recipe|process|bank';
function coinedExampleNames(root, text) {
  // A tree with no examples directory has no example to misname.
  let entries;
  try { entries = readdirSync(join(root, 'examples')); } catch { return []; }
  const stems = entries
    .filter((f) => /\.(ts|mjs)$/.test(f))
    .map((f) => f.replace(/\.(ts|mjs)$/, '').replace(/-/g, ' '));
  const body = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/\]\([^)]*\)/g, ']');
  const found = new Set();
  const named = new RegExp('\\b(?:the|this|a|an) (' + stems.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?: and \\w+)? (?:' + EXAMPLE_NOUNS + ')\\b', 'gi');
  for (const m of body.matchAll(named)) found.add(m[0]);
  for (const m of body.matchAll(/\b(?:use this|this) (?:process|recipe|helper)\b/gi)) found.add(m[0]);
  for (const m of body.matchAll(/\bworkflow bank\b/gi)) found.add(m[0]);
  return [...found];
}

function definesItsOwnTitle(title, line) {
  if (!title || !line) return false;
  const opening = line.toLowerCase().match(/^(?:an?|the)?\s*([a-z0-9 -]{1,40}?)\s+(?:is|are)\s+/);
  if (!opening) return false;
  const subject = opening[1].replace(/s$/, '');
  return titleWords(title).some((word) => subject.includes(word));
}

/**
 * The third shape a page must not have: code that is not a whole file.
 *
 * A block that is a cut from a file shows an import in one block and a body
 * in another, and uses names the reader never sees declared. A block that
 * exists on no file compiles nowhere and drifts the day the API moves. So
 * every TypeScript block on a page is one whole file under `examples/`, byte
 * for byte, and that file is one the chain runs (an `example:*` script) and
 * compiles against the packed packages (the clean consumer's list). This was
 * asked for by name: "All examples must be in full and be able to compile and
 * run."
 */
/**
 * The languages a reader's program is written in. A `js` block is left alone:
 * the pages that show a real run print the files a model wrote as `js`, and
 * those are the run's output, not an example to copy.
 */
const WHOLE_FILE_LANGS = new Set(['ts', 'typescript', 'tsx', 'mjs']);
const NAMED_EXAMPLE = /examples\/([A-Za-z0-9_./-]+\.(?:ts|mjs))/g;

function exampleFiles(root, dir = join(root, 'examples'), prefix = '') {
  const found = new Map();
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const [k, v] of exampleFiles(root, join(dir, entry.name), rel)) found.set(k, v);
    } else if (/\.(ts|mjs)$/.test(entry.name)) {
      found.set(rel, readFileSync(join(dir, entry.name), 'utf8').replace(/\n+$/, ''));
    }
  }
  return found;
}

/**
 * The example files a `verify:*` chain runs: an `example:*` script counts only
 * when a chain reaches it, so a script that exists and is never called is
 * not "run by the chain".
 */
export function examplesRunByTheChain(root) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); } catch { return new Set(); }
  const scripts = manifest.scripts ?? {};
  const reached = reachableScripts(scripts);
  const ran = new Set();
  for (const [name, command] of Object.entries(scripts)) {
    if (!name.startsWith('example:') || !reached.has(name)) continue;
    for (const match of String(command).matchAll(/examples\/([A-Za-z0-9_./-]+\.(?:ts|mjs))/g)) ran.add(match[1]);
  }
  return ran;
}

function fencedBlocks(text) {
  return [...text.matchAll(/^[ \t]*```([a-zA-Z0-9]*)[^\n]*\n([\s\S]*?)^[ \t]*```/gm)]
    .map((m) => ({ lang: m[1], body: m[2].replace(/\n+$/, '') }));
}

/** Files a chain cannot run because they need signed-in model CLIs, each with its reason. */
export function realEngineExamples(entries = REAL_ENGINE_EXAMPLES) {
  const files = new Set();
  for (const entry of entries) {
    if (!entry.file || !entry.why) throw new Error(`a real-engine example entry needs a file and a why: ${JSON.stringify(entry)}`);
    files.add(entry.file);
  }
  return files;
}

export function wholeFileFaults(name, text, { examples, ran, compiled, realEngine = realEngineExamples() }) {
  const faults = [];
  for (const block of fencedBlocks(text)) {
    if (!WHOLE_FILE_LANGS.has(block.lang)) continue;
    const first = (block.body.split('\n')[0] ?? '').slice(0, 60);
    let file;
    for (const [rel, content] of examples) if (content === block.body) { file = rel; break; }
    if (file === undefined) {
      faults.push(`${name}: a ${block.lang} block is not a whole file under examples/ (it starts "${first}")`);
      continue;
    }
    if (!ran.has(file) && !realEngine.has(file)) faults.push(`${name}: quotes examples/${file} whole, but no example:* script runs it`);
    if (!compiled.has(file)) faults.push(`${name}: quotes examples/${file} whole, but the clean consumer does not compile it`);
  }
  // A page that names a file under examples/ in its prose names one that exists.
  const prose = text.replace(/```[\s\S]*?```/g, '');
  for (const match of prose.matchAll(NAMED_EXAMPLE)) {
    if (!examples.has(match[1])) faults.push(`${name}: names examples/${match[1]}, which does not exist`);
  }
  return faults;
}

export function checkPageShape(root, { allowNoExample = new Set(), debt = buildDebtIndex(), compiled = new Set(CONSUMER_EXAMPLES), realEngine = realEngineExamples() } = {}) {
  const examples = exampleFiles(root);
  const ran = examplesRunByTheChain(root);
  const failures = [];
  const forgiven = (page, fault) => debt.has(`${page}::${fault}`);
  for (const path of pages(join(root, 'docs', 'public')).sort()) {
    const name = path.slice(join(root, 'docs', 'public').length + 1);
    const text = readFileSync(path, 'utf8');
    const langs = [...text.matchAll(/^\s*```([a-zA-Z0-9]*)/gm)].map((m) => m[1]);
    const exempt = COMMANDS_ARE_THE_CONTENT.has(name) || allowNoExample.has(name) || forgiven(name, 'example');
    if (!langs.some((lang) => EXAMPLE.has(lang)) && !exempt) {
      failures.push(langs.length
        ? `${name}: its only blocks are commands, so it never shows the reader the thing it tells them to run`
        : `${name}: no example a reader can copy`);
    }
    const title = frontmatterTitle(text);
    const line = firstProseLine(text);
    if (!forgiven(name, 'wholefile')) failures.push(...wholeFileFaults(name, text, { examples, ran, compiled, realEngine }));
    for (const phrase of coinedExampleNames(root, text)) {
      failures.push(`${name}: names an example as if it were a feature: "${phrase}"`);
    }
    if (definesItsOwnTitle(title, line) && !forgiven(name, 'opening')) {
      failures.push(`${name}: opens by defining "${title}", the word already in its title`);
    }
  }
  return failures;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  let failures;
  const root = process.argv[2] ?? process.cwd();
  try {
    // The list's own health first: an exemption nobody owns any more forgives
    // a fault for ever, so it is a failure before any page is read.
    assertDebtOwnersAreOpen(root);
    failures = checkPageShape(root);
  } catch (error) {
    // A list that cannot be trusted is a failure, not a crash.
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  if (failures.length) {
    for (const failure of failures) console.error(failure);
    process.exitCode = 1;
  } else {
    const owed = KNOWN_DEBT.length;
    console.log(owed
      ? `Every documentation page carries an example and opens with what a reader can do, apart from ${owed} named in the list, each with the stage that owns its fix.`
      : 'Every documentation page carries an example and opens with what a reader can do.');
  }
}
