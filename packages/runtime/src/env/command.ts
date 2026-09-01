/**
 * `commandEnvironment` — a generic, CLI-driven Environment. Every IaC tool
 * (sst, terraform, pulumi, cloudformation-via-aws-cli) has the same shape: a
 * command to deploy a stage, a command to read its outputs, a command to tear it
 * down. This factory captures that shape. The consumer supplies the concrete
 * command configuration.
 *
 * It drives the CLIs through `execa` (no SDK, no new dependency), so it stays in
 * the Lines package as an opt-in subpath without coupling
 * the core to any deploy tool. An SDK-bound adapter (e.g. @aws-sdk) adds a real
 * dependency and belongs in a separate package or the consumer instead.
 *
 * The consumer supplies the tool-specific bits: how a stage name is derived, the
 * argv for each phase, and `map` (which parsed output is the URL and how the
 * outputs become the env vars the gate reads). The factory stays tool-agnostic.
 */

import { execa } from 'execa';

import type { Workspace } from '../core/types.js';
import type { Environment, EnvHandle } from './environment.js';

/** A command to run: a binary and its args. */
export interface Cmd {
  cmd: string;
  args?: string[];
}

export interface CommandEnvConfig {
  /** Adapter name (surfaced in errors). Default 'command'. */
  name?: string;
  /** Working dir for the commands. Default: the workspace dir (the worktree). */
  cwd?: (ws: Workspace) => string;
  /** Stage/stack/workspace identity. Default: a slug of the workspace branch. */
  stage?: (ws: Workspace) => string;
  /** Argv to deploy the stage. */
  deploy: (stage: string, ws: Workspace) => Cmd;
  /** Argv to read outputs as JSON on stdout. Optional (no URL/env if omitted). */
  outputs?: (stage: string, ws: Workspace) => Cmd;
  /** Argv to tear the stage down. */
  destroy: (stage: string, ws: Workspace) => Cmd;
  /**
   * Turn the outputs into the handle's `url` + `env`, normalising the tool's
   * specific shape. `outputs` is the best-effort JSON parse (for
   * terraform/pulumi/sst); `raw` is the verbatim stdout (for tools whose output
   * is not JSON, e.g. `docker compose port` prints `0.0.0.0:49153`).
   */
  map?: (
    outputs: Record<string, unknown>,
    stage: string,
    raw: string,
  ) => { url?: string; env?: Record<string, string> };
  /** Per-command timeout (ms). */
  timeoutMs?: number;
}

/** Slug a branch into a stage-safe identity. */
function stageSlug(s: string | undefined): string {
  return (
    (s ?? 'main').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/(^-+|-+$)/g, '') ||
    'main'
  );
}

function parseJson(s: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function commandEnvironment(config: CommandEnvConfig): Environment {
  const name = config.name ?? 'command';
  const stageOf = config.stage ?? ((ws: Workspace) => stageSlug(ws.branch));
  const cwdOf = config.cwd ?? ((ws: Workspace) => ws.dir);

  return {
    name,
    async up(ws: Workspace, signal: AbortSignal): Promise<EnvHandle> {
      const stage = stageOf(ws);
      const cwd = cwdOf(ws);

      const exec = async (c: Cmd, phase: string): Promise<string> => {
        const r = await execa(c.cmd, c.args ?? [], {
          cwd,
          cancelSignal: signal,
          timeout: config.timeoutMs,
          reject: false,
          stdin: 'ignore',
        });
        if (r.exitCode !== 0) {
          const detail = (r.stderr || r.stdout || '').slice(0, 500);
          throw new Error(
            `${name} ${phase} failed for stage "${stage}" (exit ${r.exitCode}): ${detail}`.trim(),
          );
        }
        return r.stdout ?? '';
      };

      await exec(config.deploy(stage, ws), 'deploy');
      const raw = config.outputs
        ? await exec(config.outputs(stage, ws), 'outputs')
        : '';
      const mapped = config.map?.(parseJson(raw), stage, raw) ?? {};

      return {
        url: mapped.url,
        env: mapped.env ?? {},
        async down(sig: AbortSignal): Promise<void> {
          const d = config.destroy(stage, ws);
          await execa(d.cmd, d.args ?? [], {
            cwd,
            cancelSignal: sig,
            timeout: config.timeoutMs,
            reject: false,
            stdin: 'ignore',
          });
        },
      };
    },
  };
}
