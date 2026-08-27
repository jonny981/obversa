import { describe, expect, it } from 'vitest';

import {
  AnthropicApiEngine,
  type AnthropicApiEngineOptions,
} from '../src/index.ts';

describe('@obversa/engine-anthropic-api', () => {
  it('constructs the public engine with package-owned options', () => {
    const options: AnthropicApiEngineOptions = {
      defaultModel: 'claude-test',
      apiKey: 'test-key',
    };

    const engine = new AnthropicApiEngine(options);

    expect(engine.name).toBe('anthropic-api');
  });
});
