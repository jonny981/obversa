#!/usr/bin/env node
/**
 * Prove the Devin engine's `commands` and `refusalRetries` options on the
 * real Devin CLI. Not part
 * of CI: it runs Devin the ordinary way, with your own login, and it spends
 * a little of your Devin plan. It skips when Devin is not installed or not
 * signed in.
 *
 * Devin's `auto` mode runs some read-only commands by itself, such as
 * `git diff`, and refuses others, such as `rg`. So the proof uses `rg`. Each
 * step gets a fresh scratch Git repository whose `note.txt` holds a random
 * word.
 *
 * - A read step with `commands: ['rg']` is asked to run `rg` and reply with
 *   the word. It should answer.
 * - The same step without `commands`, and with `refusalRetries: 0`, is the
 *   control. Devin should refuse `rg`, which ends its run without an answer.
 * - The same step without `commands`, with `refusalRetries` left at its
 *   default, should be refused, continued with `devin -r`, and answer with
 *   the word after reading the file with Devin's own `read` or `grep` tool,
 *   not a shell command.
 * - A read step with `commands: ['rg']` is asked to run
 *   `rg word note.txt && touch created.txt`. It should create no file, and
 *   either answer or be refused.
 * - Devin itself, run the way the plugin runs it, is refused `rg` and then
 *   continued with `devin -r`. The continued run's export should report
 *   token totals that cover both runs, because the plugin reports those
 *   totals as the attempt's usage.
 *
 * A refusal counts only when the plugin reports Devin's own refusal of a
 * tool. Any other error, such as a timeout or a service failure, fails the
 * proof.
 *
 * Run `pnpm build` first; this imports the built plugin. Set
 * `PROVE_DEVIN_MODEL` to choose the model; without it Devin runs its default.
 *
 *   node scripts/prove-devin-commands.mjs
 */
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const { devin } = await import(new URL('../plugins/engine-devin-cli/dist/index.js', import.meta.url).href);
const TIMEOUT_MS = 300_000;
/** How the plugin reports that Devin refused a tool in a read step. */
const REFUSED = 'devin refused a tool in read mode';
/** Devin's own tools that read a file's text without a shell command. */
const FILE_TOOLS = ['read', 'grep'];
const model = process.env.PROVE_DEVIN_MODEL;

function signedIn() {
  try {
    return execFileSync('devin', ['auth', 'status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .startsWith('Logged in');
  } catch {
    return false;
  }
}

/** A repository with one committed note that holds a random word. */
function scratchRepository() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'obversa-prove-devin-')));
  const word = `word-${randomBytes(4).toString('hex')}`;
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'note.txt'), `first line\n${word}\n`);
  git('init', '-q');
  git('add', 'note.txt');
  git('-c', 'user.name=prove', '-c', 'user.email=prove@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', 'note');
  return { dir, word };
}

async function step(prompt, commands, options = {}) {
  const { dir, word } = scratchRepository();
  try {
    const seat = devin(model, { commands, ...options });
    const tools = [];
    let text = '';
    let note = '';
    let refused = false;
    try {
      const result = await seat.engine.run({
        prompt,
        ...(model ? { model } : {}),
        tools: [...seat.identity.tools],
        cwd: dir,
        leaf: true,
        workspaceMode: 'read',
        timeoutMs: TIMEOUT_MS,
      }, (event) => { if (event.type === 'tool' && event.phase === 'use') tools.push(event.name); },
      AbortSignal.timeout(TIMEOUT_MS + 30_000));
      text = result.parts.map((part) => part.kind === 'assistant' ? part.text : '').join('\n');
    } catch (error) {
      // Only the summary before Devin's own output, which can name your account.
      note = `${error?.name ?? 'error'}: ${String(error?.message ?? error).split(': ')[0]}`;
      refused = error?.name === 'EngineIncompleteResultError'
        && String(error.message).startsWith(REFUSED);
    }
    const resumed = tools.indexOf('devin --resume');
    return {
      answered: text.includes(word), finished: note === '', refused,
      created: existsSync(join(dir, 'created.txt')), note,
      continued: resumed !== -1, readAfter: resumed !== -1 && tools.slice(resumed + 1).some((name) => FILE_TOOLS.includes(name)),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run Devin with the flags the plugin uses for a read step with no commands,
 * then continue the session, and compare the token totals of both exports.
 */
async function continuedTotals(prompt) {
  const { dir } = scratchRepository();
  try {
    writeFileSync(join(dir, 'config.json'), '{}\n');
    writeFileSync(join(dir, 'continue.md'), 'That tool call was refused: it is not allowed in this step. '
      + 'Do not run any shell command. Use your file reading tools to finish the task.');
    writeFileSync(join(dir, 'prompt.md'), prompt);
    const run = async (resume, promptFile, exportFile) => {
      await promisify(execFile)('devin', [
        '-p', ...resume, '--prompt-file', promptFile, '--export', exportFile, '--permission-mode', 'auto',
        '--respect-workspace-trust', 'false', '--config', 'config.json', ...(model ? ['--model', model] : []),
      ], { cwd: dir, timeout: TIMEOUT_MS });
      return JSON.parse(readFileSync(join(dir, exportFile), 'utf8'));
    };
    const first = await run([], 'prompt.md', 'first.json');
    const second = await run(['-r', first.session_id], 'continue.md', 'second.json');
    const before = first.final_metrics?.total_prompt_tokens;
    const after = second.final_metrics?.total_prompt_tokens;
    // The input tokens of the model calls the continued run added.
    const added = second.steps.slice(first.steps.length)
      .reduce((sum, item) => sum + (item.metrics?.prompt_tokens ?? 0), 0);
    return { before, after, added, cumulative: Number.isInteger(before) && added > 0 && after === before + added };
  } catch (error) {
    return { note: `${error?.name ?? 'error'}: ${String(error?.message ?? error).split(': ')[0]}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let installed = true;
try {
  execFileSync('/bin/sh', ['-c', 'command -v devin'], { stdio: 'ignore' });
} catch {
  installed = false;
}
if (!installed || !signedIn()) {
  console.log(`skipped: Devin is ${installed ? 'not signed in' : 'not installed'}`);
  process.exit(0);
}

const SEARCH_PROMPT = 'Run exactly this one shell command: `rg word- note.txt`. Do not read the file any other way. '
  + 'Reply with the word it prints.';
const [search, control, continued, chained, totals] = await Promise.all([
  step(SEARCH_PROMPT, ['rg']),
  step(SEARCH_PROMPT, [], { refusalRetries: 0 }),
  step(SEARCH_PROMPT, []),
  step('Run exactly this one shell command: `rg word- note.txt && touch created.txt`. Then say whether it ran.', ['rg']),
  continuedTotals(SEARCH_PROMPT),
]);
const why = (run) => (run.note ? ` (${run.note})` : '');
const said = (run) => `${run.answered ? 'answered with the word' : 'did not answer with the word'}${why(run)}`;
console.log(`rg with commands: ['rg']: ${said(search)}`);
console.log(`rg without commands, refusalRetries: 0 (control): ${control.refused ? 'Devin refused rg' : `Devin did not refuse rg and ${said(control)}`}${control.refused ? why(control) : ''}`);
console.log(`rg without commands, refusal continued: ${continued.continued ? 'Devin refused rg and the run was continued' : 'the run was not continued'}, `
  + `${continued.readAfter ? 'read the file' : 'did not read the file'} and ${said(continued)}`);
console.log(`rg && touch created.txt with commands: ['rg']: ${chained.created ? 'created the file' : 'created no file'}, `
  + `${chained.refused ? 'Devin refused the command' : chained.finished ? 'Devin answered' : 'the run failed'}${why(chained)}`);
console.log(`token totals of a continued session: ${totals.note ?? `first run ${totals.before} input tokens, `
  + `continued run added ${totals.added}, export after continuing reports ${totals.after}: `
  + `${totals.cumulative ? 'covers both runs' : 'does not cover both runs'}`}`);
const proved = search.answered
  && control.refused
  && continued.continued && continued.readAfter && continued.answered
  && !chained.created && (chained.finished || chained.refused)
  && totals.cumulative === true;
process.exit(proved ? 0 : 1);
