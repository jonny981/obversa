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

  test('every one of the six moments carries the text an incoming webhook renders', async () => {
    const endpoint = await serverFor();
    // One notifier per moment, because a run announces its start and its end
    // only once and this has to see all six.
    const moments: RunEvent[][] = [
      [event({ kind: 'workflow:start' })],
      [event({ kind: 'dag:node', node: 'draft', phase: 'done', outcome: { status: 'pass' } })],
      [event({ kind: 'dag:kickback', from: 'review', to: 'draft', reason: 'thin', accepted: true })],
      [event({ kind: 'dag:end', outcome: { status: 'paused', summary: 'approve?' } })],
      [event({ kind: 'dag:end', outcome: { status: 'pass' } })],
      [event({ kind: 'dag:end', outcome: { status: 'fail' } })],
    ];
    for (const events of moments) {
      const notifier = webhookNotifier({ url: endpoint.url });
      for (const each of events) notifier.onEvent(each);
      await notifier.done();
    }

    expect(endpoint.received.map((message) => message.event)).toEqual([
      'run-started', 'stage-finished', 'sent-back', 'paused', 'finished', 'failed',
    ]);
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
    notifier.onEvent(event({
      kind: 'dag:end',
      outcome: { status: 'paused', summary: 'ship the release notes?' },
    }));
    await notifier.done();

    const [message] = endpoint.received;
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

  test('a run that stays up for the answer still reports finishing after the wait', async () => {
    const endpoint = await serverFor();
    const notifier = webhookNotifier({ url: endpoint.url });
    notifier.onEvent(event({ kind: 'dag:start', path: ['brief'] }));
    notifier.onEvent(event({
      kind: 'dag:node', node: 'approve', phase: 'done',
      outcome: { status: 'paused', summary: 'ship it?' },
    }));
    // the person answers, the run carries on and ends
    notifier.onEvent(event({ kind: 'dag:end', outcome: { status: 'pass' } }));
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

  test('a stage finishing deep inside the tree is not a run-level stage', () => {
    expect(messageFor(event({
      kind: 'dag:node', node: 'inner', phase: 'done',
      path: ['root', 'outer'], outcome: { status: 'pass' },
    }))).toBeUndefined();
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
    notifier.onEvent(event({ kind: 'dag:node', node: 'draft', phase: 'done', outcome: { status: 'pass' } }));
    notifier.onEvent(event({ kind: 'dag:end', outcome: { status: 'pass' } }));
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
