import { describe, it, expect } from 'vitest';

import {
  redactEnvValues,
  redactSecrets,
  scrubCapture,
} from '../src/core/redact.ts';

describe('redactEnvValues URL carve-out', () => {
  it('keeps an origin-only BASE_URL readable in diagnostics', () => {
    const env = { BASE_URL: 'http://localhost:3456' };
    expect(redactEnvValues('probing http://localhost:3456/health', env)).toBe(
      'probing http://localhost:3456/health',
    );
    // A trailing slash is still origin-only.
    expect(
      redactEnvValues('base https://preview.test/', {
        BASE_URL: 'https://preview.test/',
      }),
    ).toBe('base https://preview.test/');
  });

  it('scrubs URL-borne credentials: webhook paths, ?token= links, presigned URLs', () => {
    const env = {
      SLACK_WEBHOOK: 'https://hooks.slack.com/services/T000/B000/XXXXXXXX',
      SHARE_LINK: 'https://files.test/download?token=abcdef123456',
      PRESIGNED:
        'https://bucket.s3.test/key?X-Amz-Signature=deadbeefdeadbeef',
    };
    for (const value of Object.values(env)) {
      expect(redactEnvValues(`posting to ${value} now`, env)).toBe(
        'posting to [redacted] now',
      );
    }
  });

  it('scrubs a URL carrying userinfo even with no path', () => {
    const env = { DB: 'postgres://app:S3cretPw@db.test' };
    expect(redactEnvValues('using postgres://app:S3cretPw@db.test', env)).toBe(
      'using [redacted]',
    );
  });
});

describe('scrubCapture (the one scrub-then-cut composition)', () => {
  it('redacts env values on the full text BEFORE the cut, so a secret straddling the boundary cannot survive', () => {
    const env = { TOKEN: 'supersecretvalue99' };
    // The secret starts inside the cap window and extends past it: a
    // cut-then-scrub composition would leave its head in the capture.
    const text = `prefix ${env.TOKEN} tail`;
    const out = scrubCapture(text, env, 12);
    expect(out).not.toContain('supersec');
    expect(out).toBe('prefix [re\n…');
  });

  it('redacts shape-matched secrets before the cut too (the engine stderr case)', () => {
    const key = `sk-ant-${'a'.repeat(24)}`;
    const out = scrubCapture(`auth failed for ${key}`, undefined, 20);
    expect(out).not.toContain('sk-ant-');
  });

  it('with no cap it is redactSecrets ∘ redactEnvValues, unbounded', () => {
    const env = { SECRET: 'longsecretvalue' };
    const text = `x ${env.SECRET} y user@example.com z`;
    expect(scrubCapture(text, env)).toBe(
      redactSecrets(redactEnvValues(text, env)),
    );
    expect(scrubCapture(text, env)).toContain(' z');
  });
});
