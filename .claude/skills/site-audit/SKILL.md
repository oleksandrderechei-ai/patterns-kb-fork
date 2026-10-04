---
name: site-audit
description: "Look at the built Astro site as a reader does — pages, four widths, both themes — and report what is wrong in the chat, each finding a measurement. Use when the site is about to be shown, after a layout or token change, or when something looks off and no gate agrees. Not for markup quality (page-audit) or the accessibility gates."
---

# Audit the site with your eyes

The site's gates read every built page as text and, from P7, open each one in a browser for the
WCAG floor. Between them they hold everything a rule can state. This audit is the half no rule
states: whether a page is any good to look at. A table can silently clip its last column while
the document reports nothing to scroll and every check agrees the page is fine; a screenshot
shows the column that is not there. It applies to the Astro site, built from `docs/` into
`site/dist/`.

1. **Build what you are about to look at.** When the change touched a remark or rehype plugin in
   `site/astro.config.mjs`, delete `site/.astro/` first: the render cache is not keyed on the
   config, so the build succeeds and serves the old markup.

   ```bash
   make site-build
   ```

2. **Let the gates go first.** Contrast, labels and focusable regions are a gate's job; fix
   what they report before you look, and never put it in the report.

   ```bash
   make validate
   ```

3. **Photograph the matrix** with `make site-shots OUT=<folder outside the repo>`. It takes
   seven pages (the home page, the caching hub, the circuit-breaker pattern page, the
   singleton pattern page with its two-column polarity cards, the Bitly design page, the
   object-stores comparison with its wide table, the stack map), four widths (390, 900, 1280
   and 1600 pixels, one inside each layout band) and both themes — fifty-six images, named
   `<width>-<page>-<theme>.png`. Keep them outside the repo: they are evidence for one reading,
   not a baseline.
4. **Look at all fifty-six in a fixed order**, width by width, page by page, both themes side by
   side. For each, answer: is anything cut off; how long are the lines; what is the empty space
   doing; is the type legible at the size it renders; does the theme change anything but
   colour; would you scroll this?
5. **Turn every impression into a number** with the browser that took the shot: an element's
   `getBoundingClientRect()`, its `scrollWidth` against its `clientWidth`, a computed style.
   Measure the suspect element and the container it should fit in; each can look right alone.
6. **Report in the chat**, never in a file: a one-line statement, the commands that repeat the
   measurements, the scope (build, widths, themes, pages), what was fixed and which gate now
   holds it (or that none does), the open findings with their numbers and no rank or owner, and
   what was not audited — motion, print, forced colours, real assistive technology and every
   width between the four.

## Done means

- `make validate` was green before you looked.
- All fifty-six images were opened, not the five you expected trouble in.
- Every finding in the report carries a measurement, not an adjective.
- Each fix names the gate that now prevents it, or says plainly that nothing does.
- Nothing was written under `docs/` but the fixes themselves.
