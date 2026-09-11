// The package-arrow authority.
// dependency-cruiser proves every static arrow between packages: static import,
// re-export, static dynamic import, require, package-import alias, public
// subpath. Expression imports, reflection, and generated code are out of its
// scope and stated as residuals. Every rule is an error, never a
// warning. The pass/fail fixture matrix lives in scripts/check-arrows.spec.mjs
// and proves each rule fires on the form it names.
//
// Resolution honours each package's `exports` map under ESM conditions, so a
// deep import of another package's internals by name fails to resolve and the
// no-unresolvable rule reports it: the exports map itself is the public-subpath
// gate. Type-only imports are included (tsPreCompilationDeps).

const testPath = ['\\.(test|spec)\\.[^/]+$', '(^|/)tests?/'];

module.exports = {
  options: {
    doNotFollow: { path: '(^|/)node_modules/|^(packages|plugins)/[^/]+/dist/' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
  forbidden: [
    {
      name: 'no-unresolvable',
      comment:
        'every static dependency must resolve; a name that does not resolve is a missing declaration, a deep import past an exports map, or a package-import alias no manifest defines',
      severity: 'error',
      from: { pathNot: '^examples/' },
      to: {
        couldNotResolve: true,
        // The browser page imports ./surface-client.mjs as a URL; the
        // surfacer serves that module over HTTP at runtime, so it has no
        // file beside the page source. This exact specifier only.
        pathNot: '^\\./surface-client\\.mjs$',
      },
    },
    {
      name: 'no-unresolvable-example',
      comment:
        'examples resolve at run time relative to the workspace package that runs them, so the real package roots are unresolvable from here statically — those exact names and their subpaths only. A misspelt or unknown name is an error like anywhere else',
      severity: 'error',
      from: { path: '^examples/' },
      to: {
        couldNotResolve: true,
        pathNot: '^@obversa/(engine|engine-agent-sdk|engine-anthropic-api|engine-claude-cli|engine-codex|engine-grok-cli|engine-opencode-cli|memory|memory-git|memory-simple|process|runner|runtime|source|surfacer)(/|$)',
      },
    },
    {
      name: 'no-circular',
      comment: 'no dependency cycles, within or between packages',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-undeclared-external',
      comment:
        'an external module that ships must be declared in the nearest package manifest; reaching a root tool through parent lookup is an incidental arrow the manifest never claimed. tests are exempt: they never ship, and the shared test runner is a workspace tool the root provides',
      severity: 'error',
      from: { path: '^(packages|plugins|hosts)/', pathNot: testPath },
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
    },
    {
      name: 'no-dev-dep-from-prod',
      comment: 'production code cannot import a dependency declared only for development',
      severity: 'error',
      from: { path: '^(packages|plugins|hosts)/[^/]+/(src|lib|bin|assets)/' },
      to: { dependencyTypes: ['npm-dev'] },
    },
    {
      name: 'no-test-from-prod',
      comment: 'production code cannot import tests',
      severity: 'error',
      from: { path: '^(packages|plugins|hosts)/', pathNot: testPath },
      to: { path: testPath },
    },
    {
      name: 'no-cross-package-test-import',
      comment:
        'a test that reaches into another package must use that package public testing subpath, never its test files; a test importing its own package is unchanged',
      severity: 'error',
      from: { path: '^(?:packages|plugins)/([^/]+)/' },
      to: { path: testPath, pathNot: '^(?:packages|plugins)/$1/' },
    },
    {
      name: 'no-cross-package-internal-path',
      comment:
        'a cross-package import uses the @obversa package name and an exported subpath; a relative, absolute, or aliased path into a sibling package bypasses its public surface',
      severity: 'error',
      from: { path: '^packages/([^/]+)/' },
      to: { path: '^(packages/(?!$1/)|plugins/|hosts/)', dependencyTypes: ['local', 'aliased'] },
    },
    {
      name: 'no-cross-plugin-internal-path',
      comment:
        'a plugin reaches interfaces through their public names and never reaches a package or sibling plugin by path',
      severity: 'error',
      from: { path: '^plugins/([^/]+)/' },
      to: { path: '^(plugins/(?!$1/)|packages/|hosts/)', dependencyTypes: ['local', 'aliased'] },
    },
    {
      name: 'no-host-internal-path',
      comment: 'a host takes packages by their public names, never by path',
      severity: 'error',
      from: { path: '^hosts/' },
      to: { path: '^(packages|plugins)/', dependencyTypes: ['local', 'aliased'] },
    },
    {
      name: 'no-script-internal-path',
      comment: 'scripts and examples consume public exports only',
      severity: 'error',
      from: { path: '^(scripts|examples)/' },
      to: { path: '^(packages|plugins|hosts)/', dependencyTypes: ['local', 'aliased'] },
    },
    {
      name: 'no-package-to-host',
      comment: 'no package reaches a host; a host is a composition root, not a dependency',
      severity: 'error',
      from: { path: '^(packages|plugins)/' },
      to: { path: '^hosts/' },
    },
    // The arrow matrix. Each package names the packages it may reach; every
    // other cross-package arrow is an error whatever form it takes.
    {
      name: 'engine-reaches-no-package',
      comment: '@obversa/engine is a contract package; it reaches no other package or plugin',
      severity: 'error',
      from: { path: '^packages/engine/' },
      to: { path: '^(packages|plugins)/', pathNot: '^packages/(engine|process)/' },
    },
    {
      name: 'process-reaches-no-package',
      comment: '@obversa/process is dependency-free infrastructure; it reaches no other package or plugin',
      severity: 'error',
      from: { path: '^packages/process/' },
      to: { path: '^(packages|plugins)/', pathNot: '^packages/process/' },
    },
    {
      name: 'memory-reaches-no-package',
      comment: '@obversa/memory is a contract package; it reaches no other package or plugin',
      severity: 'error',
      from: { path: '^packages/memory/' },
      to: { path: '^(packages|plugins)/', pathNot: '^packages/memory/' },
    },
    {
      name: 'surfacer-reaches-no-package',
      comment: '@obversa/surfacer reaches no @obversa package',
      severity: 'error',
      from: { path: '^packages/surfacer/' },
      to: { path: '^(packages|plugins)/', pathNot: '^packages/surfacer/' },
    },
    {
      name: 'source-reaches-surfacer-only',
      comment:
        '@obversa/source carries the review command, which injects the surfacer launch port itself: the one flipped arrow. It reaches nothing else',
      severity: 'error',
      from: { path: '^packages/source/' },
      to: { path: '^(packages|plugins)/', pathNot: '^packages/(source|surfacer)/' },
    },
    {
      name: 'runtime-reaches-interfaces-only',
      comment: 'the runtime reaches only the engine and memory interfaces; never a provider plugin or surface',
      severity: 'error',
      from: { path: '^packages/runtime/' },
      to: { path: '^(packages|plugins)/', pathNot: '^packages/(runtime|engine|memory|process)/' },
    },
    {
      name: 'runner-reaches-runtime-and-engine-only',
      comment: 'the runner supervises through public runtime and engine APIs; it never reaches an adapter or another package',
      severity: 'error',
      from: { path: '^packages/runner/' },
      to: { path: '^(packages|plugins)/', pathNot: '^packages/(runner|runtime|engine)/' },
    },
    {
      name: 'memory-plugin-reaches-memory-only',
      comment: 'a memory plugin reaches only the memory interface and its own files',
      severity: 'error',
      from: { path: '^plugins/(memory-(?:git|simple))/' },
      to: { path: '^(packages|plugins)/', pathNot: '^(plugins/$1/|packages/(memory|process)/)' },
    },
    {
      name: 'agent-sdk-plugin-reaches-interfaces-only',
      comment: 'the Agent SDK plugin reaches the engine and memory interfaces only',
      severity: 'error',
      from: { path: '^plugins/engine-agent-sdk/' },
      to: { path: '^(packages|plugins)/', pathNot: '^(plugins/engine-agent-sdk/|packages/(engine|memory|process)/)' },
    },
    {
      name: 'engine-plugin-reaches-engine-only',
      comment: 'an engine plugin reaches only the engine interface and its own files',
      severity: 'error',
      from: { path: '^plugins/(engine-(?:anthropic-api|claude-cli|codex|grok-cli|opencode-cli))/' },
      to: { path: '^(packages|plugins)/', pathNot: '^(plugins/$1/|packages/(engine|process)/)' },
    },
    {
      name: 'host-reaches-no-package',
      comment:
        'a host keeps placement glue only: no host module imports any @obversa package. A host manifest may still depend on a package to take its bin by public name',
      severity: 'error',
      from: { path: '^hosts/' },
      to: { path: '^(packages|plugins)/' },
    },
  ],
};
