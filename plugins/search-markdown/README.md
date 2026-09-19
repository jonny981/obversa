# @obversa/search-markdown

`@obversa/search-markdown` finds matching passages in a local Markdown
directory. It returns the file path and line range for each hit, so a caller
can hand only the selected files to `ground` and then bound them with `curate`.

## Install

```bash
pnpm add @obversa/search-markdown @obversa/runtime
```

## Requirements

- Node.js 22.12 or later

## Read-only corpus

`openMarkdownCorpus` exposes a `memory` property because `ground` reads sources
through the public `Memory` contract. That view is **read-only**: `view` reads
the corpus, while `create`, `str_replace`, `insert`, `delete`, and `rename`
return an error. Search must not edit the source material it is selecting.

Corpus directories and `.md` file names use the same safe path segments as
`MemoryPath`: each segment starts with a letter or number, then uses letters,
numbers, dots, underscores, or hyphens.

## Runnable example

From the workspace root, run:

```bash
pnpm example:search-markdown
```

The complete source is on the
[search-markdown package page](https://docs.obversa.ai/packages/search-markdown).

## License

[MIT](LICENSE)
