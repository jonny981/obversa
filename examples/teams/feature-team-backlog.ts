import { mkdir, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { briefFromFile, type BriefSource } from '@obversa/runtime';

import { deliver } from './feature-delivery.js';

/**
 * The feature team, pointed at a backlog: a folder of markdown tickets.
 * It takes the next ticket, delivers it in its own worktree, records the
 * result and moves on. It stops at the first ticket that does not pass, and
 * leaves that ticket in the backlog. Pass `--unattended` to land each
 * change without asking.
 */

const backlog = 'backlog';
const done = join(backlog, 'done');

// The work lives in a folder here. To take it from Linear or GitHub issues
// instead, change these two functions and nothing else. `next` asks the
// tracker for the next ready issue (for example `gh issue list --label
// ready --limit 1 --json number,body`, or a Linear API query) and returns
// its text as the brief and the files it names. `finish` closes the issue
// or moves it to done.
async function next(): Promise<{ id: string; ticket: BriefSource } | undefined> {
  const [id] = (await readdir(backlog)).filter((name) => name.endsWith('.md')).sort();
  return id === undefined ? undefined : { id, ticket: briefFromFile(join(backlog, id)) };
}

async function finish(id: string): Promise<void> {
  await mkdir(done, { recursive: true });
  await rename(join(backlog, id), join(done, id));
}

const delivered: { ticket: string; status: string; summary?: string }[] = [];
for (let item = await next(); item !== undefined; item = await next()) {
  const result = await deliver(item.ticket, `records/${item.id.replace(/\.md$/, '')}.jsonl`);
  delivered.push({ ticket: item.id, status: result.outcome.status, summary: result.outcome.summary });
  if (result.outcome.status !== 'pass') break;
  await finish(item.id);
}
console.log(JSON.stringify({ delivered }, null, 2));
