import type { Environment } from '@obversa/api';

export type { Environment, EnvHandle, EnvironmentWorkspace } from '@obversa/api';

/** Duck-type guard: a ready-made `Environment` rather than something else. */
export function isEnvironment(value: unknown): value is Environment {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Environment).name === 'string' &&
    typeof (value as Environment).up === 'function'
  );
}
