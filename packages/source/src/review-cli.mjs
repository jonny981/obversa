// The review command, importable: parse the arguments, wire the surfacer's
// launch port and client kit to reviewDiff, run one review, report on
// stderr, and return the exit code. The bin file calls this unconditionally;
// a router plugin reaches it through the package's ./bin subpath export.
//
// The package reaches itself by its own public name — Node resolves
// "@obversa/source" from inside the package through its exports map — so
// even the command consumes only what the package exports, and a disposable
// consumer with stub packages in node_modules decides resolution the same
// way a real install does.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { runSurface } from "@obversa/surfacer";
import { reviewDiff } from "@obversa/source";
import { HELP, parseArgs } from "./review-args.mjs";

/**
 * Run the review command once. Writes to the real process streams; the exit
 * code is returned, never set here, so an importer stays in charge of its
 * process. Placement is the host's concern: the host injects
 * OBVERSA_SURFACE_BIN (its glue wrapper defaults it to the placement script
 * beside itself), and the surfacer reads it.
 *
 * @param {string[]} argv
 * @returns {Promise<number>} the exit code
 */
export async function runReviewCommand(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  // The client kit the page loads, as the surfacer exports it — resolved
  // under the `import` condition, the one the browser's module import
  // matches, not the `require` condition a createRequire lookup would follow.
  const clientKitSource = await readFile(
    fileURLToPath(import.meta.resolve("@obversa/surfacer/client")),
    "utf8",
  );

  const { status, result, meta } = await reviewDiff({
    mode: options.mode,
    range: options.range,
    cwd: options.cwd,
    app: options.app,
    open: options.open,
    // With --no-open the surface is not placed in a pane, so the URL is the
    // only way to reach it: print it once the session is up.
    ready: options.open ? undefined : ({ url }) => process.stderr.write(`Open the review surface at: ${url}\n`),
    launchSurface: runSurface,
    clientKitSource,
  });

  if (status === "completed") {
    const count = result.annotations.length;
    process.stderr.write(`Review of the ${meta.label} finished: ${result.decision}, ${count} annotation${count === 1 ? "" : "s"} returned.\n`);
    return 0;
  }
  const outcome = result ? `${result.decision}` : "no result";
  process.stderr.write(`Review of the ${meta.label} ended without the reviewer returning (${status}: ${outcome}).\n`);
  return 1;
}
