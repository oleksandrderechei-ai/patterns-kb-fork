// @vitest-environment node
/**
 * The pattern-to-product tables, rendered over the real tree: the summary, a
 * band's rows with the pattern as each row's header, the last column the one
 * that takes the slack, and the refusal to draw a band nobody holds. Which
 * cells a row gets is tools/src/lib/site-map.ts's, tested there. The `node`
 * docblock is the one every render test needs (see
 * ../SectionHub/section-hub.render.test.ts).
 */
import { describe, expect, it } from 'vitest';

import { renderComponent } from '../../lib/render-fixture';

import StackIndex from './StackIndex.astro';

/** The rendered markup with the whitespace between tags taken out, so a test reads structure, not layout. */
const render = async (props: Record<string, unknown> = {}): Promise<string> =>
  (await renderComponent(StackIndex, { props })).replace(/>\s+</g, '><');

describe('StackIndex', () => {
  it('says how many patterns and rows the index holds, with no band', async () => {
    const html = await render();
    expect(html).toMatch(
      /All \d+ patterns in one index, in \d+ rows: \d+ sold ready-made by a cloud, \d+ that no\s+cloud sells by nature, and \d+ not mapped yet\./,
    );
    expect(html).not.toContain('<table');
  });

  it("draws a band's table: a row header per pattern, four service columns, the last one taking the slack", async () => {
    const html = await render({ band: 'distributed' });
    expect(html).toContain(
      '<th scope="col">Pattern</th><th scope="col">AWS</th><th scope="col">Azure</th><th scope="col">Google Cloud</th><th scope="col">Open source</th>',
    );
    expect(html).toMatch(
      /<tr id="stack-circuit-breaker" class="kb-stack-row kb-stack-row--(mapped|linked|none|gap)"><th scope="row"><a href="\/patterns\/distributed\/resilience\/circuit-breaker\.html">Circuit Breaker<\/a>/,
    );
    const row = /<tr id="stack-circuit-breaker"[\s\S]*?<\/tr>/.exec(html)?.[0] ?? '';
    expect(row.match(/<td/g)).toHaveLength(4);
    expect(row.match(/kb-cell-prose/g)).toHaveLength(1);
    expect(row.lastIndexOf('<td')).toBe(row.indexOf('<td class="kb-cell-prose"'));
  });

  it('says why a band has nothing for sale', async () => {
    const html = await render({ band: 'gof' });
    expect(html).toContain('<strong>No cloud sells these.</strong>');
  });

  it('refuses a band that holds no pattern', async () => {
    await expect(render({ band: 'no-such-band' })).rejects.toThrow(
      'StackIndex: no band "no-such-band" holds a pattern',
    );
  });
});
