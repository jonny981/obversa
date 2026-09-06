import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function repositoryVersion(root) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, 'packages', 'runtime', 'package.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('packages/runtime/package.json is missing');
    if (error instanceof SyntaxError) throw new Error('packages/runtime/package.json is not valid JSON');
    throw error;
  }
  if (typeof manifest?.version !== 'string' || !manifest.version.trim()) {
    throw new Error('packages/runtime/package.json must contain a non-empty version string');
  }
  return manifest.version;
}
