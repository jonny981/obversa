import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { DEFAULT_MAX_QUESTION_TEXT, type MemoryCandidate } from './pick.js';
import {
  SourceReadError,
  type CandidateReadRequest,
  type CandidateReadResult,
  type CandidateSource,
} from './source.js';

export interface KnowledgeBaseOptions {
  /** Characters of candidate text the decision model is shown; the same
   *  budget pick's `maxQuestionText` carries. A section longer than this
   *  is offered in parts cut at line ends, so every part is judged. The
   *  read request's own `maxQuestionText`, filled by `pickFromSources`
   *  from the pick limits, tightens the cut further. */
  readonly maxQuestionText?: number;
}
const TOKEN = /[\p{L}\p{N}]+/gu;
const CODE_FORM = /[@\w./-]*[./@][\w./-]+|[a-z]+[A-Z]\w+|`[^`]+`/g;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;
const SECTION_BREAK = /\n(?=## )/g;
const HEADING = /^#{1,6} +(.+)$/m;
const FIELD = /^([A-Za-z_][\w-]*):\s*(.+?)\s*$/;
// A note declares it has been replaced through a frontmatter match or a
// marker in the first characters of its body; a negative signal, not
// removal.
const REPLACED_WORDS = '(superseded|retired|deprecated|obsolete|withdrawn)';
const REPLACED_FRONTMATTER = new RegExp(`\\b${REPLACED_WORDS}\\b`, 'i');
const REPLACED_LINE = new RegExp(`^>?\\s*\\**${REPLACED_WORDS}\\b`, 'im');
const LINK = /\[\[([^\]|#]+)|\]\(([^)#]+\.md)\b[^)]*\)/g;
const STOP = new Set([
  'about', 'after', 'agent', 'and', 'answers', 'are', 'before', 'change',
  'context', 'every', 'for', 'into', 'not', 'only', 'question', 'should',
  'that', 'the', 'their', 'there', 'these', 'this', 'what', 'when', 'where',
  'which', 'with', 'would', 'you',
]);
const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** Characters of a note's body scanned for a replaced marker. */
const FIRST_CHARACTERS = 400;
const DATE_FIELDS: ReadonlyArray<readonly [string, 'recorded' | 'effective']> = [
  ['date', 'recorded'],
  ['written', 'recorded'],
  ['effective', 'effective'],
  ['applies-from', 'effective'],
];

function tokenize(value: string): readonly string[] {
  return value.normalize('NFKC').toLowerCase().match(TOKEN) ?? [];
}

function taskTerms(task: string, paths: readonly string[] = []): readonly string[] {
  const words = new Set<string>();
  const add = (value: string) => {
    for (const token of tokenize(value)) {
      if (token.length > 2 && !STOP.has(token)) words.add(token);
    }
  };
  for (const word of task.toLowerCase().split(/[^a-z0-9-]+/)) add(word);
  for (const form of task.match(CODE_FORM) ?? []) add(form.replace(/`/g, ''));
  for (const part of paths.flatMap((path) => path.split('/'))) {
    if (part.length >= 4) add(part);
  }
  return [...words];
}

function hits(text: string, terms: readonly string[]): number {
  const words = new Set(tokenize(text));
  return terms.filter((term) => words.has(term)).length;
}

interface Walked {
  readonly files: readonly string[];
  /** Entries that looked like content but were not walked or read; each
   *  a symbolic link. Skipped items make the read incomplete. */
  readonly skipped: number;
}

async function walkMarkdown(
  root: string,
  signal: AbortSignal | undefined,
  exclude: ReadonlySet<string>,
): Promise<Walked> {
  const files: string[] = [];
  let skipped = 0;
  async function walk(directory: string): Promise<void> {
    if (signal?.aborted) throw new SourceReadError('cancelled', 'The read was cancelled.');
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw new SourceReadError('failed', `Could not list ${directory}: ${message(error)}`);
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      if (isExcluded(path, root, exclude)) continue;
      if (entry.isSymbolicLink()) {
        skipped += 1;
      } else if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(path);
      }
    }
  }
  await walk(root);
  return { files, skipped };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isExcluded(path: string, root: string, exclude: ReadonlySet<string>): boolean {
  if (exclude.size === 0) return false;
  const within = relative(root, path).split(sep).join('/');
  const fromCwd = relative(process.cwd(), path).split(sep).join('/');
  for (const entry of exclude) {
    if (path === entry || path.startsWith(`${entry}${sep}`)) return true;
    if (within === entry || within.startsWith(`${entry}/`)) return true;
    if (fromCwd === entry || fromCwd.startsWith(`${entry}/`)) return true;
  }
  return false;
}

interface Note {
  readonly fields: ReadonlyMap<string, string>;
  readonly frontmatter: string;
  readonly body: string;
  /** File lines the frontmatter block occupies; body line 1 sits this
   *  many lines into the file. */
  readonly bodyOffset: number;
}

function parseNote(raw: string): Note {
  const match = FRONTMATTER.exec(raw);
  if (!match) return { fields: new Map(), frontmatter: '', body: raw, bodyOffset: 0 };
  const frontmatter = match[1] ?? '';
  const fields = new Map<string, string>();
  for (const line of frontmatter.split(/\r?\n/)) {
    const field = FIELD.exec(line);
    if (field) fields.set(field[1]!.toLowerCase(), field[2]!.replace(/^(['"])(.*)\1$/, '$2'));
  }
  return {
    fields,
    frontmatter,
    body: raw.slice(match[0].length),
    bodyOffset: (match[0].match(/\n/g)?.length ?? 0),
  };
}

function declaredDate(fields: ReadonlyMap<string, string>): MemoryCandidate['date'] {
  for (const [name, meaning] of DATE_FIELDS) {
    const value = fields.get(name);
    if (value !== undefined && value !== '') return { value, meaning };
  }
  return undefined;
}

interface Section {
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly heading?: string;
}

function sections(body: string, bodyOffset: number): readonly Section[] {
  const starts = [0];
  for (const match of body.matchAll(SECTION_BREAK)) starts.push(match.index + 1);
  starts.push(body.length);
  const result: Section[] = [];
  for (let index = 0; index < starts.length - 1; index += 1) {
    const text = body.slice(starts[index], starts[index + 1]);
    if (text.trim() === '') continue;
    const before = body.slice(0, starts[index]);
    const startLine = bodyOffset + (before.match(/\n/g)?.length ?? 0) + 1;
    const endLine = startLine + (text.match(/\n/g)?.length ?? 0) - (text.endsWith('\n') ? 1 : 0);
    const heading = HEADING.exec(text)?.[1]?.trim();
    result.push({ text, startLine, endLine, ...(heading === undefined ? {} : { heading }) });
  }
  return result;
}

/** Cut text into parts of at most `limit` characters at line ends, so the
 *  parts joined exactly reproduce the text. A single line longer than the
 *  limit is hard-cut; every part must still be judged. */
function splitParts(text: string, limit: number): readonly string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    const windowEnd = Math.min(start + limit, text.length);
    if (windowEnd === text.length) {
      parts.push(text.slice(start));
      break;
    }
    const newline = text.lastIndexOf('\n', windowEnd - 1);
    const end = newline > start ? newline + 1 : windowEnd;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

function bm25Scores(docs: readonly string[], terms: readonly string[]): readonly number[] {
  const count = docs.length;
  const tokens = docs.map(tokenize);
  const lengths = tokens.map((doc) => doc.length);
  const avgLength = count === 0 ? 0 : lengths.reduce((sum, n) => sum + n, 0) / count;
  if (avgLength === 0) return docs.map(() => 0);
  const documentFrequency = new Map<string, number>();
  for (const doc of tokens) {
    const seen = new Set(doc);
    for (const term of terms) {
      if (seen.has(term)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  return tokens.map((doc, index) => {
    const counts = new Map<string, number>();
    for (const token of doc) counts.set(token, (counts.get(token) ?? 0) + 1);
    let score = 0;
    for (const term of terms) {
      const n = documentFrequency.get(term) ?? 0;
      const f = counts.get(term) ?? 0;
      if (n === 0 || f === 0) continue;
      const idf = Math.log(1 + (count - n + 0.5) / (n + 0.5));
      score += idf * (f * (BM25_K1 + 1))
        / (f + BM25_K1 * (1 - BM25_B + BM25_B * (lengths[index]! / avgLength)));
    }
    return score;
  });
}

function withBm25(
  candidates: readonly MemoryCandidate[],
  terms: readonly string[],
): MemoryCandidate[] {
  const scores = bm25Scores(candidates.map((candidate) => candidate.text), terms);
  return candidates.map((candidate, index) =>
    scores[index] === 0
      ? candidate
      : { ...candidate, signals: { ...candidate.signals, bm25: scores[index]! } });
}

interface ReadState {
  readonly root: string;
  readonly files: readonly string[];
  readonly skipped: number;
}

/** Resolve the directory, refuse a pinned revision the working tree
 *  cannot resolve (this slice does no Git reads, so no revision can be
 *  honoured, 'HEAD' included), and enumerate its Markdown files without
 *  opening content. An excluded entry is refused here, before its file is
 *  ever read. */
async function openDirectory(
  directory: string,
  request: CandidateReadRequest,
): Promise<ReadState | CandidateReadResult> {
  if (request.revision !== undefined) {
    return {
      status: 'absent',
      reason: 'a working-tree Markdown read cannot resolve a pinned revision',
    };
  }
  if (request.signal?.aborted) throw new SourceReadError('cancelled', 'The read was cancelled.');
  let root: string;
  try {
    root = await realpath(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { status: 'absent', reason: `there is no directory at ${directory}` };
    }
    throw new SourceReadError('failed', `Could not resolve ${directory}: ${message(error)}`);
  }
  let stat;
  try {
    stat = await lstat(root);
  } catch (error) {
    throw new SourceReadError('failed', `Could not inspect ${directory}: ${message(error)}`);
  }
  if (!stat.isDirectory()) {
    return { status: 'absent', reason: `${directory} is not a directory` };
  }
  // Exclusion is resolved before any file's content is opened: each entry
  // is matched as a real path (the walk's paths are realpath'd), as the
  // lexical absolute form the caller would write, and as a path relative
  // to the source root or the working directory.
  const exclude = new Set<string>();
  for (const entry of request.exclude ?? []) {
    if (typeof entry !== 'string' || entry.trim() === '') continue;
    const absolute = resolve(entry);
    exclude.add(absolute);
    try {
      exclude.add(await realpath(absolute));
    } catch {
      // An excluded path that does not exist still matches its relative forms.
    }
    const cleaned = entry.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (cleaned !== '') exclude.add(cleaned);
  }
  const { files, skipped } = await walkMarkdown(root, request.signal, exclude);
  return { root, files, skipped };
}

async function readTexts(
  state: ReadState,
  signal: AbortSignal | undefined,
): Promise<ReadonlyMap<string, Note>> {
  const notes = new Map<string, Note>();
  for (const file of state.files) {
    if (signal?.aborted) throw new SourceReadError('cancelled', 'The read was cancelled.');
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      throw new SourceReadError('failed', `Could not read ${file}: ${message(error)}`);
    }
    notes.set(file, parseNote(raw));
  }
  return notes;
}

function finish(
  request: CandidateReadRequest,
  candidates: MemoryCandidate[],
  skipped: number,
): CandidateReadResult {
  candidates.sort((left, right) => {
    const score = (candidate: MemoryCandidate) =>
      Object.values(candidate.signals).reduce((sum, value) => sum + value, 0);
    return score(right) - score(left) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  });
  const limit = request.limit;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new TypeError('limit must be a positive safe integer.');
  }
  const reasons: string[] = [];
  let emitted = candidates;
  if (limit !== undefined && candidates.length > limit) {
    emitted = candidates.slice(0, limit);
    reasons.push(`the limit kept ${limit} of ${candidates.length} candidates`);
  }
  if (skipped > 0) reasons.push(`skipped ${skipped} symbolic-link ${skipped === 1 ? 'entry' : 'entries'}`);
  return {
    status: 'read',
    candidates: emitted,
    complete: reasons.length === 0,
    ...(reasons.length === 0 ? {} : { partial: reasons.join('; ') }),
  };
}

/**
 * A knowledge base of Markdown notes: one candidate per `## ` section of
 * each `.md` file, every candidate role 'reference'. A note cannot declare
 * itself a rule; frontmatter `applies` is never honoured here.
 *
 * Signals: BM25 over the task's words against this source's own
 * candidates, words shared with the heading and with the file name and
 * frontmatter, a path the task names appearing in the text, inbound
 * `[[wiki]]` and relative `.md` links from other notes, and a negative
 * signal when the note says it was replaced.
 */
export function knowledgeBase(
  directory: string,
  options: KnowledgeBaseOptions = {},
): CandidateSource {
  if (typeof directory !== 'string' || directory.trim() === '') {
    throw new TypeError('directory must be a non-empty string.');
  }
  const maxQuestionText = options.maxQuestionText ?? DEFAULT_MAX_QUESTION_TEXT;
  if (!Number.isSafeInteger(maxQuestionText) || maxQuestionText < 1) {
    throw new TypeError('maxQuestionText must be a positive safe integer.');
  }
  const resolved = resolve(directory);
  return {
    id: `knowledge-base:${resolved}`,
    role: 'reference',
    async read(request) {
      const state = await openDirectory(resolved, request);
      if ('status' in state) return state;
      const notes = await readTexts(state, request.signal);
      const terms = taskTerms(request.task, request.paths ?? []);
      const paths = request.paths ?? [];
      if (request.maxQuestionText !== undefined
        && (!Number.isSafeInteger(request.maxQuestionText) || request.maxQuestionText < 1)) {
        throw new TypeError('maxQuestionText must be a positive safe integer.');
      }
      const partBudget = Math.min(maxQuestionText, request.maxQuestionText ?? maxQuestionText);

      // Inbound links count by the target's full path inside the source,
      // so two notes that share a file name in different folders stay
      // distinct and a link between them is not mistaken for a
      // self-link. A relative `.md` link resolves against the linking
      // note's folder. A `[[wiki]]` link names a note, not a neighbour:
      // it resolves by its path from the source root, or by a unique
      // file of that name anywhere in the source when the root path
      // matches nothing.
      const inbound = new Map<string, number>();
      const notePaths = new Set<string>();
      const notesByName = new Map<string, string[]>();
      for (const file of notes.keys()) {
        const name = relative(state.root, file).split(sep).join('/');
        notePaths.add(name);
        const leaf = name.slice(name.lastIndexOf('/') + 1);
        const same = notesByName.get(leaf);
        if (same === undefined) notesByName.set(leaf, [name]);
        else same.push(name);
      }
      for (const [file, note] of notes) {
        const from = relative(state.root, file).split(sep).join('/');
        for (const match of note.body.matchAll(LINK)) {
          const raw = (match[1] ?? match[2] ?? '').trim();
          if (raw === '') continue;
          let target: string | undefined;
          if (match[1] === undefined) {
            target = relative(state.root, resolve(dirname(file), raw)).split(sep).join('/');
            if (target.startsWith('..')) continue;
          } else {
            const linked = raw.endsWith('.md') ? raw : `${raw}.md`;
            const rooted = relative(state.root, resolve(state.root, linked)).split(sep).join('/');
            if (notePaths.has(rooted)) {
              target = rooted;
            } else {
              const same = notesByName.get(linked.slice(linked.lastIndexOf('/') + 1));
              target = same?.length === 1 ? same[0] : undefined;
            }
          }
          if (target === undefined || target === from) continue;
          inbound.set(target, (inbound.get(target) ?? 0) + 1);
        }
      }

      const candidates: MemoryCandidate[] = [];
      for (const [file, note] of notes) {
        if (request.signal?.aborted) throw new SourceReadError('cancelled', 'The read was cancelled.');
        const name = relative(state.root, file).split(sep).join('/');
        const replaced = REPLACED_FRONTMATTER.test(note.frontmatter)
          || REPLACED_LINE.test(note.body.slice(0, FIRST_CHARACTERS));
        const date = declaredDate(note.fields);
        for (const [sectionIndex, section] of sections(note.body, note.bodyOffset).entries()) {
          const parts = splitParts(section.text, partBudget);
          for (const [partIndex, text] of parts.entries()) {
            const heading = section.heading ?? basename(file);
            const signals: Record<string, number> = {};
            const headingHits = hits(heading, terms);
            if (headingHits > 0) signals['heading-words'] = Math.min(2, headingHits * 2);
            const fileHits = hits(`${name} ${note.frontmatter}`, terms);
            if (fileHits > 0) signals['file-words'] = Math.min(1, fileHits);
            if (paths.some((path) => text.includes(path))) signals['names-path'] = 3;
            const linked = inbound.get(name) ?? 0;
            if (linked > 0) signals['inbound-links'] = Math.min(1, Math.log10(1 + linked));
            if (replaced) signals['replaced'] = -2;
            candidates.push({
              sourceId: `knowledge-base:${resolved}`,
              role: 'reference',
              id: parts.length === 1 ? `${name}#${sectionIndex + 1}` : `${name}#${sectionIndex + 1}.${partIndex + 1}`,
              title: parts.length === 1 ? `${name}: ${heading}` : `${name}: ${heading} (part ${partIndex + 1})`,
              text,
              contentRef: `${name}#L${section.startLine}-L${section.endLine}`,
              ...(date === undefined ? {} : { date }),
              signals,
            });
          }
        }
      }

      return finish(request, withBm25(candidates, terms), state.skipped);
    },
  };
}

/**
 * A folder of workflow rules: one candidate per `.md` file, every
 * candidate role 'rule', the folder's `README.md` excluded. Frontmatter
 * `applies: always` is carried onto the candidate so pick selects the
 * rule without asking. This is the only source that emits role 'rule'.
 */
export function rules(directory: string): CandidateSource {
  if (typeof directory !== 'string' || directory.trim() === '') {
    throw new TypeError('directory must be a non-empty string.');
  }
  const resolved = resolve(directory);
  return {
    id: `rules:${resolved}`,
    role: 'rule',
    async read(request) {
      const state = await openDirectory(resolved, request);
      if ('status' in state) return state;
      const files = state.files.filter((file) => basename(file).toLowerCase() !== 'readme.md');
      const notes = await readTexts({ ...state, files }, request.signal);
      const terms = taskTerms(request.task, request.paths ?? []);
      const paths = request.paths ?? [];

      const candidates: MemoryCandidate[] = [];
      for (const [file, note] of notes) {
        const name = relative(state.root, file).split(sep).join('/');
        const signals: Record<string, number> = {};
        if (paths.some((path) => note.body.includes(path))) signals['names-path'] = 3;
        const date = declaredDate(note.fields);
        candidates.push({
          sourceId: `rules:${resolved}`,
          role: 'rule',
          id: name,
          title: name,
          text: note.body,
          contentRef: name,
          ...(note.fields.get('applies') === 'always' ? { applies: 'always' as const } : {}),
          ...(date === undefined ? {} : { date }),
          signals,
        });
      }

      return finish(request, withBm25(candidates, terms), state.skipped);
    },
  };
}
