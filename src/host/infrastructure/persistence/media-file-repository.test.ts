import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { SqlitePersistence } from './sqlite-persistence.ts';
import { directoryLikePatterns, escapeLike, matchDirectory, trimTrailingSeparators } from './path-prefix.ts';
import { downloadRecord, makeTempDir, mediaFile, openTestPersistence } from './test-fixtures.ts';

function allPaths(persistence: SqlitePersistence, conversationId = 'd1'): string[] {
  return persistence.context.files.pathsByConversation(conversationId);
}

describe('path prefix helpers', () => {
  it('escapes LIKE wildcards', () => {
    assert.equal(escapeLike('a%b_c\\d'), 'a\\%b\\_c\\\\d');
    assert.deepEqual(directoryLikePatterns('/dl/50%_off'), [
      '/dl/50\\%\\_off',
      '/dl/50\\%\\_off/%',
      '/dl/50\\%\\_off\\\\%'
    ]);
    assert.deepEqual(directoryLikePatterns('/dl/é😀'), ['/dl/__', '/dl/__/%', '/dl/__\\\\%']);
  });

  it('matches only the directory itself or its descendants', () => {
    assert.equal(matchDirectory('/dl/foo', '/dl/foo', false), '');
    assert.equal(matchDirectory('/dl/foo/a.jpg', '/dl/foo', false), '/a.jpg');
    assert.equal(matchDirectory('C:\\dl\\foo\\a.jpg', 'C:\\dl\\foo', false), '\\a.jpg');
    assert.equal(matchDirectory('/dl/foobar/a.jpg', '/dl/foo', false), null);
    assert.equal(matchDirectory('/DL/Foo/a.jpg', '/dl/foo', false), null);
    assert.equal(matchDirectory('/DL/Foo/a.jpg', '/dl/foo', true), '/a.jpg');
    assert.equal(matchDirectory('/dl/fo', '/dl/foo', false), null);
  });

  it('trims trailing separators but keeps a root', () => {
    assert.equal(trimTrailingSeparators('/dl/foo///'), '/dl/foo');
    assert.equal(trimTrailingSeparators('C:\\dl\\'), 'C:\\dl');
    assert.equal(trimTrailingSeparators('/'), '/');
  });
});

describe('SqliteMediaFileRepository', () => {
  let cleanup: () => void;
  let dir: string;
  let persistence: SqlitePersistence;

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
    persistence = openTestPersistence(dir);
    persistence.context.downloads.save(downloadRecord({ id: 'd1' }));
    persistence.context.downloads.save(downloadRecord({ id: 'd2' }));
  });
  afterEach(() => {
    persistence.context.close();
    cleanup();
  });

  it('adds files once per (conversation, path) and allows orphan files', () => {
    const { files } = persistence.context;
    const added = files.add(mediaFile());
    assert.ok(added);
    assert.equal(added.path, '/dl/gallery-dl/a.jpg');
    assert.equal(typeof added.id, 'number');
    assert.equal(files.add(mediaFile({ sizeBytes: 5 })), null);
    assert.ok(files.add(mediaFile({ conversationId: 'd2' })), 'same path in another conversation');
    assert.ok(files.add(mediaFile({ conversationId: null })));
    assert.equal(files.add(mediaFile({ conversationId: null })), null, 'orphan paths stay unique');
    assert.equal(files.countByConversation('d1'), 1);
  });

  it('paginates files oldest first with stable cursors', () => {
    const { files } = persistence.context;
    for (let i = 0; i < 25; i += 1) {
      // Several files share a timestamp to exercise the id tie-breaker.
      files.add(mediaFile({ path: `/dl/f${String(i).padStart(2, '0')}.jpg`, createdAt: 1_000 + Math.floor(i / 4) }));
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = files.listByConversation('d1', 10, cursor);
      seen.push(...page.items.map((f) => f.path));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);
    assert.equal(pages, 3);
    assert.deepEqual(
      seen,
      Array.from({ length: 25 }, (_, i) => `/dl/f${String(i).padStart(2, '0')}.jpg`)
    );
    assert.deepEqual(files.listByConversation('d1', 10, 'not-a-cursor!'), { items: [], nextCursor: null });
    assert.equal(files.listByConversation('d1', 25, null).nextCursor, null, 'exact fit has no next page');
  });

  it('deletes by conversation and by paths', () => {
    const { files } = persistence.context;
    files.add(mediaFile({ path: '/dl/a.jpg' }));
    files.add(mediaFile({ path: '/dl/b.jpg' }));
    files.add(mediaFile({ conversationId: 'd2', path: '/dl/a.jpg' }));
    assert.equal(files.deleteByPaths(['/dl/a.jpg', '/dl/zzz.jpg', '/DL/B.JPG']), 2);
    assert.deepEqual(allPaths(persistence), ['/dl/b.jpg']);
    assert.equal(files.deleteByPaths([]), 0);
    assert.equal(files.deleteByConversation('d1'), 1);
    assert.equal(files.countByConversation('d1'), 0);
  });

  it('maps paths to their newest producing conversation', () => {
    const { files } = persistence.context;
    files.add(mediaFile({ path: '/dl/a.jpg', createdAt: 1 }));
    files.add(mediaFile({ conversationId: 'd2', path: '/dl/a.jpg', createdAt: 2 }));
    files.add(mediaFile({ path: '/dl/b.jpg' }));
    files.add(mediaFile({ conversationId: null, path: '/dl/orphan.jpg' }));
    const map = files.conversationIdsForPaths([
      '/dl/a.jpg',
      '/dl/b.jpg',
      '/dl/orphan.jpg',
      '/dl/none.jpg',
      '/DL/A.JPG'
    ]);
    assert.deepEqual([...map.entries()].sort(), [
      ['/dl/a.jpg', 'd2'],
      ['/dl/b.jpg', 'd1']
    ]);
  });

  it('matches paths case-insensitively on Windows', () => {
    persistence.context.close();
    persistence = openTestPersistence(dir, 'win32');
    const { files } = persistence.context;
    files.add(mediaFile({ path: 'C:\\DL\\Pic.JPG' }));
    const map = files.conversationIdsForPaths(['c:\\dl\\pic.jpg']);
    assert.equal(map.get('c:\\dl\\pic.jpg'), 'd1');
    assert.equal(files.deleteByPaths(['c:\\dl\\PIC.jpg']), 1);
  });

  it('pathsReferencedElsewhere: paths another conversation still records (orphans and the asker do not count)', () => {
    const { files } = persistence.context;
    files.add(mediaFile({ path: '/dl/shared.jpg' }));
    files.add(mediaFile({ path: '/dl/shared.jpg', conversationId: 'd2' }));
    files.add(mediaFile({ path: '/dl/own.jpg' }));
    files.add(mediaFile({ path: '/dl/library.jpg' }));
    files.add(mediaFile({ path: '/dl/library.jpg', conversationId: null }));
    files.add(mediaFile({ path: '/dl/Case.jpg', conversationId: 'd2' }));
    const asked = ['/dl/shared.jpg', '/dl/own.jpg', '/dl/library.jpg', '/dl/case.jpg', '/dl/shared.jpg'];
    assert.deepEqual(
      files.pathsReferencedElsewhere(asked, 'd1'),
      ['/dl/shared.jpg', '/dl/shared.jpg'],
      'exact match on POSIX, input order and spelling kept'
    );
    assert.deepEqual(files.pathsReferencedElsewhere(['/dl/shared.jpg'], 'd2'), ['/dl/shared.jpg']);
    assert.deepEqual(files.pathsReferencedElsewhere([], 'd1'), []);
  });

  it('pathsReferencedElsewhere ignores case on Windows (like deleteByPaths)', () => {
    persistence.context.close();
    persistence = openTestPersistence(dir, 'win32');
    const { files } = persistence.context;
    files.add(mediaFile({ path: 'C:\\DL\\Pic.JPG', conversationId: 'd2' }));
    files.add(mediaFile({ path: 'c:\\dl\\pic.jpg' }));
    assert.deepEqual(files.pathsReferencedElsewhere(['c:\\dl\\pic.jpg'], 'd1'), ['c:\\dl\\pic.jpg']);
    assert.deepEqual(files.pathsReferencedElsewhere(['c:\\dl\\pic.jpg'], 'd2'), ['c:\\dl\\pic.jpg']);
  });

  it('renames an exact directory without touching sibling prefixes', () => {
    const { files } = persistence.context;
    for (const path of ['/dl/foo', '/dl/foo/a.jpg', '/dl/foo/sub/b.jpg', '/dl/foobar/c.jpg', '/dl/foo.bak/d.jpg']) {
      files.add(mediaFile({ path }));
    }
    assert.equal(files.renameDirectory('/dl/foo/', '/dl/baz', false), 3);
    assert.deepEqual(allPaths(persistence).sort(), [
      '/dl/baz',
      '/dl/baz/a.jpg',
      '/dl/baz/sub/b.jpg',
      '/dl/foo.bak/d.jpg',
      '/dl/foobar/c.jpg'
    ]);
  });

  it('handles emoji and unicode names without corrupting paths', () => {
    const { files } = persistence.context;
    files.add(mediaFile({ path: '/dl/😀 fotos/ação 🎉.jpg' }));
    files.add(mediaFile({ path: '/dl/😀 fotos/日本語/画像.png' }));
    files.add(mediaFile({ path: '/dl/😀 fotosx/keep.jpg' }));
    assert.equal(files.renameDirectory('/dl/😀 fotos', '/dl/🐱 gatos', false), 2);
    assert.deepEqual(allPaths(persistence).sort(), [
      '/dl/🐱 gatos/ação 🎉.jpg',
      '/dl/🐱 gatos/日本語/画像.png',
      '/dl/😀 fotosx/keep.jpg'
    ]);
  });

  it('escapes LIKE wildcards in directory names', () => {
    const { files } = persistence.context;
    files.add(mediaFile({ path: '/dl/50%_off/a.jpg' }));
    files.add(mediaFile({ path: '/dl/50XXoff/b.jpg' }));
    assert.equal(files.renameDirectory('/dl/50%_off', '/dl/sale', false), 1);
    assert.deepEqual(allPaths(persistence).sort(), ['/dl/50XXoff/b.jpg', '/dl/sale/a.jpg']);
  });

  it('renames case-insensitively (Windows) including non-ASCII letters and backslashes', () => {
    const { files } = persistence.context;
    files.add(mediaFile({ path: 'C:\\Downloads\\ÁLBUM\\x.jpg' }));
    files.add(mediaFile({ path: 'c:\\downloads\\álbum\\y.jpg' }));
    files.add(mediaFile({ path: 'C:\\Downloads\\ÁLBUMS\\z.jpg' }));
    assert.equal(files.renameDirectory('C:\\Downloads\\Álbum', 'C:\\Downloads\\Fotos', false), 0);
    assert.equal(files.renameDirectory('C:\\Downloads\\Álbum', 'C:\\Downloads\\Fotos', true), 2);
    assert.deepEqual(allPaths(persistence).sort(), [
      'C:\\Downloads\\Fotos\\x.jpg',
      'C:\\Downloads\\Fotos\\y.jpg',
      'C:\\Downloads\\ÁLBUMS\\z.jpg'
    ]);
  });

  it('collapses a rename onto an already-recorded path in the same conversation', () => {
    const { files } = persistence.context;
    files.add(mediaFile({ path: '/dl/old/a.jpg' }));
    files.add(mediaFile({ path: '/dl/new/a.jpg' }));
    assert.equal(files.renameDirectory('/dl/old', '/dl/new', false), 1);
    assert.deepEqual(allPaths(persistence), ['/dl/new/a.jpg']);
  });
});
