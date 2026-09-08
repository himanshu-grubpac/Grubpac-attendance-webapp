import { describe, expect, it } from 'vitest';
import { mergeAppendUnique } from './listMerge.js';

const byId = (list) => list.map((item) => item.id);

describe('mergeAppendUnique', () => {
  it('appends only unseen rows', () => {
    const current = [{ id: 'a' }, { id: 'b' }];
    const fresh = [{ id: 'b' }, { id: 'c' }];
    expect(byId(mergeAppendUnique(current, fresh))).toEqual(['a', 'b', 'c']);
  });

  it('drops a fully overlapping page and keeps referential stability', () => {
    const current = [{ id: 'a' }, { id: 'b' }];
    expect(mergeAppendUnique(current, [{ id: 'a' }, { id: 'b' }])).toBe(current);
  });

  it('tolerates empty or missing input', () => {
    expect(mergeAppendUnique([{ id: 'a' }], [])).toEqual([{ id: 'a' }]);
    expect(mergeAppendUnique(null, [{ id: 'a' }])).toEqual([{ id: 'a' }]);
    expect(mergeAppendUnique(undefined, undefined)).toEqual([]);
  });

  it('supports a custom id selector', () => {
    const current = [{ userId: 'u1' }];
    const merged = mergeAppendUnique(current, [{ userId: 'u1' }, { userId: 'u2' }], (item) => item.userId);
    expect(merged.map((item) => item.userId)).toEqual(['u1', 'u2']);
  });

  it('never drops rows without an id', () => {
    const merged = mergeAppendUnique([{}], [{}, { id: 'a' }]);
    expect(merged).toHaveLength(3);
    expect(merged.filter((item) => item.id === 'a')).toHaveLength(1);
  });

  it('collapses duplicates within the fresh page itself', () => {
    const merged = mergeAppendUnique([{ id: 'a' }], [{ id: 'b' }, { id: 'b' }, { id: 'c' }]);
    expect(merged.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });
});
