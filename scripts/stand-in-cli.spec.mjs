import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./stand-in-cli.mjs', import.meta.url));
const prompt = Buffer.from('First chunk\nSecond chunk: café 🐈\n');
const reply = 'The entire prompt arrived.';

async function run(t, role, args, sendPrompt) {
  const directory = mkdtempSync(join(tmpdir(), 'obversa-stand-in-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cli = join(directory, role);
  const preload = join(directory, 'nonblocking.mjs');
  symlinkSync(fixture, cli);
  writeFileSync(join(directory, '.obversa-stand-in.json'), JSON.stringify({ [role]: [{ reply }] }));
  writeFileSync(preload, `
    import assert from 'node:assert/strict';
    const stdin = process.stdin;
    // Node exposes no public switch for the real pipe's nonblocking mode.
    assert.equal(typeof stdin._handle?.setBlocking, 'function');
    stdin._handle.setBlocking(false);
    const isTTY = stdin.isTTY;
    Object.defineProperty(stdin, 'isTTY', { get() {
      // The parent cannot write until the fixture yields after checking stdin.
      // A synchronous read of the empty nonblocking pipe fails before this runs.
      setImmediate(() => process.send('reading'));
      return isTTY;
    } });
  `);
  const child = spawn(process.execPath, ['--import', preload, cli, ...args], {
    cwd: directory,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    timeout: 10_000,
  });
  let timer;
  let reads = 0;
  t.after(() => { clearTimeout(timer); child.kill(); });
  child.stdin.on('error', () => {}); // An early child exit is reported with stderr below.
  child.on('message', (message) => {
    assert.equal(message, 'reading');
    reads += 1;
    if (sendPrompt) {
      // Split inside a UTF-8 character as well as delaying EOF.
      child.stdin.write(prompt.subarray(0, prompt.length - 3));
      timer = setTimeout(() => child.stdin.end(prompt.subarray(prompt.length - 3)), 25);
    }
  });
  const [[code, signal], stdout, stderr] = await Promise.all([
    once(child, 'close'), text(child.stdout), text(child.stderr),
  ]);
  assert.equal(signal, null, stderr);
  assert.equal(code, 0, stderr);
  return { directory, stdout, reads };
}

for (const [role, version] of Object.entries({
  claude: '2.1.261 (Claude Code)\n',
  codex: 'codex-cli 0.153.2\n',
  opencode: '1.18.23\n',
})) {
  // The regression concerns POSIX pipes; Windows has different pipe semantics.
  test(`${role} reads delayed chunks from a nonblocking pipe`, { skip: process.platform === 'win32' }, async (t) => {
    const result = await run(t, role, role === 'codex' ? ['-o', 'reply.txt'] : [], true);
    assert.equal(result.reads, 1);
    const calls = readFileSync(join(result.directory, '.obversa-stand-in-calls.log'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].prompt, prompt.toString());
    assert.equal(calls[0].role, role);
    const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    if (role === 'codex') {
      assert.equal(readFileSync(join(result.directory, 'reply.txt'), 'utf8'), reply);
      assert.equal(events[0].type, 'turn.completed');
    } else if (role === 'claude') {
      assert.equal(events.find((event) => event.type === 'result').result, reply);
    } else {
      assert.equal(events.find((event) => event.type === 'text').part.text, reply);
    }
  });

  test(`${role} answers --version while stdin stays open`, { skip: process.platform === 'win32' }, async (t) => {
    const result = await run(t, role, ['--version'], false);
    assert.equal(result.stdout, version);
    assert.equal(result.reads, 0);
  });
}
