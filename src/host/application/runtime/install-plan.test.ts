import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ToolId } from '../../../shared/domain/engine.ts';
import type { ToolStatusDto } from '../../../shared/contracts/dto.ts';
import { planInstall, planUpdate } from './install-plan.ts';
import { parseManifest, resolvePlatform } from './manifest.ts';
import { buildToolStatuses } from './tool-status.ts';
import { probed } from './testing-fakes.ts';
import type { ProbedTool } from './ports.ts';

function status(id: ToolId, installed: boolean, extra: Partial<ToolStatusDto> = {}): ToolStatusDto {
  return {
    id,
    installed,
    version: installed ? '1.0' : null,
    source: installed ? 'managed' : 'none',
    path: installed ? `/x/${id}` : null,
    pinnedVersion: '1.0',
    latestVersion: '1.0',
    updateAvailable: false,
    ...extra
  };
}

function statuses(
  installed: readonly ToolId[],
  extra: Partial<Record<ToolId, Partial<ToolStatusDto>>> = {}
): ToolStatusDto[] {
  return (['gallery-dl', 'yt-dlp', 'deno', 'ffmpeg', 'python'] as const).map((id) =>
    status(id, installed.includes(id), extra[id])
  );
}

describe('install plans', () => {
  it('installs only what the mode is missing, in a stable order', () => {
    assert.deepEqual(planInstall('standalone', statuses(['yt-dlp'])), [
      { kind: 'executable', tool: 'gallery-dl' },
      { kind: 'executable', tool: 'deno' },
      { kind: 'executable', tool: 'ffmpeg' }
    ]);
    assert.deepEqual(planInstall('python', statuses(['deno', 'ffmpeg'])), [
      { kind: 'python', packages: ['gallery-dl', 'yt-dlp'] }
    ]);
    assert.deepEqual(planInstall('python', statuses(['deno', 'ffmpeg', 'python', 'gallery-dl'])), [
      { kind: 'pip', engines: ['yt-dlp'] }
    ]);
    assert.deepEqual(planInstall('standalone', statuses(['gallery-dl', 'yt-dlp', 'deno', 'ffmpeg'])), []);
  });

  it('updates outdated or missing requested tools and never touches a system Python', () => {
    const outdated = statuses(['gallery-dl', 'yt-dlp', 'deno', 'ffmpeg', 'python'], {
      'yt-dlp': { updateAvailable: true }
    });
    assert.deepEqual(planUpdate('standalone', outdated, null), [{ kind: 'executable', tool: 'yt-dlp' }]);
    assert.deepEqual(planUpdate('standalone', outdated, ['deno']), [], 'up-to-date tools are skipped');
    assert.deepEqual(planUpdate('python', outdated, ['yt-dlp']), [{ kind: 'pip', engines: ['yt-dlp'] }]);

    const noPython = statuses(['deno', 'ffmpeg']);
    assert.deepEqual(planUpdate('python', noPython, ['gallery-dl']), [
      { kind: 'python', packages: ['gallery-dl', 'yt-dlp'] }
    ]);

    const systemPython = statuses(['python'], { python: { source: 'system', updateAvailable: true } });
    assert.deepEqual(planUpdate('standalone', systemPython, ['python']), []);
  });

  it('reinstalls every engine into a replaced managed Python in python mode only', () => {
    const managed = statuses(['gallery-dl', 'yt-dlp', 'deno', 'ffmpeg', 'python'], {
      python: { source: 'managed', updateAvailable: true }
    });
    assert.deepEqual(planUpdate('python', managed, ['python']), [
      { kind: 'python', packages: ['gallery-dl', 'yt-dlp'] }
    ]);
    assert.deepEqual(planUpdate('python', managed, null), [{ kind: 'python', packages: ['gallery-dl', 'yt-dlp'] }]);
    assert.deepEqual(planUpdate('standalone', managed, ['python']), [{ kind: 'python', packages: [] }]);
  });
});

describe('tool statuses', () => {
  const parsed = parseManifest({
    schemaVersion: 1,
    tools: Object.fromEntries(
      (['gallery-dl', 'yt-dlp', 'deno', 'ffmpeg', 'python'] as const).map((tool) => [
        tool,
        {
          ...(tool === 'yt-dlp' ? { latest: { repo: 'yt-dlp/yt-dlp', checksumsAsset: 'SHA2-256SUMS' } } : {}),
          assets: {
            'linux-x64': {
              version: {
                'gallery-dl': '2026.08.19',
                'yt-dlp': '2025.11.12',
                deno: '2.5.6',
                ffmpeg: '7.1.1',
                python: '3.12.14'
              }[tool],
              url: `https://example.test/${tool}`,
              sha256: null,
              archive: 'none'
            }
          }
        }
      ])
    ),
    pythonPackages: {
      'gallery-dl': { requirement: 'gallery-dl', version: '1.32.9' },
      'yt-dlp': { requirement: 'yt-dlp[default]', version: '2025.11.12' }
    }
  });
  assert.ok(parsed.ok);
  const manifest = resolvePlatform(parsed.value, 'linux', 'x64');

  function build(tools: Partial<Record<ToolId, ProbedTool>>, latestKnown: Partial<Record<ToolId, string>> = {}) {
    const snapshot = {
      tools: { 'gallery-dl': null, 'yt-dlp': null, deno: null, ffmpeg: null, python: null, ...tools },
      managedBinDir: '/rt/bin'
    };
    const metas = {
      'gallery-dl': { tool: 'gallery-dl' as const, version: '2026.08.01', sha256: null, source: 'x', installedAt: 1 }
    };
    return buildToolStatuses({ mode: 'standalone', snapshot, metas, manifest, latestKnown });
  }

  it('offers updates for managed tools and outdated system engines only', () => {
    const list = build({
      'gallery-dl': probed('/rt/bin/gallery-dl', 'managed', '1.32.9-dev'),
      'yt-dlp': probed('/usr/bin/yt-dlp', 'system', '2025.01.01'),
      ffmpeg: probed('/usr/bin/ffmpeg', 'system', 'ffmpeg version 6.0'),
      deno: probed('/rt/bin/deno', 'managed', 'deno 2.5.6 (stable)')
    });
    const byId = new Map(list.map((s) => [s.id, s]));
    assert.deepEqual(
      [byId.get('gallery-dl')?.version, byId.get('gallery-dl')?.updateAvailable],
      ['2026.08.01', true],
      'managed build compared by recorded tag'
    );
    assert.equal(byId.get('yt-dlp')?.updateAvailable, true);
    assert.equal(byId.get('ffmpeg')?.updateAvailable, false, 'system ffmpeg is left alone');
    assert.equal(byId.get('deno')?.updateAvailable, false);
    assert.equal(byId.get('python')?.installed, false);
  });

  it('lets yt-dlp float to a newer upstream release', () => {
    const list = build(
      { 'yt-dlp': probed('/rt/bin/yt-dlp', 'managed', '2025.11.12') },
      { 'yt-dlp': '2026.02.01', deno: '9.9.9' }
    );
    const yt = list.find((s) => s.id === 'yt-dlp');
    assert.deepEqual([yt?.pinnedVersion, yt?.latestVersion, yt?.updateAvailable], ['2025.11.12', '2026.02.01', true]);
    assert.equal(list.find((s) => s.id === 'deno')?.latestVersion, '2.5.6', 'tools without a feed stay on the pin');
  });
});
