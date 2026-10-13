import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SlotBudget, type SlotCandidate } from './slot-budget.ts';

const G = 1;
const Y = 2;

function candidates(weights: readonly number[]): SlotCandidate[] {
  return weights.map((weight, index) => ({ id: `d${index}`, position: index, weight }));
}

describe('SlotBudget', () => {
  const budget = new SlotBudget(8);

  it('runs up to 8 gallery-dl or 4 yt-dlp downloads', () => {
    assert.equal(budget.plan(candidates(Array(10).fill(G)), 0).length, 8);
    assert.equal(budget.plan(candidates(Array(10).fill(Y)), 0).length, 4);
  });

  it('mixes engines within the budget', () => {
    assert.deepEqual(budget.plan(candidates([Y, Y, G, G, G, G, G]), 0), ['d0', 'd1', 'd2', 'd3', 'd4', 'd5']);
  });

  it('accounts for weight already in use', () => {
    assert.deepEqual(budget.plan(candidates([Y, Y]), 5), ['d0']);
    assert.deepEqual(budget.plan(candidates([G]), 8), []);
  });

  it('lets lighter downloads overtake a heavier head that does not fit', () => {
    assert.deepEqual(budget.plan(candidates([Y, G]), 7), ['d1']);
  });

  it('follows position order, not input order', () => {
    const pending: SlotCandidate[] = [
      { id: 'late', position: 9, weight: Y },
      { id: 'early', position: 1, weight: Y }
    ];
    assert.deepEqual(budget.plan(pending, 6), ['early']);
  });

  it('clamps weights to 1..budget', () => {
    assert.equal(budget.weightOf(0), 1);
    assert.equal(budget.weightOf(99), 8);
    assert.equal(budget.weightOf(Number.NaN), 1);
    assert.equal(budget.used([Y, G, 99]), 11);
    assert.deepEqual(budget.plan([{ id: 'huge', position: 0, weight: 50 }], 0), ['huge']);
  });
});
