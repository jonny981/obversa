import { spawn } from "node:child_process";

/**
 * Open a surface URL in the selected host's native pane. cmux is the first
 * adapter, reached through the F0 glue script. The fallbacks are the
 * platform browser and, last, printing the URL for the user to open.
 * Diagnostics stay on stderr; stdout belongs to the framed result.
 */
export async function openSurfaceUrl(url, {
  surfaceBin = process.env.OBVERSA_SURFACE_BIN || "obversa-surface",
  browserCommand = process.platform === "darwin" ? ["open"]
    : process.platform === "win32" ? ["cmd", "/c", "start", ""]
    : ["xdg-open"],
  stderr = process.stderr,
} = {}) {
  if (await runDetached(surfaceBin, [url])) return { opened: true, via: "host" };
  const [browserBin, ...browserArgs] = browserCommand;
  if (await runDetached(browserBin, [...browserArgs, url])) return { opened: true, via: "browser" };
  stderr.write(`Open this surface in a browser: ${url}\n`);
  return { opened: false, via: "print" };
}

function runDetached(command, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "ignore", "ignore"] });
    } catch {
      resolve(false);
      return;
    }
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}
