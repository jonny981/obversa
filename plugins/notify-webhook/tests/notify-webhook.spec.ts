import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, test } from 'vitest';

import {
  messageFor,
  webhookNotifier,
  type RunEvent,
  type WebhookMessage,
} from '../src/index.js';

/**
 * A real server on a port the operating system picks, so the address the tests
 * post to is generated at run time. No URL is written down anywhere in this
 * package.
 */
async function receiver(options: { status?: number } = {}): Promise<{
  url: string;
  received: WebhookMessage[];
  contentTypes: string[];
  close: () => Promise<void>;
}> {
  const received: WebhookMessage[] = [];
  const contentTypes: string[] = [];
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
    request.on('end', () => {
      contentTypes.push(request.headers['content-type'] ?? '');
      received.push(JSON.parse(body) as WebhookMessage);
      response.writeHead(options.status ?? 200).end();
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    contentTypes,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => { error ? reject(error) : resolve(); });
    }),
  };
}

/**
 * An address the operating system handed out and nobody is listening on. The
 * address is generated the same way a live one is, so no endpoint is written
 * down here either.
 */
async function deadAddress(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  return `http://127.0.0.1:${port}/`;
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.();
});

async function serverFor(options: { status?: number } = {}) {
  const made = await receiver(options);
  open.push(made.close);
  return made;
}

/**
 * A run event. The extra properties are deliberate: a real event carries
 * fields the notifier's own type does not declare, and it must ignore them.
 */
function event(
  partial: Partial<RunEvent> & { kind: string } & Record<string, unknown>,
): RunEvent {
  return { ts: 1, path: [], ...partial };
}

describe('a run reaching a real endpoint', () => {
  test('posts one message per interesting moment, in the order they happened', async () => {
    const endpoint = await serverFor();
    const notifier = webhookNotifier({ url: endpoint.url });

    notifier.onEvent(event({ kind: 'monitor', url: 'http://127.0.0.1:1/' }));
    notifier.onEvent(event({ kind: 'workflow:start' }));
    notifier.onEvent(event({ kind: 'dag:start', path: [] }));
    notifier.onEvent(event({ kind: 'engine:text' }));
    notifier.onEvent(event({
      kind: 'dag:node', node: 'draft', phase: 'done', outcome: { status: 'pass' },
    }));
    notifier.onEvent(event({
      kind: 'dag:kickback', from: 'review', to: 'draft',
      reason: 'the second paragraph contradicts the brief', accepted: true,
    }));
    notifier.onEvent(event({ kind: 'dag:end', outcome: { status: 'pass', summary: 'all nodes passed' } }));
    await notifier.done();

    expect(endpoint.received.map((message) => message.event)).toEqual([
      'run-started', 'stage-finished', 'sent-back', 'finished',
    ]);
    expect(endpoint.contentTypes.every((type) => type.includes('application/json'))).toBe(true);
  });

  test('run boundary events do not change the existing container messages', async () => {
    const endpoint = await serverFor();
    const notifier = webhookNotifier({ url: endpoint.url });

    notifier.onEvent(event({ kind: 'run:start', path: [] }));
    notifier.onEvent(event({ kind: 'loop:start', path: ['count'] }));
    notifier.onEvent(event({
      kind: 'loop:end', path: ['count'], outcome: { status: 'pass', summary: 'counted' },
    }));
    notifier.onEvent(event({ kind: 'run:end', path: [], outcome: { status: 'pass', summary: 'counted' } }));
    await notifier.done();

    expect(endpoint.received.map((message) => message.event)).toEqual(['run-started', 'finished']);
  });

  test('every one of the six moments carries the text an incoming webhook renders', async () => {
    const endpoint = await serverFor();
    // One notifier per moment, because a run announces its start and its end
    // only once and this has to see all six.
    const moments: RunEvent[][] = [
      [event({ kind: 'workflow:start' })],
      [event({ kind: 'dag:node', node: 'draft', phase: 'done', outcome: { status: 'pass' } })],
      [event({ kind: 'dag:kickback', from: 'review', to: 'draft', reason: 'thin', accepted: true })],
      [event({ kind: 'dag:start', path: [] }), event({ kind: 'dag:end', outcome: { status: 'paused', summary: 'approve?' } })],
      [event({ kind: 'dag:start', path: [] }), event({ kind: 'dag:end', outcome: { status: 'pass' } })],
      [event({ kind: 'dag:start', path: [] }), event({ kind: 'dag:end', outcome: { status: 'fail' } })],
    ];
    for (const events of moments) {
      const notifier = webhookNotifier({ url: endpoint.url });
      for (const each of events) notifier.onEvent(each);
      await notifier.done();
    }

    // Three of the groups open with a dag, which is itself a run starting, so
    // the moment each group is about is the LAST message it produced.
    expect(endpoint.received.map((message) => message.event)).toContain('stage-finished');
    for (const moment of ['run-started', 'stage-finished', 'sent-back', 'paused', 'finished', 'failed']) {
      expect(endpoint.received.map((message) => message.event)).toContain(moment);
    }
    for (const message of endpoint.received) {
      expect(typeof message.text).toBe('string');
      expect(message.text.length).toBeGreaterThan(0);
    }
  });

  test('the message words are the event words', () => {
    const words = (e: RunEvent, monitor?: string) => messageFor(e, monitor)?.text ?? '';
    expect(words(event({ kind: 'dag:start', path: ['brief'] }))).toBe('Run started: brief.');
    expect(words(event({
      kind: 'dag:node', node: 'draft', phase: 'done', outcome: { status: 'pass' },
    }))).toBe('Stage finished: draft (pass)');
    expect(words(event({
      kind: 'dag:node', node: 'draft', phase: 'done', outcome: { status: 'fail' },
    }))).toBe('Stage finished: draft (fail)');
    expect(words(event({ kind: 'dag:end', outcome: { status: 'pass', summary: 'all green' } })))
      .toBe('Run finished.');
    expect(words(event({ kind: 'dag:end', outcome: { status: 'fail', summary: 'two nodes failed' } })))
      .toBe('Run failed: two nodes failed.');
  });

  test('a workflow wrapped by post.always still reports its stages', async () => {
    // post.always wraps the whole graph in a loop, so the graph's events sit
    // one level deeper. Probed shapes: loop:start at ['brief-post'], every dag
    // event at ['brief-post','brief'], loop:end back at ['brief-post'].
    const endpoint = await serverFor();
    const notifier = webhookNotifier({ url: endpoint.url });
    notifier.onEvent(event({ kind: 'loop:start', path: ['brief-post'] }));
    notifier.onEvent(event({ kind: 'dag:start', path: ['brief-post', 'brief'] }));
    for (const node of ['draft', 'review']) {
      // each node's own job, whose end must not be read as the run's
      notifier.onEvent(event({ kind: 'job:start', path: ['brief-post', 'brief'], label: node }));
      notifier.onEvent(event({
        kind: 'job:end', path: ['brief-post', 'brief'], label: node,
        outcome: { status: 'pass', summary: `${node} done` },
      }));
      notifier.onEvent(event({
        kind: 'dag:node', node, phase: 'done',
        path: ['brief-post', 'brief'], outcome: { status: 'pass' },
      }));
    }
    notifier.onEvent(event({
      kind: 'dag:end', path: ['brief-post', 'brief'], outcome: { status: 'pass' },
    }));
    notifier.onEvent(event({ kind: 'loop:end', path: ['brief-post'], outcome: { status: 'pass' } }));
    await notifier.done();

    expect(endpoint.received.map((message) => message.event))
      .toEqual(['run-started', 'stage-finished', 'stage-finished', 'finished']);
    expect(endpoint.received.map((message) => message.stage))
      .toEqual([undefined, 'draft', 'review', undefined]);
  });

  test('a loop body job finishing is not the run finishing', async () => {
    // Every iteration emits job:start and job:end at the top level, carrying
    // the body job's own outcome. Reading one as the run's ending announces
    // the run finished after the first pass, and the once-only guard then
    // swallows the real ending - a failure included.
    const endpoint = await serverFor();
    const notifier = webhookNotifier({ url: endpoint.url });
    notifier.onEvent(event({ kind: 'loop:start', path: ['count'] }));
    for (const iteration of [1, 2, 3]) {
      notifier.onEvent(event({ kind: 'loop:iteration', path: ['count'], iteration }));
      notifier.onEvent(event({ kind: 'job:start', path: ['count'], label: 'tick' }));
      notifier.onEvent(event({
        kind: 'job:end', path: ['count'], label: 'tick', outcome: { status: 'pass', summary: 'tick' },
      }));
    }
    notifier.onEvent(event({
      kind: 'loop:end', path: ['count'],
      outcome: { status: 'fail', summary: 'never reached the goal' },
    }));
    await notifier.done();

    expect(endpoint.received.map((message) => message.event)).toEqual(['run-started', 'failed']);
    expect(endpoint.received[1]?.text).toBe('Run failed: never reached the goal.');
  });

  test('a run that is one job still reports its ending', async () => {
    // With no loop, graph or workflow around it, the job's own end is the
    // run's end and there is nothing else to report it.
    const endpoint = await serverFor();
    const notifier = webhookNotifier({ url: endpoint.url });
    notifier.onEvent(event({ kind: 'job:start', path: [], label: 'write' }));
    notifier.onEvent(event({
      kind: 'job:end', path: [], label: 'write', outcome: { status: 'pass', summary: 'one page written' },
    }));
    await notifier.done();

    expect(endpoint.received.map((message) => message.event)).toEqual(['finished']);
  });

  test('a loop inside a job does not stop the job reporting the run', async () => {
    // Only a container at the TOP of the tree reports the run's ending. One
    // nested inside the root job does not, so the root job's end is still the
    // run's end.
    const endpoint = await serverFor();
    const notifier = webhookNotifier({ url: endpoint.url });
    notifier.onEvent(event({ kind: 'job:start', path: [], label: 'write' }));
    notifier.onEvent(event({ kind: 'loop:start', path: ['write', 'polish'] }));
    // The loop's own body job, which the first version of this test omitted -
    // and omitting it is what hid a nested job:end being read as the run's.
    notifier.onEvent(event({ kind: 'job:start', path: ['write', 'polish'], label: 'tidy' }));
    notifier.onEvent(event({
      kind: 'job:end', path: ['write', 'polish'], label: 'tidy',
      outcome: { status: 'pass', summary: 'tidied' },
    }));
    notifier.onEvent(event({ kind: 'loop:end', path: ['write', 'polish'], outcome: { status: 'pass' } }));
    notifier.onEvent(event({
      kind: 'job:end', path: [], label: 'write', outcome: { status: 'fail', summary: 'the outer job failed' },
    }));
    await notifier.done();

    // The run failed. A nested job finishing must not have announced success
    // and suppressed it.
    expect(endpoint.received.map((message) => message.event)).toEqual(['failed']);
    expect(endpoint.received[0]?.text).toBe('Run failed: the outer job failed.');
  });

  test('a run ends once however many ending events arrive', async () => {
    const endpoint = await serverFor();
    const notifier = webhookNotifier({ url: endpoint.url });
    notifier.onEvent(event({ kind: 'dag:start', path: ['brief'] }));
    notifier.onEvent(event({ kind: 'dag:end', path: ['brief'], outcome: { status: 'pass' } }));
    notifier.onEvent(event({
      kind: 'loop:end', path: ['brief'], outcome: { status: 'fail', summary: 'a second ending' },
    }));
    await notifier.done();

    expect(endpoint.received.map((message) => message.event)).toEqual(['run-started', 'finished']);
  });

  test('a nested container of the same kind does not end the run', async () => {
    // The root is a loop at one level; a loop inside it ending is not the run
    // ending, so the kind alone is not enough - the depth it announced itself
    // at is part of what makes an ending the run's.
    const endpoint = await serverFor();
    const notifier = webhookNotifier({ url: endpoint.url });
    notifier.onEvent(event({ kind: 'loop:start', path: ['outer'] }));
    notifier.onEvent(event({ kind: 'loop:start', path: ['outer', 'inner'] }));
    // the inner loop's own body job, end included
    notifier.onEvent(event({ kind: 'job:start', path: ['outer', 'inner'], label: 'tick' }));
    notifier.onEvent(event({
      kind: 'job:end', path: ['outer', 'inner'], label: 'tick', outcome: { status: 'pass', summary: 'tick' },
    }));
    notifier.onEvent(event({
      kind: 'loop:end', path: ['outer', 'inner'], outcome: { status: 'fail', summary: 'the inner loop' },
    }));
    notifier.onEvent(event({
      kind: 'loop:end', path: ['outer'], outcome: { status: 'pass', summary: 'the run' },
    }));
    await notifier.done();

    expect(endpoint.received.map((message) => message.event)).toEqual(['run-started', 'finished']);
  });

  /**
   * These two exist for one reason each: to hold the once-only guards. Their
   * coverage has twice been lost as a side effect of improving something else,
   * both times found by a mutation rather than a review, so each guard now has
   * a test that exists for no other purpose and is named for it. Do not fold
   * them into a test that is about something else.
   */
  test('GUARD: a second ending message is dropped', async () => {
    const endpoint = await serverFor();
    const notifier = webhookNotifier({ url: endpoint.url });
    notifier.onEvent(event({ kind: 'dag:start', path: ['brief'] }));
    notifier.onEvent(event({ kind: 'dag:end', path: ['brief'], outcome: { status: 'pass' } }));
    notifier.onEvent(event({
      kind: 'dag:end', path: ['brief'], outcome: { status: 'fail', summary: 'a repeated ending' },
    }));
    await notifier.done();

    expect(endpoint.received.map((message) => message.event)).toEqual(['run-started', 'finished']);
  });

  test('GUARD: a second run-started message is dropped', async () => {
    const endpoint = await serverFor();
    const notifier = webhookNotifier({ url: endpoint.url });
    notifier.onEvent(event({ kind: 'workflow:start', path: [] }));
    notifier.onEvent(event({ kind: 'dag:start', path: [] }));
    await notifier.done();

    expect(endpoint.received.map((message) => message.event)).toEqual(['run-started']);
  });

  test('a run is announced once and ended once', async () => {
    const endpoint = await serverFor();
    const notifier = webhookNotifier({ url: endpoint.url });

    // A declarative workflow reports its own start and its graph's; a graph's
    // end and the root job's end both report the outcome.
    notifier.onEvent(event({ kind: 'workflow:start' }));
    notifier.onEvent(event({ kind: 'dag:start', path: ['brief'] }));
    notifier.onEvent(event({ kind: 'dag:end', outcome: { status: 'pass' } }));
    notifier.onEvent(event({ kind: 'job:end', label: 'root', outcome: { status: 'pass' } }));
    await notifier.done();

    expect(endpoint.received.map((message) => message.event)).toEqual(['run-started', 'finished']);
  });
});

describe('the messages that carry the information rather than a pointer', () => {
  test('the paused message names the run page, so the person can answer from it', async () => {
    const endpoint = await serverFor();
    const notifier = webhookNotifier({ url: endpoint.url });
    notifier.onEvent(event({ kind: 'monitor', url: 'http://127.0.0.1:65000/' }));
    notifier.onEvent(event({ kind: 'dag:start', path: [] }));
    notifier.onEvent(event({
      kind: 'dag:end',
      outcome: { status: 'paused', summary: 'ship the release notes?' },
    }));
    await notifier.done();

    const message = endpoint.received.find((each) => each.event === 'paused');
    expect(message?.event).toBe('paused');
    expect(message?.monitor).toBe('http://127.0.0.1:65000/');
    // The question, then the way in on its own line.
    expect(message?.text).toBe('Paused: ship the release notes?\nhttp://127.0.0.1:65000/');
  });

  test('a stage waiting for a person is Paused, not finished', () => {
    // It has not finished. In the mode where the run stays up for the answer
    // this is the only message that would ever be sent about the wait.
    const message = messageFor(event({
      kind: 'dag:node', node: 'approve', phase: 'done',
      outcome: { status: 'paused', summary: 'ship the release notes?' },
    }), 'http://127.0.0.1:65000/');
    expect(message?.event).toBe('paused');
    expect(message?.stage).toBe('approve');
    expect(message?.text).toBe('Paused: ship the release notes?\nhttp://127.0.0.1:65000/');
  });

  test('the message asks the question, not the runtime phrase in front of it', () => {
    // A person gate writes its summary as "waiting for a person: <question>",
    // which would read "Paused: waiting for a person: ..." — Paused already
    // says that. The question itself is carried as its own field.
    const asItReallyArrives = messageFor(event({
      kind: 'dag:node', node: 'approve', phase: 'done', path: ['delivery'],
      outcome: {
        status: 'paused',
        summary: 'waiting for a person: Send the prepared result?',
        data: { decisionText: 'Send the prepared result?' },
      },
    }));
    expect(asItReallyArrives?.text).toBe('Paused: Send the prepared result?');
    expect(asItReallyArrives?.summary).toBe('Send the prepared result?');
  });

  test('the carried question wins over the summary when they differ', () => {
    const message = messageFor(event({
      kind: 'dag:node', node: 'approve', phase: 'done', path: ['delivery'],
      outcome: {
        status: 'paused',
        summary: 'waiting for a person: an older wording of the question?',
        data: { decisionText: 'Send the prepared result?' },
      },
    }));
    expect(message?.text).toBe('Paused: Send the prepared result?');
  });

  test('a blank carried question is not the question', () => {
    const message = messageFor(event({
      kind: 'dag:node', node: 'approve', phase: 'done', path: ['delivery'],
      outcome: { status: 'paused', summary: 'the release needs a decision', data: { decisionText: '   ' } },
    }));
    expect(message?.text).toBe('Paused: the release needs a decision.');
  });

  test('a summary that is not a person gate is left alone', () => {
    const message = messageFor(event({
      kind: 'dag:end', outcome: { status: 'paused', summary: 'the token budget ran out' },
    }));
    expect(message?.text).toBe('Paused: the token budget ran out.');
  });

  test('a run that stays up for the answer still reports finishing after the wait', async () => {
    const endpoint = await serverFor();
    const notifier = webhookNotifier({ url: endpoint.url });
    notifier.onEvent(event({ kind: 'dag:start', path: ['brief'] }));
    notifier.onEvent(event({
      kind: 'dag:node', node: 'approve', phase: 'done', path: ['brief'],
      outcome: { status: 'paused', summary: 'ship it?' },
    }));
    // the person answers, the run carries on and ends
    notifier.onEvent(event({ kind: 'dag:end', path: ['brief'], outcome: { status: 'pass' } }));
    await notifier.done();

    expect(endpoint.received.map((message) => message.event))
      .toEqual(['run-started', 'paused', 'finished']);
  });

  test('a stage pause and the run ending paused are one message, not two', async () => {
    const endpoint = await serverFor();
    const notifier = webhookNotifier({ url: endpoint.url });
    notifier.onEvent(event({
      kind: 'dag:node', node: 'approve', phase: 'done',
      outcome: { status: 'paused', summary: 'ship it?' },
    }));
    // the mode that exits reports the same wait again as the run's own outcome
    notifier.onEvent(event({ kind: 'dag:end', outcome: { status: 'paused', summary: 'paused at approve' } }));
    await notifier.done();

    expect(endpoint.received.map((message) => message.event)).toEqual(['paused']);
    expect(endpoint.received[0]?.stage).toBe('approve');
  });

  test('a second gate in one run is told, not swallowed', async () => {
    const endpoint = await serverFor();
    const notifier = webhookNotifier({ url: endpoint.url });
    notifier.onEvent(event({
      kind: 'dag:node', node: 'approve-spend', phase: 'done',
      outcome: { status: 'paused', summary: 'approve the spend?' },
    }));
    notifier.onEvent(event({
      kind: 'dag:node', node: 'approve-copy', phase: 'done',
      outcome: { status: 'paused', summary: 'approve the wording?' },
    }));
    await notifier.done();

    expect(endpoint.received.map((message) => message.stage))
      .toEqual(['approve-spend', 'approve-copy']);
  });

  test('the sent-back message carries what the reviewer said', () => {
    const message = messageFor(event({
      kind: 'dag:kickback', from: 'review', to: 'draft',
      reason: 'no figure for the third claim', accepted: true,
    }));
    expect(message?.event).toBe('sent-back');
    expect(message?.from).toBe('review');
    expect(message?.to).toBe('draft');
    expect(message?.reason).toBe('no figure for the third claim');
    // The reason is a sentence, so it gets its own line.
    expect(message?.text).toBe('Sent back: review returned work to draft\nno figure for the third claim');
  });

  test('a loop review sending work back is posted, like a graph kickback', () => {
    // The commonest shape anyone runs. A loop review sends work back to the
    // loop's own body, so it names no stages, and its reason is its summary.
    const message = messageFor(event({
      kind: 'loop:review', path: ['write'],
      outcome: { status: 'fail', summary: 'the second claim has no figure' },
    }));
    expect(message?.event).toBe('sent-back');
    expect(message?.accepted).toBe(true);
    expect(message?.reason).toBe('the second claim has no figure');
    expect(message?.text).toBe('Sent back: the review returned the work for another pass\nthe second claim has no figure');
    expect(message?.from).toBeUndefined();
    expect(message?.to).toBeUndefined();
  });

  test('a loop review the loop will not act on says so', () => {
    const message = messageFor(event({
      kind: 'loop:review', path: ['write'], accepted: false,
      outcome: { status: 'fail', summary: 'still thin, and the loop is out of passes' },
    }));
    expect(message?.accepted).toBe(false);
    expect(message?.text).toBe('Sent back refused: the review asked for another pass and the loop is done\nstill thin, and the loop is out of passes');
  });

  test('a passing loop review is not a send-back', () => {
    expect(messageFor(event({
      kind: 'loop:review', path: ['write'], outcome: { status: 'pass', summary: 'both claims carry a figure' },
    }))).toBeUndefined();
  });

  test('a loop review anywhere in the tree is a send-back', () => {
    // A review returning work is news wherever it happens, for the same reason
    // a stage finishing is.
    expect(messageFor(event({
      kind: 'loop:review', path: ['outer', 'inner'], outcome: { status: 'fail', summary: 'thin' },
    }))).toMatchObject({ event: 'sent-back', reason: 'thin' });
  });

  test('a refused send-back says it was refused and why', () => {
    const message = messageFor(event({
      kind: 'dag:kickback', from: 'review', to: 'draft',
      reason: 'still thin', accepted: false, note: 'the re-run budget is spent',
    }));
    expect(message?.event).toBe('sent-back');
    expect(message?.accepted).toBe(false);
    expect(message?.text).toBe('Sent back refused: review asked draft for another pass\nthe re-run budget is spent');
  });

  test('a paused run with no page still says what it is waiting for', () => {
    const message = messageFor(event({
      kind: 'dag:end', outcome: { status: 'paused', summary: 'approve the spend?' },
    }));
    expect(message?.event).toBe('paused');
    expect(message?.monitor).toBeUndefined();
    expect(message?.text).toBe('Paused: approve the spend?');
  });
});

describe('what is not notified', () => {
  test('the noisy events send nothing', () => {
    for (const kind of [
      'engine:text', 'engine:thinking', 'engine:tool', 'engine:usage',
      'loop:iteration', 'loop:condition', 'condition:result', 'log',
      'advisor:consult', 'proof', 'limit:wait', 'loop:stall', 'loop:review',
    ]) {
      expect(messageFor(event({ kind }))).toBeUndefined();
    }
  });

  test('a stage finishing anywhere in the tree is reported', () => {
    // News from inside the run is not filtered by depth. A graph wrapped by a
    // workflow's post.always sits one level deeper without being any less the
    // work the person cares about.
    expect(messageFor(event({
      kind: 'dag:node', node: 'inner', phase: 'done',
      path: ['brief-post', 'brief'], outcome: { status: 'pass' },
    }))).toMatchObject({ event: 'stage-finished', stage: 'inner' });
  });

  test('a stage starting is not a stage finishing', () => {
    expect(messageFor(event({ kind: 'dag:node', node: 'draft', phase: 'start' }))).toBeUndefined();
  });
});

describe('a failed post never fails the run', () => {
  test('a refusing endpoint reaches onError and the run is unaffected', async () => {
    const endpoint = await serverFor({ status: 500 });
    const errors: string[] = [];
    const notifier = webhookNotifier({
      url: endpoint.url,
      onError: (error) => { errors.push(error.message); },
    });

    expect(() => {
      notifier.onEvent(event({ kind: 'workflow:start' }));
      notifier.onEvent(event({ kind: 'dag:start', path: [] }));
      notifier.onEvent(event({ kind: 'dag:end', outcome: { status: 'pass' } }));
    }).not.toThrow();
    await notifier.done();

    expect(errors).toEqual(['the webhook answered 500', 'the webhook answered 500']);
    // The endpoint still received both: the failure is the answer, not the send.
    expect(endpoint.received).toHaveLength(2);
  });

  test('one failed post does not stop the next', async () => {
    const posted: string[] = [];
    let call = 0;
    const notifier = webhookNotifier({
      url: await deadAddress(),
      onError: () => {},
      fetch: async (_url, init) => {
        call += 1;
        posted.push((JSON.parse(init.body) as WebhookMessage).event);
        return { ok: call !== 1, status: call === 1 ? 503 : 200 };
      },
    });
    notifier.onEvent(event({ kind: 'workflow:start' }));
    notifier.onEvent(event({ kind: 'dag:start', path: [] }));
    notifier.onEvent(event({ kind: 'dag:node', node: 'draft', phase: 'done', outcome: { status: 'pass' } }));
    notifier.onEvent(event({ kind: 'dag:end', outcome: { status: 'pass' } }));
    await notifier.done();

    expect(posted).toEqual(['run-started', 'stage-finished', 'finished']);
  });

  test('messages arrive in the order the run made them, even when one post is slow', async () => {
    // Posts are chained, not raced. Without that the first slow post lands
    // last and a reader sees the run finish before it started.
    const arrived: string[] = [];
    let slowOne = true;
    const notifier = webhookNotifier({
      url: await deadAddress(),
      fetch: async (_url, init) => {
        const message = JSON.parse(init.body) as WebhookMessage;
        if (slowOne) {
          slowOne = false;
          await new Promise((resolve) => { setTimeout(resolve, 40); });
        }
        arrived.push(message.event);
        return { ok: true, status: 200 };
      },
    });
    notifier.onEvent(event({ kind: 'dag:start', path: ['brief'] }));
    notifier.onEvent(event({ kind: 'dag:node', node: 'draft', phase: 'done', path: ['brief'], outcome: { status: 'pass' } }));
    notifier.onEvent(event({ kind: 'dag:end', path: ['brief'], outcome: { status: 'pass' } }));
    await notifier.done();

    expect(arrived).toEqual(['run-started', 'stage-finished', 'finished']);
  });

  test('an unreachable endpoint is reported, not thrown', async () => {
    const errors: Error[] = [];
    const notifier = webhookNotifier({
      url: await deadAddress(),
      onError: (error) => { errors.push(error); },
    });
    notifier.onEvent(event({ kind: 'workflow:start' }));
    await notifier.done();
    expect(errors).toHaveLength(1);
  });
});

describe('how a run ends', () => {
  test('a failing outcome is a failed message', () => {
    expect(messageFor(event({ kind: 'dag:end', outcome: { status: 'fail', summary: 'two nodes failed' } })))
      .toMatchObject({ event: 'failed', status: 'fail', summary: 'two nodes failed' });
  });

  test('an exhausted loop is a failed message', () => {
    expect(messageFor(event({ kind: 'loop:end', outcome: { status: 'exhausted' } })))
      .toMatchObject({ event: 'failed', status: 'exhausted' });
  });

  test('an error event sends nothing, because the run may still pass', () => {
    // A loop can log an error in one iteration and pass in the next. The event
    // that ends the run carries the same message in its summary.
    expect(messageFor(event({ kind: 'error', message: 'the engine never answered' })))
      .toBeUndefined();
  });

  test('the ending event carries the error the run failed on', () => {
    expect(messageFor(event({
      kind: 'loop:end',
      outcome: { status: 'fail', summary: 'fn is not a function' },
    }))).toMatchObject({ event: 'failed', status: 'fail', summary: 'fn is not a function' });
  });

  test('a graph run and a loop run are both announced as started', () => {
    expect(messageFor(event({ kind: 'dag:start', path: ['brief'] })))
      .toMatchObject({ event: 'run-started' });
    expect(messageFor(event({ kind: 'loop:start', path: ['count'] })))
      .toMatchObject({ event: 'run-started' });
  });

  test('a loop body job starting is not the run starting', () => {
    // In a loop run every iteration emits job:start at the top level. Only the
    // loop itself starting is the run starting.
    expect(messageFor(event({ kind: 'job:start', label: 'tick', path: ['count'] })))
      .toBeUndefined();
  });
});
