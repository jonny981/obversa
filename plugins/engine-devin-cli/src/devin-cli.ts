/**
 * Engine plugin: the `devin` CLI as a non-interactive subprocess. One fresh
 * `devin -p` process runs each attempt, with the person's own environment,
 * Devin login and Devin settings. The plugin adds only what the step needs:
 * Devin's permission mode for the workspace mode, the model when one is named,
 * the commands a read step may run, and a conversation export it reads the
 * answer from. When Devin refuses a tool in a read step, the plugin continues
 * the same session with `devin -r` and says what the step may run.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  EngineError,
  EngineIncompleteResultError,
  assertReadAccess,
  classifyEngineFailure,
  engineSelection,
  modelIdentity,
  validateAgentResult,
  type AgentRequest,
  type AgentResult,
  type AgentResultPart,
  type Engine,
  type EngineEventSink,
  type EngineSelectionRecord,
} from '@obversa/api';
import {
  attemptEnvironment,
  scrubCapture,
  DEFAULT_OWNED_COMMAND_LIMITS,
  OwnedCommandError,
  ownedCommandIdentity,
  resolveCommandExecutable,
  runOwnedCommand,
} from '@obversa/core/command';
import { readDevinExport, type DevinConversation } from './atif.js';

const ADAPTER = 'devin-cli';
const PROVIDER = 'cognition';
/** The model a seat records when it leaves the choice of model to Devin. */
const DEFAULT_MODEL = 'default';
const DIAGNOSTIC_MAX = 700;
const NO_EFFORT = 'devin has no reasoning effort switch, so it cannot take effort; leave effort unset';
/** Whether a run leaves out the person's own setup when `clean` is not set. */
const CLEAN_BY_DEFAULT = true;
/** The settings a clean-mode run reads in place of the person's Devin config file. */
const CLEAN_CONFIG = '{}\n';

/** A character that makes a command more than one plain command: chaining, redirects, substitution. */
const SHELL_CHARACTER = /[&;|<>`$\r\n]/;
/** Devin's allow rule for a command prefix, as a step's `allowedTools` carries it. */
const EXEC_RULE = /^Exec\(([\s\S]*)\)$/;

type PermissionMode = NonNullable<DevinCliEngineOptions['permissionMode']>;
const PERMISSION_MODES: readonly string[] = ['auto', 'accept-edits', 'smart', 'dangerous'];
/** How many times a read step's session is continued after a refused tool, when `refusalRetries` is unset. */
const DEFAULT_REFUSAL_RETRIES = 2;

export interface DevinCliEngineOptions {
  /** Model for requests that name none. Without a model, Devin runs its own default model, or the one your Devin settings choose with `clean: false`. */
  readonly defaultModel?: string;
  /** Absolute path or bare command name; `devin` by default. */
  readonly cliBinary?: string;
  /**
   * Run with an empty Devin config file in place of the person's own
   * `~/.config/devin/config.json`, holding only the `commands` allow rules
   * in a read step. Their own MCP servers and skills still
   * load, because Devin has no switch to leave them out. The repository's
   * instruction files still apply, and the run keeps the person's login.
   * On by default; `false` runs on the person's own setup.
   */
  readonly clean?: boolean;
  /** Unsupported: the Devin CLI has no reasoning effort switch, so setting it throws. */
  readonly effort?: string;
  /**
   * Devin's permission mode for a step that may write; `accept-edits` when
   * unset, which edits files but refuses a command that needs confirmation
   * and so ends the run. `dangerous` auto-approves tool calls, so a builder
   * can run its tests and builds; a deny or ask rule from the organisation or
   * the person's Devin setup can still refuse one.
   * A read step always runs with `auto`, and refuses any other mode.
   */
  readonly permissionMode?: 'auto' | 'accept-edits' | 'smart' | 'dangerous';
  /**
   * Command prefixes a read step may run, such as `git diff` or `rg`, besides
   * those Devin's `auto` mode runs by itself. Each becomes an `Exec(prefix)`
   * allow rule in the config file the attempt runs with. A read step whose
   * `allowedTools` carry `Exec(prefix)` entries runs with those in place of
   * this list. A write step does not get them; its permission mode decides
   * what it may run. None by default. The attempt records the request's
   * tools; `devin()` adds the rules to its seat's tools.
   */
  readonly commands?: readonly string[];
  /**
   * How many times a read step's run is continued after Devin refuses a
   * tool. In print mode a refusal ends Devin's run without an answer; the
   * plugin then continues the same session with a message that names the
   * commands the step may run. 2 by default; 0 turns this off. A write step
   * is never continued.
   */
  readonly refusalRetries?: number;
}

export interface DevinSeat {
  readonly engine: DevinCliEngine;
  readonly identity: {
    readonly adapter: 'devin-cli';
    readonly provider: 'cognition';
    readonly modelFamily: string;
    readonly model: string;
    readonly tools: readonly string[];
  };
}

export interface DevinSeatOptions {
  readonly permissionMode?: DevinCliEngineOptions['permissionMode'];
  /** Command prefixes a read step may run; see `DevinCliEngineOptions.commands`. */
  readonly commands?: readonly string[];
  /** Continuations after a refused tool in a read step; see `DevinCliEngineOptions.refusalRetries`. */
  readonly refusalRetries?: number;
  readonly clean?: boolean;
  /** Unsupported: the Devin CLI has no reasoning effort switch, so setting it throws. */
  readonly effort?: string;
}

/**
 * Create the Devin seat used by declarative team workflows. Without a model,
 * Devin runs its own default model, or the one your Devin settings choose with
 * `clean: false`, and the seat records the model as `default`.
 */
export function devin(model?: string, options: DevinSeatOptions = {}): DevinSeat {
  if (model !== undefined && !model.trim()) throw new TypeError('devin model must not be empty');
  return {
    engine: new DevinCliEngine({
      ...(model === undefined ? {} : { defaultModel: model }),
      ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
      ...(options.effort === undefined ? {} : { effort: options.effort }),
      ...(options.clean === undefined ? {} : { clean: options.clean }),
      ...(options.commands === undefined ? {} : { commands: options.commands }),
      ...(options.refusalRetries === undefined ? {} : { refusalRetries: options.refusalRetries }),
    }),
    identity: {
      adapter: ADAPTER,
      provider: PROVIDER,
      modelFamily: modelIdentity(model ?? DEFAULT_MODEL).modelFamily,
      model: model ?? DEFAULT_MODEL,
      tools: ['read', 'edit', 'exec', ...execRules(options.commands)],
    },
  };
}

/** Devin's `Exec(prefix)` allow rule for each command; refuses an entry that is not one plain command. */
function execRules(commands: readonly string[] = []): string[] {
  for (const command of commands) {
    if (!command.trim()) throw new TypeError(`devin commands entry ${JSON.stringify(command)} is empty`);
    if (SHELL_CHARACTER.test(command)) {
      throw new TypeError(`devin commands entry ${JSON.stringify(command)} has a shell character `
        + '(&, ;, |, <, >, `, $ or a newline), so it cannot be a read-only command');
    }
  }
  return [...new Set(commands.map((command) => `Exec(${command})`))];
}

/**
 * The allow rules a step runs with. A read step takes the `Exec(prefix)`
 * entries of its `allowedTools`, or the engine's commands when it has none.
 * A write step gets none.
 */
function stepRules(req: AgentRequest, opts: DevinCliEngineOptions): string[] {
  const engineRules = execRules(opts.commands);
  const stepCommands = (req.allowedTools ?? []).flatMap((tool) => EXEC_RULE.exec(tool)?.[1] ?? []);
  const rules = stepCommands.length > 0 ? execRules(stepCommands) : engineRules;
  return req.workspaceMode === 'write' ? [] : rules;
}

/** Whether an attempt runs with a config file of its own rather than the person's. */
function hasAttemptConfig(clean: boolean, rules: readonly string[]): boolean {
  return clean || rules.length > 0;
}

function personalConfigPath(): string {
  return join(homedir(), '.config', 'devin', 'config.json');
}

/** The person's own Devin config file, or `{}` when it does not exist. */
function personalConfig(): Record<string, unknown> {
  const path = personalConfigPath();
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new EngineError({ kind: 'invalid-config', message: `devin cannot read the config file ${path}`, cause: error });
    }
    text = CLEAN_CONFIG;
  }
  let config: unknown;
  try { config = JSON.parse(text); } catch { config = undefined; }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new EngineError({
      kind: 'invalid-config',
      message: `devin config file ${path} is not a JSON object, so the commands cannot be added to it`,
    });
  }
  return config as Record<string, unknown>;
}

/**
 * The config file an attempt runs with, or undefined to leave Devin on the
 * person's own. Allow rules go in a fresh file each attempt: the empty one
 * in clean mode, a copy of the person's own with `clean: false`.
 */
function attemptConfig(req: AgentRequest, opts: DevinCliEngineOptions): string | undefined {
  const rules = stepRules(req, opts);
  const clean = opts.clean ?? CLEAN_BY_DEFAULT;
  if (!hasAttemptConfig(clean, rules)) return undefined;
  if (rules.length === 0) return CLEAN_CONFIG;
  const config = clean ? {} : personalConfig();
  const permissions = config.permissions ?? {};
  const allow = (permissions as { allow?: unknown }).allow ?? [];
  if (typeof permissions !== 'object' || permissions === null || Array.isArray(permissions) || !Array.isArray(allow)) {
    throw new EngineError({
      kind: 'invalid-config',
      message: 'devin config file permissions is not an object with an allow list, so the commands cannot be added to it',
    });
  }
  return `${JSON.stringify({ ...config, permissions: { ...permissions, allow: [...allow, ...rules] } }, null, 2)}\n`;
}

function modelFor(req: AgentRequest, opts: DevinCliEngineOptions): string | undefined {
  const model = req.model ?? opts.defaultModel;
  return model === undefined || model === DEFAULT_MODEL ? undefined : model;
}

/** Devin's permission mode for a step: `auto` to read, the engine's mode or `accept-edits` to write. */
function permissionMode(req: AgentRequest, opts: DevinCliEngineOptions): PermissionMode {
  if (opts.permissionMode !== undefined && !PERMISSION_MODES.includes(opts.permissionMode)) {
    throw new TypeError('devin permission mode must be auto, accept-edits, smart or dangerous');
  }
  if (req.workspaceMode === 'write') return opts.permissionMode ?? 'accept-edits';
  if (opts.permissionMode !== undefined && opts.permissionMode !== 'auto') {
    throw new TypeError(`devin permission mode ${opts.permissionMode} can edit files or run commands, `
      + 'so a read step cannot use it; leave permissionMode unset or set it to auto');
  }
  return 'auto';
}

/**
 * Build the `devin` argv for one attempt, or for a run that continues the
 * attempt's session when `sessionId` is given. Exported so the flag wiring
 * is testable without spawning a process.
 */
export function buildDevinArgs(
  req: AgentRequest,
  opts: DevinCliEngineOptions,
  files: { readonly promptFile: string; readonly exportFile: string; readonly configFile?: string },
  sessionId?: string,
): string[] {
  const clean = opts.clean ?? CLEAN_BY_DEFAULT;
  let mode: PermissionMode;
  let rules: string[];
  try {
    assertReadAccess(req);
    rules = stepRules(req, opts);
    if (clean && files.configFile === undefined) {
      throw new TypeError('devin clean mode requires an empty config file');
    }
    if (hasAttemptConfig(clean, rules) && files.configFile === undefined) {
      throw new TypeError('devin needs a config file for this step');
    }
    if (req.tools?.length === 0) {
      throw new TypeError('devin cannot turn its tools off; choose an engine that supports tools: []');
    }
    if (req.workspaceMode === 'none') {
      throw new TypeError('devin has no mode without workspace access; choose read or write');
    }
    if ((req.effort ?? opts.effort) !== undefined) throw new TypeError(NO_EFFORT);
    mode = permissionMode(req, opts);
  } catch (cause) {
    throw new EngineError({
      kind: 'invalid-config',
      message: cause instanceof Error ? cause.message : 'invalid Devin workspace configuration',
      cause,
    });
  }
  const model = modelFor(req, opts);
  return [
    '-p',
    ...(sessionId === undefined ? [] : ['-r', sessionId]),
    '--prompt-file', files.promptFile,
    '--export', files.exportFile,
    '--permission-mode', mode,
    // Print mode cannot show Devin's folder trust prompt; without this flag
    // every folder the person has not opened in Devin before refuses to run.
    '--respect-workspace-trust', 'false',
    ...(hasAttemptConfig(clean, rules) ? ['--config', files.configFile!] : []),
    ...(model === undefined ? [] : ['--model', model]),
  ];
}

function requestedSelection(req: AgentRequest, opts: DevinCliEngineOptions): EngineSelectionRecord {
  const model = modelFor(req, opts);
  return engineSelection({
    adapter: ADAPTER,
    provider: PROVIDER,
    modelFamily: model === undefined ? null : modelIdentity(model).modelFamily,
    model: model ?? null,
    capabilities: req.tools ?? [],
  });
}

function assertDevinConfiguration(req: AgentRequest, opts: DevinCliEngineOptions): void {
  buildDevinArgs(req, opts, { promptFile: 'prompt', exportFile: 'export', configFile: 'config' });
  try {
    const env = attemptEnvironment(req) ?? {};
    const limits = {
      timeoutMs: req.timeoutMs ?? DEFAULT_OWNED_COMMAND_LIMITS.timeoutMs,
      teardownGraceMs: req.timeoutGraceMs ?? DEFAULT_OWNED_COMMAND_LIMITS.teardownGraceMs,
      maxOutputBytes: req.maxOutputBytes ?? DEFAULT_OWNED_COMMAND_LIMITS.maxOutputBytes,
      maxMemoryBytes: req.maxMemoryBytes ?? DEFAULT_OWNED_COMMAND_LIMITS.maxMemoryBytes,
    };
    if (!isAbsolute(req.cwd ?? process.cwd())
      || Object.values(env).some((value) => typeof value !== 'string')
      || !Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 1
      || !Number.isSafeInteger(limits.teardownGraceMs) || limits.teardownGraceMs < 0
      || limits.timeoutMs + limits.teardownGraceMs > 2_147_483_647
      || !Number.isSafeInteger(limits.maxOutputBytes) || limits.maxOutputBytes < 0
      || !Number.isSafeInteger(limits.maxMemoryBytes) || limits.maxMemoryBytes < 1) {
      throw new Error('invalid Devin command request');
    }
    ownedCommandIdentity({ adapter: ADAPTER, runId: req.attempt?.runId,
      leafId: req.attempt?.leafId, attemptId: req.attempt?.attemptId });
  } catch {
    throw new EngineError({ kind: 'invalid-config', message: 'invalid Devin command configuration' });
  }
}

const LOAD_SPAWN_CODES = new Set(['EAGAIN', 'EMFILE', 'ENOMEM']);

function devinCommandError(error: unknown, executable?: string): unknown {
  if (!(error instanceof OwnedCommandError)) return error;
  if (error.code === 'INVALID_EXECUTABLE') {
    return new EngineError({ kind: 'missing-cli', message: 'Devin executable is not runnable' });
  }
  if (error.code === 'INVALID_COMMAND') {
    return new EngineError({ kind: 'invalid-config', message: 'invalid Devin command request' });
  }
  if (error.code === 'SPAWN_FAILED') {
    if (LOAD_SPAWN_CODES.has(error.spawnCode ?? '')) {
      return new EngineError({
        kind: 'transient',
        message: `the system refused to start the Devin process (${error.spawnCode})`,
      });
    }
    if (executable !== undefined) {
      try { resolveCommandExecutable(executable); }
      catch { return new EngineError({ kind: 'missing-cli', message: 'Devin executable is not runnable' }); }
    }
    return new EngineError({ kind: 'unknown', message: 'Devin command could not start' });
  }
  return error;
}

/** What Devin prints when its permission mode refuses a tool in print mode. */
const REFUSED_TOOL_WARNING = 'rejected a tool call that requires confirmation';

/** The message that continues a read step's session after Devin refuses a tool. */
function refusalMessage(rules: readonly string[]): string {
  const commands = rules.map((rule) => `\`${EXEC_RULE.exec(rule)![1]}\``);
  return `That tool call was refused: it is not allowed in this step. ${commands.length > 0
    ? `The only shell commands this step may run are ${commands.join(', ')}. `
      + 'Finish the task with your file reading tools and those commands only.'
    : 'This step may run no shell command. Finish the task with your file reading tools only.'}`;
}

function validRefusalRetries(value: number | undefined): number {
  if (value === undefined) return DEFAULT_REFUSAL_RETRIES;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('devin refusalRetries must be a whole number of 0 or more');
  }
  return value;
}

function output(sub: { readonly stdout: Uint8Array; readonly stderr: Uint8Array }): string {
  return [new TextDecoder().decode(sub.stderr), new TextDecoder().decode(sub.stdout)]
    .filter((text) => text.length > 0).join('\n');
}

function readExport(path: string): DevinConversation | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return readDevinExport(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export class DevinCliEngine implements Engine {
  readonly name = ADAPTER;
  private executable: string | undefined;
  private version: Promise<string> | undefined;
  constructor(private readonly opts: DevinCliEngineOptions = {}) {
    if (opts.effort !== undefined) throw new TypeError(NO_EFFORT);
    execRules(opts.commands);
    validRefusalRetries(opts.refusalRetries);
  }

  private commandExecutable(expected?: EngineSelectionRecord): string {
    const configured = this.opts.cliBinary ?? 'devin';
    if (configured.length === 0 || (!isAbsolute(configured) && basename(configured) !== configured)) {
      throw new EngineError({ kind: 'invalid-config', message: 'Devin command must be absolute or a bare name' });
    }
    if (expected && (expected.executable === null
      || (isAbsolute(configured) && configured !== expected.executable)
      || (this.executable !== undefined && this.executable !== expected.executable))) {
      throw new EngineError({ kind: 'invalid-config', message: 'Devin executable selection changed' });
    }
    try {
      this.executable ??= resolveCommandExecutable(expected?.executable ?? configured);
      return resolveCommandExecutable(this.executable);
    } catch (error) { throw devinCommandError(error, this.executable); }
  }

  private async observeVersion(req: AgentRequest, executable: string, signal: AbortSignal): Promise<string> {
    try {
      const result = await runOwnedCommand({
        executable, args: ['--version'], stdin: '',
        cwd: req.cwd ?? process.cwd(), env: attemptEnvironment(req) ?? {},
        ...ownedCommandIdentity({ adapter: ADAPTER, runId: req.attempt?.runId,
          leafId: req.attempt?.leafId, attemptId: req.attempt?.attemptId }),
        ...DEFAULT_OWNED_COMMAND_LIMITS,
        timeoutMs: Math.min(req.timeoutMs ?? 5_000, 5_000),
        teardownGraceMs: Math.min(req.timeoutGraceMs ?? 1_000, 1_000),
        maxOutputBytes: Math.min(req.maxOutputBytes ?? 4_096, 4_096),
        maxMemoryBytes: req.maxMemoryBytes ?? DEFAULT_OWNED_COMMAND_LIMITS.maxMemoryBytes,
      }, signal);
      if (result.aborted || signal.aborted) {
        throw new EngineError({ kind: 'aborted', message: 'Devin version observation aborted' });
      }
      if (result.timedOut) {
        throw new EngineError({ kind: 'timeout', message: 'Devin version observation timed out' });
      }
      if (result.exitCode !== 0) {
        throw new EngineError({ kind: 'unknown', message: 'Devin version command failed' });
      }
      const matched = /^devin (\d+\.\d+\.\d+) \([0-9a-f]+\)$/.exec(new TextDecoder().decode(result.stdout).trim());
      if (!matched) {
        throw new EngineError({ kind: 'invalid-config', message: 'Devin version output is not recognized' });
      }
      return matched[1]!;
    } catch (error) {
      const mapped = devinCommandError(error, executable);
      if (mapped instanceof EngineError) throw mapped;
      throw new EngineError({ kind: 'unknown', message: 'Devin version observation failed' });
    }
  }

  async admit(
    request: Omit<AgentRequest, 'prompt'>,
    signal: AbortSignal,
    expectedSelection?: EngineSelectionRecord,
  ): Promise<EngineSelectionRecord> {
    if (signal.aborted) throw new EngineError({ kind: 'aborted', message: 'Devin admission aborted' });
    const req: AgentRequest = { ...request, prompt: '' };
    assertDevinConfiguration(req, this.opts);
    let expected: EngineSelectionRecord | undefined;
    let proposed: EngineSelectionRecord;
    try {
      expected = expectedSelection === undefined ? undefined : engineSelection(expectedSelection);
      proposed = requestedSelection(req, this.opts);
    } catch {
      throw new EngineError({ kind: 'invalid-config', message: 'invalid Devin selection' });
    }
    const executable = this.commandExecutable(expected);
    let observation = this.version;
    if (observation === undefined) {
      observation = this.observeVersion(req, executable, signal);
      this.version = observation;
    }
    let adapterVersion: string;
    try { adapterVersion = await observation; }
    catch (error) {
      if (this.version === observation) this.version = undefined;
      throw error;
    }
    if (signal.aborted) throw new EngineError({ kind: 'aborted', message: 'Devin admission aborted' });
    const selected = engineSelection({ ...proposed, executable, adapterVersion });
    if (expected && !isDeepStrictEqual(selected, expected)) {
      throw new EngineError({ kind: 'invalid-config', message: 'Devin selection changed' });
    }
    return selected;
  }

  async run(
    req: AgentRequest,
    onEvent: EngineEventSink,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    if (signal.aborted) throw new EngineError({ kind: 'aborted', message: 'devin run aborted' });
    const { prompt: _prompt, ...admissionRequest } = req;
    const requested = await this.admit(admissionRequest, signal);
    const executable = requested.executable!;
    const dir = mkdtempSync(join(tmpdir(), 'obversa-devin-'));
    const promptFile = join(dir, 'prompt.md');
    const continueFile = join(dir, 'continue.md');
    const configFile = join(dir, 'config.json');
    const env = attemptEnvironment(req);
    const retries = validRefusalRetries(this.opts.refusalRetries);
    // Every run in the attempt shares the attempt's time and output limits.
    const timeoutMs = req.timeoutMs ?? DEFAULT_OWNED_COMMAND_LIMITS.timeoutMs;
    const maxOutputBytes = req.maxOutputBytes ?? DEFAULT_OWNED_COMMAND_LIMITS.maxOutputBytes;
    const deadline = performance.now() + timeoutMs;
    let outputBytes = 0;
    let messagesSent = 0;
    let toolEventsSent = 0;
    try {
      // Devin has no system prompt flag, so system text leads the prompt.
      writeFileSync(
        promptFile,
        req.system ? `${req.system}\n\n---\n\n${req.prompt}` : req.prompt,
        { encoding: 'utf8', mode: 0o600 },
      );
      const config = attemptConfig(req, this.opts);
      if (config !== undefined) writeFileSync(configFile, config, { encoding: 'utf8', mode: 0o600 });
      let exportFile = join(dir, 'conversation.json');
      let args = buildDevinArgs(req, this.opts, { promptFile, exportFile, configFile });
      for (let refusals = 0; ; refusals += 1) {
        const sub = await runOwnedCommand({
          executable,
          args,
          cwd: req.cwd ?? process.cwd(),
          env: env ?? {},
          stdin: '',
          ...ownedCommandIdentity({ adapter: ADAPTER, runId: req.attempt?.runId,
            leafId: req.attempt?.leafId, attemptId: req.attempt?.attemptId }),
          ...DEFAULT_OWNED_COMMAND_LIMITS,
          // A continued run that starts after the deadline times out at once.
          timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())),
          teardownGraceMs: req.timeoutGraceMs ?? DEFAULT_OWNED_COMMAND_LIMITS.teardownGraceMs,
          maxOutputBytes: maxOutputBytes - outputBytes,
          maxMemoryBytes: req.maxMemoryBytes ?? DEFAULT_OWNED_COMMAND_LIMITS.maxMemoryBytes,
        }, signal).catch((error: unknown) => { throw devinCommandError(error, executable); });
        outputBytes += sub.stdout.byteLength + sub.stderr.byteLength;

        const conversation = readExport(exportFile);
        const answered = conversation?.answered === true;
        const aborted = sub.aborted || signal.aborted;
        if (aborted && !answered) throw new EngineError({ kind: 'aborted', message: 'devin run aborted' });
        const diagnostic = scrubCapture(
          output(sub),
          env,
          DIAGNOSTIC_MAX,
        ).trim();
        const failed = aborted || sub.timedOut || sub.exitCode !== 0;
        if (failed && !answered) {
          throw new EngineError({
            kind: sub.timedOut ? 'timeout' : classifyEngineFailure(new Error(diagnostic)),
            message: `devin exited ${sub.exitCode ?? '?'}${diagnostic ? `: ${diagnostic}` : ''}`,
          });
        }
        if (conversation === undefined) {
          throw new EngineError({
            kind: 'unknown',
            message: `devin wrote no readable conversation export${diagnostic ? `: ${diagnostic}` : ''}`,
          });
        }

        let effective = requested;
        if (conversation.model !== undefined) {
          try {
            effective = engineSelection({
              ...requested,
              model: conversation.model,
              modelFamily: modelIdentity(conversation.model).modelFamily,
            });
          } catch {
            // A model name Devin reports but no family can be read from keeps the requested record.
          }
        }
        const parts: AgentResultPart[] = conversation.messages.map((text, index) => ({
          kind: 'assistant',
          text,
          final: answered && index === conversation.messages.length - 1,
        }));
        // A continued session's export holds the earlier runs too; send only what is new.
        for (const text of conversation.messages.slice(messagesSent)) onEvent({ type: 'text', delta: text });
        for (const event of conversation.toolEvents.slice(toolEventsSent)) onEvent(event);
        messagesSent = conversation.messages.length;
        toolEventsSent = conversation.toolEvents.length;
        if (!answered) {
          // In print mode, Devin ends the whole run with exit 0 and no answer
          // when its permission mode refuses a tool, such as a write in a read step.
          // A read step continues the same session, up to `refusalRetries` times.
          const refusedInRead = req.workspaceMode !== 'write'
            && output(sub).includes(REFUSED_TOOL_WARNING);
          if (refusedInRead && refusals < retries && conversation.sessionId !== undefined) {
            writeFileSync(continueFile, refusalMessage(stepRules(req, this.opts)), { encoding: 'utf8', mode: 0o600 });
            exportFile = join(dir, `conversation-${refusals + 1}.json`);
            args = buildDevinArgs(req, this.opts, { promptFile: continueFile, exportFile, configFile }, conversation.sessionId);
            const target = `refused: ${conversation.refused.at(-1) ?? 'a tool call'}`;
            onEvent({ type: 'tool', name: 'devin --resume', phase: 'use', target });
            onEvent({ type: 'tool', name: 'devin --resume', phase: 'result', target });
            continue;
          }
          throw new EngineIncompleteResultError(
            `${refusedInRead
              ? `devin refused a tool in read mode ${refusals + 1} time${refusals > 0 ? 's' : ''}, `
                + 'which ends its run without an answer; no file changed'
              : `devin ended without a final answer under permission mode ${permissionMode(req, this.opts)}`}${
              diagnostic ? `: ${diagnostic}` : ''
            }`,
            { parts, usage: conversation.usage, requested, effective },
          );
        }
        onEvent({ type: 'usage', usage: conversation.usage, model: effective.model ?? 'devin' });
        return validateAgentResult({
          parts,
          usage: conversation.usage,
          requested,
          effective,
          ...(failed
            ? {
                transportFailure: {
                  kind: aborted ? 'aborted' as const : sub.timedOut ? 'timeout' as const : 'unknown' as const,
                  message: `devin completed but exited ${sub.exitCode ?? '?'} during teardown${
                    diagnostic ? `: ${diagnostic}` : ''
                  }`,
                  exitCode: sub.exitCode ?? null,
                },
              }
            : {}),
        });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
