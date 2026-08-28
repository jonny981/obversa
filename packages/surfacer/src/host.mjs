import { spawn } from "node:child_process";

/**
 * Open a surface URL in the selected host's native pane. cmux is the first
 * adapter, reached through the F0 glue script. The fallbacks are the
 * platform browser and, last, printing the URL for the user to open.
 * Diagnostics stay on stderr; stdout belongs to the framed result.
 */
export async function openSurfaceUrl(url, {
  surfaceBin = process.env.OBVERSA_SURFACE_BIN || "obversa-surface",
  // No win32 command lane: appending a URL to cmd /c start is a shell
  // injection vector. Windows prints the URL until a safe launcher lands.
  browserCommand = process.platform === "darwin" ? ["open"]
    : process.platform === "linux" ? ["xdg-open"]
    : null,
  stderr = process.stderr,
  settleMs = PLACEMENT_SETTLE_MS,
} = {}) {
  if (await runDetached(surfaceBin, [url], settleMs)) return { opened: true, via: "host" };
  if (browserCommand) {
    const [browserBin, ...browserArgs] = browserCommand;
    if (await runDetached(browserBin, [...browserArgs, url], settleMs)) return { opened: true, via: "browser" };
  }
  stderr.write(`Open this surface in a browser: ${url}\n`);
  return { opened: false, via: "print" };
}

// A placement command that exits reports whether it succeeded. One that is
// still alive after `settleMs` — a browser that keeps the tab's process — is
// ASSUMED to have opened the surface: that is an assumption made so a live
// placement never holds the session back from waiting for its decision, not
// an observed success, and a command that fails after the settle is reported
// as opened all the same.
const PLACEMENT_SETTLE_MS = 5_000;
function runDetached(command, args, settleMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "ignore", "ignore"] });
    } catch {
      resolve(false);
      return;
    }
    const settled = setTimeout(() => {
      child.unref?.();
      resolve(true);
    }, settleMs);
    settled.unref?.();
    child.once("error", () => { clearTimeout(settled); resolve(false); });
    child.once("exit", (code) => { clearTimeout(settled); resolve(code === 0); });
  });
}
