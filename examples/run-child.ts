import { runChild } from '@obversa/process';

const result = await runChild({
  executable: process.execPath,
  args: ['-e', 'process.stdout.write("ready")'],
  cwd: process.cwd(),
  env: {},
  stdin: '',
  timeoutMs: 30_000,
  killGraceMs: 5_000,
  maxOutputBytes: 1_024 * 1_024,
});

console.log(new TextDecoder().decode(result.stdout));
