/**
 * Engine plugin: the `devin` CLI as a non-interactive subprocess. One fresh
 * `devin -p` process runs each attempt, with the person's own environment,
 * Devin login and Devin settings. The plugin adds only what the step needs:
 * Devin's permission mode for the workspace mode, the model when one is named,
 * and a conversation export it reads the answer from.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

export interface DevinCliEngineOptions {
  /** Model for requests that name none. Without a model, Devin runs its own default model, or the one your Devin settings choose with `clean: false`. */
  readonly defaultModel?: string;
  /** Absolute path or bare command name; `devin` by default. */
  readonly cliBinary?: string;
  /**
   * Run with an empty Devin config file in place of the person's own
   * `~/.config/devin/config.json`. Their own MCP servers and skills still
   * load, because Devin has no switch to leave them out. The repository's
   * instruction files still apply, and the run keeps the person's login.
   * On by default; `false` runs on the person's own setup.
   */
  readonly clean?: boolean;
  /** Unsupported: the Devin CLI has no reasoning effort switch, so setting it throws. */
  readonly effort?: string;
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
      ...(options.effort === undefined ? {} : { effort: options.effort }),
      ...(options.clean === undefined ? {} : { clean: options.clean }),
    }),
    identity: {
      adapter: ADAPTER,
      provider: PROVIDER,
      modelFamily: modelIdentity(model ?? DEFAULT_MODEL).modelFamily,
      model: model ?? DEFAULT_MODEL,
      tools: ['read', 'edit', 'exec'],
    },
  };
}

function modelFor(req: AgentRequest, opts: DevinCliEngineOptions): string | undefined {
  const model = req.model ?? opts.defaultModel;
  return model === undefined || model === DEFAULT_MODEL ? undefined : model;
}

/** Devin's permission mode for a workspace mode: read-only tools, or those plus workspace edits. */
function permissionMode(req: AgentRequest): 'auto' | 'accept-edits' {
  return req.workspaceMode === 'write' ? 'accept-edits' : 'auto';
}

/**
 * Build the `devin` argv for one attempt. Exported so the flag wiring is
 * testable without spawning a process.
 */
export function buildDevinArgs(
  req: AgentRequest,
  opts: DevinCliEngineOptions,
  files: { readonly promptFile: string; readonly exportFile: string; readonly configFile?: string },
): string[] {
  const clean = opts.clean ?? CLEAN_BY_DEFAULT;
  try {
    assertReadAccess(req);
    if (clean && files.configFile === undefined) {
      throw new TypeError('devin clean mode requires an empty config file');
    }
    if (req.tools?.length === 0) {
      throw new TypeError('devin cannot turn its tools off; choose an engine that supports tools: []');
    }
    if (req.workspaceMode === 'none') {
      throw new TypeError('devin has no mode without workspace access; choose read or write');
    }
    if ((req.effort ?? opts.effort) !== undefined) throw new TypeError(NO_EFFORT);
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
    '--prompt-file', files.promptFile,
    '--export', files.exportFile,
    '--permission-mode', permissionMode(req),
    // Print mode cannot show Devin's folder trust prompt; without this flag
    // every folder the person has not opened in Devin before refuses to run.
    '--respect-workspace-trust', 'false',
    ...(clean ? ['--config', files.configFile!] : []),
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

function devinCommandError(error: unknown, executable?: string): unknown {
  if (!(error instanceof OwnedCommandError)) return error;
  if (error.code === 'INVALID_EXECUTABLE') {
    return new EngineError({ kind: 'missing-cli', message: 'Devin executable is not runnable' });
  }
  if (error.code === 'INVALID_COMMAND') {
    return new EngineError({ kind: 'invalid-config', message: 'invalid Devin command request' });
  }
  if (error.code === 'SPAWN_FAILED') {
    if (executable !== undefined) {
      try { resolveCommandExecutable(executable); }
      catch { return new EngineError({ kind: 'missing-cli', message: 'Devin executable is not runnable' }); }
    }
    return new EngineError({ kind: 'unknown', message: 'Devin command could not start' });
  }
  return error;
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
    const exportFile = join(dir, 'conversation.json');
    const configFile = join(dir, 'config.json');
    const env = attemptEnvironment(req);
    try {
      // Devin has no system prompt flag, so system text leads the prompt.
      writeFileSync(
        promptFile,
        req.system ? `${req.system}\n\n---\n\n${req.prompt}` : req.prompt,
        { encoding: 'utf8', mode: 0o600 },
      );
      if (this.opts.clean ?? CLEAN_BY_DEFAULT) {
        writeFileSync(configFile, CLEAN_CONFIG, { encoding: 'utf8', mode: 0o600 });
      }
      const sub = await runOwnedCommand({
        executable,
        args: buildDevinArgs(req, this.opts, { promptFile, exportFile, configFile }),
        cwd: req.cwd ?? process.cwd(),
        env: env ?? {},
        stdin: '',
        ...ownedCommandIdentity({ adapter: ADAPTER, runId: req.attempt?.runId,
          leafId: req.attempt?.leafId, attemptId: req.attempt?.attemptId }),
        ...DEFAULT_OWNED_COMMAND_LIMITS,
        timeoutMs: req.timeoutMs ?? DEFAULT_OWNED_COMMAND_LIMITS.timeoutMs,
        teardownGraceMs: req.timeoutGraceMs ?? DEFAULT_OWNED_COMMAND_LIMITS.teardownGraceMs,
        maxOutputBytes: req.maxOutputBytes ?? DEFAULT_OWNED_COMMAND_LIMITS.maxOutputBytes,
        maxMemoryBytes: req.maxMemoryBytes ?? DEFAULT_OWNED_COMMAND_LIMITS.maxMemoryBytes,
      }, signal).catch((error: unknown) => { throw devinCommandError(error, executable); });

      const conversation = readExport(exportFile);
      const answered = conversation?.answered === true;
      const aborted = sub.aborted || signal.aborted;
      if (aborted && !answered) throw new EngineError({ kind: 'aborted', message: 'devin run aborted' });
      const diagnostic = scrubCapture(
        [new TextDecoder().decode(sub.stderr), new TextDecoder().decode(sub.stdout)]
          .filter((text) => text.length > 0).join('\n'),
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
      for (const text of conversation.messages) onEvent({ type: 'text', delta: text });
      for (const event of conversation.toolEvents) onEvent(event);
      if (!answered) {
        // A tool the permission mode does not approve is refused, and Devin
        // can then end with no answer and exit 0.
        throw new EngineIncompleteResultError(
          `devin ended without a final answer under permission mode ${permissionMode(req)}${
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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
