/**
 * What a failed check's record and finding quote: the failing tests by
 * name, the lines that report the failure, and the end of stdout and of
 * stderr, each on its own, as much as fits the reader's limit.
 */

/** Where a run keeps the whole output of its failed checks: beside its record, named for it. */
export function checkOutputDir(recordPath: string): string {
  return `${recordPath.replace(/\.jsonl$/, '')}.checks`;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

const FAILURE_LINE = [
  /^\s*FAIL(?:ED)?\b/,
  /^\s*[×✗✖]\s/,
  /^\s*not ok\b/,
  /\b\d+\s+failed\b/i,
  /^\s*(?:Error|AssertionError|TypeError|RangeError|ReferenceError)\b[^:]*:/,
  /\berror TS\d+:/,
  /ERR_PNPM_|npm ERR!/,
];

const TEST_NAME = [
  /^\s*FAIL\s+(\S+\.[cm]?[jt]sx?\b.*?)\s*$/,
  /^\s*[×✗✖]\s+(.+?)(?:\s+\d+(?:\.\d+)?\s*m?s)?\s*$/,
  /^\s*not ok \d+\s+-\s+(.+?)\s*$/,
];

function lines(text: string): string[] {
  return text.replace(ANSI, '').split(/\r?\n/);
}

/** The lines of `text` that report a failure, each once, in order. */
export function failureLines(text: string): string[] {
  return [...new Set(lines(text).filter((line) => FAILURE_LINE.some((pattern) => pattern.test(line))).map((line) => line.trimEnd()))];
}

/** The failing tests a test runner's output names: vitest's `FAIL` and `×` lines, and node's `not ok`. */
export function failingTests(text: string): string[] {
  const names: string[] = [];
  for (const line of lines(text)) {
    for (const pattern of TEST_NAME) {
      const name = pattern.exec(line)?.[1];
      if (name !== undefined) {
        names.push(name);
        break;
      }
    }
  }
  return [...new Set(names)];
}

/** The last `budget` characters of `text`, from the start of a line where one falls inside them. */
function tail(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const cut = text.slice(text.length - budget);
  const newline = cut.indexOf('\n');
  return newline >= 0 && newline < cut.length - 1 ? cut.slice(newline + 1) : cut;
}

function streamBlock(name: string, text: string, kept: string): string {
  return kept.length === text.length
    ? `${name}:\n${text}`
    : `${name} (the last ${kept.length} of ${text.length} characters):\n${kept}`;
}

export interface CheckOutput {
  readonly exit: string;
  /** Scrubbed already. */
  readonly stdout: string;
  /** Scrubbed already. */
  readonly stderr: string;
  /** The most characters the excerpt may take; none keeps both streams whole. */
  readonly limit?: number;
}

/** The excerpt a failed check's record and finding quote. */
export function checkOutputExcerpt(output: CheckOutput): string {
  const all = `${output.stdout}\n${output.stderr}`;
  const tests = failingTests(all);
  const reported = failureLines(all);
  const head = [
    `exit: ${output.exit}`,
    ...(tests.length > 0 ? [`failing tests:\n${tests.map((name) => `- ${name}`).join('\n')}`] : []),
    ...(reported.length > 0 ? [`the lines that report the failure:\n${reported.join('\n')}`] : []),
  ].join('\n\n');
  if (output.limit === undefined) {
    return [head, streamBlock('stdout', output.stdout, output.stdout), streamBlock('stderr', output.stderr, output.stderr)].join('\n\n');
  }
  const shownHead = head.length >= output.limit ? head.slice(0, output.limit) : head;
  // What is left goes to the end of each stream: half each, and what one
  // stream does not need goes to the other.
  const overhead = streamBlock('stdout', output.stdout, '').length + streamBlock('stderr', output.stderr, '').length + 4;
  const left = Math.max(0, output.limit - shownHead.length - overhead);
  const half = Math.floor(left / 2);
  const outBudget = Math.max(half, left - Math.min(half, output.stderr.length));
  const errBudget = left - Math.min(outBudget, output.stdout.length);
  const out = tail(output.stdout, outBudget);
  const err = tail(output.stderr, errBudget);
  return [shownHead, streamBlock('stdout', output.stdout, out), streamBlock('stderr', output.stderr, err)].join('\n\n');
}
