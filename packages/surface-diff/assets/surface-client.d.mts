// Types only. The surfacer serves ./surface-client.mjs over HTTP at runtime,
// so no JavaScript file sits beside the page source; this declaration gives
// the compiler the served kit's contract. The dependency-cruiser config and
// the ESLint ignores carry the same fact for their tools.

export function createSurfaceClient(options?: { heartbeatMs?: number }): {
  api: (endpoint: string, body?: unknown) => Promise<any>;
  submit: (endpoint: string, payload: unknown) => Promise<void>;
  cancel: () => Promise<void>;
  dispose: () => void;
};
