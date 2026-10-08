import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  EngineError,
  assertReadAccess,
  canonicalJson,
  classifyEngineFailure,
  engineSelection,
  modelIdentity,
  reportedUsage,
  type AgentRequest,
  type AgentResult,
  type AgentResultPart,
  type Engine,
  type EngineEventSink,
  type EngineFailureKind,
  type EngineSelectionRecord,
  type JsonObject,
  type JsonValue,
  type UsageReceipt,
  validateAgentResult,
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
import { toolTarget } from '@obversa/core/tool-target';

type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto';

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const VERSION_TIMEOUT_MS = 5_000;
const VERSION_TEARDOWN_MS = 1_000;
const VERSION_OUTPUT_BYTES = 4_096;
const LOAD_SPAWN_CODES = new Set(['EAGAIN', 'EMFILE', 'ENOMEM']);
const GROK_VERSION = /^grok ([0-9]+\.[0-9]+\.[0-9]+)(?: \([0-9a-f]+\))?(?: \[[A-Za-z0-9._-]+\])?$/u;
const BASE_SYSTEM_PROMPT =
  'Execute one Obversa node attempt. Use only the declared tools and permissions.';
const WEB_TOOLS = new Set(['web_search', 'web_fetch', 'websearch', 'webfetch']);
const READ_ONLY_TOOLS = new Set([
  'read_file',
  'grep',
  'list_dir',
  'web_search',
  'web_fetch',
]);
const PERMISSION_RULE = /^(?:Bash|Edit|Write|Read|Grep|WebFetch|MCPTool)(?:\([^\u0000-\u001f\u007f]*\))?$/u;
const PERMISSION_TOOLS: Readonly<Record<string, readonly string[]>> = {
  Bash: ['run_terminal_command'],
  Edit: ['search_replace'],
  Write: ['search_replace'],
  Read: ['read_file', 'list_dir', 'grep'],
  Grep: ['grep', 'list_dir'],
  WebFetch: ['web_fetch'],
  MCPTool: ['use_tool'],
};
// The permission rule for a Grok tool named as a rule. A workflow role gives
// the seat's tools to the engine as its permission rules too.
const TOOL_RULES: Readonly<Record<string, string>> = {
  read_file: 'Read',
  list_dir: 'Read',
  grep: 'Grep',
  search_replace: 'Edit',
  run_terminal_command: 'Bash',
  web_fetch: 'WebFetch',
  use_tool: 'MCPTool',
};
// The tool id `--tools` takes, where it differs from the name Grok reports.
const TOOL_FLAG_IDS: Readonly<Record<string, string>> = {
  run_terminal_command: 'run_terminal_cmd',
};
// The tool names Grok reports in its start frame, where they differ from the
// declared capability.
const REPORTED_TOOLS: Readonly<Record<string, readonly string[]>> = {
  task: [
    'kill_command_or_subagent',
    'get_command_or_subagent_output',
    'spawn_subagent',
  ],
};

export interface GrokCliIdentity {
  readonly provider: string | null;
  readonly modelFamily: string | null;
}

export interface GrokCliEngineOptions {
  readonly executable: string;
  readonly version: string;
  readonly identity: GrokCliIdentity;
  readonly permissionMode?: PermissionMode;
  /** Values set on top of the person's own environment. */
  readonly environment?: Readonly<Record<string, string>>;
  /** A Grok login file to use instead of the person's own login. */
  readonly authFile?: string;
  /** Passed as `grok --reasoning-effort <level>`; a request's own `effort` wins. */
  readonly effort?: string;
  /**
   * Grok has no clean mode, so `true` throws. Its strict sandbox reads no
   * login outside its own home folder, so a run cannot leave the person's
   * Grok home out and keep their login. Grok runs on the person's setup
   * unless `authFile` is set, so it has no default to flip.
   */
  readonly clean?: boolean;
}

interface GrokAccumulator {
  readonly parts: AgentResultPart[];
  readonly toolNames: Map<string, string>;
  terminal: JsonObject | null;
  model: string | null;
  capabilities: readonly string[] | null;
  parseError: Error | null;
}

function nonEmptyText(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || CONTROL_CHARACTER.test(value)
  ) {
    throw new TypeError(
      `${field} must be a non-empty trimmed string without control characters`,
    );
  }
  return value;
}

function nullableText(value: unknown, field: string): string | null {
  return value === null ? null : nonEmptyText(value, field);
}

function requestedCapabilities(request: AgentRequest): readonly string[] {
  assertReadAccess(request);
  return engineSelection({
    adapter: 'grok-cli',
    capabilities: request.tools ?? [],
  }).capabilities;
}

function hasTool(tools: readonly string[], expected: string): boolean {
  return tools.some((tool) => tool.toLowerCase() === expected.toLowerCase());
}

function hasWebTool(tools: readonly string[]): boolean {
  return tools.some((tool) => WEB_TOOLS.has(tool.toLowerCase()));
}

function permissionRules(request: AgentRequest): readonly string[] {
  if (request.allowedTools === undefined) return Object.freeze([]);
  const rules = request.allowedTools.map((rule, index) =>
    nonEmptyText(rule, `allowedTools[${index}]`),
  );
  if (new Set(rules).size !== rules.length) {
    throw new TypeError('allowedTools must be unique');
  }
  // Two tools can share a rule, as `read_file` and `list_dir` share `Read`.
  const mapped = [...new Set(rules.map((rule) => TOOL_RULES[rule] ?? rule))];
  for (const rule of mapped) {
    if (!PERMISSION_RULE.test(rule)) {
      throw new TypeError(`Grok cannot represent permission rule ${rule}`);
    }
  }
  return Object.freeze(mapped);
}

function grokPermissionMode(options: GrokCliEngineOptions): 'dontAsk' {
  if (
    options.permissionMode !== undefined
    && options.permissionMode !== 'dontAsk'
  ) {
    throw new TypeError('Grok permissionMode must be dontAsk');
  }
  return 'dontAsk';
}

function sandboxProfile(request: AgentRequest): 'strict' | 'read-only' | 'workspace' {
  const mode = request.workspaceMode ?? 'none';
  if (mode === 'read') return 'strict';
  if (mode === 'write') return 'workspace';
  if (mode === 'none') return 'strict';
  throw new TypeError('Grok workspace mode must be none, read, or write');
}

function assertReadOnlyCapabilities(
  request: AgentRequest,
  tools: readonly string[],
  rules: readonly string[],
): void {
  if (request.workspaceMode === 'none') {
    if (tools.some((tool) => !WEB_TOOLS.has(tool.toLowerCase()))
      || rules.some((rule) => !/^WebFetch(?:\([^\u0000-\u001f\u007f]*\))?$/u.test(rule))) {
      throw new TypeError('Grok workspace mode none cannot expose filesystem tools or permissions');
    }
    return;
  }
  if (request.workspaceMode !== 'read') return;
  const unsafeTool = tools.find((tool) => !READ_ONLY_TOOLS.has(tool.toLowerCase()));
  if (unsafeTool !== undefined) {
    throw new TypeError(
      `Grok read-only workspace cannot expose capability ${unsafeTool}`,
    );
  }
  const unsafeRule = rules.find((rule) =>
    !/^(?:Read|Grep|WebFetch)(?:\([^\u0000-\u001f\u007f]*\))?$/u.test(rule),
  );
  if (unsafeRule !== undefined) {
    throw new TypeError(
      `Grok read-only workspace cannot grant permission ${unsafeRule}`,
    );
  }
  if (!tools.some((tool) => READ_ONLY_TOOLS.has(tool.toLowerCase()) && !WEB_TOOLS.has(tool.toLowerCase()))) {
    throw new TypeError('Grok read workspace requires a file-reading capability');
  }
}

function trustedSystemPrompt(request: AgentRequest): string {
  if (request.systemMode === 'replace') {
    if (request.system === undefined) {
      throw new TypeError('Grok system replacement requires system text');
    }
    return request.system;
  }
  return request.system === undefined
    ? BASE_SYSTEM_PROMPT
    : `${BASE_SYSTEM_PROMPT}\n\n${request.system}`;
}

function authRedactions(contents: string | null): Readonly<Record<string, string>> {
  if (contents === null) return Object.freeze({});
  const text = contents;
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) {
    throw new TypeError('Grok auth file must not exceed 1 MiB');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TypeError('Grok auth file must contain valid JSON');
  }
  const redactions: Record<string, string> = { GROK_AUTH_FILE: text };
  const pending: unknown[] = [value];
  let index = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      redactions[`GROK_AUTH_VALUE_${index}`] = current;
      index += 1;
    } else if (Array.isArray(current)) {
      pending.push(...current);
    } else if (typeof current === 'object' && current !== null) {
      pending.push(...Object.values(current));
    }
  }
  return Object.freeze(redactions);
}

function scrubAuthValues(
  text: string,
  redactions: Readonly<Record<string, string>>,
): string {
  const values = [...new Set(Object.values(redactions))]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
  let scrubbed = text;
  for (const value of values) {
    scrubbed = scrubbed.split(value).join('[redacted]');
  }
  return scrubbed;
}

function reportedTools(capabilities: readonly string[]): readonly string[] {
  return capabilities.flatMap((capability) =>
    REPORTED_TOOLS[capability] ?? [capability],
  );
}

/**
 * The values set on top of the person's own environment. Grok reads its
 * normal home folder and login unless the host chose another login file:
 * then a temporary Grok home holds a copy of only that file, because Grok's
 * sandbox reads no login outside its home.
 */
function childEnvironment(
  directory: string | undefined,
  request: AgentRequest,
  capabilities: readonly string[],
  selected: Readonly<Record<string, string>>,
  authContents: string | null,
): Readonly<Record<string, string>> {
  const attempt = attemptEnvironment({ ...request, env: undefined }) ?? {};
  let grokHome: Record<string, string> = {};
  if (authContents !== null) {
    const home = join(directory!, 'grok-home');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, 'auth.json'), authContents, {
      encoding: 'utf8',
      mode: 0o600,
    });
    grokHome = { GROK_HOME: home };
  }
  return Object.freeze({
    ...selected,
    ...attempt,
    ...grokHome,
    GROK_SUBAGENTS:
      request.leaf === false && hasTool(capabilities, 'task') ? '1' : '0',
  });
}

export function buildGrokArgs(
  request: AgentRequest,
  options: GrokCliEngineOptions,
  promptFile: string,
): string[] {
  if (!isAbsolute(promptFile)) {
    throw new TypeError('Grok prompt file must be an absolute path');
  }
  if (typeof request.cwd !== 'string' || !isAbsolute(request.cwd)) {
    throw new TypeError('Grok request cwd must be an absolute path');
  }
  if (
    (request as AgentRequest & { readonly memory?: unknown }).memory !==
    undefined
  ) {
    throw new TypeError('Grok CLI does not bridge Obversa memory');
  }
  const model = nonEmptyText(request.model, 'Grok request model');
  const tools = requestedCapabilities(request);
  const rules = permissionRules(request);
  assertReadOnlyCapabilities(request, tools, rules);
  for (const rule of rules) {
    const permission = rule.split('(', 1)[0]!;
    if (!PERMISSION_TOOLS[permission]!.some((tool) => hasTool(tools, tool))) {
      throw new TypeError(`Grok permission ${rule} has no declared capability`);
    }
  }
  const structured = request.jsonSchema !== undefined;
  const subagentsAllowed = request.leaf === false && hasTool(tools, 'task');
  // Grok reads an empty `--tools` list as every tool, so a step with no tools
  // allows one and then removes it with `--disallowed-tools`.
  const noTools = tools.length === 0;
  const args = [
    '--prompt-file',
    promptFile,
    '--output-format',
    structured ? 'json' : 'streaming-messages-json',
    '--cwd',
    request.cwd,
    '--model',
    model,
    '--permission-mode',
    grokPermissionMode(options),
    '--sandbox',
    sandboxProfile(request),
    '--tools',
    noTools ? 'read_file' : tools.map((tool) => TOOL_FLAG_IDS[tool] ?? tool).join(','),
    '--verbatim',
    '--no-auto-update',
  ];
  const effort = request.effort ?? options.effort;
  if (effort !== undefined) args.push('--reasoning-effort', effort);
  for (const rule of rules) args.push('--allow', rule);
  const disallowedTools = [
    ...(noTools ? ['read_file'] : []),
    ...(hasTool(tools, 'search_tool') ? [] : ['search_tool']),
    ...(hasTool(tools, 'use_tool') ? [] : ['use_tool']),
    ...(subagentsAllowed ? [] : ['Agent']),
  ];
  if (disallowedTools.length > 0) {
    args.push('--disallowed-tools', disallowedTools.join(','));
  }
  if (!hasTool(tools, 'search_tool') && !hasTool(tools, 'use_tool')) {
    args.push('--deny', 'MCPTool');
  }
  if (request.workspaceMode === 'read') {
    args.push('--deny', 'Bash', '--deny', 'Edit', '--deny', 'Write');
  }
  args.push('--system-prompt-override', trustedSystemPrompt(request));
  if (request.jsonSchema !== undefined) {
    args.push('--json-schema', canonicalJson(request.jsonSchema));
  }
  if (!subagentsAllowed) args.push('--no-subagents');
  if (!hasWebTool(tools)) args.push('--disable-web-search');
  return args;
}

function object(value: unknown, field: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as JsonObject;
}

function optionalToken(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : undefined;
}

function usageFromTerminal(terminal: JsonObject): UsageReceipt {
  if (terminal.usage_is_incomplete === true) return { kind: 'unknown' };
  if (!Object.hasOwn(terminal, 'usage')) return { kind: 'unknown' };
  const usage = object(terminal.usage, 'Grok result usage');
  const input = optionalToken(usage.input_tokens);
  const output = optionalToken(usage.output_tokens);
  const cacheCreation = optionalToken(usage.cache_creation_input_tokens);
  const cacheRead = optionalToken(usage.cache_read_input_tokens);
  if (
    input === undefined
    || output === undefined
    || (Object.hasOwn(usage, 'cache_creation_input_tokens')
      && cacheCreation === undefined)
    || (Object.hasOwn(usage, 'cache_read_input_tokens')
      && cacheRead === undefined)
  ) {
    return { kind: 'unknown' };
  }
  if (
    input === 0
    && output === 0
    && (cacheCreation ?? 0) === 0
    && (cacheRead ?? 0) === 0
  ) {
    return { kind: 'unknown' };
  }
  const inputTokens = input + (cacheCreation ?? 0) + (cacheRead ?? 0);
  if (!Number.isSafeInteger(inputTokens)) return { kind: 'unknown' };
  return reportedUsage({
    inputTokens,
    outputTokens: output,
    ...(Object.hasOwn(usage, 'cache_creation_input_tokens')
      ? { cacheCreationInputTokens: cacheCreation! }
      : {}),
    ...(Object.hasOwn(usage, 'cache_read_input_tokens')
      ? { cacheReadInputTokens: cacheRead! }
      : {}),
  });
}

function contentBlocks(message: JsonObject): readonly unknown[] {
  return Array.isArray(message.content) ? message.content : [];
}

function consumeAssistant(
  message: JsonObject,
  accumulator: GrokAccumulator,
  onEvent: EngineEventSink,
  topLevel: boolean,
): void {
  if (
    topLevel
    && typeof message.model === 'string'
    && message.model !== 'unknown'
    && message.model !== 'Grok Build'
  ) {
    accumulator.model = nonEmptyText(message.model, 'Grok assistant model');
  }
  let text = '';
  for (const rawBlock of contentBlocks(message)) {
    const block = object(rawBlock, 'Grok assistant content block');
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
      onEvent({ type: 'text', delta: block.text });
    } else if (
      block.type === 'thinking'
      && typeof block.thinking === 'string'
    ) {
      onEvent({ type: 'thinking', delta: block.thinking });
    } else if (
      (block.type === 'tool_use' || block.type === 'server_tool_use')
      && typeof block.id === 'string'
      && typeof block.name === 'string'
    ) {
      const id = nonEmptyText(block.id, 'Grok tool id');
      const name = nonEmptyText(block.name, 'Grok tool name');
      accumulator.toolNames.set(id, name);
      const target = toolTarget(block.input);
      onEvent({ type: 'tool', name, phase: 'use', ...(target === undefined ? {} : { target }) });
    }
  }
  if (text.length > 0) {
    accumulator.parts.push({ kind: 'assistant', text, final: false });
  }
}

function consumeUser(
  message: JsonObject,
  accumulator: GrokAccumulator,
  onEvent: EngineEventSink,
): void {
  for (const rawBlock of contentBlocks(message)) {
    const block = object(rawBlock, 'Grok user content block');
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') {
      continue;
    }
    const id = nonEmptyText(block.tool_use_id, 'Grok tool result id');
    onEvent({
      type: 'tool',
      name: accumulator.toolNames.get(id) ?? id,
      phase: 'result',
    });
  }
}

function consumeLine(
  line: string,
  accumulator: GrokAccumulator,
  onEvent: EngineEventSink,
  expectedCapabilities: readonly string[],
): void {
  if (line.trim().length === 0 || accumulator.parseError !== null) return;
  try {
    if (accumulator.terminal !== null) {
      throw new TypeError('Grok emitted data after its terminal result');
    }
    const frame = object(JSON.parse(line), 'Grok stream frame');
    // Grok prints a start frame with an empty session id and no tools when it
    // fails before a session starts, such as when it is not signed in. Its
    // result frame then carries the reason.
    if (
      frame.type === 'system'
      && frame.session_id === ''
      && (frame.tools === undefined
        || (Array.isArray(frame.tools) && frame.tools.length === 0))
    ) return;
    if (frame.type === 'system') {
      if (
        typeof frame.model === 'string'
        && frame.model !== 'unknown'
        && frame.model !== 'Grok Build'
      ) {
        accumulator.model = nonEmptyText(frame.model, 'Grok init model');
      }
      if (Array.isArray(frame.tools)) {
        // Grok lists the tools of the person's own MCP servers that connected
        // before this frame, even when `--deny MCPTool` keeps them from the
        // model, so the check leaves out the tools of a server it names.
        const servers = Array.isArray(frame.mcp_servers)
          ? frame.mcp_servers.flatMap((server) =>
            typeof server === 'object' && server !== null && !Array.isArray(server)
              && typeof server.name === 'string' ? [`${server.name}__`] : [])
          : [];
        const reported = frame.tools.map((tool, index) =>
          nonEmptyText(tool, `Grok init tools[${index}]`),
        ).filter((tool) => !servers.some((prefix) => tool.startsWith(prefix)));
        const expected = reportedTools(expectedCapabilities);
        const undeclared = reported.find((tool) => !expected.includes(tool));
        if (undeclared !== undefined) {
          throw new TypeError(
            `Grok init reported undeclared capability ${undeclared}`,
          );
        }
        const missing = expected.find((tool) => !reported.includes(tool));
        if (missing !== undefined) {
          throw new TypeError(
            `Grok init omitted declared capability ${missing}`,
          );
        }
        accumulator.capabilities = expectedCapabilities;
      }
    } else if (frame.type === 'assistant') {
      consumeAssistant(
        object(frame.message, 'Grok assistant message'),
        accumulator,
        onEvent,
        frame.parent_tool_use_id === null,
      );
    } else if (frame.type === 'user') {
      consumeUser(
        object(frame.message, 'Grok user message'),
        accumulator,
        onEvent,
      );
    } else if (frame.type === 'result') {
      accumulator.terminal = frame;
    }
  } catch (error) {
    accumulator.parseError = error instanceof Error
      ? error
      : new Error(String(error));
  }
}

function finalParts(
  parts: readonly AgentResultPart[],
  terminal: JsonObject,
): readonly AgentResultPart[] {
  const output = [...parts];
  if (
    Object.hasOwn(terminal, 'structuredOutput')
    || Object.hasOwn(terminal, 'structured_output')
  ) {
    output.push({
      kind: 'structured',
      value: (
        Object.hasOwn(terminal, 'structuredOutput')
          ? terminal.structuredOutput
          : terminal.structured_output
      ) as JsonValue,
      final: true,
    });
    return output;
  }
  const finalText = typeof terminal.result === 'string'
    ? terminal.result
    : '';
  const last = output.at(-1);
  if (
    finalText.length > 0
    && last?.kind === 'assistant'
    && last.text === finalText
  ) {
    output[output.length - 1] = { ...last, final: true };
    return output;
  }
  if (finalText.length > 0) {
    output.push({ kind: 'assistant', text: finalText, final: true });
    return output;
  }
  if (last?.kind === 'assistant') {
    output[output.length - 1] = { ...last, final: true };
    return output;
  }
  throw new TypeError('Grok completed without a final result');
}

function observedJsonModel(
  terminal: JsonObject,
  requestedModel: string,
): string | null {
  if (!Object.hasOwn(terminal, 'modelUsage')) return null;
  const usage = object(terminal.modelUsage, 'Grok result modelUsage');
  const models = Object.keys(usage)
    .map((model, index) =>
      nonEmptyText(model, `Grok result modelUsage key ${index}`),
    )
    .filter((model) => model !== 'Grok Build');
  if (models.includes(requestedModel)) return requestedModel;
  return models.length === 1 ? models[0]! : null;
}

function stopReason(terminal: JsonObject): string | undefined {
  const value = terminal.stopReason ?? terminal.stop_reason;
  return typeof value === 'string' ? value : undefined;
}

function sameCapabilities(
  expected: readonly string[],
  observed: readonly string[],
): boolean {
  return expected.length === observed.length
    && expected.every((capability) => observed.includes(capability));
}

function loopError(
  kind: EngineFailureKind,
  message: string,
  effective?: EngineSelectionRecord,
): EngineError {
  return new EngineError({ kind, message, effective });
}

function transportFailure(
  diagnostic: string,
  exitCode: number | null,
  timedOut: boolean,
  aborted: boolean,
): AgentResult['transportFailure'] {
  const kind = aborted
    ? 'aborted'
    : timedOut
    ? 'timeout'
    : classifyEngineFailure(new Error(diagnostic));
  return {
    kind,
    message: diagnostic || 'Grok transport failed after its final result',
    exitCode,
  };
}

export interface GrokSeatOptions {
  /** Absolute path to the Grok CLI. */
  readonly executable: string;
  /** The version the CLI must report. Default `1.0.44`, the tested version. */
  readonly version?: string;
  /** Default `read_file`, `grep` and `list_dir`. */
  readonly tools?: readonly string[];
  readonly effort?: string;
}

export interface GrokSeat {
  readonly engine: GrokCliEngine;
  readonly identity: {
    readonly adapter: 'grok-cli';
    readonly provider: 'xai';
    readonly modelFamily: string;
    readonly model: string;
    readonly tools: readonly string[];
  };
}

/** Create the Grok seat used by declarative team workflows. */
export function grok(model: string, options: GrokSeatOptions): GrokSeat {
  const { modelFamily } = modelIdentity(model);
  return {
    engine: new GrokCliEngine({
      executable: options.executable,
      version: options.version ?? '1.0.44',
      identity: { provider: 'xai', modelFamily },
      ...(options.effort === undefined ? {} : { effort: options.effort }),
    }),
    identity: {
      adapter: 'grok-cli',
      provider: 'xai',
      modelFamily,
      model,
      tools: options.tools ?? ['read_file', 'grep', 'list_dir'],
    },
  };
}

export class GrokCliEngine implements Engine {
  readonly name = 'grok-cli';
  readonly #executable: string;
  readonly #version: string;
  #versionObservation: Promise<string> | undefined;
  readonly #identity: GrokCliIdentity;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #authFile: string | null;
  readonly #authContents: string | null;
  readonly #authRedactions: Readonly<Record<string, string>>;
  readonly #options: GrokCliEngineOptions;

  constructor(options: GrokCliEngineOptions) {
    if (options.clean === true) {
      throw new TypeError(
        'Grok has no clean mode: its strict sandbox reads no login outside its own home folder, so a run cannot leave your Grok setup out and keep your login',
      );
    }
    grokPermissionMode(options);
    if (typeof options.executable !== 'string' || !isAbsolute(options.executable)) {
      throw new TypeError('Grok executable must be an absolute path');
    }
    this.#executable = nonEmptyText(options.executable, 'Grok executable');
    this.#version = nonEmptyText(options.version, 'Grok CLI version');
    const checked = engineSelection({
      adapter: 'grok-cli',
      adapterVersion: this.#version,
      provider: nullableText(options.identity.provider, 'Grok provider'),
      modelFamily: nullableText(options.identity.modelFamily, 'Grok model family'),
    });
    this.#identity = Object.freeze({
      provider: checked.provider,
      modelFamily: checked.modelFamily,
    });
    const selectedEnvironment: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.environment ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
        throw new TypeError(`Grok environment name ${name} is invalid`);
      }
      if (typeof value !== 'string' || value.includes('\0')) {
        throw new TypeError(`Grok environment value ${name} must be a string without NUL`);
      }
      if (name.startsWith('GROK_')) {
        throw new TypeError(`Grok environment cannot replace ${name}`);
      }
      selectedEnvironment[name] = value;
    }
    this.#environment = Object.freeze(selectedEnvironment);
    if (options.authFile === undefined) {
      this.#authFile = null;
      this.#authContents = null;
    } else {
      if (!isAbsolute(options.authFile)) {
        throw new TypeError('Grok auth file must be an absolute path');
      }
      const auth = lstatSync(options.authFile);
      if (auth.isSymbolicLink() || !auth.isFile()) {
        throw new TypeError('Grok auth file must be a regular file, not a symlink');
      }
      this.#authFile = realpathSync(options.authFile);
      this.#authContents = readFileSync(this.#authFile, 'utf8');
    }
    this.#authRedactions = authRedactions(this.#authContents);
    this.#options = Object.freeze({
      executable: this.#executable,
      version: this.#version,
      identity: this.#identity,
      ...(options.permissionMode === undefined
        ? {}
        : { permissionMode: options.permissionMode }),
      ...(Object.keys(this.#environment).length === 0
        ? {}
        : { environment: this.#environment }),
      ...(this.#authFile === null ? {} : { authFile: this.#authFile }),
      ...(options.effort === undefined ? {} : { effort: options.effort }),
    });
  }

  async admit(
    request: Omit<AgentRequest, 'prompt'>,
    signal: AbortSignal,
    expectedSelection?: EngineSelectionRecord,
  ): Promise<EngineSelectionRecord> {
    if (signal.aborted) {
      throw loopError('aborted', 'Grok admission was aborted before start');
    }
    let normalized: AgentRequest;
    let selected: EngineSelectionRecord;
    try {
      if (request.env !== undefined && Object.keys(request.env).length > 0) {
        throw new TypeError(
          'Grok request environment is not allowed; select values in the constructor environment',
        );
      }
      const model = nonEmptyText(request.model, 'Grok request model');
      if (typeof request.cwd !== 'string' || !isAbsolute(request.cwd)) {
        throw new TypeError('Grok request cwd must be an absolute path');
      }
      const cwd = realpathSync(request.cwd);
      normalized = { ...request, cwd, prompt: '' };
      const capabilities = requestedCapabilities(normalized);
      buildGrokArgs(normalized, this.#options, join(cwd, 'prompt.md'));
      const timeout = request.timeoutMs ?? DEFAULT_OWNED_COMMAND_LIMITS.timeoutMs;
      const grace = request.timeoutGraceMs ?? DEFAULT_OWNED_COMMAND_LIMITS.teardownGraceMs;
      const output = request.maxOutputBytes ?? DEFAULT_OWNED_COMMAND_LIMITS.maxOutputBytes;
      const memory = request.maxMemoryBytes ?? DEFAULT_OWNED_COMMAND_LIMITS.maxMemoryBytes;
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647
        || !Number.isSafeInteger(grace) || grace < 0 || grace > 2_147_483_647 - timeout
        || !Number.isSafeInteger(output) || output < 0
        || !Number.isSafeInteger(memory) || memory < 1) {
        throw new TypeError('Grok request command limits are invalid');
      }
      ownedCommandIdentity({
        adapter: 'grok-cli', runId: request.attempt?.runId,
        leafId: request.attempt?.leafId, attemptId: request.attempt?.attemptId,
      });
      selected = engineSelection({
        adapter: 'grok-cli', adapterVersion: this.#version,
        provider: this.#identity.provider, modelFamily: this.#identity.modelFamily,
        model, executable: this.#executable, capabilities,
        effort: request.effort ?? this.#options.effort,
      });
      if (expectedSelection !== undefined
        && !isDeepStrictEqual(engineSelection(expectedSelection), selected)) {
        throw new TypeError('Grok expected selection does not match its configured path and request');
      }
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : 'invalid request';
      throw loopError('invalid-config', scrubCapture(
        scrubAuthValues(diagnostic, this.#authRedactions), { ...this.#environment }, 700,
      ));
    }
    // Recheck availability at the retained absolute path, never choose another path.
    try {
      resolveCommandExecutable(this.#executable);
    } catch {
      throw loopError('missing-cli', 'Grok configured executable is missing or not runnable');
    }
    const version = await (this.#versionObservation ??= this.#observeVersion(
      normalized, selected.capabilities, signal,
    ).catch((error: unknown) => {
      this.#versionObservation = undefined;
      throw error;
    }));
    if (signal.aborted) throw loopError('aborted', 'Grok admission was aborted');
    return engineSelection({ ...selected, adapterVersion: version });
  }

  async #observeVersion(
    request: AgentRequest,
    capabilities: readonly string[],
    signal: AbortSignal,
  ): Promise<string> {
    let directory: string | undefined;
    let primary: EngineError | undefined;
    try {
      if (this.#authContents !== null) {
        directory = mkdtempSync(join(tmpdir(), 'lines-grok-version-'));
      }
      const environment = childEnvironment(
        directory, request, capabilities, this.#environment, this.#authContents,
      );
      const command = await runOwnedCommand({
        executable: this.#executable,
        args: ['--version'],
        cwd: request.cwd!,
        env: environment,
        stdin: '',
        ...ownedCommandIdentity({
          adapter: 'grok-cli', runId: request.attempt?.runId,
          leafId: request.attempt?.leafId, attemptId: request.attempt?.attemptId,
        }),
        timeoutMs: Math.min(request.timeoutMs ?? VERSION_TIMEOUT_MS, VERSION_TIMEOUT_MS),
        teardownGraceMs: Math.min(request.timeoutGraceMs ?? VERSION_TEARDOWN_MS, VERSION_TEARDOWN_MS),
        maxOutputBytes: Math.min(request.maxOutputBytes ?? VERSION_OUTPUT_BYTES, VERSION_OUTPUT_BYTES),
        maxMemoryBytes: request.maxMemoryBytes ?? DEFAULT_OWNED_COMMAND_LIMITS.maxMemoryBytes,
      }, signal);
      if (command.aborted || signal.aborted) {
        throw loopError('aborted', 'Grok version check was aborted');
      }
      if (command.timedOut) throw loopError('timeout', 'Grok version check timed out');
      if (command.exitCode !== 0) {
        throw loopError('invalid-config', 'Grok version command did not succeed');
      }
      const version = GROK_VERSION.exec(new TextDecoder().decode(command.stdout).trim())?.[1];
      if (version === undefined) {
        throw loopError('invalid-config', 'Grok returned an unsupported version format');
      }
      if (version !== this.#version) {
        throw loopError('invalid-config', 'Grok observed version does not match its configured version');
      }
      return version;
    } catch (error) {
      if (error instanceof EngineError) {
        primary = error;
      } else if (signal.aborted) {
        primary = loopError('aborted', 'Grok version check was aborted');
      } else if (error instanceof OwnedCommandError && error.code === 'INVALID_EXECUTABLE') {
        primary = loopError('missing-cli', 'Grok configured executable could not start');
      } else if (error instanceof OwnedCommandError && error.code === 'SPAWN_FAILED') {
        if (LOAD_SPAWN_CODES.has(error.spawnCode ?? '')) {
          primary = loopError('transient', `the system refused to start the Grok process (${error.spawnCode})`);
        } else {
          try { resolveCommandExecutable(this.#executable); }
          catch { primary = loopError('missing-cli', 'Grok configured executable is missing or not runnable'); }
          if (primary === undefined) primary = loopError('unknown', 'Grok version process could not start');
        }
      } else if (error instanceof OwnedCommandError
        && (error.code === 'OUTPUT_LIMIT' || error.code === 'INVALID_COMMAND')) {
        primary = loopError('invalid-config', 'Grok version command exceeded or rejected its limits');
      } else {
        // Local command/cleanup failure supplies no provider availability evidence.
        primary = loopError('unknown', 'Grok version check could not complete');
      }
      throw primary;
    } finally {
      if (directory !== undefined) {
        try {
          rmSync(directory, { recursive: true, force: true });
        } catch {
          throw primary ?? loopError('unknown', 'Grok version check could not complete');
        }
      }
    }
  }

  async run(
    request: AgentRequest,
    onEvent: EngineEventSink,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    if (signal.aborted) {
      throw loopError('aborted', 'Grok attempt was aborted before start');
    }
    const { prompt: _prompt, ...staticRequest } = request;
    const requested = await this.admit(staticRequest, signal);
    const model = requested.model!;
    const capabilities = requested.capabilities;
    const cwd = realpathSync(request.cwd!);
    const normalizedRequest: AgentRequest = { ...request, cwd };
    const directory = mkdtempSync(join(tmpdir(), 'lines-grok-'));
    const promptFile = join(directory, 'prompt.md');
    writeFileSync(promptFile, request.prompt, { encoding: 'utf8', mode: 0o600 });
    const accumulator: GrokAccumulator = {
      parts: [],
      toolNames: new Map(),
      terminal: null,
      model: null,
      capabilities: null,
      parseError: null,
    };
    const decoder = new TextDecoder();
    let buffer = '';
    const parserAbort = new AbortController();
    const commandSignal = AbortSignal.any([signal, parserAbort.signal]);
    const flush = (line: string): void =>
      consumeLine(line, accumulator, onEvent, capabilities);
    const startedAt = Date.now();
    const owner = ownedCommandIdentity({
      adapter: 'grok-cli',
      runId: request.attempt?.runId,
      leafId: request.attempt?.leafId,
      attemptId: request.attempt?.attemptId,
    });

    try {
      const environment = childEnvironment(
        directory,
        normalizedRequest,
        capabilities,
        this.#environment,
        this.#authContents,
      );
      const structured = normalizedRequest.jsonSchema !== undefined;
      const command = await runOwnedCommand({
        executable: this.#executable,
        args: buildGrokArgs(normalizedRequest, this.#options, promptFile),
        cwd,
        env: environment,
        stdin: '',
        ...owner,
        ...DEFAULT_OWNED_COMMAND_LIMITS,
        timeoutMs:
          request.timeoutMs ?? DEFAULT_OWNED_COMMAND_LIMITS.timeoutMs,
        teardownGraceMs:
          request.timeoutGraceMs ?? DEFAULT_OWNED_COMMAND_LIMITS.teardownGraceMs,
        maxOutputBytes:
          request.maxOutputBytes ?? DEFAULT_OWNED_COMMAND_LIMITS.maxOutputBytes,
        maxMemoryBytes:
          request.maxMemoryBytes ?? DEFAULT_OWNED_COMMAND_LIMITS.maxMemoryBytes,
      }, commandSignal, {
        onStdout(chunk) {
          if (structured) return;
          buffer += decoder.decode(chunk, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            flush(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            if (accumulator.parseError !== null) {
              parserAbort.abort();
              return;
            }
          }
        },
      });
      if (!structured) {
        buffer += decoder.decode();
        if (buffer.length > 0) flush(buffer);
      }

      if (accumulator.parseError) {
        throw loopError(
          'invalid-config',
          `Grok returned an invalid JSON stream: ${accumulator.parseError.message}`,
        );
      }
      const stdout = new TextDecoder().decode(command.stdout);
      const stderr = new TextDecoder().decode(command.stderr);
      const scrubDiagnostic = (value: string): string => scrubCapture(
        scrubAuthValues(value, this.#authRedactions),
        { ...this.#environment },
        700,
      );
      const stderrDiagnostic = scrubDiagnostic(stderr);
      const stdoutDiagnostic = scrubDiagnostic(stdout);
      const aborted = command.aborted || signal.aborted;
      const failed = aborted || command.timedOut || command.exitCode !== 0;
      let terminal = accumulator.terminal;
      if (structured && stdout.trim().length > 0) {
        try {
          terminal = object(JSON.parse(stdout), 'Grok JSON result');
        } catch (error) {
          if (!failed) {
            throw loopError(
              'invalid-config',
              `Grok returned invalid JSON: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      }
      const observedCapabilities = accumulator.capabilities ?? capabilities;
      const effective = engineSelection({
        adapter: 'grok-cli',
        adapterVersion: requested.adapterVersion,
        provider: this.#identity.provider,
        modelFamily: this.#identity.modelFamily,
        model: structured && terminal !== null
          ? observedJsonModel(terminal, model)
          : accumulator.model,
        executable: this.#executable,
        capabilities: observedCapabilities,
        effort: requested.effort,
      });
      const succeeded = terminal !== null && (
        structured
          ? terminal.type !== 'error'
            && Object.hasOwn(terminal, 'structuredOutput')
          : terminal.subtype === 'success' && terminal.is_error !== true
      );
      if (!succeeded) {
        // A call that ends with no answer still spent the tokens its result
        // line reported. A result line it cannot read counts as unknown, so
        // the failure keeps its own kind.
        let spent: UsageReceipt = { kind: 'unknown' };
        try {
          if (terminal !== null) spent = usageFromTerminal(terminal);
        } catch { /* unknown */ }
        onEvent({
          type: 'usage',
          usage: spent,
          model: effective.model ?? requested.model ?? 'unknown',
        });
      }
      if (aborted && !succeeded) {
        throw loopError('aborted', 'Grok attempt was aborted');
      }
      if (!succeeded) {
        const rawDetail = terminal && typeof terminal.message === 'string'
          ? terminal.message
          : terminal && Array.isArray(terminal.errors)
            ? terminal.errors.map(String).join('; ')
            : stderrDiagnostic || stdoutDiagnostic;
        const detail = scrubDiagnostic(rawDetail);
        const kind = command.timedOut
          ? 'timeout'
          : classifyEngineFailure(new Error(detail || 'Grok failed'));
        throw loopError(
          kind,
          `Grok failed${detail ? `: ${detail}` : ''}`,
          effective,
        );
      }
      if (terminal === null) {
        throw loopError('invalid-config', 'Grok completed without a result');
      }

      const usage = usageFromTerminal(terminal);
      if (!sameCapabilities(capabilities, observedCapabilities)) {
        throw loopError(
          'invalid-config',
          'Grok effective capabilities did not match the prepared request',
        );
      }
      onEvent({
        type: 'usage',
        usage,
        model: effective.model ?? requested.model ?? 'unknown',
      });
      const late = request.timeoutMs !== undefined
        && Date.now() - startedAt > request.timeoutMs;
      return validateAgentResult({
        parts: finalParts(accumulator.parts, terminal),
        usage,
        requested,
        effective,
        ...(stopReason(terminal) === undefined
          ? {}
          : { stopReason: stopReason(terminal) }),
        ...(failed
          ? {
              transportFailure: transportFailure(
                stderrDiagnostic,
                command.exitCode,
                command.timedOut,
                aborted,
              ),
            }
          : late
            ? {
                transportFailure: {
                  kind: 'timeout' as const,
                  message: 'Grok result arrived after the soft timeout',
                  exitCode: command.exitCode,
                },
              }
            : {}),
        raw: terminal,
      });
    } catch (error) {
      if (error instanceof OwnedCommandError && error.code === 'INVALID_EXECUTABLE') {
        throw loopError('missing-cli', 'Grok configured executable could not start');
      }
      if (error instanceof OwnedCommandError && error.code === 'SPAWN_FAILED') {
        if (LOAD_SPAWN_CODES.has(error.spawnCode ?? '')) {
          throw loopError('transient', `the system refused to start the Grok process (${error.spawnCode})`);
        }
        try { resolveCommandExecutable(this.#executable); }
        catch { throw loopError('missing-cli', 'Grok configured executable is missing or not runnable'); }
        throw loopError('unknown', 'Grok model process could not start');
      }
      throw error;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
