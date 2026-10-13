import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFormatters, formatMediaTime, localeTag, truncateMiddle } from './format.ts';

const DAY = 86_400_000;

describe('locale formatters', () => {
  it('maps app locales to BCP-47 tags', () => {
    assert.equal(localeTag('pt'), 'pt-BR');
    assert.equal(localeTag('en'), 'en-US');
    assert.equal(localeTag('es'), 'es-ES');
  });

  it('formats bytes with localized units and separators', () => {
    const en = createFormatters('en');
    const pt = createFormatters('pt');
    assert.equal(en.bytes(512), '512 B');
    assert.equal(pt.bytes(512), '512 B');
    assert.equal(en.bytes(1536), '1.5 kB');
    assert.equal(pt.bytes(1536), '1,5 kB');
    assert.equal(en.bytes(5 * 1024 * 1024), '5 MB');
    assert.equal(en.bytes(null), '—');
    assert.equal(en.bytes(-1), '—');
  });

  it('formats relative times per locale', () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    const en = createFormatters('en');
    assert.match(en.relativeTime(now - 5 * 60_000, now), /5 min/);
    assert.match(createFormatters('pt').relativeTime(now - 2 * 3_600_000, now), /2 h/);
    assert.match(createFormatters('es').relativeTime(now - 30_000, now), /30 s/);
  });

  it('shows time today, "yesterday" and a short date for the sidebar', () => {
    const now = new Date(2026, 5, 15, 18, 30).getTime();
    const en = createFormatters('en');
    assert.match(en.conversationDate(new Date(2026, 5, 15, 9, 5).getTime(), now), /09:05|9:05/);
    assert.equal(en.conversationDate(now - DAY, now), 'yesterday');
    assert.equal(createFormatters('pt').conversationDate(now - DAY, now), 'ontem');
    assert.match(en.conversationDate(now - 5 * DAY, now), /Jun/);
  });

  it('formats media clocks and truncates long names in the middle', () => {
    assert.equal(formatMediaTime(65), '1:05');
    assert.equal(formatMediaTime(65, true), '01:05');
    assert.equal(formatMediaTime(3725), '1:02:05');
    assert.equal(formatMediaTime(Number.NaN), '0:00');
    assert.equal(truncateMiddle('abcdefghijklmnopqrstuvwxyz', 11), 'abcde…vwxyz');
    assert.equal(truncateMiddle('short', 11), 'short');
  });
});
