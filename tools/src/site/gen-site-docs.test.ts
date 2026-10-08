/**
 * The mirror (spec kb.generation.mirror-and-hubs, mirror and link-rewrite;
 * kb.generation.output-ownership for what it may delete), and
 * mirror-and-hubs-O1.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expectFail, expectMisuse, expectPass, makeSandbox, type Sandbox } from '../lib/sandbox.js';
import { frontmatterEnd, normalizePath, rewriteTarget, spec, transformBody } from './gen-site-docs.js';
import { docsTree, frontmatter, STRUCTURE } from './site-fixtures.js';
import { CONTENT, REPO_BLOB } from './site-output.js';

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

describe('mirror-and-hubs-O1', () => {
  it('mirror-and-hubs-O1: frontmatter kept byte for byte, the H1 gone, a page link a route, a script link the repository URL, the code span untouched', async () => {
    docsTree(sb);
    const head = frontmatter('Alpha');
    sb.write(
      'docs/patterns/caching/alpha.md',
      `${head}\n# Alpha\n\nSee [Beta](./beta.md), run [the tool](../../../scripts/tool.sh), or write \`[the tool](../../../scripts/tool.sh)\`.\n`,
    );
    sb.write('scripts/tool.sh', 'true\n');
    const r = await sb.run(spec);
    expectPass(r);
    const out = sb.read(`${CONTENT}/patterns/caching/alpha.md`);
    expect(out.startsWith(head)).toBe(true);
    expect(out).not.toMatch(/^# /m);
    expect(out).toContain('[Beta](/patterns/caching/beta.html)');
    expect(out).toContain(`[the tool](${REPO_BLOB}/scripts/tool.sh)`);
    expect(out).toContain('`[the tool](../../../scripts/tool.sh)`');
  });
});

describe('gen-site-docs', () => {
  it('writes every published page at its route and prints one line counting them', async () => {
    docsTree(sb);
    const r = await sb.run(spec);
    expectPass(r);
    expect(r.out).toBe(`[gen-site-docs] wrote 3 pages to ${CONTENT}/`);
    expect(sb.read(`${CONTENT}/patterns/caching/alpha.md`)).toContain(
      'Alpha keeps answers. See [Beta](/patterns/caching/beta.html#why) and [Gamma](/hazards/gamma.html).',
    );
    expect(sb.exists(`${CONTENT}/hazards/gamma.md`)).toBe(true);
  });

  it('does not mirror the rows of an unpublished (`nav: none`) area, and links a page to one at its file on GitHub', async () => {
    docsTree(sb, {
      areas: STRUCTURE.areas.map((a) => (a.id === 'hazards' ? { ...a, nav: 'none' as const } : a)),
    });
    const r = await sb.run(spec);
    expectPass(r);
    expect(r.out).toBe(`[gen-site-docs] wrote 2 pages to ${CONTENT}/`);
    expect(sb.exists(`${CONTENT}/hazards/gamma.md`)).toBe(false);
    expect(sb.read(`${CONTENT}/patterns/caching/alpha.md`)).toContain(`[Gamma](${REPO_BLOB}/docs/hazards/gamma.md)`);
  });

  it('names a page with missing keys — every key — and one with no frontmatter, writing nothing', async () => {
    docsTree(sb);
    sb.write('docs/patterns/caching/beta.md', '---\ntitle: Beta\ndescription: d\narea: caching\n---\n\n# Beta\n');
    sb.write('docs/hazards/gamma.md', '# Gamma\n\nNo facts.\n');
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err.split('\n')).toEqual([
      '[gen-site-docs] FAIL docs/patterns/caching/beta.md: is missing required frontmatter: owner tags',
      '[gen-site-docs] FAIL docs/hazards/gamma.md: has no frontmatter — a published page needs: title description area owner tags',
    ]);
    expect(sb.exists(CONTENT)).toBe(false);
  });

  it('names an area outside the closed list at its line in the page under docs/, writing nothing', async () => {
    docsTree(sb);
    sb.write('docs/hazards/gamma.md', sb.read('docs/hazards/gamma.md').replace(/^area: .*$/m, 'area: nowhere'));
    const lines = sb.read('docs/hazards/gamma.md').split('\n');
    const at = (key: string): number => lines.findIndex((l) => l.startsWith(`${key}:`)) + 1;
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err.split('\n')).toEqual([
      `[gen-site-docs] FAIL docs/hazards/gamma.md:${at('area')}: area 'nowhere' is not in the closed list — use an area id docs/data/site-structure.json holds`,
    ]);
    expect(sb.exists(CONTENT)).toBe(false);
  });

  it("copies nothing for a generated area's rows: its generator writes them", async () => {
    docsTree(sb, {
      areas: [
        ...STRUCTURE.areas,
        {
          id: 'map',
          label: 'Map',
          generated: 'tools/src/site/gen-map-pages.ts',
          hub: { description: 'Two views', intro: 'Two views.', tags: ['caching', 'performance'] },
          pages: [{ slug: 'stack', label: 'From Pattern to Product', source: 'generated', route: '/map/stack.html' }],
        },
      ],
    });
    const r = await sb.run(spec);
    expectPass(r);
    expect(r.out).toBe(`[gen-site-docs] wrote 3 pages to ${CONTENT}/`);
    expect(sb.exists(`${CONTENT}/map`)).toBe(false);
  });

  it('names a row whose source is missing', async () => {
    docsTree(sb);
    sb.rm('docs/hazards/gamma.md');
    expectFail(await sb.run(spec), 'docs/hazards/gamma.md: is listed in the structure file for /hazards/gamma.html and does not exist');
  });

  it('removes the last build’s pages and the folders they leave empty, before writing', async () => {
    docsTree(sb);
    expectPass(await sb.run(spec));
    sb.write(`${CONTENT}/patterns/caching/alpha.md`, 'hand edit to a mirrored page\n');
    sb.write(`${CONTENT}/gone/area/old.md`, 'a page whose area left\n');
    sb.write(`${CONTENT}/patterns/index.mdx`, 'a hub: the hub generator’s to replace, not the mirror’s\n');
    const structure = { areas: STRUCTURE.areas.filter((a) => a.id !== 'hazards') };
    sb.write('docs/data/site-structure.json', JSON.stringify(structure));
    expectPass(await sb.run(spec));
    expect(sb.read(`${CONTENT}/patterns/caching/alpha.md`)).toContain('Alpha keeps answers.');
    expect(sb.exists(`${CONTENT}/gone`)).toBe(false);
    expect(sb.exists(`${CONTENT}/hazards`)).toBe(false);
    expect(sb.exists(`${CONTENT}/patterns/index.mdx`)).toBe(true);
  });

  it('leaves a hand-written page in the input folder alone, with one note, even at a page’s path', async () => {
    docsTree(sb);
    sb.write(`${CONTENT}/index.mdx`, 'hand-written home\n');
    sb.write(`${CONTENT}/hazards/gamma.md`, 'hand-written, committed\n');
    sb.git('add', '-f', `${CONTENT}/hazards/gamma.md`, `${CONTENT}/index.mdx`);
    sb.git('commit', '-qm', 'hand-written');
    const r = await sb.run(spec);
    expectPass(r);
    expect(r.out).toBe(`[gen-site-docs] wrote 2 pages to ${CONTENT}/`);
    expect(r.err).toBe(`[gen-site-docs] note: ${CONTENT}/hazards/gamma.md is hand-written — leaving it alone, so docs/hazards/gamma.md is not mirrored`);
    expect(sb.read(`${CONTENT}/hazards/gamma.md`)).toBe('hand-written, committed\n');
    expect(sb.read(`${CONTENT}/index.mdx`)).toBe('hand-written home\n');
  });

  it('mirrors an escaped link as the text it is: the target of `\\[Beta\\](./beta.md)` stays as written beside a real link', async () => {
    docsTree(sb);
    sb.write('docs/patterns/caching/alpha.md', `${frontmatter('Alpha')}\n# Alpha\n\nA \\[Beta\\](./beta.md) is text, a [Beta](./beta.md) is a link.\n`);
    expectPass(await sb.run(spec));
    expect(sb.read(`${CONTENT}/patterns/caching/alpha.md`)).toContain('A \\[Beta\\](./beta.md) is text, a [Beta](/patterns/caching/beta.html) is a link.');
  });

  it('writes the same bytes twice over', async () => {
    docsTree(sb);
    expectPass(await sb.run(spec));
    const once = sb.snapshot();
    expectPass(await sb.run(spec));
    expect(sb.snapshot()).toEqual(once);
  });

  it('exits 2 on --check or any unknown argument, writing nothing', async () => {
    docsTree(sb);
    const before = sb.snapshot();
    expectMisuse(await sb.run(spec, ['--check']));
    expectMisuse(await sb.run(spec, ['--nope']));
    expect(sb.snapshot()).toEqual(before);
  });

  it('fails when git cannot say what the build owns', async () => {
    docsTree(sb);
    sb.write('.git/index', 'not an index');
    await expect(sb.run(spec)).rejects.toThrow(/git cannot say which files under site\/src\/content\/docs are build output/);
  });
});

describe('the pieces', () => {
  it('finds the frontmatter’s closing line, or none', () => {
    expect(frontmatterEnd('---\na: b\n---\nbody')).toBe(3);
    expect(frontmatterEnd('---\r\na: b\r\n---\r\n')).toBe(3);
    expect(frontmatterEnd('# no frontmatter')).toBe(0);
    expect(frontmatterEnd('---\nnever closed\n')).toBe(0);
  });

  it('resolves a path against a folder, never climbing out of the repository', () => {
    expect(normalizePath('docs/a/b', '../c.md')).toBe('docs/a/c.md');
    expect(normalizePath('docs', '../../../x.md')).toBe('x.md');
    expect(normalizePath('docs', './y/./z.md')).toBe('docs/y/z.md');
  });

  it('keeps external, fragment-only, root-absolute and empty targets', () => {
    const routes = new Map([['docs/a.md', '/a.html']]);
    for (const t of ['https://x.io/a', 'mailto:a@b.c', '#top', '/abs.html', '']) expect(rewriteTarget(t, 'docs', routes)).toBe(t);
    expect(rewriteTarget('a.md#f', 'docs', routes)).toBe('/a.html#f');
    expect(rewriteTarget('b.md', 'docs', routes)).toBe(`${REPO_BLOB}/docs/b.md`);
  });

  it('rewrites a link, but not the target after an escaped bracket: an odd run of backslashes before the `]` makes it text', () => {
    const body = [
      'Real [x](a.md), escaped \\[x\\](a.md), and one more [y](a.md).',
      'Two backslashes leave the bracket a link, [z\\\\](a.md); three escape it, \\[z\\\\\\](a.md).',
      'In a span, `\\[x\\](a.md)` and `[x](a.md)` nothing moves.',
    ].join('\n');
    expect(transformBody(body, 'docs', new Map([['docs/a.md', '/a.html']])).split('\n')).toEqual([
      'Real [x](/a.html), escaped \\[x\\](a.md), and one more [y](/a.html).',
      'Two backslashes leave the bracket a link, [z\\\\](/a.html); three escape it, \\[z\\\\\\](a.md).',
      'In a span, `\\[x\\](a.md)` and `[x](a.md)` nothing moves.',
    ]);
  });

  it('strips only the first H1 outside a fence, and rewrites nothing inside one', () => {
    const body = [
      '',
      '<!-- stamp -->',
      '',
      '```md',
      '# not the title [x](a.md)',
      '```',
      '# Title',
      '',
      'Text [x](a.md).',
      '~~~~',
      '[y](a.md)',
      '~~~',
      '~~~~',
      '# Second',
    ].join('\n');
    const out = transformBody(body, 'docs', new Map([['docs/a.md', '/a.html']]));
    expect(out.split('\n')).toEqual([
      '<!-- stamp -->',
      '',
      '```md',
      '# not the title [x](a.md)',
      '```',
      '',
      'Text [x](/a.html).',
      '~~~~',
      '[y](a.md)',
      '~~~',
      '~~~~',
      '# Second',
    ]);
  });
});
