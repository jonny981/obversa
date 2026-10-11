import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  knowledgeBase,
  pick,
  pickFromSources,
  rules,
  SourceReadError,
  type CandidateSource,
  type PickAnswer,
  type PickBatch,
} from '../src/index.js';

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

  it('answers absent for a HEAD pin too, since it resolves nothing', async () => {
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
