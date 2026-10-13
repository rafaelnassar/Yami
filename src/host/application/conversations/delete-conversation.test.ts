import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NewMediaFile } from '../ports/persistence.ts';
import { ErrorCode, appError } from '../../../shared/kernel/errors.ts';
import { SandboxedFileRemover } from '../library/sandboxed-file-remover.ts';
import { makeDownloadRecord } from '../testing-a2/records.ts';
import { createWorld, type World } from '../testing-a2/world.ts';
import { DeleteConversationService } from './delete-conversation.ts';

function file(conversationId: string, path: string): NewMediaFile {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { conversationId, path, name, mediaType: 'image', extension: '.jpg', sizeBytes: 1, createdAt: 1 };
}

type Remover = Pick<SandboxedFileRemover, 'remove'>;

/** Expected command result. */
function summary(filesDeleted: number, filesFailed: number, filesKept = 0, conversationId = 'c1') {
  return { ok: true, value: { conversationId, filesDeleted, filesFailed, filesKept } };
}

function setup(makeRemover?: (world: World, real: Remover) => Remover): {
  world: World;
  service: DeleteConversationService;
} {
  const world = createWorld({ records: [makeDownloadRecord({ id: 'c1' }), makeDownloadRecord({ id: 'c2' })] });
  world.events.append({
    conversationId: 'c1',
    type: 'created',
    level: 'info',
    code: 'created',
    params: {},
    createdAt: 1
  });
  const real = new SandboxedFileRemover(world.sandbox, world.fs);
  const service = new DeleteConversationService({
    downloads: world.downloads,
    records: world.records,
    files: world.files,
    events: world.events,
    tx: world.tx,
    remover: makeRemover ? makeRemover(world, real) : real,
    scanner: world.scanner,
    sink: world.sink
  });
  return { world, service };
}

describe('DeleteConversationService', () => {
  it('removes rows only (one transaction) when files are kept', async () => {
    const { world, service } = setup();
    world.fs.addFile('/dl/a.jpg');
    world.files.add(file('c1', '/dl/a.jpg'));
    const result = await service.delete({ conversationId: 'c1', deleteFiles: false });
    assert.deepEqual(result, summary(0, 0));
    assert.ok(world.fs.has('/dl/a.jpg'));
    assert.equal(world.records.get('c1'), null);
    assert.equal(world.files.rows.length, 0);
    assert.equal(world.events.rows.length, 0);
    assert.equal(world.tx.count, 1);
    assert.deepEqual(world.downloads.forgotten, ['c1']);
    assert.deepEqual(world.sink.events, [{ type: 'conversation.changed', conversationId: 'c1', reason: 'deleted' }]);
    assert.equal(world.scanner.invalidations, 0);
  });

  it('deletes files with partial failures and counts them', async () => {
    const { world, service } = setup();
    world.fs.addFile('/dl/ok.jpg').addFile('/dl/locked.jpg').addDir('/dl/dir.jpg');
    world.fs.removeFailures.set('/dl/locked.jpg', appError(ErrorCode.FILE_OPERATION_FAILED));
    for (const path of ['/dl/ok.jpg', '/dl/locked.jpg', '/dl/gone.jpg', '/etc/passwd', '/dl/dir.jpg', '/dl/ok.jpg']) {
      world.files.add(file('c1', path));
    }
    const result = await service.delete({ conversationId: 'c1', deleteFiles: true });
    // ok → deleted; locked, outside sandbox and a directory → failed; missing → neither.
    assert.deepEqual(result, summary(1, 3));
    assert.deepEqual(world.fs.removed, ['/dl/ok.jpg']);
    assert.ok(world.fs.has('/dl/locked.jpg'));
    assert.equal(world.records.get('c1'), null);
    assert.equal(world.scanner.invalidations, 1);
  });

  it('keeps (and counts as kept) the files another conversation also lists, deleting only its own', async () => {
    const { world, service } = setup();
    world.fs.addFile('/dl/shared.jpg').addFile('/dl/own.jpg').addFile('/dl/other.jpg');
    world.files.add(file('c1', '/dl/shared.jpg'));
    world.files.add(file('c1', '/dl/own.jpg'));
    world.files.add(file('c2', '/dl/shared.jpg')); // a re-download of the same file
    world.files.add(file('c2', '/dl/other.jpg'));
    const result = await service.delete({ conversationId: 'c1', deleteFiles: true });
    assert.deepEqual(result, summary(1, 0, 1));
    assert.deepEqual(world.fs.removed, ['/dl/own.jpg'], 'the shared file is never touched');
    assert.ok(world.fs.has('/dl/shared.jpg'));
    const rows = world.files.rows.map((row) => `${row.conversationId}:${row.path}`);
    assert.deepEqual(rows, ['c2:/dl/shared.jpg', 'c2:/dl/other.jpg']);
  });

  it('also removes rows of other conversations that point to a file deleted here under another spelling', async () => {
    const { world, service } = setup((_world, real) => ({
      async remove(path) {
        const outcome = await real.remove(path);
        // The sandbox canonicalizes the path (e.g. a symlinked download dir).
        return outcome.kind === 'deleted' ? { kind: 'deleted', resolvedPath: '/real/a.jpg' } : outcome;
      }
    }));
    world.fs.addFile('/dl/a.jpg');
    world.files.add(file('c1', '/dl/a.jpg'));
    world.files.add(file('c2', '/real/a.jpg'));
    const result = await service.delete({ conversationId: 'c1', deleteFiles: true });
    assert.ok(result.ok && result.value.filesDeleted === 1 && result.value.filesKept === 0);
    assert.equal(world.files.rows.length, 0, 'the library never lists a file that no longer exists');
  });

  it('keeps everything when the download cannot be stopped', async () => {
    const { world, service } = setup();
    world.fs.addFile('/dl/a.jpg');
    world.files.add(file('c1', '/dl/a.jpg'));
    world.downloads.forgetErrors.set('c1', appError(ErrorCode.PROCESS_KILL_FAILED));
    const result = await service.delete({ conversationId: 'c1', deleteFiles: true });
    assert.ok(!result.ok && result.error.code === ErrorCode.PROCESS_KILL_FAILED);
    assert.ok(world.records.get('c1'));
    assert.ok(world.fs.has('/dl/a.jpg'));
    assert.equal(world.files.rows.length, 1);
    assert.equal(world.sink.events.length, 0);
  });

  it('stops the download before reading its files', async () => {
    const { world, service } = setup();
    world.downloads.onForget = () => {
      // A finishing engine may still record a file while being stopped.
      world.fs.addFile('/dl/late.jpg');
      world.files.add(file('c1', '/dl/late.jpg'));
    };
    const result = await service.delete({ conversationId: 'c1', deleteFiles: true });
    assert.ok(result.ok && result.value.filesDeleted === 1);
    assert.ok(!world.fs.has('/dl/late.jpg'));
  });

  it('removes the rows before touching the disk, so nothing can relaunch or orphan the download', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let removalStarted = false;
    const { world, service } = setup((_world, real) => ({
      async remove(path) {
        removalStarted = true;
        await gate;
        return real.remove(path);
      }
    }));
    world.fs.addFile('/dl/a.jpg');
    world.files.add(file('c1', '/dl/a.jpg'));

    const pending = service.delete({ conversationId: 'c1', deleteFiles: true });
    await new Promise((resolve) => setImmediate(resolve));
    // Disk deletion is in flight (a crash here must not leave a record behind).
    assert.ok(removalStarted);
    assert.equal(world.records.get('c1'), null);
    assert.equal(world.files.rows.length, 0);
    assert.equal(world.events.rows.length, 0);
    assert.equal(world.tx.count, 1);
    assert.ok(world.fs.has('/dl/a.jpg'));

    release();
    const result = await pending;
    assert.deepEqual(result, summary(1, 0));
    assert.ok(!world.fs.has('/dl/a.jpg'));
  });

  it('completes the delete when removing a file throws unexpectedly', async () => {
    const { world, service } = setup((_world, real) => ({
      async remove(path) {
        if (path === '/dl/boom.jpg') throw new Error('EIO');
        return real.remove(path);
      }
    }));
    world.fs.addFile('/dl/boom.jpg').addFile('/dl/ok.jpg');
    world.files.add(file('c1', '/dl/boom.jpg'));
    world.files.add(file('c1', '/dl/ok.jpg'));
    const result = await service.delete({ conversationId: 'c1', deleteFiles: true });
    assert.deepEqual(result, summary(1, 1));
    assert.equal(world.records.get('c1'), null);
    assert.deepEqual(world.sink.events, [{ type: 'conversation.changed', conversationId: 'c1', reason: 'deleted' }]);
  });

  it('is idempotent for unknown conversations', async () => {
    const { world, service } = setup();
    world.downloads.forgetErrors.set('ghost', appError(ErrorCode.CONVERSATION_NOT_FOUND));
    const result = await service.delete({ conversationId: 'ghost', deleteFiles: true });
    assert.deepEqual(result, summary(0, 0, 0, 'ghost'));
    assert.equal(world.tx.count, 0);
    assert.equal(world.sink.events.length, 0);
  });
});
