import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  gitHistory,
  knowledgeBase,
  pick,
  pickFromSources,
  rules,
  SourceReadError,
  type CandidateSource,
  type PickAnswer,
  type PickBatch,
} from '../src/index.js';

// knowledgeBase's own git invocations carry `-c core.hooksPath=…`; only
// those calls have their child environment recorded, so the fixture's own
// commits stay out of the locale assertions. The child is also handed to
// onGitChild so a spec can act on the running process.
const gitEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
let onGitChild: ((child: ChildProcess, args: readonly string[]) => void) | undefined;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const wrapped = (...rest: unknown[]) => {
    const child = (actual.execFile as (...call: unknown[]) => ChildProcess)(...rest);
    const args = rest[1];
    if (Array.isArray(args) && args.some((arg) => String(arg).startsWith('core.hooksPath='))) {
      gitEnvs.push((rest[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env);
      onGitChild?.(child, args.map(String));
    }
    return child;
  };
  return { ...actual, execFile: wrapped };
});

const temporaryDirectories: string[] = [];

async function tree(files: Readonly<Record<string, string>>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'obversa-rdc-'));
  temporaryDirectories.push(directory);
  for (const [path, text] of Object.entries(files)) {
    const file = join(directory, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  return directory;
}

function read(
  source: CandidateSource,
  request: { task: string } & Omit<Parameters<CandidateSource['read']>[0], 'task'>,
) {
  return source.read(request);
}

function allAnswered(probability: number) {
  return async (batch: PickBatch): Promise<Record<string, PickAnswer>> =>
    Object.fromEntries(batch.questions.map((question) => [
      question.key,
      { status: 'answered' as const, probability },
    ]));
}

beforeEach(() => {
  gitEnvs.length = 0;
  onGitChild = undefined;
});

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('knowledgeBase', () => {
  it('emits one reference candidate per `## ` section with stable ids', async () => {
    const directory = await tree({
      'guide.md': [
        '---',
        'title: The guide',
        '---',
        '# Guide',
        '',
        '## Setup',
        'Install the tool.',
        '',
        '## Usage',
        'Run the tool.',
        '',
      ].join('\n'),
    });

    const result = await read(knowledgeBase(directory), { task: 'install the tool' });
    expect(result.status).toBe('read');
    if (result.status !== 'read') return;

    // Ids are relative to the source root, so they are the same wherever
    // the host runs from.
    expect([...result.candidates].sort((left, right) => left.id.localeCompare(right.id))
      .map((candidate) => candidate.id)).toEqual([
      'guide.md#1',
      'guide.md#2',
      'guide.md#3',
    ]);
    expect(result.candidates.every((candidate) => candidate.role === 'reference')).toBe(true);
    expect([...result.candidates].sort((left, right) => left.id.localeCompare(right.id))
      .map((candidate) => candidate.title)).toEqual([
      'guide.md: Guide',
      'guide.md: Setup',
      'guide.md: Usage',
    ]);
    expect(result.candidates[1]!.contentRef).toMatch(/^guide\.md#L\d+-L\d+$/);
  });

  it('keeps two knowledge bases with the same leaf path distinct', async () => {
    const parent = await tree({});
    const left = join(parent, 'a', 'kb');
    const right = join(parent, 'b', 'kb');
    await mkdir(left, { recursive: true });
    await mkdir(right, { recursive: true });
    await writeFile(join(left, 'note.md'), '## Shared name\nLeft copy.\n');
    await writeFile(join(right, 'note.md'), '## Shared name\nRight copy.\n');

    const leftRead = await read(knowledgeBase(left), { task: 'read the note' });
    const rightRead = await read(knowledgeBase(right), { task: 'read the note' });
    expect(leftRead.status).toBe('read');
    expect(rightRead.status).toBe('read');
    if (leftRead.status !== 'read' || rightRead.status !== 'read') return;

    // The id is relative to the source root, so both bases produce the
    // same id and it never varies with the host's working directory; the
    // sourceId keeps the two knowledge bases apart.
    const leftIds = leftRead.candidates.map((candidate) => candidate.id).sort();
    const rightIds = rightRead.candidates.map((candidate) => candidate.id).sort();
    expect(leftIds).toEqual(['note.md#1']);
    expect(rightIds).toEqual(['note.md#1']);
    const pairs = new Set(
      [...leftRead.candidates, ...rightRead.candidates]
        .map((candidate) => `${candidate.sourceId}:${candidate.id}`),
    );
    expect(pairs.size).toBe(leftRead.candidates.length + rightRead.candidates.length);
  });

  it('offers a section longer than the question budget in parts that rejoin exactly', async () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index} of the long section`);
    const directory = await tree({
      'long.md': `## Long\n${lines.join('\n')}\n`,
    });

    const result = await read(knowledgeBase(directory, { maxQuestionText: 80 }), { task: 'read it' });
    expect(result.status).toBe('read');
    if (result.status !== 'read') return;

    // Candidates arrive ranked, not file-ordered; rejoin in part order.
    const parts = result.candidates
      .filter((candidate) => candidate.id.endsWith('#1') || candidate.id.includes('#1.'))
      .sort((left, right) =>
        Number(/#1(?:\.(\d+))?$/.exec(left.id)?.[1] ?? '0')
        - Number(/#1(?:\.(\d+))?$/.exec(right.id)?.[1] ?? '0'));
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) {
      expect(part.text.length).toBeLessThanOrEqual(80);
      expect(part.title).toContain('(part ');
    }
    const section = `## Long\n${lines.join('\n')}\n`;
    expect(parts.map((part) => part.text).join('')).toBe(section);
    expect(parts.map((part) => part.id)).toEqual(
      parts.map((_, index) => expect.stringMatching(new RegExp(`long\\.md#1\\.${index + 1}$`))),
    );
  });

  it('cuts a section past the default budget so default pick shows every part whole', async () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index} of the long section`);
    const section = `## Long\n${lines.join('\n')}\n`;
    const directory = await tree({ 'long.md': section });

    const result = await read(knowledgeBase(directory), { task: 'read it' });
    expect(result.status).toBe('read');
    if (result.status !== 'read') return;

    const parts = result.candidates
      .slice()
      .sort((left, right) =>
        Number(/#1\.(\d+)$/.exec(left.id)?.[1] ?? '0')
        - Number(/#1\.(\d+)$/.exec(right.id)?.[1] ?? '0'));
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.text.length).toBeLessThanOrEqual(700);
    expect(parts.map((part) => part.text).join('')).toBe(section);

    const picked = await pick(result.candidates, { task: 'read it', decide: allAnswered(0.9) });
    expect(picked.record.candidates.every((entry) => entry.truncated !== true)).toBe(true);
  });

  it('cuts parts at the pick budget pickFromSources passes down', async () => {
    const lines = Array.from({ length: 24 }, (_, index) => `sentence ${index} of the section`);
    const section = `## Long\n${lines.join('\n')}\n`;
    const directory = await tree({ 'long.md': section });

    const seen = new Map<string, string>();
    const result = await pickFromSources(
      [knowledgeBase(directory)],
      { task: 'read it' },
      {
        task: 'read it',
        limits: { maxQuestionText: 100 },
        decide: async (batch) => {
          for (const question of batch.questions) seen.set(question.id, question.text);
          return allAnswered(0.9)(batch);
        },
      },
    );

    // The read cut parts at pick's 100-character budget, so the model
    // saw each part whole and the parts rejoin to the section.
    const ids = [...seen.keys()].sort((left, right) =>
      Number(/\.(\d+)$/.exec(left)?.[1] ?? '0') - Number(/\.(\d+)$/.exec(right)?.[1] ?? '0'));
    expect(ids.length).toBeGreaterThan(2);
    expect(ids.map((id) => seen.get(id)).join('')).toBe(section);
    expect(result.record.candidates.every((entry) => entry.truncated !== true)).toBe(true);
  });

  it('counts inbound links by resolved path, so same-named files in different folders stay distinct', async () => {
    const directory = await tree({
      'a/index.md': '## Index\nPlain text.\n',
      'a/plan.md': '## Plan A\nSee [the b plan](../b/plan.md).\n',
      'b/other.md': '## Other\nSee [the a plan](../a/plan.md) and [the b plan](plan.md).\n',
      'b/plan.md': '## Plan B\nThe b plan.\n',
    });

    const result = await read(knowledgeBase(directory), { task: 'the plans' });
    expect(result.status).toBe('read');
    if (result.status !== 'read') return;

    // a/plan.md earns one link (from b/other.md across folders);
    // b/plan.md earns two (from a/plan.md across folders, not discarded
    // as a self-link, and from b/other.md beside it). Counting by file
    // name alone would tie the two plans.
    const aPlan = result.candidates.find((candidate) => candidate.id.startsWith('a/plan.md'))!;
    const bPlan = result.candidates.find((candidate) => candidate.id.startsWith('b/plan.md'))!;
    const index = result.candidates.find((candidate) => candidate.id.startsWith('a/index.md'))!;
    expect(aPlan.signals['inbound-links']).toBeGreaterThan(0);
    expect(bPlan.signals['inbound-links']).toBeGreaterThan(aPlan.signals['inbound-links']!);
    expect(index.signals['inbound-links']).toBeUndefined();
  });

  it('counts a `[[wiki]]` link by note name across folders', async () => {
    const directory = await tree({
      'a/index.md': '## Index\nSee [[plan]] for the approach.\n',
      'b/plan.md': '## Plan\nThe plan lives in another folder.\n',
    });

    const result = await read(knowledgeBase(directory), { task: 'the approach' });
    expect(result.status).toBe('read');
    if (result.status !== 'read') return;

    // `[[plan]]` names a note anywhere in the source, not a file beside
    // the linking note, so b/plan.md earns the link.
    const plan = result.candidates.find((candidate) => candidate.id.startsWith('b/plan.md'))!;
    expect(plan.signals['inbound-links']).toBeGreaterThan(0);
  });

  it('counts a `.md` link that carries a `#section` anchor', async () => {
    const directory = await tree({
      'index.md': '## Index\nSee [the plan](plan.md#details) for detail.\n',
      'plan.md': '## Plan\nThe plan.\n\n## Details\nThe detail.\n',
    });

    const result = await read(knowledgeBase(directory), { task: 'the plan' });
    expect(result.status).toBe('read');
    if (result.status !== 'read') return;

    const plan = result.candidates.find((candidate) => candidate.id === 'plan.md#1')!;
    expect(plan.signals['inbound-links']).toBeGreaterThan(0);
  });

  it('offers every part to the decision model', async () => {
    const lines = Array.from({ length: 20 }, (_, index) => `paragraph ${index}`);
    const directory = await tree({
      'long.md': `## Long\n${lines.join('\n')}\n`,
    });
    const source = knowledgeBase(directory, { maxQuestionText: 60 });
    const result = await read(source, { task: 'read it' });
    expect(result.status).toBe('read');
    if (result.status !== 'read') return;

    const seen: string[] = [];
    await pick(result.candidates, {
      task: 'read it',
      decide: async (batch) => {
        seen.push(...batch.questions.map((question) => question.text));
        return Object.fromEntries(batch.questions.map((question) => [
          question.key,
          { status: 'answered' as const, probability: 0.9 },
        ]));
      },
    });

    const texts = result.candidates.map((candidate) => candidate.text);
    expect(new Set(seen)).toEqual(new Set(texts));
    expect(seen).toHaveLength(texts.length);
  });

  it('ranks a section naming the task words above one that does not (BM25)', async () => {
    const directory = await tree({
      'notes.md': [
        '## Billing migration',
        'The billing migration moves invoices to the new ledger with a billing run per customer.',
        '',
        '## Office plants',
        'Water the ferns on Fridays.',
        '',
      ].join('\n'),
    });

    const result = await read(knowledgeBase(directory), { task: 'the billing migration ledger' });
    expect(result.status).toBe('read');
    if (result.status !== 'read') return;

    const billing = result.candidates.find((candidate) => candidate.title.includes('Billing migration'))!;
    const plants = result.candidates.find((candidate) => candidate.title.includes('Office plants'))!;
    expect(billing.signals['bm25']).toBeGreaterThan(plants.signals['bm25'] ?? 0);
    expect(result.candidates[0]!.title).toContain('Billing migration');
  });

  it('ranks a section naming short task words above one that does not (BM25)', async () => {
    const directory = await tree({
      'notes.md': [
        '## Query engine',
        'The SQL engine plans each query.',
        '',
        '## Other plants',
        'Water the ferns on Fridays.',
        '',
      ].join('\n'),
    });

    const result = await read(knowledgeBase(directory), { task: 'fix the SQL bug' });
    expect(result.status).toBe('read');
    if (result.status !== 'read') return;

    // 'Other' contains 'the' and task words count whole words only, so
    // the plants heading earns nothing and the SQL section keeps first
    // place.
    const engine = result.candidates.find((candidate) => candidate.title.includes('Query engine'))!;
    const plants = result.candidates.find((candidate) => candidate.title.includes('Other plants'))!;
    expect(engine.signals['bm25']).toBeGreaterThan(plants.signals['bm25'] ?? 0);
    expect(plants.signals['heading-words']).toBeUndefined();
    expect(result.candidates[0]!.title).toContain('Query engine');
  });

  it('scores heading, file and frontmatter words, and inbound links', async () => {
    const directory = await tree({
      'deployment-ledger.md': [
        '---',
        'tags: deployment ledger rollout',
        '---',
        '## Deployment ledger',
        'The ledger records each deployment.',
        '',
      ].join('\n'),
      'index.md': [
        '## Index',
        'See [[deployment-ledger]] and [the ledger](deployment-ledger.md) for the record.',
        '',
      ].join('\n'),
    });

    const result = await read(knowledgeBase(directory), { task: 'deployment ledger rollout' });
    expect(result.status).toBe('read');
    if (result.status !== 'read') return;

    const ledger = result.candidates.find((candidate) =>
      candidate.id.includes('deployment-ledger.md'))!;
    expect(ledger.signals['heading-words']).toBeGreaterThan(0);
    expect(ledger.signals['file-words']).toBeGreaterThan(0);
    expect(ledger.signals['inbound-links']).toBeGreaterThan(0);
  });

  it('keeps a replaced note as a candidate with the negative signal', async () => {
    const directory = await tree({
      'old-plan.md': [
        '---',
        'status: superseded by new-plan.md',
        '---',
        '## Old plan',
        'The original rollout plan for the billing migration.',
        '',
      ].join('\n'),
      'new-plan.md': '## New plan\nThe current rollout plan for the billing migration.\n',
    });

    const result = await read(knowledgeBase(directory), { task: 'billing migration rollout' });
    expect(result.status).toBe('read');
    if (result.status !== 'read') return;

    const old = result.candidates.find((candidate) => candidate.id.includes('old-plan.md'))!;
    expect(old.signals['replaced']).toBe(-2);
    expect(old.role).toBe('reference');
  });

  it('marks replaced notes found in the first lines too', async () => {
    const directory = await tree({
      'retired.md': '## Retired\n\n> superseded by the 2025 policy\n\nOld text.\n',
    });
    const result = await read(knowledgeBase(directory), { task: 'the policy' });
    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    expect(result.candidates.some((candidate) => candidate.signals['replaced'] === -2)).toBe(true);
  });

  it('never honours applies frontmatter: a note stays reference', async () => {
    const directory = await tree({
      'note.md': '---\napplies: always\n---\n## Note\nBody.\n',
    });
    const result = await read(knowledgeBase(directory), { task: 'anything' });
    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    for (const candidate of result.candidates) {
      expect(candidate.role).toBe('reference');
      expect(candidate.applies).toBeUndefined();
    }
  });

  it('carries a declared date with its meaning and leaves an undeclared note without one', async () => {
    const directory = await tree({
      'dated.md': '---\ndate: 2025-01-04\n---\n## Dated\nDated body.\n',
      'effective.md': '---\neffective: 2025-02-01\n---\n## Effective\nEffective body.\n',
      'plain.md': '## Plain\nUndated body.\n',
    });
    const result = await read(knowledgeBase(directory), { task: 'body' });
    expect(result.status).toBe('read');
    if (result.status !== 'read') return;

    const byFile = (name: string) => result.candidates.filter((c) => c.id.includes(name));
    expect(byFile('dated.md')[0]!.date).toEqual({ value: '2025-01-04', meaning: 'recorded' });
    expect(byFile('effective.md')[0]!.date).toEqual({ value: '2025-02-01', meaning: 'effective' });
    expect(byFile('plain.md').every((c) => c.date === undefined)).toBe(true);
  });

  it('reports a missing directory as absent with its reason', async () => {
    const missing = join(await tree({}), 'nowhere');
    const result = await read(knowledgeBase(missing), { task: 'read it' });
    expect(result).toMatchObject({ status: 'absent' });
    if (result.status === 'absent') expect(result.reason).toContain('nowhere');
  });

  it('reports a non-directory path as absent', async () => {
    const directory = await tree({ 'file.md': '## A\nBody.\n' });
    const result = await read(knowledgeBase(join(directory, 'file.md')), { task: 'read it' });
    expect(result.status).toBe('absent');
  });

  it('throws a SourceReadError when a file cannot be read', async () => {
    const directory = await tree({
      'open.md': '## Open\nReadable.\n',
      'locked.md': '## Locked\nUnreadable.\n',
    });
    const locked = join(directory, 'locked.md');
    await chmod(locked, 0o000);
    try {
      await expect(read(knowledgeBase(directory), { task: 'read it' })).rejects.toBeInstanceOf(SourceReadError);
    } finally {
      await chmod(locked, 0o644);
    }
  });

  it('never opens an excluded file, so an unreadable one cannot fail the read', async () => {
    const directory = await tree({
      'open.md': '## Open\nReadable.\n',
      'secret.md': '## Secret\nHidden.\n',
    });
    const locked = join(directory, 'secret.md');
    await chmod(locked, 0o000);
    try {
      const result = await read(knowledgeBase(directory), {
        task: 'read it',
        exclude: [locked],
      });
      expect(result.status).toBe('read');
      if (result.status !== 'read') return;
      expect(result.candidates.every((candidate) => !candidate.id.includes('secret.md'))).toBe(true);
    } finally {
      await chmod(locked, 0o644);
    }
  });

  it('reads a read-only folder', async () => {
    const directory = await tree({ 'note.md': '## Note\nBody.\n' });
    await chmod(directory, 0o555);
    try {
      const result = await read(knowledgeBase(directory), { task: 'read it' });
      expect(result.status).toBe('read');
      if (result.status === 'read') expect(result.candidates.length).toBeGreaterThan(0);
    } finally {
      await chmod(directory, 0o755);
    }
  });

  it('keeps the text it read when the file changes afterwards', async () => {
    const directory = await tree({ 'note.md': '## Note\nOriginal text.\n' });
    const result = await read(knowledgeBase(directory), { task: 'read it' });
    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    const text = result.candidates.map((candidate) => candidate.text).join('');
    await writeFile(join(directory, 'note.md'), '## Note\nReplaced text.\n');
    expect(result.candidates.map((candidate) => candidate.text).join('')).toBe(text);
    expect(text).toContain('Original text.');
  });

  it('skips a symbolic link and reports the read incomplete', async () => {
    const directory = await tree({ 'real.md': '## Real\nBody.\n' });
    await symlink(join(directory, 'real.md'), join(directory, 'link.md'));

    const result = await read(knowledgeBase(directory), { task: 'read it' });
    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    expect(result.complete).toBe(false);
    expect(result.partial).toContain('symbolic-link');
    expect(result.candidates.every((candidate) => !candidate.id.includes('link.md'))).toBe(true);
  });

  it('reports a truncated read as incomplete with its reason', async () => {
    const directory = await tree({
      'a.md': '## A\nFirst.\n',
      'b.md': '## B\nSecond.\n',
      'c.md': '## C\nThird.\n',
    });
    const result = await read(knowledgeBase(directory), { task: 'read it', limit: 1 });
    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    expect(result.candidates).toHaveLength(1);
    expect(result.complete).toBe(false);
    expect(result.partial).toContain('kept 1 of');
  });

  it('answers absent for a pinned revision the working tree cannot resolve', async () => {
    const directory = await tree({ 'note.md': '## Note\nBody.\n' });
    const result = await read(knowledgeBase(directory), { task: 'read it', revision: 'abc123' });
    expect(result).toEqual({
      status: 'absent',
      reason: 'a working-tree Markdown read cannot resolve a pinned revision',
    });
  });

  it('answers absent for a HEAD pin too, since the corpus sits outside any work tree', async () => {
    const directory = await tree({ 'note.md': '## Note\nBody.\n' });
    const result = await read(knowledgeBase(directory), { task: 'read it', revision: 'HEAD' });
    expect(result).toEqual({
      status: 'absent',
      reason: 'a working-tree Markdown read cannot resolve a pinned revision',
    });
  });

  it('stops a cancelled read distinctly', async () => {
    const directory = await tree({ 'note.md': '## Note\nBody.\n' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      read(knowledgeBase(directory), { task: 'read it', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'SourceReadError', code: 'cancelled' });
  });
});

describe('rules', () => {
  it('emits one rule candidate per file, excluding README.md', async () => {
    const directory = await tree({
      'README.md': '# Rules\nWhat this folder is.\n',
      'sign-commits.md': '# Sign commits\nEvery commit is signed.\n',
      'small-prs.md': '# Small pull requests\nKeep changes small.\n',
    });
    const result = await read(rules(directory), { task: 'commit work' });
    expect(result.status).toBe('read');
    if (result.status !== 'read') return;

    expect(result.candidates.map((candidate) => candidate.id).sort()).toEqual([
      'sign-commits.md',
      'small-prs.md',
    ]);
    expect(result.candidates.every((candidate) => candidate.role === 'rule')).toBe(true);
    expect(result.candidates.every((candidate) => candidate.title === candidate.id)).toBe(true);
    expect(result.complete).toBe(true);
  });

  it('marks applies: always frontmatter so pick selects it without asking', async () => {
    const directory = await tree({
      'always-rule.md': '---\napplies: always\n---\n# Always\nAlways true.\n',
      'sometimes-rule.md': '# Sometimes\nOnly sometimes.\n',
    });
    const result = await read(rules(directory), { task: 'any task' });
    expect(result.status).toBe('read');
    if (result.status !== 'read') return;

    const always = result.candidates.find((candidate) => candidate.id === 'always-rule.md');
    const sometimes = result.candidates.find((candidate) => candidate.id === 'sometimes-rule.md');
    expect(always?.applies).toBe('always');
    expect(sometimes?.applies).toBeUndefined();

    const asked: string[] = [];
    const picked = await pick(result.candidates, {
      task: 'any task',
      decide: async (batch) => {
        asked.push(...batch.questions.map((question) => question.id));
        return allAnswered(0.9)(batch);
      },
    });
    expect(asked).toEqual(['sometimes-rule.md']);
    expect(picked.selected.map((candidate) => candidate.id).sort()).toEqual([
      'always-rule.md',
      'sometimes-rule.md',
    ]);
    expect(picked.record.candidates.find((entry) => entry.id === 'always-rule.md'))
      .toMatchObject({ status: 'selected', asked: false });
    expect(picked.record.rulesCoverage).toBe('complete');
  });

  it('reports a read stopped by limit as incomplete', async () => {
    const directory = await tree({
      'a.md': '# A\nFirst rule.\n',
      'b.md': '# B\nSecond rule.\n',
    });
    const result = await read(rules(directory), { task: 'any task', limit: 1 });
    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    expect(result.candidates).toHaveLength(1);
    expect(result.complete).toBe(false);
    expect(result.partial).toContain('kept 1 of 2');
  });

  it('makes rulesCoverage incomplete when a limited rules read is picked', async () => {
    const directory = await tree({
      'a.md': '# A\nFirst rule.\n',
      'b.md': '# B\nSecond rule.\n',
      'c.md': '# C\nThird rule.\n',
    });
    const source = rules(directory);
    const result = await read(source, { task: 'any task', limit: 2 });
    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    expect(result.candidates).toHaveLength(2);

    // Every supplied rule is answered; the truncated enumeration alone must
    // hold the coverage at incomplete.
    const picked = await pick(result.candidates, {
      task: 'any task',
      decide: allAnswered(0.9),
      rulesEnumerationComplete: result.complete,
    });
    expect(picked.record.rulesCoverage).toBe('incomplete');
  });

  it('never opens an excluded file', async () => {
    const directory = await tree({
      'open-rule.md': '# Open\nReadable.\n',
      'secret-rule.md': '# Secret\nHidden.\n',
    });
    const locked = join(directory, 'secret-rule.md');
    await chmod(locked, 0o000);
    try {
      const result = await read(rules(directory), {
        task: 'any task',
        exclude: ['secret-rule.md'],
      });
      expect(result.status).toBe('read');
      if (result.status !== 'read') return;
      expect(result.candidates.map((candidate) => candidate.id)).toEqual(['open-rule.md']);
    } finally {
      await chmod(locked, 0o644);
    }
  });
});

describe('knowledgeBase git dates', () => {
  const IDENTITY: NodeJS.ProcessEnv = {
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };

  function git(directory: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('git', ['-C', directory, ...args], { env: { ...process.env, ...env } },
        (error, stdout) => {
          if (error === null) resolve(stdout.toString());
          else reject(error);
        });
    });
  }

  /** A repository with the given files committed in one commit. */
  async function committedRepo(
    files: Record<string, string>,
    date = '2026-09-15T12:00:00Z',
  ): Promise<string> {
    const root = await tree({ 'repo/.keep': '' });
    const repo = join(root, 'repo');
    for (const [path, text] of Object.entries(files)) {
      const file = join(repo, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text);
    }
    await git(repo, ['init', '-b', 'main']);
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'add the corpus'], {
      ...IDENTITY,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });
    return repo;
  }

  it('labels an undated note with its last committed change', async () => {
    const repo = await committedRepo({ 'docs/ops.md': 'the ops body' });
    const toplevel = (await git(repo, ['rev-parse', '--show-toplevel'])).trim();

    const result = await read(knowledgeBase(join(repo, 'docs')), { task: 'ops work' });

    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      path: 'docs/ops.md',
      repository: toplevel,
      date: { value: '2026-09-15T12:00:00+00:00', meaning: 'changed' },
    });
  });

  it('keeps a declared frontmatter date ahead of the commit date', async () => {
    const repo = await committedRepo({
      'docs/ops.md': '---\ndate: 2026-01-01\n---\nthe ops body\n',
    });

    const result = await read(knowledgeBase(join(repo, 'docs')), { task: 'ops work' });

    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    expect(result.candidates[0]!.date).toEqual({ value: '2026-01-01', meaning: 'recorded' });
  });

  it('leaves notes outside any repository exactly as before', async () => {
    const directory = await tree({ 'docs/ops.md': 'the ops body' });

    const result = await read(knowledgeBase(directory), { task: 'ops work' });

    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    expect(result.candidates[0]).not.toHaveProperty('date');
    expect(result.candidates[0]).not.toHaveProperty('path');
    expect(result.candidates[0]).not.toHaveProperty('repository');
  });

  it('gives an untracked note no git date', async () => {
    const repo = await committedRepo({ 'docs/ops.md': 'the ops body' });
    await writeFile(join(repo, 'docs', 'draft.md'), 'uncommitted draft');

    const result = await read(knowledgeBase(join(repo, 'docs')), { task: 'ops work' });

    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    const byId = new Map(result.candidates.map((candidate) => [candidate.id, candidate]));
    expect(byId.get('ops.md#1')!.date).toEqual({
      value: '2026-09-15T12:00:00+00:00',
      meaning: 'changed',
    });
    expect(byId.get('draft.md#1')).not.toHaveProperty('date');
  });

  it("dates a modified working file by its last committed change", async () => {
    const repo = await committedRepo({ 'docs/ops.md': 'the committed body' });
    await writeFile(join(repo, 'docs', 'ops.md'), 'uncommitted edits');

    const result = await read(knowledgeBase(join(repo, 'docs')), { task: 'ops work' });

    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    expect(result.candidates[0]!.text).toContain('uncommitted edits');
    expect(result.candidates[0]!.date).toEqual({
      value: '2026-09-15T12:00:00+00:00',
      meaning: 'changed',
    });
  });

  it('dates a note by the merge commit whose resolution changed it', async () => {
    const repo = await committedRepo({ 'docs/ops.md': 'the first body' });
    await git(repo, ['checkout', '-b', 'side']);
    await writeFile(join(repo, 'docs', 'ops.md'), 'the side body');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'side edit'], {
      ...IDENTITY,
      GIT_AUTHOR_DATE: '2026-10-01T12:00:00Z',
      GIT_COMMITTER_DATE: '2026-10-01T12:00:00Z',
    });
    await git(repo, ['checkout', 'main']);
    await writeFile(join(repo, 'docs', 'ops.md'), 'the main body');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'main edit'], {
      ...IDENTITY,
      GIT_AUTHOR_DATE: '2026-10-05T12:00:00Z',
      GIT_COMMITTER_DATE: '2026-10-05T12:00:00Z',
    });
    // Both sides changed the note, so the merge conflicts; the
    // resolution writes a third version, which is the last change.
    await git(repo, ['merge', '--no-ff', 'side', '-m', 'merge side']).catch(() => {});
    await writeFile(join(repo, 'docs', 'ops.md'), 'the resolved body');
    await git(repo, ['add', 'docs/ops.md']);
    await git(repo, ['commit', '-m', 'merge side'], {
      ...IDENTITY,
      GIT_AUTHOR_DATE: '2026-10-10T12:00:00Z',
      GIT_COMMITTER_DATE: '2026-10-10T12:00:00Z',
    });

    const result = await read(knowledgeBase(join(repo, 'docs')), { task: 'ops work' });

    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    expect(result.candidates[0]!.date).toEqual({
      value: '2026-10-10T12:00:00+00:00',
      meaning: 'changed',
    });
  });

  it('reads a repository-relative exclusion the same way as the commit reader', async () => {
    const repo = await committedRepo({
      'docs/ops.md': 'the first ops body',
      'docs/private.md': 'the private body',
    });
    await writeFile(join(repo, 'docs', 'ops.md'), 'the second ops body');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'ops update'], IDENTITY);
    // One relative entry means the same to both readers: the commit that
    // touched the private path is dropped, and the note is never opened
    // (it cannot even be read) on the working-tree or the pinned pass.
    const privateNote = join(repo, 'docs', 'private.md');
    await chmod(privateNote, 0o000);
    try {
      const request = { task: 'ops work', exclude: ['docs/private.md'] };
      const commits = await read(gitHistory(repo), request);
      const notes = await read(knowledgeBase(join(repo, 'docs')), request);
      const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
      const pinned = await read(
        knowledgeBase(join(repo, 'docs')),
        { ...request, revision: head },
      );

      expect(commits.status).toBe('read');
      expect(notes.status).toBe('read');
      expect(pinned.status).toBe('read');
      if (commits.status !== 'read' || notes.status !== 'read' || pinned.status !== 'read') return;
      expect(commits.candidates.map((candidate) => candidate.title)).toEqual(['ops update']);
      expect(notes.candidates.map((candidate) => candidate.id)).toEqual(['ops.md#1']);
      expect(pinned.candidates.map((candidate) => candidate.id)).toEqual(['ops.md#1']);
    } finally {
      await chmod(privateNote, 0o644);
    }
  });

  it('excludes a deleted file on a pinned read through a symlinked workspace path', async () => {
    const repo = await committedRepo({
      'docs/ops.md': 'the ops body',
      'docs/private.md': 'the private body',
    });
    const pinned = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await rm(join(repo, 'docs', 'private.md'));
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'drop the private note'], IDENTITY);
    const parent = await mkdtemp(join(tmpdir(), 'obversa-rdc-link-'));
    temporaryDirectories.push(parent);
    const link = join(parent, 'repo-link');
    await symlink(repo, link);

    // The pin still holds private.md; the working tree does not. The
    // exclusion is spelled through the link, so it resolves only through
    // its deepest existing ancestor — a bare realpath of the file itself
    // fails on the deleted path and leaves the alias spelling, which the
    // realpath'd enumeration never matches.
    const corpus = join(link, 'docs');
    const open = await read(knowledgeBase(corpus), { task: 'ops work', revision: pinned });
    const filtered = await read(knowledgeBase(corpus), {
      task: 'ops work',
      exclude: [join(link, 'docs', 'private.md')],
      revision: pinned,
    });

    expect(open.status).toBe('read');
    expect(filtered.status).toBe('read');
    if (open.status !== 'read' || filtered.status !== 'read') return;
    expect(open.candidates.map((candidate) => candidate.id).sort())
      .toEqual(['ops.md#1', 'private.md#1']);
    expect(filtered.candidates.map((candidate) => candidate.id)).toEqual(['ops.md#1']);
  });

  it('reads the pinned snapshot: earlier text, no later file, the pin as the revision', async () => {
    const repo = await committedRepo({ 'docs/ops.md': 'version one' });
    const first = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await writeFile(join(repo, 'docs', 'ops.md'), 'version two');
    await writeFile(join(repo, 'docs', 'new.md'), 'added later');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'second change'], {
      ...IDENTITY,
      GIT_AUTHOR_DATE: '2026-10-01T12:00:00Z',
      GIT_COMMITTER_DATE: '2026-10-01T12:00:00Z',
    });

    const result = await read(
      knowledgeBase(join(repo, 'docs')),
      { task: 'ops work', revision: first },
    );

    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    expect(result.revision).toBe(first);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.text).toContain('version one');
    expect(result.candidates[0]!.date).toEqual({
      value: '2026-09-15T12:00:00+00:00',
      meaning: 'changed',
    });
  });

  it('keeps the pinned snapshot when HEAD advances after the pin resolves', async () => {
    const repo = await committedRepo({ 'docs/ops.md': 'version one' });
    const pinned = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    onGitChild = (child, args) => {
      // The pause the proof needs: 'HEAD' has already resolved, and this
      // commit lands before the tree and dates are read. The read must
      // still describe the SHA the resolution returned.
      if (args.includes('--verify')) {
        child.once('close', () => {
          writeFileSync(join(repo, 'docs', 'ops.md'), 'version two');
          writeFileSync(join(repo, 'docs', 'new.md'), 'added later');
          execFileSync('git', ['-C', repo, 'add', '-A'], {
            env: { ...process.env, ...IDENTITY },
          });
          execFileSync('git', ['-C', repo, 'commit', '-m', 'second change'], {
            env: { ...process.env, ...IDENTITY },
          });
        });
      }
    };
    try {
      const result = await read(
        knowledgeBase(join(repo, 'docs')),
        { task: 'ops work', revision: 'HEAD' },
      );

      expect(result.status).toBe('read');
      if (result.status !== 'read') return;
      expect(result.revision).toBe(pinned);
      expect(result.candidates.map((candidate) => candidate.id)).toEqual(['ops.md#1']);
      expect(result.candidates[0]!.text).toContain('version one');
      expect(result.candidates[0]!.date).toEqual({
        value: '2026-09-15T12:00:00+00:00',
        meaning: 'changed',
      });
    } finally {
      onGitChild = undefined;
    }
  });

  it('reports absent for a pinned revision on a corpus outside any repository', async () => {
    const directory = await tree({ 'docs/ops.md': 'the ops body' });

    await expect(read(knowledgeBase(directory), { task: 'ops', revision: 'HEAD' }))
      .resolves.toEqual({
        status: 'absent',
        reason: 'a working-tree Markdown read cannot resolve a pinned revision',
      });
  });

  it('reads a corpus outside any repository under a non-English locale', async () => {
    const directory = await tree({ 'docs/ops.md': 'the ops body' });
    const names = ['LANG', 'LC_ALL', 'LANGUAGE'] as const;
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    // The work-tree probe matches git's English stderr; a translated
    // message must never turn an expected absence into a thrown error.
    process.env.LANG = 'de_DE.UTF-8';
    process.env.LC_ALL = 'de_DE.UTF-8';
    process.env.LANGUAGE = 'de';
    try {
      const result = await read(knowledgeBase(directory), { task: 'ops work' });
      expect(result.status).toBe('read');
    } finally {
      for (const name of names) {
        const value = previous.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    // The work-tree probe ran with the pinned locale: every recorded
    // child got LC_ALL 'C', so a translated error message can never
    // reach the absent/throw decision.
    expect(gitEnvs.length).toBeGreaterThan(0);
    expect(gitEnvs.every((env) => env?.LC_ALL === 'C')).toBe(true);
  });

  it('keeps a pinned rules read absent, as before', async () => {
    const repo = await committedRepo({ 'rules/run.md': '# Run\nFollow it.\n' });

    await expect(read(rules(join(repo, 'rules')), { task: 'ops', revision: 'HEAD' }))
      .resolves.toEqual({
        status: 'absent',
        reason: 'a working-tree Markdown read cannot resolve a pinned revision',
      });
  });

  it('refuses every note for a root exclusion, the same set the commit reader refuses', async () => {
    const repo = await committedRepo({
      'docs/ops.md': 'the ops body',
      'docs/other.md': 'the other body',
    });
    const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();

    // The corpus repository sits outside the working directory, so '.'
    // can only name a root through the readers' own anchors — the
    // repository root, not the process's cwd. On the working-tree pass
    // and the pinned pass alike, nothing beneath it is opened.
    const commits = await read(gitHistory(repo), { task: 'ops work', exclude: ['.'] });
    expect(commits.status).toBe('read');
    if (commits.status === 'read') expect(commits.candidates).toHaveLength(0);
    for (const request of [
      { task: 'ops work', exclude: ['.'] },
      { task: 'ops work', exclude: ['./'] },
      { task: 'ops work', exclude: ['.'], revision: head },
    ]) {
      const result = await read(knowledgeBase(join(repo, 'docs')), request);
      expect(result.status).toBe('read');
      if (result.status !== 'read') return;
      expect(result.candidates).toHaveLength(0);
    }
  });

  it('reads the pinned corpus when the working tree no longer holds the directory', async () => {
    const repo = await committedRepo({ 'docs/ops.md': 'the pinned body' });
    const pinned = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await rm(join(repo, 'docs'), { recursive: true, force: true });
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'drop the corpus'], IDENTITY);

    // The directory is gone from the working tree, but the commit the
    // pin names still holds it: the repository is located through the
    // existing ancestor and the corpus enumerated from that commit.
    const result = await read(
      knowledgeBase(join(repo, 'docs')),
      { task: 'ops work', revision: pinned },
    );

    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    expect(result.revision).toBe(pinned);
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(['ops.md#1']);
    expect(result.candidates[0]!.text).toContain('the pinned body');
    expect(result.candidates[0]!.date).toEqual({
      value: '2026-09-15T12:00:00+00:00',
      meaning: 'changed',
    });
  });

  it('still reads the notes when the work-tree probe fails unexpectedly', async () => {
    const repo = await committedRepo({ 'docs/ops.md': 'the ops body' });
    const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    // A stand-in git that fails every call with an unexpected error:
    // the probe cannot even refuse cleanly, and an unpinned read skips
    // the tier and carries what the walk found.
    const bin = await mkdtemp(join(tmpdir(), 'obversa-rdc-bin-'));
    temporaryDirectories.push(bin);
    await writeFile(join(bin, 'git'), '#!/bin/sh\necho "unexpected git failure" >&2\nexit 128\n');
    await chmod(join(bin, 'git'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const result = await read(knowledgeBase(join(repo, 'docs')), { task: 'ops work' });
      expect(result.status).toBe('read');
      if (result.status !== 'read') return;
      expect(result.candidates.map((candidate) => candidate.id)).toEqual(['ops.md#1']);
      expect(result.candidates[0]!.text).toContain('the ops body');
      expect(result.candidates[0]).not.toHaveProperty('date');
      expect(result.candidates[0]).not.toHaveProperty('path');
      expect(result.candidates[0]).not.toHaveProperty('repository');
      // A pinned read still throws: it cannot honour its pin without git.
      await expect(
        read(knowledgeBase(join(repo, 'docs')), { task: 'ops work', revision: head }),
      ).rejects.toMatchObject({ name: 'SourceReadError' });
    } finally {
      process.env.PATH = path;
    }
  });

  it('still reads the notes when the git log pass fails unexpectedly', async () => {
    const repo = await committedRepo({ 'docs/ops.md': 'the ops body' });
    const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    // A stand-in git that refuses only `log`: the probe and every other
    // call go through to the real binary, and the failing date pass
    // drops the tier rather than the read.
    const bin = await mkdtemp(join(tmpdir(), 'obversa-rdc-bin-'));
    temporaryDirectories.push(bin);
    const real = execFileSync('which', ['git']).toString().trim();
    await writeFile(join(bin, 'git'), [
      '#!/bin/sh',
      'for arg in "$@"; do',
      '  if [ "$arg" = "log" ]; then',
      '    echo "unexpected git failure" >&2',
      '    exit 128',
      '  fi',
      'done',
      `exec "${real}" "$@"`,
      '',
    ].join('\n'));
    await chmod(join(bin, 'git'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const result = await read(knowledgeBase(join(repo, 'docs')), { task: 'ops work' });
      expect(result.status).toBe('read');
      if (result.status !== 'read') return;
      expect(result.candidates.map((candidate) => candidate.id)).toEqual(['ops.md#1']);
      expect(result.candidates[0]!.text).toContain('the ops body');
      expect(result.candidates[0]).not.toHaveProperty('date');
      expect(result.candidates[0]).not.toHaveProperty('path');
      expect(result.candidates[0]).not.toHaveProperty('repository');
      // A pinned read still throws: its dates cannot be honoured.
      await expect(
        read(knowledgeBase(join(repo, 'docs')), { task: 'ops work', revision: head }),
      ).rejects.toMatchObject({ name: 'SourceReadError' });
    } finally {
      process.env.PATH = path;
    }
  });
});
