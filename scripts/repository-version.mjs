import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function repositoryVersion(root) {
  return JSON.parse(readFileSync(join(root, 'packages', 'runtime', 'package.json'), 'utf8')).version;
}
