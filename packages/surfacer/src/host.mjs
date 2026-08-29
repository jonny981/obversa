import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

/**
 * Open a surface URL in the selected host's native pane. cmux is the first
 * adapter, reached through the F0 glue script. The fallbacks are the
 * platform browser and, last, printing the URL for the user to open.
 * Diagnostics stay on stderr; stdout belongs to the framed result.
 */
export async function openSurfaceUrl(url, {
  // The host placement command is the one the host injected, by absolute
  // path (OBVERSA_SURFACE_BIN). A bare name would be looked up on PATH, and
  // the URL it receives carries the session's bearer token, so an
  // executable placed earlier on PATH could take the token and forge the
  // result; a name that is not an absolute path is not run.
  surfaceBin = process.env.OBVERSA_SURFACE_BIN,
  // No win32 command lane: appending a URL to cmd /c start is a shell
  // injection vector. Windows prints the URL until a safe launcher lands.
  browserCommand = process.platform === "darwin" ? ["open"]
    : process.platform === "linux" ? ["xdg-open"]
    : null,
  stderr = process.stderr,
} = {}) {
  if (typeof surfaceBin === "string" && surfaceBin.length > 0) {
    if (!isAbsolute(surfaceBin)) stderr.write(`OBVERSA_SURFACE_BIN is not an absolute path and is not run: ${surfaceBin}\n`);
    else if (await runDetached(surfaceBin, [url])) return { opened: true, via: "host" };
  }
  if (browserCommand) {
    const [browserBin, ...browserArgs] = browserCommand;
    if (await runDetached(browserBin, [...browserArgs, url])) return { opened: true, via: "browser" };
  }
  stderr.write(`Open this surface in a browser: ${url}\n`);
  return { opened: false, via: "print" };
}

// A placement command that exits reports whether it succeeded. One that is
// still alive after `settleMs` — a browser that keeps the tab's process — is
// ASSUMED to have opened the surface: that is an assumption made so a live
// placement never holds the session back from waiting for its decision, not
// an observed success, and a command that fails after the settle is reported
// as opened all the same. The settle is fixed; `settleMs` exists for this
// module's own test and is not part of the package's public surface.
const PLACEMENT_SETTLE_MS = 5_000;
export function runDetached(command, args, settleMs = PLACEMENT_SETTLE_MS) {
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
