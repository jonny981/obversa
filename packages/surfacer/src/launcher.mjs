import { Writable } from "node:stream";

import { claimFrames } from "./claim-frames.mjs";
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
  const release = () => { for (const [signal, handler] of handlers.splice(0)) process.off(signal, handler); };
  try {
    const placement = open
      ? await openSurfaceUrl(surface.url)
      : { opened: false, via: "disabled" };
    ready?.({ url: surface.url, origin: surface.origin, port: surface.port });
    const result = await surface.waitForDecision();
    // The session is decided: from here the process is a plain writer, and
    // a signal ends it the default way. Keeping the handlers would swallow
    // every signal while a large frame waits on a reader that has stopped
    // taking it, and a session that is over cannot be interrupted anyway.
    release();
    // The frame was produced once, at the claim; it is written verbatim.
    // A claim with no frame (its ending could not be framed) is an error
    // here, never a frame serialised afresh from whatever the result has
    // since become.
    const frame = claimFrames.get(result);
    if (typeof frame !== "string") throw new Error("The session's result was claimed without a frame and cannot be handed off");
    await writeFrame(stdout, frame);
    return { result, placement, url: surface.url };
  } finally {
    release();
    await surface.stop();
  }
}
