/**
 * The engine registry. Built-ins are registered by name; anyone can
 * `register(name, factory)` their own, or pass a ready-made `Engine` instance
 * anywhere an `EngineRef` is accepted. Factories run lazily (on first
 * `create`), so the Anthropic API engine never needs a key unless you actually
 * select it.
 */

import type { Engine, EngineName, EngineOptions, EngineRef } from './engine.js';
import { isEngine } from './engine.js';
import { LoopError } from '../core/errors.js';

export type EngineFactory = (opts: EngineOptions) => Engine;

export class EngineRegistry {
  private readonly factories = new Map<string, EngineFactory>();
  private readonly cache = new Map<string, Engine>();

  constructor(private readonly opts: EngineOptions = {}) {
    this.registerBuiltins();
  }

  /** Add or override an engine. The key is what you pass as an `EngineRef`. */
  register(name: string, factory: EngineFactory): this {
    this.factories.set(name, factory);
    this.cache.delete(name);
    return this;
  }

  has(name: string): boolean {
    return this.factories.has(name);
  }

  names(): string[] {
    return [...this.factories.keys()];
  }

  /** Resolve a ref to an `Engine`: instance → as-is; name → built/cached. */
  create(ref: EngineRef | undefined, fallback: EngineName): Engine {
    if (isEngine(ref)) return ref;
    const name = (ref as string | undefined) ?? fallback;
    const cached = this.cache.get(name);
    if (cached) return cached;
    const factory = this.factories.get(name);
    if (!factory) {
      throw new LoopError({
        code: 'CONFIG',
        message: `unknown engine "${name}" (have: ${this.names().join(', ')})`,
      });
    }
    const engine = factory(this.opts);
    this.cache.set(name, engine);
    return engine;
  }

  private registerBuiltins(): void {
    // Adapter modules are imported lazily inside the factory so that selecting,
    // say, claude-cli never loads the Anthropic API SDK and vice versa.
    this.register('agent-sdk', (o) =>
      lazy(
        () => import('./agent-sdk.js').then((m) => new m.AgentSdkEngine(o)),
        'agent-sdk',
      ),
    );
    this.register('claude-cli', (o) =>
      lazy(
        () => import('./claude-cli.js').then((m) => new m.ClaudeCliEngine(o)),
        'claude-cli',
      ),
    );
    this.register('anthropic-api', (o) =>
      lazy(
        () =>
          import('./anthropic-api.js').then((m) => new m.AnthropicApiEngine(o)),
        'anthropic-api',
      ),
    );
    // A different CLI-backed model for second-model reviewers. The adapter stays
    // read-only unless `bypassPermissions` is explicitly selected.
    this.register('codex', (o) =>
      lazy(() => import('./codex.js').then((m) => new m.CodexEngine(o)), 'codex'),
    );
  }
}

/**
 * Wrap a dynamically-imported engine so the heavy module only loads on the
 * first `run`. Presents the synchronous `Engine` interface the registry expects.
 */
function lazy(load: () => Promise<Engine>, name: EngineName): Engine {
  let inner: Promise<Engine> | undefined;
  return {
    name,
    run(req, onEvent, signal) {
      inner ??= load();
      return inner.then((engine) => engine.run(req, onEvent, signal));
    },
  };
}
