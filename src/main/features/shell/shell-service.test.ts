import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_APP_SETTINGS } from '../../../shared/contracts/app-settings.ts';
import type { FileInspectionDto } from '../../../shared/contracts/dto.ts';
import type { FileRisk } from '../../../shared/domain/media.ts';
import { err, ok } from '../../../shared/kernel/result.ts';
import type { ConfirmOptions } from '../dialogs/native-dialogs.ts';
import { ShellService } from './shell-service.ts';

function inspection(name: string, risk: FileRisk, exists = true): FileInspectionDto {
  return {
    path: `/dl/${name}`,
    name,
    exists,
    isDirectory: false,
    sizeBytes: 1,
    mediaType: 'other',
    previewMime: null,
    risk
  };
}

function setup(file: FileInspectionDto | null, confirm = false) {
  const calls: string[] = [];
  const prompts: ConfirmOptions[] = [];
  const service = new ShellService({
    inspect: async () => (file ? ok(file) : err({ code: 'PATH_OUTSIDE_SANDBOX' })),
    shell: {
      openPath: async (path) => {
        calls.push(`open:${path}`);
        return '';
      },
      showItemInFolder: (path) => calls.push(`reveal:${path}`),
      openExternal: async (url) => {
        calls.push(`external:${url}`);
      }
    },
    dialogs: {
      confirm: async (_parent, options) => {
        prompts.push(options);
        return confirm;
      }
    },
    settings: { get: () => ({ ...DEFAULT_APP_SETTINGS, locale: 'en' }), onChange: () => () => undefined },
    windowFor: () => null
  });
  return { service, calls, prompts };
}

describe('ShellService.openFile risk policy', () => {
  it('opens safe files directly', async () => {
    const { service, calls, prompts } = setup(inspection('a.jpg', 'safe'));
    assert.deepEqual(await service.openFile('a.jpg', 'main'), ok({ action: 'opened' }));
    assert.deepEqual(calls, ['open:/dl/a.jpg']);
    assert.equal(prompts.length, 0);
  });

  it('only reveals blocked files', async () => {
    const { service, calls } = setup(inspection('setup.exe', 'blocked'));
    assert.deepEqual(await service.openFile('setup.exe', 'main'), ok({ action: 'revealed' }));
    assert.deepEqual(calls, ['reveal:/dl/setup.exe']);
  });

  it('asks before opening unknown types (localized) and honors a decline', async () => {
    const declined = setup(inspection('data.xyz', 'caution'), false);
    assert.deepEqual(await declined.service.openFile('data.xyz', 'main'), ok({ action: 'declined' }));
    assert.deepEqual(declined.calls, []);
    assert.equal(declined.prompts[0]?.message, 'Open “data.xyz”?');
    const accepted = setup(inspection('data.xyz', 'caution'), true);
    assert.deepEqual(await accepted.service.openFile('data.xyz', 'main'), ok({ action: 'opened' }));
  });

  it('propagates host rejections and missing files', async () => {
    const outside = setup(null);
    assert.deepEqual(await outside.service.openFile('/etc/passwd', 'main'), err({ code: 'PATH_OUTSIDE_SANDBOX' }));
    const missing = setup(inspection('gone.jpg', 'safe', false));
    assert.deepEqual(await missing.service.revealFile('gone.jpg'), err({ code: 'PATH_NOT_FOUND' }));
  });

  it('opens only http(s) links externally', async () => {
    const { service, calls } = setup(null);
    assert.deepEqual(await service.openExternal('https://github.com/x'), ok(null));
    assert.equal((await service.openExternal('file:///etc/passwd')).ok, false);
    assert.deepEqual(calls, ['external:https://github.com/x']);
  });
});
