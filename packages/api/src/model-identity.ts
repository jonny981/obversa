import { EngineError } from './error.js';

/**
 * The provider and model family a harness reports for the model it was given.
 * `provider` is present only when the string carried one (`provider/model`);
 * a harness that runs one provider's models supplies its own.
 */
export interface ModelIdentity {
  readonly provider?: string;
  readonly modelFamily: string;
}

/**
 * Read the provider and the model family from a model string.
 *
 * A harness that runs other providers' models (OpenCode today, Devin next)
 * must report the identity of the model it was given, never its own name,
 * or two seats on one model wearing different tool names pass the
 * distinct-family check. Every such harness, and the teams gate that reads
 * recorded models back, derives the identity through this one function.
 *
 * `provider/model` yields both parts; a bare `model` yields the family alone.
 * `openrouter/vendor/model` keeps OpenRouter as the provider and reads the
 * family from the final model name. Other extra separators and whitespace
 * inside an identifier are refused.
 * The family is the model name up to its first hyphen, lowercased, so
 * `claude-sonnet-4-5` and `claude-opus-4-1` are one family and `gpt-5.6-luna`
 * another. A string that names no readable family, including the `unknown`
 * placeholder some adapters emit, is refused with an `invalid-config` engine
 * error rather than reported as a family called `unknown`.
 */
export function modelIdentity(model: string): ModelIdentity {
  if (typeof model !== 'string') {
    throw invalid(`a model must be a string, not ${typeof model}`);
  }
  const trimmed = model.trim();
  const slash = trimmed.indexOf('/');
  const provider = slash === -1 ? undefined : trimmed.slice(0, slash).trim().toLowerCase();
  let name = slash === -1 ? trimmed : trimmed.slice(slash + 1).trim();
  if (slash !== -1 && (provider === '' || name === '')) {
    throw invalid(`model ${JSON.stringify(model)} must name both a provider and a model`);
  }
  if (name.includes('/')) {
    const parts = name.split('/');
    if (provider !== 'openrouter' || parts.length !== 2 || !parts[0] || !parts[1]) {
      throw invalid(
        `model ${JSON.stringify(model)} must use provider/model or openrouter/vendor/model`,
      );
    }
    if (parts[0].toLowerCase() === 'openrouter') {
      throw invalid(`model ${JSON.stringify(model)} names a router: OpenRouter chooses the model, so it names no fixed family`);
    }
    name = parts[1];
  }
  if (/\s/u.test(trimmed)) {
    throw invalid(`model ${JSON.stringify(model)} must not contain whitespace`);
  }
  const family = name.split('-', 1)[0]?.trim().toLowerCase() ?? '';
  if (family === '' || family === 'unknown') {
    throw invalid(`model ${JSON.stringify(model)} names no readable model family`);
  }
  return Object.freeze(provider === undefined ? { modelFamily: family } : { provider, modelFamily: family });
}

function invalid(message: string): EngineError {
  return new EngineError({ kind: 'invalid-config', message });
}
