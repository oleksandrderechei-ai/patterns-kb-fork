/**
 * The rows an implements edge may pin: the body rows of a mapping or matrix
 * block, each with its label, and nothing outside those blocks.
 */

import { describe, expect, it } from 'vitest';

import { STORE_PAGE } from './fixtures.js';
import { mapRows } from './map-rows.js';

describe('mapRows', () => {
  it('keeps body rows of the mapping and matrix blocks only, each with its first cell as its label', () => {
    const matrix = '## Side by side\n<!--meta block=matrix-->\n\n| Condition | A |\n| --- | --- |\n| Scale | yes |\n';
    const choosing = '## Choosing\n<!--meta block=choosing-->\n\n| x | y |\n| --- | --- |\n| 1 | 2 |\n';
    expect([...mapRows(STORE_PAGE)]).toEqual([
      ['mapping-row-1', 'Blobs'],
      ['mapping-row-2', 'Queues'],
    ]);
    expect([...mapRows(matrix + choosing)]).toEqual([['matrix-row-1', 'Scale']]);
    // A table above the first block heading sits in no block at all.
    expect([...mapRows('| a | b |\n| --- | --- |\n| 1 | 2 |\n')]).toEqual([]);
  });


  it('reads a label as plain text, its link and emphasis taken off', () => {
    const page = '## Mapping\n<!--meta block=mapping-->\n\n| Capability | AWS |\n| --- | --- |\n| **Managed** [cache](../x.md) | ElastiCache |\n';
    expect([...mapRows(page)]).toEqual([['mapping-row-1', 'Managed cache']]);
  });
});
