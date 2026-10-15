import { describe, expect, it } from 'vitest';
import { SPECIES_NAMES, createNamePicker } from './speciesNames';

describe('SPECIES_NAMES', () => {
  it('has 100 distinct, non-empty names', () => {
    expect(SPECIES_NAMES).toHaveLength(100);
    expect(new Set(SPECIES_NAMES).size).toBe(100);
    for (const name of SPECIES_NAMES) expect(name.trim()).toBe(name);
    expect(SPECIES_NAMES.every((name) => name.length > 0)).toBe(true);
  });

  it('contains only Korean transliterations of scientific names', () => {
    for (const name of SPECIES_NAMES) expect(name).toMatch(/^[가-힣]+( [가-힣]+){1,2}$/);
  });
});

describe('createNamePicker', () => {
  it('never repeats a name until all 100 were handed out', () => {
    const next = createNamePicker();
    const first = Array.from({ length: 100 }, next);
    expect(new Set(first).size).toBe(100);
  });

  it('starts over with a fresh shuffle afterwards', () => {
    const next = createNamePicker();
    const names = Array.from({ length: 200 }, next);
    expect(new Set(names.slice(100)).size).toBe(100);
  });

  it('is driven by the given random source', () => {
    // random() close to 1 keeps every element in place, so names come out from the end of the list.
    const unshuffled = createNamePicker(() => 0.999);
    expect([unshuffled(), unshuffled()]).toEqual([SPECIES_NAMES[99], SPECIES_NAMES[98]]);

    const seeded = () => {
      let state = 42;
      return () => (state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296) / 4_294_967_296;
    };
    const a = Array.from({ length: 10 }, createNamePicker(seeded()));
    const b = Array.from({ length: 10 }, createNamePicker(seeded()));
    expect(a).toEqual(b);
  });

  it('gives different orders for different runs', () => {
    const a = Array.from({ length: 10 }, createNamePicker());
    const b = Array.from({ length: 10 }, createNamePicker());
    expect(a).not.toEqual(b);
  });
});
