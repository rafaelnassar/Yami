/**
 * Architecture fitness test — enforces the dependency rule of the layered design
 * (see docs/ARCHITECTURE.md). Fails the build when a module imports across a
 * forbidden boundary.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');

interface Rule {
  /** Files whose path (relative to src/, with `/`) starts with this prefix. */
  readonly scope: string;
  /** Relative-import targets (resolved, relative to src/) that are forbidden. */
  readonly forbiddenTargets: readonly string[];
  /** Bare module specifiers that are forbidden (prefix match, e.g. `node:`, `electron`, `react`). */
  readonly forbiddenModules: readonly string[];
  /** When set, only these bare modules are allowed (prefix match). */
  readonly allowedModules?: readonly string[];
}

const RULES: readonly Rule[] = [
  {
    scope: 'shared/',
    forbiddenTargets: ['host/', 'main/', 'preload/', 'renderer/'],
    forbiddenModules: ['node:', 'electron', 'react'],
    allowedModules: []
  },
  {
    scope: 'host/domain/',
    forbiddenTargets: [
      'host/application/',
      'host/infrastructure/',
      'host/interface/',
      'host/bootstrap/',
      // Domain may use shared/domain + shared/kernel only — not IPC contracts or i18n.
      'shared/contracts/',
      'shared/i18n/',
      'shared/validation/',
      'main/',
      'preload/',
      'renderer/'
    ],
    forbiddenModules: ['node:', 'electron', 'react'],
    allowedModules: []
  },
  {
    scope: 'host/application/',
    forbiddenTargets: ['host/infrastructure/', 'host/interface/', 'host/bootstrap/', 'main/', 'preload/', 'renderer/'],
    forbiddenModules: ['node:', 'electron', 'react'],
    allowedModules: []
  },
  {
    scope: 'host/infrastructure/',
    forbiddenTargets: ['host/interface/', 'host/bootstrap/', 'main/', 'preload/', 'renderer/'],
    forbiddenModules: ['electron', 'react']
  },
  {
    scope: 'host/interface/',
    forbiddenTargets: ['host/infrastructure/', 'host/bootstrap/', 'main/', 'preload/', 'renderer/'],
    forbiddenModules: ['react']
  },
  {
    scope: 'host/',
    forbiddenTargets: ['main/', 'preload/', 'renderer/'],
    forbiddenModules: ['react']
  },
  {
    scope: 'main/',
    forbiddenTargets: ['host/', 'preload/', 'renderer/'],
    forbiddenModules: ['react']
  },
  {
    scope: 'preload/',
    forbiddenTargets: ['host/', 'main/', 'renderer/'],
    forbiddenModules: ['node:', 'react'],
    allowedModules: ['electron']
  },
  {
    scope: 'renderer/',
    forbiddenTargets: ['host/', 'main/', 'preload/'],
    forbiddenModules: ['node:', 'electron']
  }
];

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function listSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) listSources(full, out);
    // Test files may use node:test / node:assert; they are not part of the shipped layers.
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts') && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const specs: string[] = [];
  for (const match of text.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec) specs.push(spec);
  }
  return specs;
}

test('layer dependency rules are respected', () => {
  const violations: string[] = [];
  for (const file of listSources(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    const rules = RULES.filter((rule) => rel.startsWith(rule.scope));
    if (rules.length === 0) continue;
    for (const spec of importsOf(file)) {
      const isRelative = spec.startsWith('.');
      if (isRelative) {
        const target = path
          .relative(SRC, path.resolve(path.dirname(file), spec))
          .split(path.sep)
          .join('/');
        for (const rule of rules) {
          const hit = rule.forbiddenTargets.find((prefix) => target.startsWith(prefix));
          if (hit) violations.push(`${rel} → ${spec} (layer '${rule.scope}' must not depend on '${hit}')`);
        }
      } else {
        for (const rule of rules) {
          const forbidden = rule.forbiddenModules.find((prefix) => spec === prefix || spec.startsWith(prefix));
          if (forbidden) violations.push(`${rel} → ${spec} (module forbidden in '${rule.scope}')`);
          if (
            rule.allowedModules &&
            !rule.allowedModules.some((prefix) => spec === prefix || spec.startsWith(`${prefix}/`))
          ) {
            violations.push(
              `${rel} → ${spec} (only ${JSON.stringify(rule.allowedModules)} allowed in '${rule.scope}')`
            );
          }
        }
      }
    }
  }
  assert.deepEqual(violations, [], `Architecture violations:\n${violations.join('\n')}`);
});

test('relative imports use explicit .ts/.tsx extensions', () => {
  const missing: string[] = [];
  for (const file of listSources(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    if (rel.startsWith('renderer/')) continue; // Vite resolves extensionless imports in the renderer.
    for (const spec of importsOf(file)) {
      if (spec.startsWith('.') && !/\.(ts|tsx|json|css)$/.test(spec)) missing.push(`${rel} → ${spec}`);
    }
  }
  assert.deepEqual(missing, [], `Imports without extension (required for native TS execution):\n${missing.join('\n')}`);
});

/**
 * Application may type-import DTOs at the CQRS/IPC boundary, but must not pull
 * runtime values (helpers, consts) from `shared/contracts/dto` — those live in
 * `shared/domain`.
 */
test('host/application only type-imports shared/contracts/dto', () => {
  // Single-line only — a cross-line match would attribute earlier imports to the dto path.
  const VALUE_IMPORT = /(?:^|\n)\s*import\s+(?!type\b)([^\n]*?)\s+from\s*['"]([^'"]*shared\/contracts\/dto\.ts)['"]/g;
  const violations: string[] = [];
  for (const file of listSources(path.join(SRC, 'host/application'))) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(VALUE_IMPORT)) {
      const clause = match[1]?.trim() ?? '';
      const bindings = clause
        .replace(/^\{|\}$/g, '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      const allType =
        bindings.length > 0 && bindings.every((binding) => binding === 'type' || binding.startsWith('type '));
      if (!allType) violations.push(`${rel} → value import of contracts/dto (${clause.slice(0, 60)})`);
    }
  }
  assert.deepEqual(violations, [], `DTO value imports in application:\n${violations.join('\n')}`);
});
