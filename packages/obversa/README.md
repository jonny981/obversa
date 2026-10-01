# @obversa/obversa

Install the bundled Obversa packages with one dependency.

```bash
npm install @obversa/obversa
```

The individual packages stay separately importable. Import the runtime,
the bundled engines, memory adapters, surfaces, notifications, or
ready-made workflows from their own package names. Not every available
engine is bundled. The Jev and Mastra engines install separately:
`npm install @obversa/engine-jev-api`, and
`npm install @obversa/engine-mastra @mastra/core`.

This package has no runtime API of its own.

The docs list every public package, including ones this package does not
install, at [docs.obversa.ai/packages/obversa](https://docs.obversa.ai/packages/obversa).
