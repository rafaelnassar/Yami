import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldRepairTitle, titleFromUrl } from './title.ts';

describe('titleFromUrl (ported from native-host/database.test.js)', () => {
  it('uses the Twitter/X username instead of the media tab', () => {
    assert.equal(titleFromUrl('https://x.com/Ursulaturnst/media?filter=photo'), 'Ursulaturnst');
    assert.equal(titleFromUrl('https://twitter.com/Ursulaturnst/media'), 'Ursulaturnst');
    assert.equal(titleFromUrl('https://x.com/Ursulaturnst/likes'), 'Ursulaturnst');
  });

  it('keeps the profile handle and tweet owner, not reserved routes', () => {
    assert.equal(titleFromUrl('https://x.com/Ursulaturnst'), 'Ursulaturnst');
    assert.equal(titleFromUrl('https://x.com/Ursulaturnst/status/1234567890'), 'Ursulaturnst');
    assert.equal(titleFromUrl('https://x.com/i/status/1234567890'), '1234567890');
    assert.equal(titleFromUrl('https://x.com/search?q=cats'), 'cats');
  });

  it('skips generic gallery tabs on other sites', () => {
    assert.equal(titleFromUrl('https://www.instagram.com/someone/reels/'), 'someone');
    assert.equal(titleFromUrl('https://danbooru.donmai.us/posts?tags=cat'), 'cat');
    assert.equal(titleFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  });

  it('falls back to hostname when the path is empty', () => {
    assert.equal(titleFromUrl('https://example.com/'), 'example.com');
    assert.equal(titleFromUrl('https://www.example.com/media'), 'example.com');
  });

  it('decodes path segments and caps the length at 120', () => {
    assert.equal(titleFromUrl('https://site.com/Jo%C3%A3o'), 'João');
    assert.equal(titleFromUrl(`https://site.com/${'a'.repeat(200)}`).length, 120);
    assert.equal(titleFromUrl('https://site.com/%E0%A4%A'), '%E0%A4%A');
  });
});

describe('shouldRepairTitle (legacy repairGenericConversationTitles)', () => {
  it('repairs leftover media-tab titles only', () => {
    assert.equal(shouldRepairTitle('media', 'https://x.com/Ursulaturnst/media?filter=photo'), true);
    assert.equal(shouldRepairTitle('My title', 'https://x.com/Ursulaturnst/media'), false);
    assert.equal(shouldRepairTitle('Ursulaturnst', 'https://x.com/Ursulaturnst/media'), false);
    assert.equal(shouldRepairTitle('cat', 'https://danbooru.donmai.us/posts/cat'), false);
  });
});
