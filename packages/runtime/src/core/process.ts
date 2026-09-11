import {
  RunChildError,
  runChild,
  type RunChildOptions,
  type RunChildResult,
} from '@obversa/process';

export const DEFAULT_PROCESS_TIMEOUT_MS = 10 * 60 * 1_000;
export const DEFAULT_PROCESS_GRACE_MS = 5 * 1_000;
export const DEFAULT_PROCESS_OUTPUT_BYTES = 16 * 1_024 * 1_024;

export type RuntimeProcessOptions = Omit<
  RunChildOptions,
  'timeoutMs' | 'killGraceMs' | 'maxOutputBytes' | 'hooks'
> & {
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
  readonly maxOutputBytes?: number;
};

export async function runRuntimeProcess(
  options: RuntimeProcessOptions,
): Promise<RunChildResult> {
  try {
    return await runChild({
      ...options,
      timeoutMs: options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS,
      killGraceMs: options.killGraceMs ?? DEFAULT_PROCESS_GRACE_MS,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_PROCESS_OUTPUT_BYTES,
    });
  } catch (error) {
    if (error instanceof RunChildError && error.code === 'SPAWN_FAILED') {
      return Object.freeze({
        exitCode: null,
        stdout: error.stdout,
        stderr: error.stderr,
        timedOut: false,
        aborted: false,
      });
    }
    throw error;
  }
}

export function processText(output: Uint8Array): string {
  return new TextDecoder().decode(output);
}
