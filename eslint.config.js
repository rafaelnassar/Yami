// @ts-check
/**
 * ESLint flat config.
 *
 * - TypeScript files get the type-checked recommended rules (typescript-eslint project service, which resolves each
 *   file through tsconfig.json → tsconfig.node.json / tsconfig.renderer.json).
 * - `no-restricted-imports` / `@typescript-eslint/no-restricted-imports` mirror the layer rules of
 *   tests/architecture.test.ts so violations show up in the editor. The test stays the source of truth.
 */
import { builtinModules } from 'node:module';
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const TS_FILES = ['**/*.{ts,tsx,mts,cts}'];
const JS_FILES = ['**/*.{js,mjs,cjs}'];

// ---------------------------------------------------------------------------------------------------------------
// Layer rules (keep in sync with tests/architecture.test.ts)
// ---------------------------------------------------------------------------------------------------------------

/**
 * @typedef {object} Layer
 * @property {string} scope                       Folder under src/ (e.g. 'host/domain'). Order matters: for a file
 *                                                matched by several scopes, the last one wins (flat config).
 * @property {readonly string[]} forbiddenTargets Folders under src/ this layer must not import.
 * @property {readonly string[]} forbiddenModules Bare specifier prefixes that are forbidden.
 * @property {readonly string[]} [allowedModules] When set, only these bare modules are allowed.
 * @property {boolean} [forbidBuiltins]           Also forbid un-prefixed Node built-ins (`fs`, `path`, …).
 */

/** @type {readonly Layer[]} */
const LAYERS = [
  {
    scope: 'shared',
    forbiddenTargets: ['host', 'main', 'preload', 'renderer'],
    forbiddenModules: ['node:', 'electron', 'react'],
    allowedModules: []
  },
  {
    // Every host file (bootstrap included); the sub-layers below override it with stricter lists.
    scope: 'host',
    forbiddenTargets: ['main', 'preload', 'renderer'],
    forbiddenModules: ['react']
  },
  {
    scope: 'host/domain',
    forbiddenTargets: [
      'host/application',
      'host/infrastructure',
      'host/interface',
      'host/bootstrap',
      'main',
      'preload',
      'renderer'
    ],
    forbiddenModules: ['node:', 'electron', 'react'],
    allowedModules: []
  },
  {
    scope: 'host/application',
    forbiddenTargets: ['host/infrastructure', 'host/interface', 'host/bootstrap', 'main', 'preload', 'renderer'],
    forbiddenModules: ['node:', 'electron', 'react'],
    allowedModules: []
  },
  {
    scope: 'host/infrastructure',
    forbiddenTargets: ['host/interface', 'host/bootstrap', 'main', 'preload', 'renderer'],
    forbiddenModules: ['electron', 'react']
  },
  {
    scope: 'host/interface',
    forbiddenTargets: ['host/infrastructure', 'host/bootstrap', 'main', 'preload', 'renderer'],
    forbiddenModules: ['react']
  },
  {
    scope: 'main',
    forbiddenTargets: ['host', 'preload', 'renderer'],
    forbiddenModules: ['react']
  },
  {
    scope: 'preload',
    forbiddenTargets: ['host', 'main', 'renderer'],
    forbiddenModules: ['node:', 'react'],
    allowedModules: ['electron'],
    forbidBuiltins: true
  },
  {
    scope: 'renderer',
    forbiddenTargets: ['host', 'main', 'preload'],
    forbiddenModules: ['node:', 'electron'],
    forbidBuiltins: true
  }
];

/** Deepest folder level (below src/) that gets exact-depth relative patterns; deeper files use the generic ones. */
const MAX_EXACT_DEPTH = 7;
/** Colocated tests may use the Node test runner even in pure layers. */
const TEST_RUNNER_EXEMPTION = '(?!node:test$|node:assert(?:/strict)?$)';
const LAYER_DOC = 'docs/ARCHITECTURE.md §3';

/** @param {string} text */
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * @typedef {{ regex: string, message: string, caseSensitive: true }} Pattern
 * @param {string} regex
 * @param {string} message
 * @returns {Pattern}
 */
const pattern = (regex, message) => ({ regex, message: `${message} (${LAYER_DOC}).`, caseSensitive: true });

/**
 * Bare-module restrictions (`node:*`, `electron`, `react`, allow-lists) — prefix matches, exactly like the test.
 * @param {Layer} layer
 * @param {boolean} testFile
 * @returns {Pattern[]}
 */
function modulePatterns(layer, testFile) {
  const exempt = testFile ? TEST_RUNNER_EXEMPTION : '';
  const where = `'src/${layer.scope}'`;
  const patterns = layer.forbiddenModules.map((prefix) =>
    pattern(`^${exempt}${escapeRegex(prefix)}`, `'${prefix}…' is not allowed in ${where}`)
  );
  if (layer.allowedModules) {
    const allowed = layer.allowedModules.map((name) => `|${escapeRegex(name)}(?:/|$)`).join('');
    const message =
      layer.allowedModules.length === 0
        ? `${where} must not use external modules (relative imports only)`
        : `Only ${layer.allowedModules.map((name) => `'${name}'`).join(', ')} may be imported in ${where}`;
    patterns.push(pattern(`^${exempt}(?![./]${allowed})`, message));
  }
  if (layer.forbidBuiltins) {
    const names = builtinModules.filter((name) => !name.startsWith('_') && !name.includes(':')).map(escapeRegex);
    patterns.push(pattern(`^(?:${names.join('|')})(?:/|$)`, `Node built-ins are not available in ${where}`));
  }
  return patterns;
}

/**
 * Cross-layer relative imports. ESLint only sees the specifier, so the file's folder depth below src/ is encoded
 * in the config (`files` glob) instead: from a file `depth` folders deep, `k` leading `../` land on a known
 * ancestor, and only specifiers that really resolve into the target layer match. Without the depth (files deeper
 * than MAX_EXACT_DEPTH) any number of `../` is accepted.
 * @param {Layer} layer
 * @param {number} [depth]
 * @returns {Pattern[]}
 */
function relativePatterns(layer, depth) {
  const scopeParts = layer.scope.split('/');
  const patterns = layer.forbiddenTargets.map((target) => {
    const targetParts = target.split('/');
    /** @type {string[]} */
    const alternatives = [];
    // `landing` = number of leading src/ folders kept after climbing; must be a common prefix of scope and target.
    for (let landing = 0; landing < scopeParts.length && landing < targetParts.length; landing += 1) {
      if (!scopeParts.slice(0, landing).every((part, index) => targetParts[index] === part)) break;
      const ups = depth === undefined ? '(?:\\.\\./)+' : `(?:\\.\\./){${depth - landing}}`;
      alternatives.push(ups + targetParts.slice(landing).map(escapeRegex).join('/'));
    }
    return pattern(`^(?:${alternatives.join('|')})(?:/|$)`, `'src/${layer.scope}' must not depend on 'src/${target}'`);
  });
  // Only the renderer resolves Vite's `@/` alias (→ src/).
  if (layer.scope === 'renderer') {
    for (const target of layer.forbiddenTargets) {
      patterns.push(pattern(`^@/${escapeRegex(target)}(?:/|$)`, `'src/renderer' must not depend on 'src/${target}'`));
    }
  }
  return patterns;
}

/**
 * Two rules so each can be scoped independently (flat config replaces a rule's options wholesale):
 * `no-restricted-imports` for bare modules (relaxed for tests), `@typescript-eslint/no-restricted-imports` for
 * cross-layer relative imports (one config per folder depth).
 * @param {Layer} layer
 */
function layerConfigs(layer) {
  const base = `src/${layer.scope}`;
  const scopeDepth = layer.scope.split('/').length;
  /** @param {Pattern[]} patterns */
  const options = (patterns) => ['error', { patterns }];
  const configs = [
    {
      name: `yami/layers/${layer.scope}`,
      files: [`${base}/**/*.{ts,tsx}`],
      rules: {
        'no-restricted-imports': options(modulePatterns(layer, false)),
        '@typescript-eslint/no-restricted-imports': options(relativePatterns(layer))
      }
    }
  ];
  for (let depth = scopeDepth; depth <= MAX_EXACT_DEPTH; depth += 1) {
    configs.push({
      name: `yami/layers/${layer.scope}/depth-${depth}`,
      files: [`${base}/${'*/'.repeat(depth - scopeDepth)}*.{ts,tsx}`],
      rules: { '@typescript-eslint/no-restricted-imports': options(relativePatterns(layer, depth)) }
    });
  }
  configs.push({
    name: `yami/layers/${layer.scope}/tests`,
    files: [`${base}/**/*.test.{ts,tsx}`],
    rules: { 'no-restricted-imports': options(modulePatterns(layer, true)) }
  });
  return configs;
}

// ---------------------------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------------------------

export default defineConfig(
  globalIgnores([
    'dist/**',
    'dist-electron/**',
    'release/**',
    'release-audit/**',
    'node_modules/**',
    'coverage/**',
    // Legacy app kept for reference until the rewrite ships.
    'electron/**',
    'native-host/**'
  ]),

  {
    name: 'yami/base',
    extends: [js.configs.recommended],
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-console': 'warn',
      'prefer-const': 'error',
      'no-var': 'error'
    }
  },

  {
    name: 'yami/typescript',
    files: TS_FILES,
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          // Root-level TS configs are not part of any tsconfig project.
          allowDefaultProject: ['vite.config.ts', 'vite.config.mts', 'tailwind.config.ts', 'src/*.d.ts'],
          defaultProject: 'tsconfig.node.json'
        },
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': [
        'error',
        // node:test's `test()`/`describe()` return promises the runner already tracks.
        {
          allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'it', 'describe', 'suite'] }]
        }
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports', disallowTypeAnnotations: true }
      ],
      // With verbatimModuleSyntax, `import { type A }` keeps an empty side-effect import; use `import type`.
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      // Port implementations are often `async` without awaiting (in-memory fakes, sync adapters).
      '@typescript-eslint/require-await': 'off'
    }
  },

  // Environments.
  {
    name: 'yami/env/node',
    files: ['src/host/**', 'src/main/**', 'tests/**', 'scripts/**', '*.{js,mjs,cjs,ts,mts}'],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    name: 'yami/env/shared',
    files: ['src/shared/**'],
    languageOptions: { globals: { ...globals['shared-node-browser'] } }
  },
  {
    name: 'yami/env/browser',
    files: ['src/renderer/**', 'src/preload/**'],
    languageOptions: { globals: { ...globals.browser } }
  },
  {
    name: 'yami/env/commonjs',
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' }
  },

  // React.
  {
    name: 'yami/react',
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // `onClick={async () => …}` is idiomatic; the promise is still checked by no-floating-promises inside.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }]
    }
  },

  {
    // Renderer tests are excluded from tsconfig.renderer.json, so there is no project to type-check them against.
    // Must come after every config that enables type-aware rules for the renderer.
    name: 'yami/renderer-tests',
    files: ['src/renderer/**/*.test.{ts,tsx}'],
    extends: [tseslint.configs.disableTypeChecked]
  },

  // Architecture (LAYERS order matters: `host` first, its sub-layers override it).
  ...LAYERS.flatMap(layerConfigs),

  // Tooling scripts talk to the terminal.
  {
    name: 'yami/scripts',
    files: ['scripts/**', ...JS_FILES.map((pattern) => pattern.replace('**/', ''))],
    rules: { 'no-console': 'off' }
  }
);
