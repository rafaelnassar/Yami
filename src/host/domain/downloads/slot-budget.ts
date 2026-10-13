/**
 * Weighted concurrency budget. Each engine declares a slot weight (gallery-dl 1,
 * yt-dlp 2); running downloads may use at most `budget` (8) in total — e.g. 8
 * gallery-dl, 4 yt-dlp, or mixes.
 *
 * Scheduling walks pending downloads in `position` order and starts every one that
 * fits; a heavier download that does not fit does not block lighter ones behind it
 * (legacy behavior).
 */

export const DEFAULT_SLOT_BUDGET = 8;

export interface SlotCandidate {
  readonly id: string;
  readonly position: number;
  readonly weight: number;
}

export class SlotBudget {
  readonly budget: number;

  constructor(budget: number = DEFAULT_SLOT_BUDGET) {
    this.budget = Math.max(1, Math.floor(budget));
  }

  /** Weight clamped to `1..budget`, so an oversized engine can still run alone. */
  weightOf(rawWeight: number): number {
    if (!Number.isFinite(rawWeight)) return 1;
    return Math.min(this.budget, Math.max(1, Math.floor(rawWeight)));
  }

  /** Total weight used by the running downloads. */
  used(runningWeights: readonly number[]): number {
    return runningWeights.reduce((sum, weight) => sum + this.weightOf(weight), 0);
  }

  /**
   * Ids to launch now, in launch order. `pending` may be unsorted; ties on
   * position keep the given order.
   */
  plan(pending: readonly SlotCandidate[], usedWeight: number): string[] {
    const ordered = pending
      .map((candidate, index) => ({ candidate, index }))
      .sort((a, b) => a.candidate.position - b.candidate.position || a.index - b.index)
      .map((entry) => entry.candidate);
    let used = usedWeight;
    const launch: string[] = [];
    for (const candidate of ordered) {
      const need = this.weightOf(candidate.weight);
      if (used + need > this.budget) continue;
      launch.push(candidate.id);
      used += need;
    }
    return launch;
  }
}
