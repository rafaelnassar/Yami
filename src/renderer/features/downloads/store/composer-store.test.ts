import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createComposerStore } from './composer-store.ts';

describe('composer store', () => {
  it('clears the draft of the submitted mode, even if the user switched modes meanwhile', () => {
    const store = createComposerStore();
    store.getState().setUrlDraft('https://a.example/1');
    store.getState().setBatchDraft('https://b.example/1\nhttps://b.example/2');
    store.getState().beginStart();
    store.getState().setMode('bulk');
    store.getState().endStart(true, 'single');
    assert.equal(store.getState().urlDraft, '');
    assert.equal(store.getState().batchDraft, 'https://b.example/1\nhttps://b.example/2');
    assert.equal(store.getState().starting, 0);
  });

  it('keeps drafts when the start failed', () => {
    const store = createComposerStore();
    store.getState().setUrlDraft('https://a.example/1');
    store.getState().beginStart();
    store.getState().endStart(false, 'single');
    assert.equal(store.getState().urlDraft, 'https://a.example/1');
  });
});
