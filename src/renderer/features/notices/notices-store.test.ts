import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NoticeDto } from '../../../shared/contracts/dto.ts';
import { autoDismissMs, createNoticesStore, key, MAX_TOASTS } from './notices-store.ts';

const notice = (id: string, kind: NoticeDto['kind'] = 'info'): NoticeDto => ({
  id,
  kind,
  code: 'x',
  params: {},
  action: null,
  ts: 1
});

describe('notices store', () => {
  it('replaces host notices with the same id and removes them on host dismissal', () => {
    const store = createNoticesStore({ now: () => 1 });
    store.getState().receiveNotice(notice('runtime-updates'));
    store.getState().receiveNotice({ ...notice('runtime-updates'), code: 'y' });
    assert.equal(store.getState().toasts.length, 1);
    assert.equal(store.getState().toasts[0]?.notice?.code, 'y');
    store.getState().remove('runtime-updates');
    assert.equal(store.getState().toasts.length, 0);
  });

  it('dedupes identical local toasts fired in quick succession', () => {
    let now = 1_000;
    const store = createNoticesStore({ now: () => now });
    const first = store.getState().push({ kind: 'error', title: key('ui.session.toast.startFail') });
    now += 500;
    const second = store.getState().push({ kind: 'error', title: key('ui.session.toast.startFail') });
    assert.equal(first, second);
    assert.equal(store.getState().toasts.length, 1);
    now += 5_000;
    store.getState().push({ kind: 'error', title: key('ui.session.toast.startFail') });
    assert.equal(store.getState().toasts.length, 2);
  });

  it('keeps at most MAX_TOASTS', () => {
    let now = 0;
    const store = createNoticesStore({ now: () => (now += 10_000) });
    for (let i = 0; i < MAX_TOASTS + 3; i += 1)
      store.getState().push({ kind: 'info', title: { kind: 'raw', text: `t${i}` } });
    assert.equal(store.getState().toasts.length, MAX_TOASTS);
  });

  it('clears the host error only when the user dismisses a host error notice', () => {
    let cleared = 0;
    const store = createNoticesStore({ now: () => 1, clearHostError: () => (cleared += 1) });
    store.getState().receiveNotice(notice('e1', 'error'));
    store.getState().receiveNotice(notice('w1', 'warn'));
    store.getState().dismiss('w1');
    store.getState().dismiss('e1');
    assert.equal(cleared, 1);
  });

  it('auto-dismisses only non-sticky toasts', () => {
    assert.equal(autoDismissMs({ sticky: true, kind: 'info' }), null);
    assert.equal(typeof autoDismissMs({ sticky: false, kind: 'success' }), 'number');
    const store = createNoticesStore({ now: () => 1 });
    store.getState().push({ kind: 'warn', title: key('ui.engine.missingMessage') });
    store.getState().push({ kind: 'info', title: key('ui.common.loading'), action: { type: 'open-settings' } });
    assert.deepEqual(
      store.getState().toasts.map((toast) => toast.sticky),
      [true, true]
    );
  });

  it('mirrors the host lastError: upsert by id, no-op when unchanged, removed when cleared', () => {
    const store = createNoticesStore({ now: () => 1 });
    let updates = 0;
    store.subscribe(() => (updates += 1));
    const error = { ...notice('runtime-install-failed', 'error'), ts: 5 };
    store.getState().syncHostError(error);
    store.getState().syncHostError({ ...error });
    assert.equal(store.getState().toasts.length, 1);
    assert.equal(updates, 1);
    store.getState().syncHostError({ ...error, ts: 6, code: 'y' });
    assert.equal(store.getState().toasts[0]?.notice?.code, 'y');
    store.getState().syncHostError(null);
    assert.equal(store.getState().toasts.length, 0);
    store.getState().syncHostError(null);
    assert.equal(updates, 3);
  });

  it('does not bring back a host error the user dismissed, but shows a new occurrence', () => {
    let cleared = 0;
    const store = createNoticesStore({ now: () => 1, clearHostError: () => (cleared += 1) });
    const error = { ...notice('runtime-install-failed', 'error'), ts: 5 };
    store.getState().syncHostError(error);
    store.getState().dismiss(error.id);
    assert.equal(cleared, 1);
    store.getState().syncHostError(error);
    assert.equal(store.getState().toasts.length, 0);
    store.getState().syncHostError({ ...error, ts: 9 });
    assert.equal(store.getState().toasts.length, 1);
  });

  it('remembers dismissal of session toasts and skips identical re-pushes', () => {
    let now = 1;
    const store = createNoticesStore({ now: () => (now += 10_000) });
    const toast = {
      id: 'engine-missing-yt-dlp',
      kind: 'warn',
      title: key('ui.engine.videoMissingTitle'),
      sticky: true,
      rememberDismissal: true
    } as const;
    store.getState().push(toast);
    const before = store.getState().toasts;
    store.getState().push(toast);
    assert.equal(store.getState().toasts, before);
    store.getState().remove(toast.id);
    store.getState().push(toast);
    assert.equal(store.getState().toasts.length, 1, 'programmatic removal is not a dismissal');
    store.getState().dismiss(toast.id);
    store.getState().push(toast);
    assert.equal(store.getState().toasts.length, 0);
    store.getState().push({ ...toast, id: 'engine-missing-gallery-dl' });
    assert.equal(store.getState().toasts.length, 1);
  });
});
