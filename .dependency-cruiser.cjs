// The package-arrow authority (an internal note).
// dependency-cruiser proves every static arrow between packages: static import,
// re-export, static dynamic import, require, package-import alias, public
// subpath. Expression imports, reflection, and generated code are out of its
// scope and stated as residuals in Every rule is an error, never a
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
    doNotFollow: { path: '(^|/)node_modules/|^packages/[^/]+/dist/' },
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
        'every static dependency must resolve; a name that does not resolve is a missing declaration, a deep import past an exports map, or a package-import alias no manifest defines. examples resolve relative to the package that runs them, so they are exempt here and governed by the internal-path and public-name rules instead',
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
      from: { path: '^(packages|hosts)/', pathNot: testPath },
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
    },
    {
      name: 'no-dev-dep-from-prod',
      comment: 'production code cannot import a dependency declared only for development',
      severity: 'error',
      from: { path: '^(packages|hosts)/[^/]+/(src|lib|bin|assets)/' },
      to: { dependencyTypes: ['npm-dev'] },
    },
    {
      name: 'no-test-from-prod',
      comment: 'production code cannot import tests',
      severity: 'error',
      from: { path: '^(packages|hosts)/', pathNot: testPath },
      to: { path: testPath },
    },
    {
      name: 'no-cross-package-test-import',
      comment:
        'a test that reaches into another package must use that package public testing subpath, never its test files; a test importing its own package is unchanged',
      severity: 'error',
      from: { path: '^packages/([^/]+)/' },
      to: { path: testPath, pathNot: '^packages/$1/' },
    },
    {
      name: 'no-cross-package-internal-path',
      comment:
        'a cross-package import uses the @obversa package name and an exported subpath; a relative, absolute, or aliased path into a sibling package bypasses its public surface',
      severity: 'error',
      from: { path: '^packages/([^/]+)/' },
      to: { path: '^(packages/(?!$1/)|hosts/)', dependencyTypes: ['local', 'aliased'] },
    },
    {
      name: 'no-host-internal-path',
      comment: 'a host takes packages by their public names, never by path',
      severity: 'error',
      from: { path: '^hosts/' },
      to: { path: '^packages/', dependencyTypes: ['local', 'aliased'] },
    },
    {
      name: 'no-script-internal-path',
      comment: 'scripts and examples consume public exports only',
      severity: 'error',
      from: { path: '^(scripts|examples)/' },
      to: { path: '^(packages|hosts)/', dependencyTypes: ['local', 'aliased'] },
    },
    {
      name: 'no-package-to-host',
      comment: 'no package reaches a host; a host is a composition root, not a dependency',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^hosts/' },
    },
    // The arrow matrix. Each package names the packages it may reach; every
    // other cross-package arrow is an error whatever form it takes.
    {
      name: 'memory-reaches-no-package',
      comment: '@obversa/memory is a contract package; it reaches no other package',
      severity: 'error',
      from: { path: '^packages/memory/' },
      to: { path: '^packages/', pathNot: '^packages/memory/' },
    },
    {
      name: 'surfacer-reaches-no-package',
      comment: '@obversa/surfacer reaches no @obversa package',
      severity: 'error',
      from: { path: '^packages/surfacer/' },
      to: { path: '^packages/', pathNot: '^packages/surfacer/' },
    },
    {
      name: 'source-reaches-surfacer-only',
      comment:
        '@obversa/source carries the review command, which injects the surfacer launch port itself: the one flipped arrow. It reaches nothing else',
      severity: 'error',
      from: { path: '^packages/source/' },
      to: { path: '^packages/', pathNot: '^packages/(source|surfacer)/' },
    },
    {
      name: 'lines-reaches-memory-only',
      comment: 'the runtime reaches the memory contract only; never a surface, source, or host',
      severity: 'error',
      from: { path: '^packages/lines/' },
      to: { path: '^packages/', pathNot: '^packages/(lines|memory)/' },
    },
    {
      name: 'memory-git-reaches-memory-only',
      comment: 'a memory adapter reaches the memory contract and its own storage library only',
      severity: 'error',
      from: { path: '^packages/memory-git/' },
      to: { path: '^packages/', pathNot: '^packages/(memory-git|memory)/' },
    },
    {
      name: 'memory-simple-reaches-memory-only',
      comment: 'a memory adapter reaches the memory contract only',
      severity: 'error',
      from: { path: '^packages/memory-simple/' },
      to: { path: '^packages/', pathNot: '^packages/(memory-simple|memory)/' },
    },
    {
      name: 'host-reaches-no-package',
      comment:
        'a host keeps placement glue only: no host module imports any @obversa package. A host manifest may still depend on a package to take its bin by public name',
      severity: 'error',
      from: { path: '^hosts/' },
      to: { path: '^packages/' },
    },
  ],
};
