import { frameResult } from "./handoff.mjs";
import { openSurfaceUrl } from "./host.mjs";
import { startSurface } from "./server.mjs";

/**
 * The one launcher: start the session, place the page in the selected
 * host, wait for the single decision, shut down, and frame the result on
 * stdout. Signals interrupt the session cleanly. `ready` receives the
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
    stdout.write(frameResult(result));
    return { result, placement, url: surface.url };
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    await surface.stop();
  }
}
