// The ownership preflight for the skill-install helper: every refusal branch
// is a failure assertion against a fixture home, and the CLI argv shapes are
// pinned. No real skills CLI runs here — the runner is injected and records.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { cliArguments, folderHash, ownershipFailure, paths, preflight, runHelper, sameSource, SKILL } from "./skill-install.mjs";

const SOURCE = "https://github.com/example/obversa.git";

function home() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "skill-install-")));
  return { directory, at: paths(directory) };
}

function owned({ directory, at }) {
  mkdirSync(at.canonical, { recursive: true });
  writeFileSync(join(at.canonical, "SKILL.md"), "---\nname: review-diff\n---\n");
  mkdirSync(dirname(at.claude), { recursive: true });
  symlinkSync(join("..", "..", ".agents", "skills", SKILL), at.claude);
  writeFileSync(at.lock, JSON.stringify({ skills: { [SKILL]: { source: SOURCE, skillFolderHash: folderHash(at.canonical) } } }));
  return { directory, at };
}

test("ownership holds only when the lock, the hash, and the symlink all agree", () => {
  const fixture = owned(home());
  try {
    assert.equal(ownershipFailure(SOURCE, fixture.at), null);
    assert.match(ownershipFailure("https://example.com/other.git", fixture.at), /source is/);
    writeFileSync(join(fixture.at.canonical, "SKILL.md"), "tampered\n");
    assert.match(ownershipFailure(SOURCE, fixture.at), /directory hash/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("a Claude Code path that is a real directory, not a symlink, breaks ownership", () => {
  const fixture = owned(home());
  try {
    rmSync(fixture.at.claude);
    mkdirSync(fixture.at.claude, { recursive: true });
    assert.match(ownershipFailure(SOURCE, fixture.at), /not a symlink/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("add on a clean home proceeds; add over a foreign install refuses before the CLI runs", () => {
  const clean = home();
  const foreign = home();
  try {
    assert.equal(preflight("add", SOURCE, clean.at), null);
    // A same-name skill someone else installed: a directory with no lock.
    mkdirSync(foreign.at.canonical, { recursive: true });
    writeFileSync(join(foreign.at.canonical, "SKILL.md"), "someone else's\n");
    assert.match(preflight("add", SOURCE, foreign.at), /add refused: .*no lock entry/);
    assert.match(preflight("update", SOURCE, foreign.at), /update refused/);
    const calls = [];
    const result = runHelper("add", SOURCE, { at: foreign.at, run: (args) => { calls.push(args); return { status: 0 }; } });
    assert.equal(result.status, 1, "the refusal is the exit");
    assert.deepEqual(calls, [], "the CLI never ran");
  } finally {
    rmSync(clean.directory, { recursive: true, force: true });
    rmSync(foreign.directory, { recursive: true, force: true });
  }
});

test("remove requires full ownership; with it, the exact remove command runs", () => {
  const fixture = owned(home());
  const bare = home();
  try {
    assert.match(preflight("remove", SOURCE, bare.at), /remove refused/);
    const calls = [];
    const result = runHelper("remove", SOURCE, { at: fixture.at, run: (args) => { calls.push(args); return { status: 0 }; } });
    assert.equal(result.status, 0);
    assert.deepEqual(calls, [["-y", "skills@1.5.17", "remove", SKILL, "--global", "--agent", "claude-code", "codex"]]);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
    rmSync(bare.directory, { recursive: true, force: true });
  }
});

test("a GitHub-recorded install owns: normalized source, tree-hash entry, structural copy", () => {
  // skills 1.5.17 records a GitHub add as normalized owner/repo with a git
  // tree hash (40 hex) no local walk can recompute; the preflight must
  // accept exactly the records the pinned CLI writes.
  const fixture = home();
  try {
    mkdirSync(fixture.at.canonical, { recursive: true });
    writeFileSync(join(fixture.at.canonical, "SKILL.md"), "---\nname: review-diff\n---\n");
    mkdirSync(dirname(fixture.at.claude), { recursive: true });
    symlinkSync(join("..", "..", ".agents", "skills", SKILL), fixture.at.claude);
    writeFileSync(fixture.at.lock, JSON.stringify({ skills: { [SKILL]: { source: "example/obversa", sourceType: "github", skillFolderHash: "a".repeat(40) } } }));
    assert.equal(ownershipFailure("https://github.com/example/obversa.git", fixture.at), null, "the URL form matches the normalized record");
    assert.equal(ownershipFailure("git@github.com:Example/Obversa", fixture.at), null, "the ssh form and case match too");
    assert.match(ownershipFailure("https://github.com/other/repo", fixture.at), /source is/);
    rmSync(join(fixture.at.canonical, "SKILL.md"));
    assert.match(ownershipFailure("example/obversa", fixture.at), /no SKILL\.md/, "a tree-hash entry still needs the copy's content");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("a malformed hash record is refused, not treated as structural", () => {
  const fixture = owned(home());
  try {
    const lockBody = { skills: { [SKILL]: { source: SOURCE, skillFolderHash: "zz-not-a-hash" } } };
    writeFileSync(fixture.at.lock, JSON.stringify(lockBody));
    assert.match(ownershipFailure(SOURCE, fixture.at), /neither the CLI's sha256 nor a git tree hash/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("source forms normalize like the CLI's record", () => {
  assert.equal(sameSource("example/obversa", "https://github.com/example/obversa.git"), true);
  assert.equal(sameSource("/some/local/checkout", "/some/local/checkout"), true);
  assert.equal(sameSource("/some/local/checkout", "/other/checkout"), false);
});

test("the add and update argv is the one pinned command line", () => {
  assert.deepEqual(
    cliArguments("add", SOURCE),
    ["-y", "skills@1.5.17", "add", SOURCE, "--skill", SKILL, "--global", "--agent", "claude-code", "codex", "--full-depth", "--yes"],
  );
  assert.deepEqual(cliArguments("update", SOURCE), cliArguments("add", SOURCE), "update is the same pinned add, never skills update");
});
