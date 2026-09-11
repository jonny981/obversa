import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { checkFirstPageClaims } from './check-first-page-claims.mjs';

const claims = [{ page: 'a.mdx', phrases: ['process at every layer', 'Inference belongs mostly at the leaves'] }];

function site(pages) {
  const dir = mkdtempSync(join(tmpdir(), 'first-page-claims-'));
  for (const [name, body] of Object.entries(pages)) {
    const path = join(dir, 'docs', 'public', name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  return dir;
}

test('a page that carries every phrase passes', () => {
  const dir = site({ 'a.mdx': 'It models process at every layer.\n\nInference belongs mostly at the leaves.\n' });
  try { assert.deepEqual(checkFirstPageClaims(dir, claims), []); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a page that lost one phrase is reported by that phrase, and the others still count', () => {
  const dir = site({ 'a.mdx': 'It models process at every layer.\n' });
  try {
    const failures = checkFirstPageClaims(dir, claims);
    assert.deepEqual(failures, ['a.mdx: no longer says "Inference belongs mostly at the leaves"']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a missing page is one failure that says so', () => {
  const dir = site({});
  try {
    const failures = checkFirstPageClaims(dir, claims);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /the page is missing/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a phrase that wraps across a line break still counts', () => {
  const dir = site({ 'a.mdx': 'It models process at every\nlayer.\n\nInference belongs mostly at\nthe leaves.\n' });
  try { assert.deepEqual(checkFirstPageClaims(dir, claims), []); } finally { rmSync(dir, { recursive: true, force: true }); }
});
