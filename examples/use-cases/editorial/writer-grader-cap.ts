import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex-cli';
import {
  briefFromFile,
  formatEvent,
  person,
  run,
  stage,
  workflow,
  type TeamSeat,
} from '@obversa/runtime';

interface EditorialEngines {
  readonly claude: (model: string) => TeamSeat;
  readonly codex: (model: string) => TeamSeat;
}

const realEngines: EditorialEngines = { claude, codex };

/**
 * A writer, a strict grader from another model family, a limit, and an
 * editor. The writer drafts the post. The grader reads it against the house
 * style and returns findings that name the line and the rule; the writer
 * runs again with them. The limit says how many times. When the grader
 * passes the draft, the run stops for the editor, who decides whether it
 * is published. A draft the grader never passes ends the run with the last
 * findings, and nothing is published.
 */
function createEditorial(engines: EditorialEngines = realEngines) {
  return workflow('writer-grader-cap', {
    brief: briefFromFile('briefs/post.md'),
    options: { timeout: '10m' },

    roles: {
      write: engines.claude('claude-sonnet-4-5'),
      grade: [engines.codex('gpt-5.6-luna')],
      editor: person('Publish this post?'),
    },

    stages: [
      stage('draft', {
        agent: 'write',
        writes: 'posts/draft.md',
        desc: 'Write the post from the brief, in the house style.',
        gate: 'The draft holds against every rule in style/house.md, as read by a grader from another model family.',
        reviewedBy: 'grade',
        // The limit. A draft that has not passed after three tries ends
        // the run with the grader's last findings, and the editor is not
        // asked. Raise it for a longer piece; lower it for a caption.
        retry: 3,
      }),

      stage('publish', {
        input: 'editor',
        desc: 'Put the graded draft in front of the editor.',
        gate: 'The editor has said publish.',
        sendsBackTo: 'draft',
      }),
    ],
  });
}

// The review loop watches what changed in the worktree between drafts, so
// the folder is a Git repository. A folder that isn't one yet becomes one.
if (!existsSync('.git')) {
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=editorial', '-c', 'user.email=editorial@example.invalid', ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'the brief and the house style');
}

const result = await run(createEditorial(), {
  onEvent: (event) => console.log(formatEvent(event)),
});
console.log(JSON.stringify(result.outcome, null, 2));
