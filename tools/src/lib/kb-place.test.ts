/**
 * Where a page sits: its kind from the folder of its markdown, its band and
 * group from the area that lists it, and the chain of areas above that one,
 * outermost first. Placement must hold on a structure the gate would refuse,
 * since a reader of one page is never to be stopped by another's row.
 */

import { describe, expect, it } from 'vitest';

import { placeOf, type PlaceKind, type PlaceStructure } from './kb-place.js';

const KINDS: readonly PlaceKind[] = [
  { id: 'pattern', folder: 'patterns' },
  { id: 'hazard', folder: 'hazards' },
  { id: 'design', folder: 'designs' },
  { id: 'theme', folder: 'themes' },
];

const STRUCTURE: PlaceStructure = {
  areas: [
    { id: 'patterns', label: 'Patterns' },
    { id: 'distributed', label: 'Distributed', nestUnder: 'patterns' },
    { id: 'distributed-resilience', label: 'Resilience', nestUnder: 'distributed' },
    { id: 'hazards' },
    { id: 'designs', label: 'Case Studies' },
    { id: 'designs-mid', label: 'Mid-level', nestUnder: 'designs' },
    { id: 'themes', label: 'Themes' },
    { id: 'loop-a', label: 'A', nestUnder: 'loop-b' },
    { id: 'loop-b', label: 'B', nestUnder: 'loop-a' },
    { id: 'orphan', label: 'Orphan', nestUnder: 'missing' },
  ],
};

describe('placeOf', () => {
  it('places a pattern by the area under the root and the area that lists it', () => {
    expect(placeOf(STRUCTURE, KINDS, { area: 'distributed-resilience', source: 'docs/patterns/distributed/resilience/breaker.md' })).toEqual({
      kind: 'pattern',
      band: 'distributed',
      group: 'distributed-resilience',
      area: 'distributed-resilience',
      areaChain: [
        { id: 'patterns', label: 'Patterns' },
        { id: 'distributed', label: 'Distributed' },
        { id: 'distributed-resilience', label: 'Resilience' },
      ],
    });
  });

  it('is its own band when the root itself lists the pattern', () => {
    expect(placeOf(STRUCTURE, KINDS, { area: 'patterns', source: 'docs/patterns/top.md' })).toEqual({
      kind: 'pattern',
      band: 'patterns',
      group: 'patterns',
      area: 'patterns',
      areaChain: [{ id: 'patterns', label: 'Patterns' }],
    });
  });

  it('is its band and its group, for any other kind, whichever area lists it', () => {
    const hazard = placeOf(STRUCTURE, KINDS, { area: 'hazards', source: 'docs/hazards/storm.md' });
    expect(hazard).toMatchObject({ kind: 'hazard', band: 'hazard', group: 'hazard', area: 'hazards' });
    // A theme filed in a designs tier is a theme: the kind is the folder, not the area.
    expect(placeOf(STRUCTURE, KINDS, { area: 'designs-mid', source: 'docs/themes/loop.md' })).toEqual({
      kind: 'theme',
      band: 'theme',
      group: 'theme',
      area: 'designs-mid',
      areaChain: [
        { id: 'designs', label: 'Case Studies' },
        { id: 'designs-mid', label: 'Mid-level' },
      ],
    });
  });

  it('labels an area that has no label by its id', () => {
    expect(placeOf(STRUCTURE, KINDS, { area: 'hazards', source: 'docs/hazards/storm.md' })?.areaChain).toEqual([{ id: 'hazards', label: 'hazards' }]);
  });

  it('places nothing that is not under a kind’s folder in docs/', () => {
    expect(placeOf(STRUCTURE, KINDS, { area: 'patterns', source: 'docs/reference/notes.md' })).toBeNull();
    expect(placeOf(STRUCTURE, KINDS, { area: 'patterns', source: 'docs/index.md' })).toBeNull();
    // The folder name alone is not enough: the markdown must sit under docs/.
    expect(placeOf(STRUCTURE, KINDS, { area: 'patterns', source: 'other/patterns/x.md' })).toBeNull();
  });

  it('ends a chain that loops back on itself where it would repeat', () => {
    expect(placeOf(STRUCTURE, KINDS, { area: 'loop-a', source: 'docs/patterns/x.md' })).toMatchObject({
      band: 'loop-a',
      group: 'loop-a',
      areaChain: [
        { id: 'loop-b', label: 'B' },
        { id: 'loop-a', label: 'A' },
      ],
    });
  });

  it('roots a chain at a nestUnder the file does not hold, and places a listing area it does not hold', () => {
    expect(placeOf(STRUCTURE, KINDS, { area: 'orphan', source: 'docs/patterns/x.md' })).toMatchObject({
      band: 'orphan',
      areaChain: [
        { id: 'missing', label: 'missing' },
        { id: 'orphan', label: 'Orphan' },
      ],
    });
    expect(placeOf(STRUCTURE, KINDS, { area: 'nowhere', source: 'docs/patterns/x.md' })).toMatchObject({
      band: 'nowhere',
      group: 'nowhere',
      areaChain: [{ id: 'nowhere', label: 'nowhere' }],
    });
  });

  it('reads its inputs and changes none of them', () => {
    const before = JSON.stringify([STRUCTURE, KINDS]);
    placeOf(STRUCTURE, KINDS, { area: 'distributed-resilience', source: 'docs/patterns/distributed/resilience/breaker.md' });
    expect(JSON.stringify([STRUCTURE, KINDS])).toBe(before);
  });
});
