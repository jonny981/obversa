import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EngineError,
  EngineIncompleteResultError,
  classifyEngineFailure,
  digestJson,
  type AgentRequest,
  type AgentResultPart,
  type EngineStreamEvent,
  type JsonValue,
} from '@obversa/engine';
import { runEngineConformance } from '@obversa/engine/testing';
import {
  buildOpenCodeInvocation,
  OpenCodeCliEngine,
  type OpenCodeCliEngineOptions,
} from '../src/index.ts';

const roots: string[] = [];
const fixtureSource = fileURLToPath(
  new URL('fixtures/opencode-cli.mjs', import.meta.url),
);

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryDirectory(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), label)));
  roots.push(root);
  return root;
}

function executable(): string {
  const directory = temporaryDirectory('lines-opencode-cli-');
  const target = join(directory, 'opencode-fixture');
  copyFileSync(fixtureSource, target);
  chmodSync(target, 0o755);
  return target;
}

function options(bin = executable()): OpenCodeCliEngineOptions {
  return {
    executable: bin,
    version: '1.18.23',
    identity: {
      provider: 'fixture-provider',
      modelFamily: 'fixture-family',
    },
  };
}

function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
  const attemptId = digestJson({
    schemaVersion: 1,
    namespace: 'tenant-a',
    streamId: 'run-1',
    nodeId: 'reviewer',
    position: 'review/main',
  });
  return {
    prompt: 'Review the candidate.',
    system: 'Follow the fixture rules.',
    model: 'fixture-provider/fixture-model',
    tools: ['read', 'grep'],
    allowedTools: ['Read(src/**)', 'Grep'],
    cwd: temporaryDirectory('lines-opencode-cwd-'),
    workspaceMode: 'read',
    leaf: true,
    timeoutMs: 2_000,
    timeoutGraceMs: 200,
    maxOutputBytes: 64 * 1_024,
    maxMemoryBytes: 256 * 1_024 * 1_024,
    attempt: {
      leaf: true,
      runId: 'run-1',
      attemptId,
      leafId: 'reviewer',
      path: ['review/main'],
      label: 'reviewer',
      iteration: 0,
    },
    ...overrides,
  };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path) && Date.now() < deadline) await delay(10);
  expect(existsSync(path)).toBe(true);
}

function invocationConfig(value: ReturnType<typeof buildOpenCodeInvocation>) {
  return JSON.parse(value.environment.OPENCODE_CONFIG_CONTENT ?? '') as {
    share: string;
    autoupdate: boolean;
    model: string;
    small_model: string;
    enabled_providers: string[];
    plugin: unknown[];
    mcp: Record<string, unknown>;
    lsp: boolean;
    formatter: boolean;
    tools: Record<string, boolean>;
    permission: Record<string, unknown>;
    agent: {
      build: {
        prompt: string;
        tools: Record<string, boolean>;
        permission: Record<string, unknown>;
      };
    };
  };
}

const STRUCTURED_RESULT_MARKER = 'OBVERSA_STRUCTURED_RESULT_V1\n';

function parseStructuredResult(
  part: AgentResultPart,
  parts: readonly AgentResultPart[] = [part],
): JsonValue {
  const marked = parts.filter(
    (value) => value.kind === 'assistant'
      && value.text.startsWith(STRUCTURED_RESULT_MARKER),
  );
  if (
    part.kind !== 'assistant'
    || !part.text.startsWith(STRUCTURED_RESULT_MARKER)
    || marked.length !== 1
    || marked[0] !== part
  ) {
    throw new TypeError('expected exactly one final structured result marker');
  }
  return JSON.parse(part.text.slice(STRUCTURED_RESULT_MARKER.length)) as JsonValue;
}

describe('OpenCode CLI adapter', () => {
  it('builds one exact isolated OpenCode 1.18.23 invocation', async () => {
    const root = temporaryDirectory('lines-opencode-invocation-');
    const input = request();
    const invocation = buildOpenCodeInvocation(input, options('/bin/echo'), root);
    const config = invocationConfig(invocation);

    expect(invocation.args).toEqual([
      'run',
      '--format',
      'json',
      '--pure',
      '--model',
      'fixture-provider/fixture-model',
      '--dir',
      input.cwd,
    ]);
    expect(invocation.stdin).toBe('Review the candidate.');
    expect(invocation.configDirectory).toBe(join(root, 'xdg-config'));
    expect(invocation.args).not.toEqual(expect.arrayContaining([
      '--auto',
      '--share',
      '--continue',
      '--session',
      '--fork',
      '--attach',
      '--agent',
    ]));
    expect(invocation.environment).toMatchObject({
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_PURE: '1',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
      OPENCODE_DISABLE_SHARE: '1',
      OPENCODE_AUTH_CONTENT: '{}',
    });
    expect(config).toMatchObject({
      share: 'disabled',
      autoupdate: false,
      model: 'fixture-provider/fixture-model',
      small_model: 'fixture-provider/fixture-model',
      enabled_providers: ['fixture-provider'],
      plugin: [],
      mcp: {},
      lsp: false,
      formatter: false,
    });
    expect(config.tools).toEqual({ '*': false, read: true, grep: true });
    expect(Object.keys(config.permission)[0]).toBe('*');
    expect(config.permission).toEqual({
      '*': 'deny',
      read: { '*': 'deny', 'src/**': 'allow' },
      grep: 'allow',
    });
    expect(config.agent.build.tools).toEqual(config.tools);
    expect(config.agent.build.permission).toEqual(config.permission);
    expect(config.agent.build.prompt).toContain('Follow the fixture rules.');
  });

  it('runs with stdin, isolated homes, explicit auth, and no parent state', async () => {
    const parentHome = temporaryDirectory('lines-opencode-parent-home-');
    const poisonedConfig = join(parentHome, 'config', 'opencode');
    mkdirSync(poisonedConfig, { recursive: true });
    writeFileSync(
      join(poisonedConfig, 'opencode.json'),
      '{"plugin":["poison"],"model":"poison/model"}',
    );
    const recordPath = join(
      temporaryDirectory('lines-opencode-record-'),
      'call.json',
    );
    vi.stubEnv('HOME', parentHome);
    vi.stubEnv('XDG_CONFIG_HOME', join(parentHome, 'config'));
    vi.stubEnv('OPENCODE_CONFIG_CONTENT', '{"plugin":["poison"]}');
    vi.stubEnv('OPENCODE_AUTH_CONTENT', '{"fixture":{"key":"poison"}}');
    vi.stubEnv('OBVERSA_POISONED_PARENT_SECRET', 'must-not-cross');
    const auth = {
      fixture: { type: 'api', key: 'selected-auth' },
    } as const;
    const input = request();
    const selectedOptions = options();

    const engine = new OpenCodeCliEngine({
      ...selectedOptions,
      auth,
      environment: {
        OBVERSA_TEST_OPENCODE_RECORD: recordPath,
        OBVERSA_TEST_OPENCODE_SCENARIO: 'ordered-parts',
        OBVERSA_TEST_OPENCODE_SELECTED: 'selected-by-host',
      },
    });
    (auth.fixture as { key: string }).key = 'changed-after-selection';
    const result = await engine.run(
      input,
      () => {},
      new AbortController().signal,
    );
    const call = JSON.parse(readFileSync(recordPath, 'utf8')) as {
      args: string[];
      cwd: string;
      prompt: string;
      attempt: { attemptId: string; runId: string; headless: string };
      environment: Record<string, string | boolean | null>;
    };
    const config = JSON.parse(String(call.environment.config)) as {
      model: string;
      plugin: unknown[];
    };

    expect(call.args).toEqual([
      'run', '--format', 'json', '--pure', '--model',
      'fixture-provider/fixture-model', '--dir', input.cwd,
    ]);
    expect(call.cwd).toBe(input.cwd);
    expect(call.prompt).toBe(input.prompt);
    expect(call.attempt).toEqual({
      attemptId: input.attempt?.attemptId,
      runId: 'run-1',
      headless: '1',
    });
    expect(call.environment).toMatchObject({
      selected: 'selected-by-host',
      requestSecret: null,
      parentSecret: null,
      projectConfigDisabled: '1',
      pure: '1',
      defaultPluginsDisabled: '1',
      externalSkillsDisabled: '1',
      claudeCodeDisabled: '1',
      autoUpdateDisabled: '1',
      lspDownloadDisabled: '1',
      shareDisabled: '1',
      poisonedConfigVisible: false,
    });
    expect(call.environment.home).not.toBe(parentHome);
    expect(call.environment.configHome).not.toBe(join(parentHome, 'config'));
    expect(call.environment.auth).toBe(
      '{"fixture":{"key":"selected-auth","type":"api"}}',
    );
    expect(config).toMatchObject({
      model: 'fixture-provider/fixture-model',
      plugin: [],
    });
    expect(existsSync(String(call.environment.home))).toBe(false);
    expect(existsSync(String(call.environment.configHome))).toBe(false);
    expect(result.parts).toEqual([
      { kind: 'assistant', text: 'draft', final: false },
      { kind: 'assistant', text: 'answer', final: true },
    ]);
    expect(result.requested.executable).toBe(selectedOptions.executable);
    expect(result.effective.executable).toBe(selectedOptions.executable);
  });

  it('refuses machine-managed config before spawn', async () => {
    const managed = temporaryDirectory('lines-opencode-managed-');
    const recordPath = join(
      temporaryDirectory('lines-opencode-record-'),
      'call.json',
    );
    writeFileSync(join(managed, 'opencode.json'), '{"tools":{"bash":true}}');
    vi.stubEnv('OPENCODE_TEST_MANAGED_CONFIG_DIR', managed);

    await expect(new OpenCodeCliEngine({
      ...options(),
      environment: { OBVERSA_TEST_OPENCODE_RECORD: recordPath },
    }).run(request(), () => {}, new AbortController().signal)).rejects.toThrow(
      'managed OpenCode config',
    );
    expect(existsSync(recordPath)).toBe(false);
  });

  it.each(['AGENTS.md', 'CLAUDE.md', 'CONTEXT.md'])(
    'refuses nested %s instructions for a read-capable attempt',
    async (name) => {
      const workspace = temporaryDirectory('lines-opencode-instructions-');
      const nested = join(workspace, 'src');
      mkdirSync(nested);
      writeFileSync(join(nested, name), 'ambient instructions');
      writeFileSync(join(nested, 'work.ts'), 'export {};');
      const recordPath = join(
        temporaryDirectory('lines-opencode-record-'),
        'call.json',
      );

      await expect(new OpenCodeCliEngine({
        ...options(),
        environment: { OBVERSA_TEST_OPENCODE_RECORD: recordPath },
      }).run(request({
        cwd: workspace,
        tools: ['read'],
        allowedTools: ['Read(src/**)'],
      }), () => {}, new AbortController().signal)).rejects.toThrow(
        'project instruction',
      );
      expect(existsSync(recordPath)).toBe(false);
    },
  );

  it('allows a root instruction when project config loading is disabled', async () => {
    const workspace = temporaryDirectory('lines-opencode-root-instructions-');
    writeFileSync(join(workspace, 'AGENTS.md'), 'root instructions');

    const result = await new OpenCodeCliEngine({
      ...options(),
      environment: { OBVERSA_TEST_OPENCODE_SCENARIO: 'success' },
    }).run(request({
      cwd: workspace,
      tools: ['read'],
      allowedTools: ['Read(src/**)'],
    }), () => {}, new AbortController().signal);

    expect(result.parts.at(-1)).toEqual({
      kind: 'assistant',
      text: 'answer',
      final: true,
    });
  });

  it('refuses instructions under .git and external directory symlinks before spawn', async () => {
    const gitWorkspace = temporaryDirectory('lines-opencode-git-instructions-');
    mkdirSync(join(gitWorkspace, '.git'));
    writeFileSync(join(gitWorkspace, '.git', 'AGENTS.md'), 'git instructions');
    const linkedWorkspace = temporaryDirectory('lines-opencode-link-instructions-');
    const target = temporaryDirectory('lines-opencode-link-target-');
    writeFileSync(join(target, 'AGENTS.md'), 'linked instructions');
    symlinkSync(target, join(linkedWorkspace, 'link'));
    const engine = new OpenCodeCliEngine(options());

    await expect(engine.run(request({
      cwd: gitWorkspace,
      tools: ['read'],
      allowedTools: ['Read(.git/**)'],
    }), () => {}, new AbortController().signal)).rejects.toThrow(
      'project instruction',
    );
    await expect(engine.run(request({
      cwd: linkedWorkspace,
      tools: ['read'],
      allowedTools: ['Read(link/**)'],
    }), () => {}, new AbortController().signal)).rejects.toThrow(
      'outside the workspace',
    );
  });

  it('allows contained directory symlinks in a pnpm-shaped workspace', async () => {
    const workspace = temporaryDirectory('lines-opencode-contained-link-');
    const target = join(workspace, 'node_modules', '.pnpm', 'fixture');
    const linkParent = join(workspace, 'packages', 'app', 'node_modules');
    mkdirSync(target, { recursive: true });
    mkdirSync(linkParent, { recursive: true });
    writeFileSync(join(target, 'index.js'), 'export {};');
    symlinkSync(target, join(linkParent, 'fixture'));

    const result = await new OpenCodeCliEngine({
      ...options(),
      environment: { OBVERSA_TEST_OPENCODE_SCENARIO: 'success' },
    }).run(request({
      cwd: workspace,
      tools: ['read'],
      allowedTools: ['Read(packages/**)'],
    }), () => {}, new AbortController().signal);

    expect(result.parts.at(-1)).toEqual({
      kind: 'assistant',
      text: 'answer',
      final: true,
    });
  });

  it('refuses a nested directory symlink back to the workspace root', async () => {
    const workspace = temporaryDirectory('lines-opencode-root-link-');
    writeFileSync(join(workspace, 'AGENTS.md'), 'root instructions');
    writeFileSync(join(workspace, 'file'), 'contents');
    symlinkSync(workspace, join(workspace, 'nested'));
    const recordPath = join(
      temporaryDirectory('lines-opencode-record-'),
      'call.json',
    );

    await expect(new OpenCodeCliEngine({
      ...options(),
      environment: { OBVERSA_TEST_OPENCODE_RECORD: recordPath },
    }).run(request({
      cwd: workspace,
      tools: ['read'],
      allowedTools: ['Read(nested/file)'],
    }), () => {}, new AbortController().signal)).rejects.toThrow(
      'workspace root',
    );
    expect(existsSync(recordPath)).toBe(false);
  });

  it.each([
    ['read', 'Read(src/link)'],
    ['edit', 'Edit(src/link)'],
    ['bash', 'Bash(cat src/link)'],
  ])('refuses an external file symlink for %s capability', async (tool, rule) => {
    const workspace = temporaryDirectory('lines-opencode-external-file-link-');
    const source = join(temporaryDirectory('lines-opencode-link-target-'), 'secret');
    const sourceParent = join(workspace, 'src');
    mkdirSync(sourceParent);
    writeFileSync(source, 'outside');
    symlinkSync(source, join(sourceParent, 'link'));
    const recordPath = join(
      temporaryDirectory('lines-opencode-record-'),
      'call.json',
    );

    await expect(new OpenCodeCliEngine({
      ...options(),
      environment: { OBVERSA_TEST_OPENCODE_RECORD: recordPath },
    }).run(request({
      cwd: workspace,
      tools: [tool],
      allowedTools: [rule],
      workspaceMode: tool === 'read' ? 'read' : 'write',
    }), () => {}, new AbortController().signal)).rejects.toThrow(
      'outside the workspace',
    );
    expect(existsSync(recordPath)).toBe(false);
  });

  it('refuses lower-case nested project instructions before spawn', async () => {
    const workspace = temporaryDirectory('lines-opencode-lower-instructions-');
    const nested = join(workspace, 'src');
    mkdirSync(nested);
    writeFileSync(join(nested, 'agents.md'), 'ambient instructions');
    const recordPath = join(
      temporaryDirectory('lines-opencode-record-'),
      'call.json',
    );

    await expect(new OpenCodeCliEngine({
      ...options(),
      environment: { OBVERSA_TEST_OPENCODE_RECORD: recordPath },
    }).run(request({
      cwd: workspace,
      tools: ['read'],
      allowedTools: ['Read(src/**)'],
    }), () => {}, new AbortController().signal)).rejects.toThrow(
      'project instruction',
    );
    expect(existsSync(recordPath)).toBe(false);
  });

  it('maps none, read, write, web, and subagent permissions without ambient allows', () => {
    const root = temporaryDirectory('lines-opencode-permissions-');
    const none = invocationConfig(buildOpenCodeInvocation(
      request({ tools: [], allowedTools: [], workspaceMode: 'none' }),
      options('/bin/echo'),
      root,
    ));
    expect(none.tools).toEqual({ '*': false });
    expect(none.permission).toEqual({ '*': 'deny' });

    const write = invocationConfig(buildOpenCodeInvocation(
      request({
        tools: ['edit', 'bash', 'webfetch', 'task'],
        allowedTools: [
          'Edit(src/**)',
          'Bash(git status)',
          'WebFetch',
          'Task(worker)',
        ],
        workspaceMode: 'write',
        leaf: false,
      }),
      options('/bin/echo'),
      root,
    ));
    expect(write.tools).toEqual({
      '*': false,
      edit: true,
      bash: true,
      webfetch: true,
      task: true,
    });
    expect(write.permission).toEqual({
      '*': 'deny',
      edit: { '*': 'deny', 'src/**': 'allow' },
      bash: { '*': 'deny', 'git status': 'allow' },
      webfetch: 'allow',
      task: { '*': 'deny', worker: 'allow' },
    });
  });

  it('keeps web and todo tools independent from filesystem access', () => {
    const root = temporaryDirectory('lines-opencode-non-filesystem-');
    const none = invocationConfig(buildOpenCodeInvocation(
      request({
        tools: ['webfetch', 'todowrite'],
        allowedTools: ['WebFetch', 'TodoWrite'],
        workspaceMode: 'none',
      }),
      options('/bin/echo'),
      root,
    ));
    expect(none.tools).toEqual({
      '*': false,
      webfetch: true,
      todowrite: true,
    });

    const read = invocationConfig(buildOpenCodeInvocation(
      request({
        tools: ['read', 'webfetch'],
        allowedTools: ['Read(src/**)', 'WebFetch'],
        workspaceMode: 'read',
      }),
      options('/bin/echo'),
      root,
    ));
    expect(read.tools).toEqual({ '*': false, read: true, webfetch: true });
  });

  it.each([
    ['webfetch', 'WebFetch(https://example.test/**)', 'fixture-provider/model'],
    ['websearch', 'WebSearch(query)', 'opencode/model'],
    ['todowrite', 'TodoWrite(item)', 'fixture-provider/model'],
  ])('rejects patterned %s permissions before spawn', (tool, rule, selectedModel) => {
    expect(() => buildOpenCodeInvocation(
      request({
        model: selectedModel,
        tools: [tool],
        allowedTools: [rule],
        workspaceMode: 'write',
      }),
      {
        ...options('/bin/echo'),
        identity: { provider: null, modelFamily: null },
      },
      temporaryDirectory('lines-opencode-pattern-rule-'),
    )).toThrow('does not accept patterns');
  });

  it('rejects unsafe or unrepresentable capabilities before spawn', async () => {
    const recordPath = join(
      temporaryDirectory('lines-opencode-record-'),
      'call.json',
    );
    const engine = new OpenCodeCliEngine({
      ...options(),
      environment: { OBVERSA_TEST_OPENCODE_RECORD: recordPath },
    });

    await expect(engine.run(
      request({ tools: ['bash'], allowedTools: ['Bash(git status)'] }),
      () => {},
      new AbortController().signal,
    )).rejects.toThrow('read-only workspace');
    await expect(engine.run(
      request({ tools: ['task'], allowedTools: ['Task'], leaf: true }),
      () => {},
      new AbortController().signal,
    )).rejects.toThrow('leaf');
    await expect(engine.run(
      request({ tools: ['plugin_tool'], allowedTools: ['PluginTool'] }),
      () => {},
      new AbortController().signal,
    )).rejects.toThrow('cannot represent capability');
    await expect(engine.run(
      request({ tools: ['list'], allowedTools: ['List'] }),
      () => {},
      new AbortController().signal,
    )).rejects.toThrow('cannot represent capability');
    await expect(engine.run(
      request({
        tools: ['lsp'],
        allowedTools: ['Lsp'],
        workspaceMode: 'write',
      }),
      () => {},
      new AbortController().signal,
    )).rejects.toThrow('cannot represent capability');
    await expect(engine.run(
      request({
        tools: ['skill'],
        allowedTools: ['Skill'],
        workspaceMode: 'write',
      }),
      () => {},
      new AbortController().signal,
    )).rejects.toThrow('cannot represent capability');
    expect(existsSync(recordPath)).toBe(false);
  });

  it('rejects websearch when the selected provider cannot expose it', async () => {
    const recordPath = join(
      temporaryDirectory('lines-opencode-record-'),
      'call.json',
    );
    const engine = new OpenCodeCliEngine({
      ...options(),
      identity: { provider: null, modelFamily: null },
      environment: { OBVERSA_TEST_OPENCODE_RECORD: recordPath },
    });

    await expect(engine.run(request({
      model: 'anthropic/claude-sonnet',
      tools: ['websearch'],
      allowedTools: ['WebSearch'],
      workspaceMode: 'write',
    }), () => {}, new AbortController().signal)).rejects.toThrow(
      'cannot expose websearch',
    );
    expect(existsSync(recordPath)).toBe(false);
  });

  it.each([
    [
      'an absolute file token',
      { system: '{file:/etc/passwd}' },
    ],
    [
      'a relative file token',
      { allowedTools: ['Read({file:README.md})'] },
    ],
    [
      'a selected environment token',
      { model: 'fixture-provider/{env:OBVERSA_TEST_OPENCODE_SELECTED}' },
    ],
  ])('rejects %s in config before spawn', async (_label, overrides) => {
    const recordPath = join(
      temporaryDirectory('lines-opencode-record-'),
      'call.json',
    );
    const engine = new OpenCodeCliEngine({
      ...options(),
      environment: {
        OBVERSA_TEST_OPENCODE_RECORD: recordPath,
        OBVERSA_TEST_OPENCODE_SELECTED: 'selected-secret',
      },
    });

    await expect(engine.run(
      request(overrides),
      () => {},
      new AbortController().signal,
    )).rejects.toThrow('config interpolation');
    expect(existsSync(recordPath)).toBe(false);
  });

  it('rejects per-request environment, Lines memory, bad models, and unpinned versions', async () => {
    expect(() => new OpenCodeCliEngine(options('opencode'))).toThrow('absolute');
    expect(() => new OpenCodeCliEngine({
      ...options('/bin/echo'),
      version: '1.18.22',
    })).toThrow('1.18.23');
    expect(() => new OpenCodeCliEngine({
      ...options('/bin/echo'),
      environment: { OPENCODE_CONFIG_CONTENT: '{}' },
    })).toThrow('cannot replace OPENCODE_CONFIG_CONTENT');

    const engine = new OpenCodeCliEngine(options());
    await expect(engine.run(
      request({ env: { OBVERSA_TEST_OPENCODE_REQUEST_SECRET: 'secret' } }),
      () => {},
      new AbortController().signal,
    )).rejects.toThrow('constructor environment');
    await expect(engine.run(
      { ...request(), memory: {} } as AgentRequest & { memory: unknown },
      () => {},
      new AbortController().signal,
    )).rejects.toThrow('does not bridge Lines memory');
    await expect(engine.run(
      request({ model: 'missing-slash' }),
      () => {},
      new AbortController().signal,
    )).rejects.toThrow('provider/model');
  });

  it('rejects an unresolved builder executable and non-object auth', () => {
    expect(() => buildOpenCodeInvocation(
      request(),
      options('opencode'),
      temporaryDirectory('lines-opencode-builder-'),
    )).toThrow('absolute');
    expect(() => new OpenCodeCliEngine({
      ...options('/bin/echo'),
      auth: [] as never,
    })).toThrow('auth must be a provider-keyed object');
  });

  it('rejects remote and malformed auth before spawn', () => {
    expect(() => new OpenCodeCliEngine({
      ...options('/bin/echo'),
      auth: {
        'https://enterprise.test': {
          type: 'wellknown',
          key: 'OPENCODE_ENTERPRISE_TOKEN',
          token: 'selected-token',
        },
      },
    })).toThrow('wellknown auth');
    expect(() => new OpenCodeCliEngine({
      ...options('/bin/echo'),
      auth: { fixture: { type: 'api' } },
    })).toThrow('api auth key');
  });

  it('derives provider from the selected model and rejects a mismatch before spawn', async () => {
    const derived = await new OpenCodeCliEngine({
      ...options(),
      identity: { provider: null, modelFamily: null },
      environment: { OBVERSA_TEST_OPENCODE_SCENARIO: 'success' },
    }).run(request(), () => {}, new AbortController().signal);
    expect(derived.requested.provider).toBe('fixture-provider');
    expect(derived.effective.provider).toBe('fixture-provider');
    expect(derived.requested.modelFamily).toBeNull();

    const recordPath = join(
      temporaryDirectory('lines-opencode-record-'),
      'call.json',
    );
    await expect(new OpenCodeCliEngine({
      ...options(),
      identity: { provider: 'other-provider', modelFamily: null },
      environment: { OBVERSA_TEST_OPENCODE_RECORD: recordPath },
    }).run(request(), () => {}, new AbortController().signal)).rejects.toThrow(
      'provider identity',
    );
    expect(existsSync(recordPath)).toBe(false);
  });

  it('keeps ordered parts, de-duplicates exact frames, and maps tool terminals', async () => {
    const run = async (scenario: string) => {
      const events: EngineStreamEvent[] = [];
      const result = await new OpenCodeCliEngine({
        ...options(),
        environment: { OBVERSA_TEST_OPENCODE_SCENARIO: scenario },
      }).run(request(), (event) => events.push(event), new AbortController().signal);
      return { result, events };
    };

    const ordered = await run('identical-duplicate');
    expect(ordered.result.parts).toEqual([
      { kind: 'assistant', text: 'draft', final: false },
      { kind: 'assistant', text: 'answer', final: true },
    ]);
    expect(ordered.events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', delta: 'draft' },
      { type: 'text', delta: 'answer' },
    ]);

    const tools = await run('tool-events');
    expect(tools.events.filter((event) => event.type === 'tool')).toEqual([
      { type: 'tool', name: 'read', phase: 'use' },
      { type: 'tool', name: 'read', phase: 'result' },
    ]);
    await expect(run('tool-error-then-final')).resolves.toMatchObject({
      result: { parts: [{ kind: 'assistant', text: 'answer', final: true }] },
    });
  });

  it('rejects an observed tool that was not declared', async () => {
    await expect(new OpenCodeCliEngine({
      ...options(),
      environment: { OBVERSA_TEST_OPENCODE_SCENARIO: 'undeclared-tool' },
    }).run(
      request({ tools: ['read'], allowedTools: ['Read(src/**)'] }),
      () => {},
      new AbortController().signal,
    )).rejects.toThrow('undeclared tool bash');
  });

  it('accepts OpenCode write and apply_patch observations as edit capability', async () => {
    const events: EngineStreamEvent[] = [];
    await expect(new OpenCodeCliEngine({
      ...options(),
      environment: { OBVERSA_TEST_OPENCODE_SCENARIO: 'edit-tool-aliases' },
    }).run(
      request({
        tools: ['edit'],
        allowedTools: ['Edit(src/**)'],
        workspaceMode: 'write',
      }),
      (event) => events.push(event),
      new AbortController().signal,
    )).resolves.toBeDefined();
    expect(events.filter((event) => event.type === 'tool')).toEqual([
      { type: 'tool', name: 'write', phase: 'use' },
      { type: 'tool', name: 'write', phase: 'result' },
      { type: 'tool', name: 'apply_patch', phase: 'use' },
      { type: 'tool', name: 'apply_patch', phase: 'result' },
    ]);
  });

  it.each([
    ['malformed-line', 'invalid JSON'],
    ['wrong-session', 'session'],
    ['conflicting-duplicate', 'conflicting duplicate'],
    ['no-final', 'final'],
  ])('fails closed for %s protocol input', async (scenario, message) => {
    await expect(new OpenCodeCliEngine({
      ...options(),
      environment: { OBVERSA_TEST_OPENCODE_SCENARIO: scenario },
    }).run(
      request(),
      () => {},
      new AbortController().signal,
    )).rejects.toThrow(message);
  });

  it('preserves the exact same-part structured-result marker for the job parser', async () => {
    const result = await new OpenCodeCliEngine({
      ...options(),
      environment: { OBVERSA_TEST_OPENCODE_SCENARIO: 'structured' },
    }).run(
      request({
        jsonSchema: {
          type: 'object',
          properties: { answer: { type: 'number' } },
          required: ['answer'],
          additionalProperties: false,
        },
      }),
      () => {},
      new AbortController().signal,
    );

    expect(result.parts).toEqual([
      { kind: 'assistant', text: 'draft', final: false },
      {
        kind: 'assistant',
        text: 'OBVERSA_STRUCTURED_RESULT_V1\n{"answer":42}',
        final: true,
      },
    ]);
  });

  it('keeps malformed usage unknown and sums unique complete steps', async () => {
    const run = async (scenario: string) => await new OpenCodeCliEngine({
      ...options(),
      environment: { OBVERSA_TEST_OPENCODE_SCENARIO: scenario },
    }).run(request(), () => {}, new AbortController().signal);

    expect((await run('unknown-usage')).usage).toEqual({ kind: 'unknown' });
    expect((await run('zero-usage')).usage).toEqual({
      kind: 'reported',
      inputTokens: 0,
      outputTokens: 0,
    });
    expect((await run('multi-usage')).usage).toEqual({
      kind: 'reported',
      inputTokens: 8,
      outputTokens: 10,
      cacheCreationInputTokens: 1,
      cacheReadInputTokens: 4,
    });
  });

  it('keeps a final result separate from a later transport failure', async () => {
    const result = await new OpenCodeCliEngine({
      ...options(),
      environment: { OBVERSA_TEST_OPENCODE_SCENARIO: 'late-final' },
    }).run(request(), () => {}, new AbortController().signal);

    expect(result.parts.at(-1)).toEqual({
      kind: 'assistant',
      text: 'answer',
      final: true,
    });
    expect(result.transportFailure).toMatchObject({
      kind: 'unknown',
      exitCode: 7,
    });
  });

  it('rejects partial text when transport fails after a tool-calls step', async () => {
    await expect(new OpenCodeCliEngine({
      ...options(),
      environment: { OBVERSA_TEST_OPENCODE_SCENARIO: 'late-partial' },
    }).run(request(), () => {}, new AbortController().signal)).rejects.toMatchObject({
      kind: 'unknown',
      message: expect.stringContaining('transport closed during tool work'),
    });
  });

  it('rejects a clean exit after a tool-calls step', async () => {
    await expect(new OpenCodeCliEngine({
      ...options(),
      environment: { OBVERSA_TEST_OPENCODE_SCENARIO: 'clean-partial' },
    }).run(request(), () => {}, new AbortController().signal)).rejects.toMatchObject({
      kind: 'invalid-config',
      message: expect.stringContaining('without a final step'),
    });
  });

  it('rejects a clean exit without a step-finish event', async () => {
    await expect(new OpenCodeCliEngine({
      ...options(),
      environment: { OBVERSA_TEST_OPENCODE_SCENARIO: 'zero-exit-no-finish' },
    }).run(request(), () => {}, new AbortController().signal)).rejects.toMatchObject({
      kind: 'invalid-config',
      message: expect.stringContaining('without a final step'),
    });
  });

  it.each(['content-filter', 'error'])(
    'rejects a %s finish reason as an engine failure',
    async (reason) => {
      await expect(new OpenCodeCliEngine({
        ...options(),
        environment: {
          OBVERSA_TEST_OPENCODE_SCENARIO: `${reason}-finish`,
        },
      }).run(request(), () => {}, new AbortController().signal)).rejects.toMatchObject({
        kind: 'unknown',
        message: expect.stringContaining(reason),
      });
    },
  );

  it('rejects token-limit truncation while preserving streamed evidence', async () => {
    const events: EngineStreamEvent[] = [];
    let error: unknown;
    try {
      await new OpenCodeCliEngine({
        ...options(),
        environment: { OBVERSA_TEST_OPENCODE_SCENARIO: 'length-finish' },
      }).run(request(), (event) => events.push(event), new AbortController().signal);
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      kind: 'unknown',
      message: expect.stringContaining('token limit'),
    });
    expect(error).toBeInstanceOf(EngineIncompleteResultError);
    if (error instanceof EngineIncompleteResultError) {
      expect(error.evidence.parts).toEqual([
        { kind: 'assistant', text: 'partial answer', final: true },
      ]);
      expect(error.evidence.usage).toMatchObject({ kind: 'reported' });
      expect(error.evidence.stopReason).toBe('length');
    }
    expect(events).toEqual(expect.arrayContaining([
      { type: 'text', delta: 'partial answer' },
      expect.objectContaining({ type: 'usage', usage: expect.objectContaining({ kind: 'reported' }) }),
    ]));
  });

  it('keeps measured usage when the token limit arrives before any text', async () => {
    let error: unknown;
    try {
      await new OpenCodeCliEngine({
        ...options(),
        environment: { OBVERSA_TEST_OPENCODE_SCENARIO: 'empty-length-finish' },
      }).run(request(), () => {}, new AbortController().signal);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(EngineIncompleteResultError);
    if (error instanceof EngineIncompleteResultError) {
      expect(error.evidence.parts).toEqual([]);
      expect(error.evidence.usage).toMatchObject({ kind: 'reported' });
      expect(error.evidence.stopReason).toBe('length');
      expect(classifyEngineFailure(error)).toBe('unknown');
    }
  });

  it('keeps measured usage when a stopped turn produces no text', async () => {
    let error: unknown;
    try {
      await new OpenCodeCliEngine({
        ...options(),
        environment: { OBVERSA_TEST_OPENCODE_SCENARIO: 'empty-stop-finish' },
      }).run(request(), () => {}, new AbortController().signal);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(EngineIncompleteResultError);
    if (error instanceof EngineIncompleteResultError) {
      expect(error.evidence.parts).toEqual([]);
      expect(error.evidence.usage).toMatchObject({ kind: 'reported' });
      expect(error.evidence.stopReason).toBe('stop');
      expect(classifyEngineFailure(error)).toBe('unknown');
    }
  });

  it('keeps a native auth failure when an empty stopped turn exits nonzero', async () => {
    let error: unknown;
    try {
      await new OpenCodeCliEngine({
        ...options(),
        environment: { OBVERSA_TEST_OPENCODE_SCENARIO: 'empty-stop-auth' },
      }).run(request(), () => {}, new AbortController().signal);
    } catch (caught) {
      error = caught;
    }

    expect(classifyEngineFailure(error)).toBe('auth');
  });

  it('rejects an invalid OpenCode step-finish reason', async () => {
    await expect(new OpenCodeCliEngine({
      ...options(),
      environment: { OBVERSA_TEST_OPENCODE_SCENARIO: 'late-invalid-reason' },
    }).run(request(), () => {}, new AbortController().signal)).rejects.toMatchObject({
      kind: 'invalid-config',
      message: expect.stringContaining('step reason'),
    });
  });

  it('uses a malformed final tool step to reject partial output', async () => {
    await expect(new OpenCodeCliEngine({
      ...options(),
      environment: { OBVERSA_TEST_OPENCODE_SCENARIO: 'late-malformed-tool-step' },
    }).run(request(), () => {}, new AbortController().signal)).rejects.toMatchObject({
      kind: 'unknown',
      message: expect.stringContaining('transport closed during malformed tool work'),
    });
  });

  it('stops an in-flight process on caller abort and on its hard timeout', async () => {
    const controller = new AbortController();
    const engine = new OpenCodeCliEngine({
      ...options(),
      environment: { OBVERSA_TEST_OPENCODE_SCENARIO: 'hang' },
    });
    const aborted = engine.run(
      request(),
      () => controller.abort(),
      controller.signal,
    );
    await expect(aborted).rejects.toMatchObject({ kind: 'aborted' });

    await expect(new OpenCodeCliEngine({
      ...options(),
      environment: { OBVERSA_TEST_OPENCODE_SCENARIO: 'hang' },
    }).run(
      request({ timeoutMs: 50, timeoutGraceMs: 25 }),
      () => {},
      new AbortController().signal,
    )).rejects.toMatchObject({ kind: 'timeout' });
  });

  it.each(['invocation', 'structured'] as const)('starts cleanup at the work deadline and keeps a completed result (%s)', async (mode) => {
    const marker = join(temporaryDirectory('lines-opencode-final-'), 'written');
    const controller = new AbortController();
    let abortFired = false;
    const running = new OpenCodeCliEngine({
      ...options(),
      environment: {
        OBVERSA_TEST_OPENCODE_FINAL_MARKER: marker,
        OBVERSA_TEST_OPENCODE_SCENARIO: mode === 'structured' ? 'timeout-final-structured' : 'timeout-final',
      },
    }).run(
      request({
        timeoutMs: 5_000,
        timeoutGraceMs: 500,
        ...(mode === 'structured' ? { jsonSchema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false } } : {}),
      }),
      () => {},
      controller.signal,
    );
    await waitForFile(marker);
    abortFired = true;
    controller.abort();
    const result = await running;

    expect(abortFired).toBe(true);
    expect(result.parts.at(-1)).toMatchObject(mode === 'structured'
      ? { kind: 'assistant', text: 'OBVERSA_STRUCTURED_RESULT_V1\n{"answer":42}', final: true }
      : { text: 'answer', final: true });
    expect(result.usage).toBeDefined();
    expect(result.transportFailure).toMatchObject({
      kind: 'aborted',
      exitCode: null,
    });
  });

  it('scrubs explicit auth values from typed failures', async () => {
    const token = 'short6';
    let error: unknown;
    try {
      await new OpenCodeCliEngine({
        ...options(),
        auth: { fixture: { type: 'api', key: token } },
        environment: { OBVERSA_TEST_OPENCODE_SCENARIO: 'auth-echo' },
      }).run(request(), () => {}, new AbortController().signal);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(token);
    expect((error as Error).message).toContain('[redacted]');
  });

  it('scrubs explicit auth values from protocol failures', async () => {
    const token = 'short6';
    let error: unknown;
    try {
      await new OpenCodeCliEngine({
        ...options(),
        auth: { fixture: { type: 'api', key: token } },
        environment: { OBVERSA_TEST_OPENCODE_SCENARIO: 'protocol-auth-echo' },
      }).run(request(), () => {}, new AbortController().signal);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(token);
    expect((error as Error).message).toContain('[redacted]');
  });

  it('scrubs short selected environment values from typed failures', async () => {
    const token = 'short6';
    let error: unknown;
    try {
      await new OpenCodeCliEngine({
        ...options(),
        environment: {
          OBVERSA_TEST_OPENCODE_SCENARIO: 'environment-echo',
          OBVERSA_TEST_OPENCODE_SELECTED: token,
        },
      }).run(request(), () => {}, new AbortController().signal);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(token);
    expect((error as Error).message).toContain('[redacted]');
  });

  it('classifies native OpenCode failures through the public vocabulary', async () => {
    for (const [scenario, expected] of [
      ['auth', 'auth'],
      ['billing', 'billing'],
      ['billing-429', 'billing'],
      ['billing-401', 'billing'],
      ['quota-401', 'quota'],
      ['model-401', 'model-unavailable'],
      ['model-unavailable', 'model-unavailable'],
      ['rate-limit', 'rate-limit'],
      ['quota', 'quota'],
      ['ambiguous-403', 'rate-limit'],
      ['ambiguous-429', 'rate-limit'],
      ['monthly-429', 'quota'],
      ['user-limit-401', 'rate-limit'],
      ['transient', 'transient'],
      ['invalid-config', 'invalid-config'],
    ] as const) {
      let error: unknown;
      try {
        await new OpenCodeCliEngine({
          ...options(),
          environment: { OBVERSA_TEST_OPENCODE_SCENARIO: scenario },
        }).run(request(), () => {}, new AbortController().signal);
      } catch (caught) {
        error = caught;
      }
      expect(classifyEngineFailure(error), scenario).toBe(expected);
    }
  });

  it('preserves a reported quota reset for the run limit policy', async () => {
    let error: unknown;
    try {
      await new OpenCodeCliEngine({
        ...options(),
        environment: { OBVERSA_TEST_OPENCODE_SCENARIO: 'quota' },
      }).run(request(), () => {}, new AbortController().signal);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(EngineError);
    expect(error).toMatchObject({
      kind: 'quota',
      resetAt: 1_777_777_999_000,
    });
  });

  it('preserves the reset hint on ambiguous quota text', async () => {
    let error: unknown;
    try {
      await new OpenCodeCliEngine({
        ...options(),
        environment: { OBVERSA_TEST_OPENCODE_SCENARIO: 'ambiguous-403' },
      }).run(request(), () => {}, new AbortController().signal);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EngineError);
    expect(error).toMatchObject({ kind: 'rate-limit', resetAt: 1_777_777_999_000 });
  });

  it('passes the public engine conformance kit', async () => {
    const bin = executable();
    const report = await runEngineConformance({
      request: request({ tools: ['read'], allowedTools: ['Read'] }),
      requested: {
        adapter: 'opencode-cli',
        adapterVersion: '1.18.23',
        provider: 'fixture-provider',
        modelFamily: 'fixture-family',
        model: 'fixture-provider/fixture-model',
        executable: bin,
        capabilities: ['read'],
      },
      effective: {
        adapter: 'opencode-cli',
        adapterVersion: '1.18.23',
        provider: 'fixture-provider',
        modelFamily: 'fixture-family',
        model: 'fixture-provider/fixture-model',
        executable: bin,
        capabilities: ['read'],
      },
      parseStructuredResult,
      open(scenario) {
        const binForScenario = scenario === 'missing-cli'
          ? join(temporaryDirectory('lines-opencode-missing-'), 'opencode')
          : bin;
        return new OpenCodeCliEngine({
          ...options(binForScenario),
          environment: { OBVERSA_ENGINE_CONFORMANCE_SCENARIO: scenario },
        });
      },
    });

    expect(report).toEqual({ ok: true, cases: 16, failures: [] });
  });

  it('uses EngineError types for adapter-owned abort and timeout failures', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new OpenCodeCliEngine(options()).run(
      request(),
      () => {},
      controller.signal,
    )).rejects.toBeInstanceOf(EngineError);
  });
});
