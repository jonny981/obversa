#!/usr/bin/env node
// The last step of `pnpm ci:local`, run only once install, verify:d2 and
// check:tarballs have all already passed (the script chains them with &&).
// Its output is what stage:finish trusts instead of re-running the checks.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCiProof, CI_PROOF_PATH } from './ci-proof.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const record = buildCiProof(root);
const proofPath = join(root, CI_PROOF_PATH);
mkdirSync(dirname(proofPath), { recursive: true });
const temporaryPath = `${proofPath}.${process.pid}.tmp`;
writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`);
renameSync(temporaryPath, proofPath);
console.log(`ci proof written for tree ${record.treeHash.slice(0, 12)}: ${proofPath}`);
