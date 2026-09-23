import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const name = '@x/published';
const version = '1.0.0';
const exactPath = `/${encodeURIComponent(name)}/${version}`;
const driver = `
  const [verifyUrl, tagUrl, encodedOptions] = process.argv.slice(1);
  process.argv[1] = undefined;
  const { verifyPublished } = await import(verifyUrl);
  const { tagPublished } = await import(tagUrl);
  const options = JSON.parse(encodedOptions);
  options.allowlist = new Set([${JSON.stringify(name)}]);
  const calls = [];
  const run = (_command, args) => {
    calls.push(args);
    return { status: args[0] === 'rev-parse' && !options.tagExists ? 1 : 0, stdout: '', stderr: '' };
  };
  const verification = await verifyPublished(options);
  const tagging = await tagPublished({ ...options, run });
  console.log(JSON.stringify({ verification, tagging, calls }));
`;

async function fixture(t, respond, { tagExists = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'exact-published-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'packages/pkg'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true }));
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  await writeFile(join(root, 'packages/pkg/package.json'), JSON.stringify({ name, version }));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === exactPath) respond(request, response);
    else {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'package metadata has not propagated' }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const registry = `http://127.0.0.1:${server.address().port}/`;
  const options = { root, registry, tagExists };
  return {
    requests,
    run: async () => {
      const { stdout } = await exec(process.execPath, [
        '--input-type=module', '-e', driver,
        new URL('./verify-published.mjs', import.meta.url).href,
        new URL('./tag-published.mjs', import.meta.url).href,
        JSON.stringify(options),
      ], {
        cwd: root, timeout: 20_000,
        env: {
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root,
          npm_config_registry: 'http://127.0.0.1:1/',
          npm_config_npm_path: join(root, 'no-npm'),
        },
      }).catch((error) => { error.message += `\nCaptured stdout: ${error.stdout}`; throw error; });
      return JSON.parse(stdout);
    },
  };
}

function document(response, value) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

test('both release steps accept an exact version while package metadata returns 404', async (t) => {
  const f = await fixture(t, (_request, response) => document(response, { name, version }));
  const result = await f.run();
  assert.deepEqual(result.verification, []);
  assert.deepEqual(result.tagging, { pushed: [`${name}@${version}`], problems: [] });
  assert.deepEqual(result.calls, [
    ['rev-parse', '-q', '--verify', `refs/tags/${name}@${version}`],
    ['push', 'origin', `refs/tags/${name}@${version}`],
  ]);
  assert.deepEqual(f.requests, [exactPath, exactPath]);
});

test('a published version without a local tag never creates or pushes a tag', async (t) => {
  const f = await fixture(t, (_request, response) => document(response, { name, version }), { tagExists: false });
  const result = await f.run();
  assert.deepEqual(result.verification, []);
  assert.equal(result.tagging.problems.length, 1);
  assert.match(result.tagging.problems[0], /tag does not exist locally/);
  assert.deepEqual(result.tagging.pushed, []);
  assert.deepEqual(result.calls, [['rev-parse', '-q', '--verify', `refs/tags/${name}@${version}`]]);
});

for (const [label, respond] of [
  ['missing version', (_request, response) => { response.writeHead(404); response.end('{}'); }],
  ['wrong package', (_request, response) => document(response, { name: '@x/other', version })],
  ['wrong version', (_request, response) => document(response, { name, version: '9.0.0' })],
  ['malformed JSON', (_request, response) => { response.writeHead(200); response.end('{'); }],
  ['incomplete body', (_request, response) => {
    response.writeHead(200, { 'content-length': '1000' });
    response.end(JSON.stringify({ name, version }));
  }],
  ['redirect', (_request, response) => {
    response.writeHead(302, { location: exactPath });
    response.end();
  }],
  ['transport failure', (request) => request.socket.destroy()],
  ['stalled response headers', () => {}],
  ['stalled response body', (_request, response) => { response.writeHead(200); response.write('{'); }],
]) {
  test(`both release steps refuse ${label} without pushing`, { timeout: 25_000 }, async (t) => {
    const f = await fixture(t, respond);
    const result = await f.run();
    assert.equal(result.verification.length, 1);
    assert.equal(result.tagging.problems.length, 1);
    assert.deepEqual(result.tagging.pushed, []);
    assert.deepEqual(result.calls, []);
    assert.deepEqual(f.requests, [exactPath, exactPath]);
  });
}
