import { createGitWorktreeProvider } from '@obversa/runtime';

const workspace = createGitWorktreeProvider({ repositoryPath: process.cwd() });
const anchor = await workspace.capture();
const result = await workspace.verify(anchor);
console.log(JSON.stringify({ head: anchor.head, verified: result.ok }));
