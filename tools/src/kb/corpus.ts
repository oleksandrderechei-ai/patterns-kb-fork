/**
 * The knowledge base as kb.mjs v2 reads it: every page of the seven kinds,
 * found through `docs/data/site-structure.json`, its facts read through the
 * one frontmatter door (tools/src/lib/frontmatter.ts), and the three data
 * files a page's neighbours live in — `content-model.json` (kinds, blocks,
 * verbs), `relations.json` (typed edges) and `learning-paths.json` (tours).
 *
 * A page body is parsed by tools/src/kb/page.ts, through
 * tools/src/lib/kb-attrs.ts; the corpus keeps the parse (`doc`) and answers
 * what needs the whole corpus: which page a link names (`linkTarget`) and which
 * pages a page mentions in its prose (`mentions`). Everything is read on first
 * use and kept, so a command pays only for what it asks: `get` reads one
 * page's frontmatter with the rest, in one spawn, and no body but its own.
 *
 * A page's KIND is the top folder of its markdown under docs/ (dialect X-03);
 * its band and group are what scripts/kb.mjs printed: for a pattern, the area
 * under `patterns` and the page's own area; for every other kind, the kind
 * itself, twice. tools/src/lib/kb-place.ts works that out.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { frontmatterMany, listOf, type FmValue } from '../lib/frontmatter.js';
import { placeOf, type AreaRef } from '../lib/kb-place.js';
import { relationGroups, type RelationsFile, type Verbs } from '../lib/render-relations.js';
import { pageCategories } from '../lib/search-score.js';

import { DiskCache } from './disk-cache.js';
import { parsePage, proseLinks, type PageDoc } from './page.js';

/** The repo this module sits in: tools/src/kb → the root. */
export const REPO = path.resolve(fileURLToPath(import.meta.url), '../../../..');

export const DATA = {
  structure: 'docs/data/site-structure.json',
  model: 'docs/data/content-model.json',
  relations: 'docs/data/relations.json',
  paths: 'docs/data/learning-paths.json',
  tags: 'docs/data/tags.json',
} as const;

/** The order scripts/kb.mjs lists kinds in (build.mjs KIND_SEQ). */
export const KIND_SEQ = ['pattern', 'hazard', 'theme', 'principle', 'design', 'capability', 'comparison'] as const;

/** A lookup failure, a refusal or a finding a command reports and exits 1 on: the call was well formed. */
export class KbError extends Error {}

/**
 * The call itself is wrong — an unknown command or flag, a flag with no value,
 * a missing argument. `run` exits 2 on it, so a script can tell a call that
 * was made badly from one that was made well and found nothing.
 */
export class KbUsageError extends KbError {}

export interface Kind {
  readonly id: string;
  readonly folder: string;
  readonly blocks: readonly string[];
  readonly optional: readonly string[];
}

export interface ContentModel {
  readonly kinds: readonly Kind[];
  readonly verbs: Verbs;
  /** Verb labels in display order (REL_ORDER). */
  readonly relOrder: readonly string[];
  readonly sketchLangs: readonly string[];
  /** A sketch language only some pages may use: its id, with the kind and area that may. */
  readonly sketchOnly: Readonly<Record<string, { readonly kind: string; readonly area: string }>>;
  /** block → the section fact its `###` groups carry and the values it takes. */
  readonly groups: Readonly<Record<string, { readonly fact: string; readonly values: readonly string[] }>>;
}

export interface Profile {
  readonly id: string;
  readonly label: string;
  readonly stages: readonly string[];
}

export interface PathNote {
  readonly role: string;
  readonly tour: string;
  readonly fluency: string;
  readonly heading?: string;
}

export interface Paths {
  readonly profiles: readonly Profile[];
  /** route → theme slug → note, each route's themes in its page's order. */
  readonly notes: Readonly<Record<string, Readonly<Record<string, PathNote>>>>;
}

/** One page, as the structure file and the kind folders place it. */
export interface Page {
  readonly slug: string;
  /** Today's route, `/` + the site path (dialect D-02). */
  readonly route: string;
  /** The route without its leading `/`: what scripts/kb.mjs printed as `path`. */
  readonly path: string;
  /** The markdown, repo-relative. */
  readonly source: string;
  readonly area: string;
  /** The area that lists the page and every area it nests under, outermost first. */
  readonly areaChain: readonly AreaRef[];
  readonly kind: string;
  readonly band: string;
  readonly group: string;
  /** The shelves the page sits on: its area chain's labels, outermost first, then its kind in a reader's words. */
  readonly categories: readonly string[];
}

/** A page's frontmatter, in the shape the reader prints; a key the page lacks reads as `''` or `[]`. */
export interface Meta {
  readonly title: string;
  readonly essence: string;
  readonly area: string;
  readonly status: string;
  readonly owner: string;
  readonly aliases: readonly string[];
  readonly tags: readonly string[];
  readonly solves: readonly string[];
  readonly favourite: boolean;
}

/** A theme a page belongs to, as scripts/kb.mjs printed `themes`. */
export interface ThemeRef {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly href: string;
}

interface Area {
  readonly id: string;
  readonly label?: string;
  readonly nestUnder?: string;
  readonly pages: readonly { readonly slug: string; readonly source: string; readonly route: string }[];
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A data file as an object, or a KbError naming it. */
export function readJsonFile(root: string, rel: string): Record<string, unknown> {
  const abs = path.join(root, rel);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new KbError(`cannot read ${rel}: ${(e as Error).message}`);
  }
  if (!isObject(parsed)) throw new KbError(`${rel} is not a JSON object`);
  return parsed;
}

/** The content model's kinds, verbs and vocabularies. */
export function readModel(root: string): ContentModel {
  const m = readJsonFile(root, DATA.model) as {
    kinds: Kind[];
    relations: { verbs: { id: string; label: string; inverse: string }[]; order: string[] };
    sketchLangs: { id: string; only?: { kind: string; area: string } }[];
    groups: Record<string, { fact: string; values: string[] }>;
  };
  const verbs: Record<string, { label: string; inverse: string; symmetric?: boolean }> = {};
  for (const v of m.relations.verbs) verbs[v.id] = { label: v.label, inverse: v.inverse, ...(v.inverse === v.id ? { symmetric: true } : {}) };
  return {
    kinds: m.kinds,
    verbs,
    // The model lists every verb it orders: it is generated from one table.
    relOrder: m.relations.order.map((id) => (verbs[id] as { label: string }).label),
    sketchLangs: m.sketchLangs.map((l) => l.id),
    sketchOnly: Object.fromEntries(m.sketchLangs.flatMap((l) => (l.only === undefined ? [] : [[l.id, l.only]]))),
    groups: m.groups,
  };
}

/**
 * Every page the structure file lists under one of the seven kinds, in
 * structure order. A page in any other area (reference, concepts) is not a
 * knowledge-base page and is left out, as scripts/kb.mjs never saw it.
 */
export function readPages(root: string, model: ContentModel): Page[] {
  const raw = readJsonFile(root, DATA.structure)['areas'];
  const areas = (Array.isArray(raw) ? raw : []) as Area[];
  const out: Page[] = [];
  for (const a of areas) {
    for (const p of a.pages ?? []) {
      // Kind is the top folder under docs/, not the top area (dialect X-03):
      // three theme pages sit in a designs tier and are still themes.
      const place = placeOf({ areas }, model.kinds, { area: a.id, source: p.source });
      if (place === null) continue;
      out.push({
        slug: p.slug,
        route: p.route,
        path: p.route.replace(/^\//, ''),
        source: p.source,
        ...place,
        categories: pageCategories(
          place.areaChain.map((c) => c.label),
          place.kind,
        ),
      });
    }
  }
  return out;
}

/** A structure row outside the seven kinds (a reference page), with the area that lists it. */
export interface OtherRow {
  readonly source: string;
  readonly route: string;
  readonly area: string;
}

/** Every structure row `readPages` leaves out, in structure order. */
export function readOtherRows(root: string, model: ContentModel): OtherRow[] {
  const raw = readJsonFile(root, DATA.structure)['areas'];
  const areas = (Array.isArray(raw) ? raw : []) as Area[];
  const folders = new Set(model.kinds.map((k) => k.folder));
  return areas.flatMap((a) =>
    (a.pages ?? []).filter((p) => !(p.source.startsWith('docs/') && folders.has(p.source.split('/')[1] as string))).map((p) => ({ source: p.source, route: p.route, area: a.id })),
  );
}

/** A frontmatter value as a list: an inline list's items, a scalar as one, absent as none. */
function asList(v: FmValue | undefined): string[] {
  const l = listOf(v);
  if (l !== null) return [...l];
  return typeof v === 'string' && v !== '' ? [v] : [];
}

export function metaOf(fm: Readonly<Record<string, FmValue>>): Meta {
  const s = (k: string): string => {
    const v = fm[k];
    return typeof v === 'string' ? v : '';
  };
  return {
    title: s('title'),
    essence: s('description'),
    area: s('area'),
    status: s('status'),
    owner: s('owner'),
    aliases: asList(fm['aliases']),
    tags: asList(fm['tags']),
    solves: asList(fm['solves']),
    favourite: s('favourite') === 'true',
  };
}

/** The whole corpus, read lazily. */
export class Corpus {
  readonly root: string;
  #model?: ContentModel;
  #pages?: Page[];
  #bySlug?: Map<string, Page>;
  #fm?: Map<string, Readonly<Record<string, FmValue>>>;
  #meta?: Map<string, Meta>;
  #relations?: RelationsFile;
  #paths?: Paths;
  #themes?: Map<string, ThemeRef[]>;
  readonly #bodies = new Map<string, string>();
  readonly #cache = new Map<string, unknown>();
  #disk?: DiskCache;

  constructor(root: string) {
    this.root = root;
  }

  /**
   * A value worked out from one page's text alone, kept on disk between runs
   * (./disk-cache.ts): what `find` and `backlinks` would otherwise parse every
   * page for on every call.
   */
  derived<T>(slug: string, facet: string, make: () => T): T {
    this.#disk ??= new DiskCache(this.root);
    return this.#disk.get(this.text(slug), facet, make);
  }

  /** Write what `derived` added this run. */
  saveDerived(): void {
    this.#disk?.save();
  }

  /**
   * A value worked out from the corpus, kept for the corpus's lifetime: a
   * parsed page, a prose index. One corpus serving many commands (a test, a
   * batch) pays for each once.
   */
  cached<T>(key: string, make: () => T): T {
    if (this.#cache.has(key)) return this.#cache.get(key) as T;
    const v = make();
    this.#cache.set(key, v);
    return v;
  }

  get model(): ContentModel {
    return (this.#model ??= readModel(this.root));
  }

  get pages(): readonly Page[] {
    return (this.#pages ??= readPages(this.root, this.model));
  }

  /** Pages in the order scripts/kb.mjs listed them: by kind, then reading order. */
  get listing(): readonly Page[] {
    const rank = (k: string): number => (KIND_SEQ as readonly string[]).indexOf(k);
    return [...this.pages].sort((a, b) => rank(a.kind) - rank(b.kind));
  }

  /** The structure rows of no kind: read only when a lookup needs to say why a file is not a page. */
  get otherRows(): readonly OtherRow[] {
    return this.cached('otherRows', () => readOtherRows(this.root, this.model));
  }

  page(slug: string): Page | undefined {
    this.#bySlug ??= new Map(this.pages.map((p) => [p.slug, p]));
    return this.#bySlug.get(slug);
  }

  /**
   * The page, or a KbError in scripts/kb.mjs's words, with near misses. No id
   * at all is a KbUsageError: the caller passes the positional it was given.
   */
  need(slug: string | undefined): Page {
    if (slug === undefined) throw new KbUsageError('unknown id: (none given)');
    const p = this.page(slug);
    if (p !== undefined) return p;
    const near = this.pages.map((x) => x.slug).filter((k) => k.includes(slug)).slice(0, 5);
    throw new KbError(`unknown id: ${slug}${near.length > 0 ? `\ndid you mean: ${near.join(', ')}` : ''}`);
  }

  /**
   * A page's frontmatter as the door reads it, lists split: every page's, read
   * in one spawn on first use. A page whose file is missing has none.
   */
  frontmatter(slug: string): Readonly<Record<string, FmValue>> {
    if (this.#fm === undefined) {
      const sources = this.pages.map((p) => p.source).filter((s) => fs.existsSync(path.join(this.root, s)));
      const fm = sources.length === 0 ? new Map<string, Record<string, FmValue>>() : frontmatterMany(this.root, sources, { lists: true });
      this.#fm = new Map(this.pages.map((p) => [p.slug, fm.get(p.source) ?? {}]));
    }
    return this.#fm.get(slug) ?? {};
  }

  /** A page's frontmatter in the shape the reader prints. */
  meta(slug: string): Meta {
    this.#meta ??= new Map(this.pages.map((p) => [p.slug, metaOf(this.frontmatter(p.slug))]));
    return this.#meta.get(slug) ?? metaOf({});
  }

  /** A page's markdown, frontmatter included. */
  text(slug: string): string {
    const cached = this.#bodies.get(slug);
    if (cached !== undefined) return cached;
    const p = this.need(slug);
    let t: string;
    try {
      t = fs.readFileSync(path.join(this.root, p.source), 'utf8');
    } catch {
      throw new KbError(`${slug}: cannot read ${p.source}`);
    }
    this.#bodies.set(slug, t);
    return t;
  }

  /** A page parsed into its blocks and marked regions (tools/src/kb/page.ts), once for the life of the corpus. */
  doc(slug: string): PageDoc {
    return this.cached(`doc:${slug}`, () => parsePage(this.text(slug)));
  }

  /**
   * The SHA-256 of a page's file, as hex: the bytes on disk, so that anyone
   * holding the file, or its `.md` copy on the site, can tell it is the one a
   * record describes.
   */
  digest(slug: string): string {
    const p = this.need(slug);
    try {
      return createHash('sha256').update(fs.readFileSync(path.join(this.root, p.source))).digest('hex');
    } catch {
      throw new KbError(`${slug}: cannot read ${p.source}`);
    }
  }

  /**
   * The page a link url names, written in the page whose markdown is
   * `fromSource`: a route (`/patterns/x.html`) or a relative path to a `.md`
   * file, its query and fragment left out. An address elsewhere, a file that is
   * not markdown and a page of none of the seven kinds name no page.
   */
  linkTarget(fromSource: string, url: string): Page | undefined {
    const bare = (url.split('#')[0] as string).split('?')[0] as string;
    if (/^[a-z]+:|^\/\//i.test(bare)) return undefined;
    if (bare.startsWith('/')) return this.byRoute(bare);
    if (!bare.endsWith('.md')) return undefined;
    const source = path.posix.normalize(path.posix.join(path.posix.dirname(fromSource), bare));
    return this.pages.find((p) => p.source === source);
  }

  /**
   * A page's prose mentions: the pages it links to in its prose, first mention
   * only, less itself and every page a typed relation, a theme it belongs to or
   * its own tour already names. What `backlinks` lists as `mentions`.
   */
  mentions(slug: string): string[] {
    return this.cached(`mentions:${slug}`, () => {
      const page = this.need(slug);
      const declared = new Set<string>([
        ...relationGroups(slug, this.relations, this.model.verbs, this.model.relOrder).flatMap((g) => g.sides.map((s) => s.to)),
        ...this.themesOf(slug).map((t) => t.id),
        ...this.membersOf(slug).map((m) => m.id),
      ]);
      const out: string[] = [];
      for (const url of this.derived(slug, 'links', () => proseLinks(this.doc(slug)))) {
        if (!url.split('#')[0]?.endsWith('.md')) continue;
        const t = this.linkTarget(page.source, url)?.slug;
        if (t === undefined || t === slug || declared.has(t) || out.includes(t)) continue;
        out.push(t);
      }
      return out;
    });
  }

  get relations(): RelationsFile {
    return (this.#relations ??= readJsonFile(this.root, DATA.relations) as unknown as RelationsFile);
  }

  get paths(): Paths {
    return (this.#paths ??= readJsonFile(this.root, DATA.paths) as unknown as Paths);
  }

  /** The page a route names, if any. */
  byRoute(route: string): Page | undefined {
    return this.pages.find((p) => p.route === route);
  }

  /**
   * The themes whose tour holds a page, in hub order, each with the role the
   * tour gives it — scripts/kb.mjs's `themes`. A theme's own entry is [].
   */
  themesOf(slug: string): readonly ThemeRef[] {
    if (this.#themes === undefined) {
      this.#themes = new Map();
      for (const prof of this.paths.profiles) {
        const theme = this.page(prof.id);
        if (theme === undefined) continue;
        for (const route of prof.stages) {
          const member = this.byRoute(route);
          if (member === undefined) continue;
          const list = this.#themes.get(member.slug) ?? [];
          list.push({ id: prof.id, name: this.meta(prof.id).title, role: this.paths.notes[route]?.[prof.id]?.role ?? '', href: theme.path });
          this.#themes.set(member.slug, list);
        }
      }
    }
    return this.#themes.get(slug) ?? [];
  }

  /** A theme's tour: its members in stage order, with their roles. */
  membersOf(slug: string): { readonly id: string; readonly role: string }[] {
    const prof = this.paths.profiles.find((p) => p.id === slug);
    if (prof === undefined) return [];
    return prof.stages.map((route) => ({
      id: this.byRoute(route)?.slug ?? route,
      role: this.paths.notes[route]?.[slug]?.role ?? '',
    }));
  }
}

/** The root a command runs against: `KB_ROOT` when set (as scripts/kb.mjs honours it), else this repo. */
export function rootFrom(env: NodeJS.ProcessEnv): string {
  const r = env['KB_ROOT'];
  return r !== undefined && r !== '' ? path.resolve(r) : REPO;
}
