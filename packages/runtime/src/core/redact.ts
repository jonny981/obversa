import { scrubCapture } from '@obversa/core/command';

export {
  redactEnvValues,
  redactSecrets,
  scrubCapture,
} from '@obversa/core/command';

/**
 * The same value, every string in it run through `scrubCapture` with the
 * resolved environment, so a draft, brief, question or answer that holds a
 * secret or an injected value is redacted in the record though the model
 * read it whole.
 */
export function scrubbed<T>(value: T, env: Record<string, string> | undefined): T {
  if (typeof value === 'string') return scrubCapture(value, env) as T;
  if (Array.isArray(value)) return value.map((item) => scrubbed(item, env)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrubbed(item, env)]),
    ) as T;
  }
  return value;
}
