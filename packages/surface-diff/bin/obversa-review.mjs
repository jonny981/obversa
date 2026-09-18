#!/usr/bin/env node
// The review command. Everything importable lives in src/review-cli.mjs;
// this file only runs it — unconditionally, with no "am I main" guard,
// which once skipped main silently through a symlinked bin install.
//
// Exit codes are set through process.exitCode, never process.exit(): stdout
// and stderr are asynchronous on a pipe, and exiting right after a write can
// cut a large framed result — or the usage text — at the pipe buffer.

import { runReviewCommand } from "../src/review-cli.mjs";

runReviewCommand(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error) => {
    process.stderr.write(`obversa-review: ${error.message}\n`);
    process.exitCode = 1;
  },
);
