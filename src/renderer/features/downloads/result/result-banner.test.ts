import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ConversationEventDto, DownloadOutcomeDto } from '../../../../shared/contracts/dto.ts';
import { resolveResultBanner } from './result-banner.ts';

function event(
  partial: Pick<ConversationEventDto, 'code' | 'type' | 'level'> & Partial<ConversationEventDto>
): ConversationEventDto {
  return {
    id: partial.id ?? 1,
    conversationId: 'c1',
    type: partial.type,
    level: partial.level,
    code: partial.code,
    params: partial.params ?? {},
    legacyMessage: partial.legacyMessage ?? null,
    createdAt: partial.createdAt ?? 1
  };
}

function conversation(input: {
  outcome: DownloadOutcomeDto | null;
  events?: readonly ConversationEventDto[];
  filesCount?: number;
}) {
  return {
    outcome: input.outcome,
    events: input.events ?? [],
    filesCount: input.filesCount ?? 0
  };
}

describe('resolveResultBanner', () => {
  it('hides the banner after a successful outcome even when an older auth failure remains in the timeline', () => {
    const banner = resolveResultBanner(
      conversation({
        outcome: { kind: 'ok', reason: null, detail: null },
        filesCount: 4,
        events: [
          event({
            id: 1,
            type: 'failed',
            level: 'error',
            code: 'failed',
            params: { reason: 'pixiv-auth', detail: '' }
          }),
          event({ id: 2, type: 'restarted', level: 'info', code: 'restarted' }),
          event({ id: 3, type: 'completed', level: 'success', code: 'completed' })
        ]
      }),
      { pixivConnected: true }
    );
    assert.equal(banner, null);
  });

  it('shows the current pixiv-auth outcome while the download is still failed', () => {
    const outcome: DownloadOutcomeDto = { kind: 'error', reason: 'pixiv-auth', detail: 'refresh-token required' };
    const banner = resolveResultBanner(
      conversation({
        outcome,
        filesCount: 0,
        events: [
          event({ type: 'failed', level: 'error', code: 'failed', params: { reason: 'pixiv-auth', detail: '' } })
        ]
      }),
      { pixivConnected: false }
    );
    assert.deepEqual(banner, { kind: 'outcome', level: 'error', outcome });
  });

  it('suppresses partial pixiv-auth noise when files exist and Pixiv is connected', () => {
    const banner = resolveResultBanner(
      conversation({
        outcome: { kind: 'partial', reason: 'pixiv-auth', detail: 'AuthenticationError' },
        filesCount: 3
      }),
      { pixivConnected: true }
    );
    assert.equal(banner, null);
  });

  it('only surfaces errors from the current attempt while a run has no outcome yet', () => {
    const current = event({
      id: 3,
      type: 'failed',
      level: 'error',
      code: 'failed',
      params: { reason: 'network', detail: 'timeout' }
    });
    const banner = resolveResultBanner(
      conversation({
        outcome: null,
        events: [
          event({
            id: 1,
            type: 'failed',
            level: 'error',
            code: 'failed',
            params: { reason: 'pixiv-auth', detail: '' }
          }),
          event({ id: 2, type: 'restarted', level: 'info', code: 'restarted' }),
          current
        ]
      })
    );
    assert.deepEqual(banner, { kind: 'event', event: current });
  });
});
