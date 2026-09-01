import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  sep,
} from 'node:path';
import {
  EngineError,
  EngineIncompleteResultError,
  attemptEnvironment,
  canonicalJson,
  classifyEngineFailure,
  cloneFrozenJson,
  engineSelection,
  reportedUsage,
  retryAfterHeaderToMs,
  scrubCapture,
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
  validateIncompleteResultEvidence,
} from '@obversa/engine';
import {
  DEFAULT_OWNED_COMMAND_LIMITS,
  ownedCommandIdentity,
  resolveCommandExecutable,
  runOwnedCommand,
} from '@obversa/engine/command';

const SUPPORTED_VERSION = '1.18.23';
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const STRUCTURED_RESULT_MARKER = 'OBVERSA_STRUCTURED_RESULT_V1\n';
const CONFIG_INTERPOLATION = /\{(?:env|file):/u;
const STEP_FINISH_REASONS = new Set([
  'stop',
  'length',
  'tool-calls',
  'content-filter',
  'error',
  'unknown',
]);
const BASE_SYSTEM_PROMPT =
  'Execute one isolated Lines node attempt. Follow only this system prompt and the user prompt. Use only the declared tools and permissions.';
const STRUCTURED_RESULT_INSTRUCTION = [
  'Your final answer must be one completed text part beginning with exactly:',
  'OBVERSA_STRUCTURED_RESULT_V1',
  'After that marker and one newline, write exactly one JSON value and nothing else.',
].join('\n');

const CAPABILITIES = new Set([
  'read',
  'edit',
  'glob',
  'grep',
  'bash',
  'task',
  'todowrite',
  'webfetch',
  'websearch',
]);
const FILESYSTEM_CAPABILITIES = new Set([
  'read',
  'edit',
  'glob',
  'grep',
  'bash',
]);
const WRITE_CAPABILITIES = new Set(['edit', 'bash']);
const PATTERN_PERMISSIONS = new Set([
  'read',
  'edit',
  'glob',
  'grep',
  'bash',
  'task',
]);
const PERMISSION_NAMES = new Map<string, string>([
  ['read', 'read'],
  ['edit', 'edit'],
  ['write', 'edit'],
  ['applypatch', 'edit'],
  ['glob', 'glob'],
  ['grep', 'grep'],
  ['bash', 'bash'],
  ['task', 'task'],
  ['todowrite', 'todowrite'],
  ['webfetch', 'webfetch'],
  ['websearch', 'websearch'],
]);

export interface OpenCodeCliIdentity {
  readonly provider: string | null;
  readonly modelFamily: string | null;
}

export interface OpenCodeCliEngineOptions {
  readonly executable: string;
  readonly version: string;
  readonly identity: OpenCodeCliIdentity;
  /** Exact host-selected values copied into the clean child environment. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Exact provider-keyed OpenCode auth data copied into the child environment. */
  readonly auth?: JsonObject;
}

export interface OpenCodeInvocation {
  readonly args: readonly string[];
  readonly stdin: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly configDirectory: string;
}

interface TextObservation {
  readonly text: string;
}

interface OpenCodeAccumulator {
  readonly frames: JsonValue[];
  readonly seenParts: Map<string, string>;
  readonly text: TextObservation[];
  sessionId: string | null;
  protocolError: Error | null;
  terminalError: JsonObject | null;
  stopReason: string | null;
  stepCount: number;
  usageValid: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

interface PermissionBuild {
  readonly capabilities: readonly string[];
  readonly tools: JsonObject;
  readonly permission: JsonObject;
}

function text(value: unknown, field: string): string {
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
  return value === null ? null : text(value, field);
}

function object(value: unknown, field: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as JsonObject;
}

function safeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function safeSum(left: number, right: number): number | undefined {
  const result = left + right;
  return Number.isSafeInteger(result) ? result : undefined;
}

function model(value: unknown): { readonly value: string; readonly provider: string } {
  const checked = text(value, 'OpenCode request model');
  const slash = checked.indexOf('/');
  if (
    slash < 1
    || slash === checked.length - 1
    || checked.includes(' ')
  ) {
    throw new TypeError('OpenCode request model must use provider/model format');
  }
  return Object.freeze({ value: checked, provider: checked.slice(0, slash) });
}

function providerForModel(
  selectedModel: { readonly provider: string },
  identity: OpenCodeCliIdentity,
): string {
  const asserted = nullableText(identity.provider, 'OpenCode provider');
  if (asserted !== null && asserted !== selectedModel.provider) {
    throw new TypeError(
      `OpenCode provider identity ${asserted} does not match model provider ${selectedModel.provider}`,
    );
  }
  return selectedModel.provider;
}

function selectedEnvironment(
  raw: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const selected: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new TypeError(`OpenCode environment name ${name} is invalid`);
    }
    if (typeof value !== 'string' || value.includes('\0')) {
      throw new TypeError(
        `OpenCode environment value ${name} must be a string without NUL`,
      );
    }
    if (
      name === 'HOME'
      || name === 'TMPDIR'
      || name.startsWith('XDG_')
      || name.startsWith('OPENCODE_')
    ) {
      throw new TypeError(`OpenCode environment cannot replace ${name}`);
    }
    selected[name] = value;
  }
  return Object.freeze(selected);
}

function authValue(value: JsonObject | undefined): JsonObject {
  if (value === undefined) return Object.freeze({});
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
  ) {
    throw new TypeError('OpenCode auth must be a provider-keyed object');
  }
  const checked = cloneFrozenJson(value);
  for (const [provider, rawEntry] of Object.entries(checked)) {
    text(provider, 'OpenCode auth provider');
    const entry = object(rawEntry, `OpenCode auth entry ${provider}`);
    if (entry.type === 'wellknown') {
      throw new TypeError('OpenCode wellknown auth is not isolated');
    }
    if (entry.type === 'api') {
      for (const field of Object.keys(entry)) {
        if (!['type', 'key', 'metadata'].includes(field)) {
          throw new TypeError(`OpenCode api auth field ${field} is not supported`);
        }
      }
      if (typeof entry.key !== 'string') {
        throw new TypeError('OpenCode api auth key must be a string');
      }
      if (entry.metadata !== undefined) {
        const metadata = object(
          entry.metadata,
          `OpenCode api auth metadata ${provider}`,
        );
        if (Object.values(metadata).some((item) => typeof item !== 'string')) {
          throw new TypeError('OpenCode api auth metadata values must be strings');
        }
      }
      continue;
    }
    if (entry.type === 'oauth') {
      for (const field of Object.keys(entry)) {
        if (![
          'type',
          'refresh',
          'access',
          'expires',
          'accountId',
          'enterpriseUrl',
        ].includes(field)) {
          throw new TypeError(`OpenCode oauth auth field ${field} is not supported`);
        }
      }
      if (typeof entry.refresh !== 'string' || typeof entry.access !== 'string') {
        throw new TypeError('OpenCode oauth auth tokens must be strings');
      }
      safeInteger(entry.expires, 'OpenCode oauth auth expiry');
      for (const field of ['accountId', 'enterpriseUrl'] as const) {
        if (entry[field] !== undefined && typeof entry[field] !== 'string') {
          throw new TypeError(`OpenCode oauth auth ${field} must be a string`);
        }
      }
      continue;
    }
    throw new TypeError(`OpenCode auth type ${String(entry.type)} is not supported`);
  }
  return checked;
}

function managedConfigSources(): readonly string[] {
  const systemDirectory = process.platform === 'darwin'
    ? '/Library/Application Support/opencode'
    : process.platform === 'win32'
      ? 'C:\\ProgramData\\opencode'
      : '/etc/opencode';
  const directories = [systemDirectory];
  const testDirectory = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR;
  if (testDirectory !== undefined) directories.push(testDirectory);
  const sources = directories.flatMap((directory) => [
    join(directory, 'opencode.json'),
    join(directory, 'opencode.jsonc'),
  ]);
  if (process.platform === 'darwin') {
    let user = 'user';
    try {
      user = userInfo().username || user;
    } catch {
      // Match OpenCode's fixed fallback without trusting HOME or USER.
    }
    sources.push(
      join(
        '/Library/Managed Preferences',
        user,
        'ai.opencode.managed.plist',
      ),
      '/Library/Managed Preferences/ai.opencode.managed.plist',
    );
  }
  return Object.freeze(sources);
}

function assertNoManagedConfig(): void {
  const source = managedConfigSources().find((candidate) => existsSync(candidate));
  if (source !== undefined) {
    throw new TypeError(`managed OpenCode config is not isolated: ${source}`);
  }
}

function assertNoProjectInstructions(
  workspace: string,
  capabilities: readonly string[],
): void {
  if (!capabilities.some((capability) => FILESYSTEM_CAPABILITIES.has(capability))) {
    return;
  }
  const instructionNames = new Set(['agents.md', 'claude.md', 'context.md']);
  const pending = [{ directory: workspace, root: true }];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const { directory, root } = pending.pop()!;
    let resolvedDirectory: string;
    let entries: ReturnType<typeof readdirSync>;
    try {
      resolvedDirectory = realpathSync(directory);
      if (visited.has(resolvedDirectory)) continue;
      visited.add(resolvedDirectory);
      entries = readdirSync(resolvedDirectory, { withFileTypes: true });
    } catch (error) {
      throw new TypeError(
        `OpenCode could not inspect project instructions under ${directory}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    for (const entry of entries) {
      const path = join(resolvedDirectory, entry.name);
      if (!root && instructionNames.has(entry.name.toLowerCase())) {
        throw new TypeError(
          `OpenCode project instruction ${path} is not isolated`,
        );
      }
      if (entry.isSymbolicLink()) {
        let target: string;
        let directoryTarget: boolean;
        try {
          target = realpathSync(path);
          directoryTarget = statSync(target).isDirectory();
        } catch (error) {
          throw new TypeError(
            `OpenCode could not inspect project symlink ${path}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        const pathFromWorkspace = relative(workspace, target);
        if (
          pathFromWorkspace === '..'
          || pathFromWorkspace.startsWith(`..${sep}`)
          || isAbsolute(pathFromWorkspace)
        ) {
          throw new TypeError(
            `OpenCode symlink ${path} resolves outside the workspace`,
          );
        }
        if (directoryTarget) {
          if (target === workspace) {
            throw new TypeError(
              `OpenCode symlink ${path} resolves to the workspace root`,
            );
          }
          pending.push({ directory: target, root: false });
        }
      } else if (entry.isDirectory()) {
        pending.push({ directory: path, root: false });
      }
    }
  }
}

function authRedactions(value: JsonObject): Readonly<Record<string, string>> {
  const redactions: Record<string, string> = {
    OPENCODE_AUTH_CONTENT: canonicalJson(value),
  };
  const pending: unknown[] = [value];
  let index = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      redactions[`OPENCODE_AUTH_VALUE_${index}`] = current;
      index += 1;
    } else if (Array.isArray(current)) {
      pending.push(...current);
    } else if (typeof current === 'object' && current !== null) {
      pending.push(...Object.values(current));
    }
  }
  return Object.freeze(redactions);
}

function scrubExactValues(
  raw: string,
  redactions: Readonly<Record<string, string>>,
): string {
  const values = [...new Set(Object.values(redactions))]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
  let result = raw;
  for (const value of values) result = result.split(value).join('[redacted]');
  return result;
}

function requestedCapabilities(request: AgentRequest): readonly string[] {
  const capabilities = engineSelection({
    adapter: 'opencode-cli',
    capabilities: request.tools ?? [],
  }).capabilities;
  for (const capability of capabilities) {
    if (!CAPABILITIES.has(capability)) {
      throw new TypeError(
        `OpenCode cannot represent capability ${capability}`,
      );
    }
  }
  if (request.leaf !== false && capabilities.includes('task')) {
    throw new TypeError('OpenCode leaf attempts cannot expose task');
  }
  const workspaceMode = request.workspaceMode ?? 'none';
  if (workspaceMode === 'none') {
    const unsafe = capabilities.find(
      (capability) => FILESYSTEM_CAPABILITIES.has(capability),
    );
    if (unsafe !== undefined) {
      throw new TypeError(
        `OpenCode workspace mode none cannot expose capability ${unsafe}`,
      );
    }
  }
  if (workspaceMode === 'read') {
    const unsafe = capabilities.find(
      (capability) => WRITE_CAPABILITIES.has(capability),
    );
    if (unsafe !== undefined) {
      throw new TypeError(
        `OpenCode read-only workspace cannot expose capability ${unsafe}`,
      );
    }
  }
  if (workspaceMode !== 'none' && workspaceMode !== 'read' && workspaceMode !== 'write') {
    throw new TypeError('OpenCode workspace mode must be none, read, or write');
  }
  return capabilities;
}

function permissionRule(
  raw: string,
): { readonly permission: string; readonly pattern: string | null } {
  const checked = text(raw, 'OpenCode permission rule');
  const match = /^([A-Za-z][A-Za-z0-9_]*)(?:\(([^\u0000-\u001f\u007f]+)\))?$/u
    .exec(checked);
  if (!match) {
    throw new TypeError(`OpenCode cannot represent permission rule ${checked}`);
  }
  const permission = PERMISSION_NAMES.get(match[1]!.toLowerCase());
  if (permission === undefined) {
    throw new TypeError(`OpenCode cannot represent permission rule ${checked}`);
  }
  return Object.freeze({ permission, pattern: match[2] ?? null });
}

function permissions(request: AgentRequest): PermissionBuild {
  const capabilities = requestedCapabilities(request);
  const toolValues: Record<string, JsonValue> = { '*': false };
  for (const capability of capabilities) toolValues[capability] = true;

  const permissionValues: Record<string, JsonValue> = { '*': 'deny' };
  const seen = new Set<string>();
  for (const raw of request.allowedTools ?? []) {
    if (seen.has(raw)) throw new TypeError('allowedTools must be unique');
    seen.add(raw);
    const rule = permissionRule(raw);
    if (rule.pattern !== null && !PATTERN_PERMISSIONS.has(rule.permission)) {
      throw new TypeError(
        `OpenCode permission ${rule.permission} does not accept patterns`,
      );
    }
    if (!capabilities.includes(rule.permission)) {
      throw new TypeError(
        `OpenCode permission ${raw} has no declared ${rule.permission} capability`,
      );
    }
    if (rule.pattern === null) {
      if (Object.hasOwn(permissionValues, rule.permission)) {
        throw new TypeError(
          `OpenCode permission ${rule.permission} has overlapping rules`,
        );
      }
      permissionValues[rule.permission] = 'allow';
      continue;
    }
    const current = permissionValues[rule.permission];
    if (typeof current === 'string') {
      throw new TypeError(
        `OpenCode permission ${rule.permission} has overlapping rules`,
      );
    }
    const patterns: Record<string, JsonValue> = current === undefined
      ? { '*': 'deny' as JsonValue }
      : { ...(current as JsonObject) };
    if (Object.hasOwn(patterns, rule.pattern)) {
      throw new TypeError(`OpenCode permission rule ${raw} is duplicated`);
    }
    patterns[rule.pattern] = 'allow';
    permissionValues[rule.permission] = patterns;
  }
  return Object.freeze({
    capabilities,
    tools: cloneFrozenJson(toolValues),
    permission: cloneFrozenJson(permissionValues),
  });
}

function trustedSystemPrompt(request: AgentRequest): string {
  let prompt: string;
  if (request.systemMode === 'replace') {
    if (request.system === undefined) {
      throw new TypeError('OpenCode system replacement requires system text');
    }
    prompt = request.system;
  } else {
    prompt = request.system === undefined
      ? BASE_SYSTEM_PROMPT
      : `${BASE_SYSTEM_PROMPT}\n\n${request.system}`;
  }
  if (request.jsonSchema !== undefined) {
    prompt = `${prompt}\n\n${STRUCTURED_RESULT_INSTRUCTION}`;
  }
  return prompt;
}

function configFor(
  request: AgentRequest,
  selectedModel: { readonly value: string; readonly provider: string },
  built: PermissionBuild,
): JsonObject {
  const agent = {
    mode: 'primary',
    model: selectedModel.value,
    prompt: trustedSystemPrompt(request),
    tools: built.tools,
    permission: built.permission,
  } as const;
  return cloneFrozenJson({
    share: 'disabled',
    autoupdate: false,
    snapshot: false,
    model: selectedModel.value,
    small_model: selectedModel.value,
    enabled_providers: [selectedModel.provider],
    default_agent: 'build',
    plugin: [],
    instructions: [],
    mcp: {},
    lsp: false,
    formatter: false,
    tools: built.tools,
    permission: built.permission,
    agent: { build: agent },
  });
}

function serializedConfig(value: JsonObject): string {
  const encoded = JSON.stringify(value);
  if (CONFIG_INTERPOLATION.test(encoded)) {
    throw new TypeError(
      'OpenCode config interpolation tokens {env:...} and {file:...} are not allowed',
    );
  }
  return encoded;
}

export function buildOpenCodeInvocation(
  request: AgentRequest,
  options: OpenCodeCliEngineOptions,
  rawDirectory: string,
): OpenCodeInvocation {
  if (typeof request.cwd !== 'string' || !isAbsolute(request.cwd)) {
    throw new TypeError('OpenCode request cwd must be an absolute path');
  }
  if (
    (request as AgentRequest & { readonly memory?: unknown }).memory !==
    undefined
  ) {
    throw new TypeError('OpenCode CLI does not bridge Lines memory');
  }
  if (request.env !== undefined && Object.keys(request.env).length > 0) {
    throw new TypeError(
      'OpenCode request environment is not allowed; select values in the constructor environment',
    );
  }
  if (!isAbsolute(rawDirectory)) {
    throw new TypeError('OpenCode isolation directory must be an absolute path');
  }
  if (typeof options.executable !== 'string' || !isAbsolute(options.executable)) {
    throw new TypeError('OpenCode executable must be an absolute path');
  }
  if (options.version !== SUPPORTED_VERSION) {
    throw new TypeError(`OpenCode CLI version must be ${SUPPORTED_VERSION}`);
  }

  const selectedModel = model(request.model);
  providerForModel(selectedModel, options.identity);
  const built = permissions(request);
  if (
    built.capabilities.includes('websearch')
    && selectedModel.provider !== 'opencode'
    && selectedModel.provider !== 'opencode-go'
  ) {
    throw new TypeError(
      `OpenCode provider ${selectedModel.provider} cannot expose websearch`,
    );
  }
  const directory = realpathSync(rawDirectory);
  const home = join(directory, 'home');
  const dataHome = join(directory, 'xdg-data');
  const configHome = join(directory, 'xdg-config');
  const cacheHome = join(directory, 'xdg-cache');
  const stateHome = join(directory, 'xdg-state');
  const temporary = join(directory, 'tmp');
  for (const path of [home, dataHome, configHome, cacheHome, stateHome, temporary]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }

  const selected = selectedEnvironment(options.environment);
  const auth = authValue(options.auth);
  const config = configFor(request, selectedModel, built);
  const configContent = serializedConfig(config);
  const attempt = attemptEnvironment({ ...request, env: undefined }) ?? {};
  const path = selected.PATH ?? [
    dirname(process.execPath),
    dirname(options.executable),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].filter((value, index, values) => values.indexOf(value) === index)
    .join(delimiter);
  const environment = Object.freeze({
    ...selected,
    ...attempt,
    PATH: path,
    HOME: home,
    XDG_DATA_HOME: dataHome,
    XDG_CONFIG_HOME: configHome,
    XDG_CACHE_HOME: cacheHome,
    XDG_STATE_HOME: stateHome,
    TMPDIR: temporary,
    OPENCODE_CONFIG_DIR: join(configHome, 'opencode'),
    OPENCODE_CONFIG_CONTENT: configContent,
    OPENCODE_AUTH_CONTENT: canonicalJson(auth),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_PURE: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_SHARE: '1',
  });
  return Object.freeze({
    args: Object.freeze([
      'run',
      '--format',
      'json',
      '--pure',
      '--model',
      selectedModel.value,
      '--dir',
      request.cwd,
    ]),
    stdin: request.prompt,
    environment,
    configDirectory: configHome,
  });
}

function partKey(part: JsonObject): string {
  return `${part.sessionID}/${part.messageID}/${part.id}`;
}

function consumePart(
  raw: unknown,
  expectedType: string,
  wrapperSessionId: string,
  accumulator: OpenCodeAccumulator,
): JsonObject | null {
  const part = object(raw, `OpenCode ${expectedType} part`);
  const id = text(part.id, `OpenCode ${expectedType} part id`);
  const sessionId = text(
    part.sessionID,
    `OpenCode ${expectedType} part sessionID`,
  );
  text(part.messageID, `OpenCode ${expectedType} part messageID`);
  if (part.type !== expectedType) {
    throw new TypeError(
      `OpenCode ${expectedType} wrapper contained ${String(part.type)} part`,
    );
  }
  if (sessionId !== wrapperSessionId) {
    throw new TypeError('OpenCode part session did not match its wrapper session');
  }
  const key = partKey({ ...part, id });
  const encoded = canonicalJson(part);
  const prior = accumulator.seenParts.get(key);
  if (prior !== undefined) {
    if (prior !== encoded) {
      throw new TypeError(`OpenCode emitted conflicting duplicate part ${key}`);
    }
    return null;
  }
  accumulator.seenParts.set(key, encoded);
  return part;
}

function consumeUsage(
  part: JsonObject,
  accumulator: OpenCodeAccumulator,
): void {
  try {
    const tokens = object(part.tokens, 'OpenCode step tokens');
    const cache = object(tokens.cache, 'OpenCode step cache tokens');
    const input = safeInteger(tokens.input, 'OpenCode input tokens');
    const output = safeInteger(tokens.output, 'OpenCode output tokens');
    const reasoning = safeInteger(tokens.reasoning, 'OpenCode reasoning tokens');
    const cacheRead = safeInteger(cache.read, 'OpenCode cache read tokens');
    const cacheWrite = safeInteger(cache.write, 'OpenCode cache write tokens');
    const inputWithRead = safeSum(input, cacheRead);
    const inputTotal = inputWithRead === undefined
      ? undefined
      : safeSum(inputWithRead, cacheWrite);
    const outputTotal = safeSum(output, reasoning);
    const nextInput = inputTotal === undefined
      ? undefined
      : safeSum(accumulator.inputTokens, inputTotal);
    const nextOutput = outputTotal === undefined
      ? undefined
      : safeSum(accumulator.outputTokens, outputTotal);
    const nextRead = safeSum(accumulator.cacheReadInputTokens, cacheRead);
    const nextWrite = safeSum(accumulator.cacheCreationInputTokens, cacheWrite);
    if (
      nextInput === undefined
      || nextOutput === undefined
      || nextRead === undefined
      || nextWrite === undefined
    ) {
      throw new TypeError('OpenCode usage totals overflowed');
    }
    accumulator.inputTokens = nextInput;
    accumulator.outputTokens = nextOutput;
    accumulator.cacheReadInputTokens = nextRead;
    accumulator.cacheCreationInputTokens = nextWrite;
    accumulator.stepCount += 1;
  } catch {
    accumulator.usageValid = false;
  }
}

function consumeLine(
  line: string,
  accumulator: OpenCodeAccumulator,
  onEvent: EngineEventSink,
  structured: boolean,
  capabilities: readonly string[],
): void {
  if (line.trim().length === 0 || accumulator.protocolError !== null) return;
  try {
    const frame = object(JSON.parse(line), 'OpenCode stream frame');
    const type = text(frame.type, 'OpenCode stream frame type');
    safeInteger(frame.timestamp, 'OpenCode stream frame timestamp');
    const sessionId = text(frame.sessionID, 'OpenCode stream frame sessionID');
    if (accumulator.sessionId === null) accumulator.sessionId = sessionId;
    if (accumulator.sessionId !== sessionId) {
      throw new TypeError('OpenCode stream changed session identity');
    }
    accumulator.frames.push(cloneFrozenJson(frame));

    if (type === 'error') {
      if (accumulator.terminalError !== null) {
        throw new TypeError('OpenCode emitted more than one terminal error');
      }
      accumulator.terminalError = object(frame.error, 'OpenCode stream error');
      return;
    }
    if (type === 'text') {
      const part = consumePart(frame.part, 'text', sessionId, accumulator);
      if (part === null) return;
      const value = typeof part.text === 'string'
        ? part.text
        : (() => { throw new TypeError('OpenCode text part text must be a string'); })();
      const time = object(part.time, 'OpenCode text part time');
      safeInteger(time.end, 'OpenCode text part end time');
      accumulator.text.push({ text: value });
      if (!structured || !value.includes(STRUCTURED_RESULT_MARKER)) {
        onEvent({ type: 'text', delta: value });
      }
      return;
    }
    if (type === 'reasoning') {
      const part = consumePart(frame.part, 'reasoning', sessionId, accumulator);
      if (part === null) return;
      if (typeof part.text !== 'string') {
        throw new TypeError('OpenCode reasoning part text must be a string');
      }
      onEvent({ type: 'thinking', delta: part.text });
      return;
    }
    if (type === 'tool_use') {
      const part = consumePart(frame.part, 'tool', sessionId, accumulator);
      if (part === null) return;
      const name = text(part.tool, 'OpenCode tool name');
      const capability = name === 'write' || name === 'apply_patch'
        ? 'edit'
        : name;
      if (!capabilities.includes(capability)) {
        throw new TypeError(`OpenCode emitted undeclared tool ${name}`);
      }
      const state = object(part.state, 'OpenCode tool state');
      if (state.status !== 'completed' && state.status !== 'error') {
        throw new TypeError('OpenCode tool terminal state must be completed or error');
      }
      onEvent({ type: 'tool', name, phase: 'use' });
      onEvent({ type: 'tool', name, phase: 'result' });
      return;
    }
    if (type === 'step_start') {
      consumePart(frame.part, 'step-start', sessionId, accumulator);
      return;
    }
    if (type === 'step_finish') {
      const part = consumePart(frame.part, 'step-finish', sessionId, accumulator);
      if (part !== null) {
        const reason = text(part.reason, 'OpenCode step reason');
        if (!STEP_FINISH_REASONS.has(reason)) {
          throw new TypeError(`OpenCode step reason ${reason} is invalid`);
        }
        accumulator.stopReason = reason;
        consumeUsage(part, accumulator);
      }
      return;
    }
    throw new TypeError(`OpenCode emitted unsupported event type ${type}`);
  } catch (error) {
    accumulator.protocolError = error instanceof Error
      ? error
      : new Error(String(error));
  }
}

function resultParts(
  accumulator: OpenCodeAccumulator,
): readonly AgentResultPart[] {
  return Object.freeze(accumulator.text.map((part, index, values) =>
    Object.freeze({
      kind: 'assistant' as const,
      text: part.text,
      final: index === values.length - 1,
    }),
  ));
}

function usage(accumulator: OpenCodeAccumulator): UsageReceipt {
  if (!accumulator.usageValid || accumulator.stepCount === 0) {
    return Object.freeze({ kind: 'unknown' });
  }
  return reportedUsage({
    inputTokens: accumulator.inputTokens,
    outputTokens: accumulator.outputTokens,
    ...(accumulator.cacheCreationInputTokens === 0
      ? {}
      : {
          cacheCreationInputTokens: accumulator.cacheCreationInputTokens,
        }),
    ...(accumulator.cacheReadInputTokens === 0
      ? {}
      : { cacheReadInputTokens: accumulator.cacheReadInputTokens }),
  });
}

function errorMessage(raw: JsonObject): string {
  const data: JsonObject = typeof raw.data === 'object' && raw.data !== null
    ? object(raw.data, 'OpenCode error data')
    : Object.freeze({});
  const detail = typeof data.message === 'string'
    ? data.message
    : typeof data.responseBody === 'string'
      ? data.responseBody
      : typeof raw.name === 'string'
        ? raw.name
        : 'OpenCode failed';
  return detail;
}

function nativeFailure(raw: JsonObject): EngineFailureKind {
  const name = typeof raw.name === 'string' ? raw.name : '';
  const data: JsonObject = typeof raw.data === 'object' && raw.data !== null
    ? object(raw.data, 'OpenCode error data')
    : Object.freeze({});
  const status = Number.isSafeInteger(data.statusCode)
    ? data.statusCode as number
    : undefined;
  const detail = errorMessage(raw);
  const responseBody = typeof data.responseBody === 'string'
    ? data.responseBody
    : '';
  if (name === 'ProviderAuthError') return 'auth';
  if (name === 'APIError' && status === 401) {
    if (/CreditsError|no payment|insufficient balance/iu.test(responseBody)) {
      return 'billing';
    }
    if (/MonthlyLimitError|UserLimitError/iu.test(responseBody)) return 'quota';
    if (/ModelError/iu.test(responseBody)) return 'model-unavailable';
  }
  if (status === 401) return 'auth';
  if (name === 'MessageAbortedError') return 'aborted';
  if (status === 402) return 'billing';
  if (status === 404) return 'model-unavailable';
  if (status === 408) return 'timeout';
  if (status === 429) {
    if (
      /credit balance|insufficient funds|out of credits|exhausted credit/iu
        .test(detail)
    ) {
      return 'billing';
    }
    return /quota|allowance|session limit|usage limit/iu.test(detail)
      ? 'quota'
      : 'rate-limit';
  }
  if (status !== undefined && status >= 500) return 'transient';
  return classifyEngineFailure(new Error(detail));
}

function header(
  raw: JsonObject,
  name: string,
): string | undefined {
  const data = typeof raw.data === 'object' && raw.data !== null
    ? object(raw.data, 'OpenCode error data')
    : undefined;
  const headers = data !== undefined
    && typeof data.responseHeaders === 'object'
    && data.responseHeaders !== null
      ? object(data.responseHeaders, 'OpenCode response headers')
      : undefined;
  if (headers === undefined) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === 'string') return value;
  }
  return undefined;
}

function resetAtHeader(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isSafeInteger(numeric)) return undefined;
    const milliseconds = numeric < 10_000_000_000
      ? numeric * 1_000
      : numeric;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function nativeLimitHints(raw: JsonObject | null): {
  readonly retryAfterMs?: number;
  readonly resetAt?: number;
} {
  if (raw === null) return Object.freeze({});
  const retryAfterMs = retryAfterHeaderToMs(header(raw, 'retry-after'));
  const resetAt = resetAtHeader(
    header(raw, 'x-ratelimit-reset')
    ?? header(raw, 'x-rate-limit-reset'),
  );
  return Object.freeze({
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(resetAt === undefined ? {} : { resetAt }),
  });
}

function loopError(
  kind: EngineFailureKind,
  message: string,
  hints: { readonly retryAfterMs?: number; readonly resetAt?: number } = {},
): EngineError {
  return new EngineError({ kind, message, ...hints });
}

function typedFailureMessage(kind: EngineFailureKind, detail: string): string {
  const label = kind === 'auth'
    ? 'authentication failed'
    : kind === 'billing'
      ? 'payment required'
      : kind === 'model-unavailable'
        ? 'model unavailable'
        : kind === 'rate-limit'
          ? 'rate limit reached'
          : kind === 'quota'
            ? 'quota reached'
            : kind === 'transient'
              ? 'service unavailable'
              : kind === 'timeout'
                ? 'timed out'
                : kind === 'aborted'
                  ? 'aborted'
                  : kind === 'invalid-config'
                    ? 'invalid configuration'
                    : 'failed';
  return `OpenCode ${label}: ${detail}`;
}

function transportFailure(
  kind: EngineFailureKind,
  message: string,
  exitCode: number | null,
): AgentResult['transportFailure'] {
  return Object.freeze({ kind, message, exitCode });
}

export class OpenCodeCliEngine implements Engine {
  readonly name = 'opencode-cli';
  readonly #executable: string;
  readonly #version: string;
  readonly #identity: OpenCodeCliIdentity;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #auth: JsonObject;
  readonly #authRedactions: Readonly<Record<string, string>>;
  readonly #options: OpenCodeCliEngineOptions;

  constructor(options: OpenCodeCliEngineOptions) {
    if (typeof options.executable !== 'string' || !isAbsolute(options.executable)) {
      throw new TypeError('OpenCode executable must be an absolute path');
    }
    try {
      this.#executable = resolveCommandExecutable(options.executable);
    } catch {
      throw new Error(`opencode command not found at ${options.executable}`);
    }
    if (options.version !== SUPPORTED_VERSION) {
      throw new TypeError(`OpenCode CLI version must be ${SUPPORTED_VERSION}`);
    }
    this.#version = options.version;
    const checked = engineSelection({
      adapter: 'opencode-cli',
      adapterVersion: this.#version,
      provider: nullableText(options.identity.provider, 'OpenCode provider'),
      modelFamily: nullableText(
        options.identity.modelFamily,
        'OpenCode model family',
      ),
    });
    this.#identity = Object.freeze({
      provider: checked.provider,
      modelFamily: checked.modelFamily,
    });
    this.#environment = selectedEnvironment(options.environment);
    this.#auth = authValue(options.auth);
    this.#authRedactions = authRedactions(this.#auth);
    this.#options = Object.freeze({
      executable: this.#executable,
      version: this.#version,
      identity: this.#identity,
      ...(Object.keys(this.#environment).length === 0
        ? {}
        : { environment: this.#environment }),
      ...(Object.keys(this.#auth).length === 0 ? {} : { auth: this.#auth }),
    });
  }

  async run(
    request: AgentRequest,
    onEvent: EngineEventSink,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    if (signal.aborted) {
      throw loopError('aborted', 'OpenCode attempt was aborted before start');
    }
    assertNoManagedConfig();
    const selectedModel = model(request.model);
    const selectedProvider = providerForModel(selectedModel, this.#identity);
    const capabilities = requestedCapabilities(request);
    const requested: EngineSelectionRecord = engineSelection({
      adapter: 'opencode-cli',
      adapterVersion: this.#version,
      provider: selectedProvider,
      modelFamily: this.#identity.modelFamily,
      model: selectedModel.value,
      executable: this.#executable,
      capabilities,
    });
    if (typeof request.cwd !== 'string' || !isAbsolute(request.cwd)) {
      throw new TypeError('OpenCode request cwd must be an absolute path');
    }
    const cwd = realpathSync(request.cwd);
    assertNoProjectInstructions(cwd, capabilities);
    const normalized: AgentRequest = { ...request, cwd };
    const directory = mkdtempSync(join(tmpdir(), 'lines-opencode-'));
    const accumulator: OpenCodeAccumulator = {
      frames: [],
      seenParts: new Map(),
      text: [],
      sessionId: null,
      protocolError: null,
      terminalError: null,
      stopReason: null,
      stepCount: 0,
      usageValid: true,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    const decoder = new TextDecoder();
    let buffer = '';
    const parserAbort = new AbortController();
    const commandSignal = AbortSignal.any([signal, parserAbort.signal]);
    const structured = request.jsonSchema !== undefined;
    const scrub = (value: string): string => scrubCapture(
      scrubExactValues(value, {
        ...this.#authRedactions,
        ...this.#environment,
      }),
      { ...this.#environment },
      700,
    );
    const owner = ownedCommandIdentity({
      adapter: 'opencode-cli',
      runId: request.attempt?.runId,
      leafId: request.attempt?.leafId,
      attemptId: request.attempt?.attemptId,
    });
    const startedAt = Date.now();

    try {
      const invocation = buildOpenCodeInvocation(
        normalized,
        this.#options,
        directory,
      );
      assertNoManagedConfig();
      const command = await runOwnedCommand({
        executable: this.#executable,
        args: invocation.args,
        cwd,
        env: invocation.environment,
        inheritParentEnv: false,
        stdin: invocation.stdin,
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
          buffer += decoder.decode(chunk, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            consumeLine(
              buffer.slice(0, newline),
              accumulator,
              onEvent,
              structured,
              capabilities,
            );
            buffer = buffer.slice(newline + 1);
            if (accumulator.protocolError !== null) {
              parserAbort.abort();
              return;
            }
          }
        },
      });
      buffer += decoder.decode();
      if (buffer.trim().length > 0) {
        consumeLine(buffer, accumulator, onEvent, structured, capabilities);
      }

      if (accumulator.protocolError !== null) {
        throw loopError(
          'invalid-config',
          `OpenCode returned an invalid JSON protocol: ${scrub(accumulator.protocolError.message)}`,
        );
      }
      if (command.aborted || signal.aborted) {
        throw loopError('aborted', 'OpenCode attempt was aborted');
      }

      const stderr = scrub(new TextDecoder().decode(command.stderr));
      const nativeKind = accumulator.terminalError === null
        ? undefined
        : nativeFailure(accumulator.terminalError);
      const nativeMessage = accumulator.terminalError === null
        ? ''
        : scrub(errorMessage(accumulator.terminalError));
      const failed = command.timedOut
        || command.exitCode !== 0
        || accumulator.terminalError !== null;
      const parts = resultParts(accumulator);
      if (
        accumulator.stopReason === 'error'
        || accumulator.stopReason === 'content-filter'
      ) {
        throw loopError(
          'unknown',
          `OpenCode ended with ${accumulator.stopReason}`,
        );
      }
      if (accumulator.stopReason === 'length') {
        const measuredUsage = usage(accumulator);
        const effective = requested;
        onEvent({
          type: 'usage',
          usage: measuredUsage,
          model: effective.model ?? 'unknown',
        });
        throw new EngineIncompleteResultError(
          'OpenCode output ended at the token limit',
          validateIncompleteResultEvidence({
            parts,
            usage: measuredUsage,
            requested,
            effective,
            stopReason: 'length',
            ...(failed
              ? {
                  transportFailure: transportFailure(
                    command.timedOut
                      ? 'timeout'
                      : nativeKind ?? classifyEngineFailure(new Error(stderr)),
                    nativeMessage || stderr || 'OpenCode transport failed',
                    command.exitCode,
                  ),
                }
              : {}),
            raw: cloneFrozenJson(accumulator.frames),
          }),
        );
      }
      const markedFinal = accumulator.stopReason === 'stop';
      if (!markedFinal) {
        if (!failed) {
          throw loopError(
            'invalid-config',
            'OpenCode completed without a final step',
          );
        }
        const kind = command.timedOut
          ? 'timeout'
          : nativeKind ?? classifyEngineFailure(new Error(stderr));
        throw loopError(
          kind,
          typedFailureMessage(
            kind,
            nativeMessage || stderr || 'incomplete result',
          ),
          nativeLimitHints(accumulator.terminalError),
        );
      }

      if (parts.length === 0) {
        if (failed) {
          const kind = command.timedOut
            ? 'timeout'
            : nativeKind ?? classifyEngineFailure(new Error(stderr));
          throw loopError(
            kind,
            typedFailureMessage(
              kind,
              nativeMessage || stderr || 'OpenCode produced no result text',
            ),
            nativeLimitHints(accumulator.terminalError),
          );
        }
        const measuredUsage = usage(accumulator);
        const effective = requested;
        onEvent({
          type: 'usage',
          usage: measuredUsage,
          model: effective.model ?? 'unknown',
        });
        throw new EngineIncompleteResultError(
          'OpenCode completed without a final text part',
          validateIncompleteResultEvidence({
            parts,
            usage: measuredUsage,
            requested,
            effective,
            stopReason: 'stop',
            raw: cloneFrozenJson(accumulator.frames),
          }),
        );
      }

      const measuredUsage = usage(accumulator);
      const effective = requested;
      onEvent({
        type: 'usage',
        usage: measuredUsage,
        model: effective.model ?? 'unknown',
      });
      const late = request.timeoutMs !== undefined
        && Date.now() - startedAt > request.timeoutMs;
      const failureKind = command.timedOut
        ? 'timeout'
        : nativeKind ?? classifyEngineFailure(new Error(stderr));
      const transportMessage = nativeMessage
        || stderr
        || 'OpenCode transport failed after its final result';
      return validateAgentResult({
        parts,
        usage: measuredUsage,
        requested,
        effective,
        ...(accumulator.stopReason === null
          ? {}
          : { stopReason: accumulator.stopReason }),
        ...(failed
          ? {
              transportFailure: transportFailure(
                failureKind,
                transportMessage,
                command.exitCode,
              ),
            }
          : late
            ? {
                transportFailure: transportFailure(
                  'timeout',
                  'OpenCode result arrived after the soft timeout',
                  command.exitCode,
                ),
              }
            : {}),
        raw: cloneFrozenJson(accumulator.frames),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
