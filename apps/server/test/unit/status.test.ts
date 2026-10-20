import { describe, expect, it } from 'vitest';
import { deriveStatus, STATUSES, type StatusIn } from '../../src/derive/status.js';

/** KURO-T-2.7: golden tests for every status and the transitions between them. */

const NOW = new Date('2026-10-20T00:00:00Z');
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const base: StatusIn = { total: 12, watched: 5, nextAvailable: true, nextIsNew: false, lastPlayedAt: days(2), moreComing: false, rewatching: false, manual: null };
const status = (over: Partial<StatusIn>) => deriveStatus({ ...base, ...over }, NOW);

describe('the seven statuses (KURO-REQ-033)', () => {
  it('there are exactly seven', () => {
    expect(STATUSES).toEqual(['plan_to_watch', 'watching', 'caught_up', 'paused', 'completed', 'dropped', 'rewatching']);
  });

  it('Watching: part-way through, played lately', () => {
    expect(status({})).toBe('watching');
  });

  it('Watching → Paused after six weeks without a play', () => {
    expect(status({ lastPlayedAt: days(41) })).toBe('watching');
    expect(status({ lastPlayedAt: days(43) })).toBe('paused');
  });

  it('Paused → Watching when a new episode came out since (a new dub episode wakes it)', () => {
    expect(status({ lastPlayedAt: days(90), nextIsNew: true })).toBe('watching');
  });

  it('Completed: everything watched, nothing more coming', () => {
    expect(status({ watched: 12, nextAvailable: false })).toBe('completed');
  });

  it('Caught up: everything out is watched and the Season is still airing, or a sequel is announced', () => {
    expect(status({ watched: 8, total: 8, nextAvailable: false, moreComing: true })).toBe('caught_up');
  });

  it('Caught up → Watching when the next episode lands', () => {
    expect(status({ watched: 8, total: 9, nextAvailable: true, nextIsNew: true, moreComing: true })).toBe('watching');
  });

  it('Caught up never pauses: waiting on a new episode is not losing interest', () => {
    expect(status({ watched: 8, total: 8, nextAvailable: false, moreComing: true, lastPlayedAt: days(100) })).toBe('caught_up');
  });

  it('Completed → Rewatching when an episode is played again, while the rewatch is recent', () => {
    expect(status({ watched: 12, nextAvailable: false, rewatching: true })).toBe('rewatching');
    expect(status({ watched: 12, nextAvailable: false, rewatching: true, lastPlayedAt: days(60) })).toBe('completed');
  });

  it('Dropped is only the owner’s, and holds until the owner watches again', () => {
    const at = days(10);
    expect(status({ manual: { status: 'dropped', at }, lastPlayedAt: days(20) })).toBe('dropped');
    expect(status({ manual: { status: 'dropped', at }, lastPlayedAt: days(1) })).toBe('watching');
    // Nothing derived ever produces Dropped on its own.
    expect(status({ lastPlayedAt: days(400) })).toBe('paused');
  });

  it('Plan to watch is the owner’s, and ends at the first watched episode', () => {
    expect(status({ manual: { status: 'plan_to_watch', at: days(5) }, watched: 0, lastPlayedAt: null })).toBe('plan_to_watch');
    expect(status({ manual: { status: 'plan_to_watch', at: days(5) }, watched: 1 })).toBe('watching');
  });

  it('every input gives exactly one status', () => {
    const seen = new Set<string>();
    for (const watched of [0, 5, 12]) for (const nextAvailable of [true, false]) for (const moreComing of [true, false]) for (const recent of [true, false]) for (const rewatching of [true, false]) {
      seen.add(status({ watched, nextAvailable: watched === 12 ? false : nextAvailable, moreComing, lastPlayedAt: recent ? days(1) : days(90), rewatching }));
    }
    for (const s of seen) expect(STATUSES).toContain(s);
  });
});
