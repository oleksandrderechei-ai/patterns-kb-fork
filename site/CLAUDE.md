# Working in site/

The Astro + Starlight workspace that builds the knowledge base's site from the pages under
`docs/` into `dist/`. It holds no page of its own but the home page: `make site-build` mirrors
`docs/` into `src/content/docs/`, writes the hubs and the map pages there, bundles the client,
runs Astro and the post-build passes, then the site gates.

```bash
make site-build   # lint, unit tests, the build, then the site gates
make site-test    # the workspace's vitest suite; one file: T=<name>
make site-open    # open the built site from disk
make site-e2e     # the reader's flows over the built site, in a browser
```

Testing by hand, flow by flow: [Testing the site](../docs/concepts/testing-the-site.md).

## Layout

- `src/components/<Name>/`: one folder per component, each with its markup, stylesheet,
  behaviour module, tests and a nested `CLAUDE.md`; the
  [site-component](../.claude/skills/site-component/SKILL.md) skill scaffolds one.
- `src/styles/`: the shared stylesheets; colours come from `tokens.css` alone.
- `src/lib/`: the helpers the components and the content schema share; `types.ts` holds the
  AREAS and TAGS tuples the gates hold to the data files.
- `src/content/docs/`: build input. Only the top `index.mdx`, the home page, and `404.mdx`, the not-found page, are written by
  hand; the root `.gitignore` names everything the build writes there.
- `dist/`, `.astro/`, `coverage/`, `public/kb.js`: build output, never committed.

## Conventions

- **A page's content lives in `docs/`.** Change it there and rebuild; the mirror overwrites
  anything written under `src/content/docs/`.
- **Links are relative**, so the site opens from a folder and from GitHub Pages; the
  post-build pass rewrites routes. The one outbound link is a vendor's documentation, from
  [products.json](../docs/data/products.json).
- **No page loads anything from another origin.** Every script and font is bundled.
- **A class is paint; a fact is a bare `data-*` on a class-free element**
  ([page-schema](../.claude/rules/page-schema.md)).

## Don't

- **Don't edit `dist/` or the mirrored pages.** The next build replaces them.
- **Don't track built output**; the `build-untracked` gate fails it.
- **Don't write a colour literal outside `src/styles/tokens.css`**; the `site-tokens` gate
  fails it.
- **Don't add a dependency without its reason** in `package.json`; install scripts stay
  denied.
