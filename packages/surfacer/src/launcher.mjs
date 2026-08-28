import { Writable } from "node:stream";

import { frameResult } from "./handoff.mjs";
import { openSurfaceUrl } from "./host.mjs";
import { startSurface } from "./server.mjs";

// Write the framed result and resolve only once the stream has taken all of
// it. Writes to a pipe are asynchronous, so returning on `write()` alone lets a
// caller exit with the frame cut off at the pipe buffer (64 KiB) — a large
// verbatim result would arrive as invalid JSON with a success exit code. A
// plain object with a synchronous `write` (the tests' capture) needs no wait.
function writeFrame(stdout, text) {
  if (!(stdout instanceof Writable)) {
    stdout.write(text);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    stdout.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * The one launcher: start the session, place the page in the selected
 * host, wait for the single decision, shut down, and frame the result on
 * stdout — resolving only after the whole frame has been handed to the
 * stream. Signals interrupt the session cleanly. `ready` receives the
 * session url once the page is reachable. F3 and later surfaces call
 * this instead of rebuilding the lifecycle.
 */
export async function runSurface({ open = true, stdout = process.stdout, ready, ...surfaceOptions }) {
  const surface = await startSurface(surfaceOptions);
  const handlers = ["SIGINT", "SIGTERM"].map((signal) => {
    const handler = () => surface.interrupt(signal);
    process.on(signal, handler);
    return [signal, handler];
  });
  try {
    const placement = open
      ? await openSurfaceUrl(surface.url)
      : { opened: false, via: "disabled" };
    ready?.({ url: surface.url, origin: surface.origin, port: surface.port });
    const result = await surface.waitForDecision();
    await writeFrame(stdout, frameResult(result));
    return { result, placement, url: surface.url };
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    await surface.stop();
  }
}
