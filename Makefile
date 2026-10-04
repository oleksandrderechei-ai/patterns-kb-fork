# patterns — a knowledge base of design patterns, written as markdown under docs/ with its
# single-source data files in docs/data/, checked by the gates in tools/ and built into a
# static site under site/dist/ by the Astro workspace in site/.
.DEFAULT_GOAL := help

# The stamp lives inside node_modules on purpose: a stamp beside package.json survives
# `rm -rf node_modules`, and the next target would then run tsx out of a directory that is
# no longer there. One `npm ci` per lockfile change, not one per invocation. Defined before
# any rule names it, because make expands a prerequisite list as it reads the rule.
NODE_STAMP := node_modules/.kb-install-stamp

# The workspace tsx, not `npx tsx`: npx would fetch a copy per gate whenever the install is
# cold. Workspace hoisting puts every bin here at the root.
TSX := node_modules/.bin/tsx

.PHONY: help check gen kb install tools-test validate validate-changed fix gate gates map glossary synonyms products \
        prerequisites taxonomy relations tours site-deps site-build site-compile site-test \
        site-clean site-rebuild site-dev site-open site-shots site-e2e site-e2e-repeat verify

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

kb: ## Read the KB without burning context — make kb ARGS='find slow dependency'
	@node scripts/kb.mjs $(ARGS)

# Every generator that writes committed text, unflagged, in the order one reads another's
# output: the relationships, tour and fluency blocks first (spliced into the pages), then the
# prerequisite graph (read from relations.json and the pages' titles), the docs map, the tag,
# glossary and search-synonym references, and the gate reference. A second run changes nothing; each one's
# `--check` is its freshness gate in `make validate`.
gen: $(NODE_STAMP) ## Regenerate every generated block and reference page from docs/ and docs/data/
	@$(TSX) tools/src/gen/gen-relations.ts
	@$(TSX) tools/src/gen/gen-tours.ts
	@$(TSX) tools/src/gen/gen-prerequisites.ts
	@$(TSX) tools/src/gen/gen-map.ts
	@$(TSX) tools/src/gen/gen-taxonomy.ts
	@$(TSX) tools/src/gen/gen-vocabulary.ts
	@$(TSX) tools/src/gen/gen-search-synonyms.ts
	@$(TSX) tools/src/gen/gen-gates.ts

check: validate ## Another name for make validate

# ---- tools/ workspace: the gates, the generators and the driver ---------------------------
# NODE_STAMP and TSX are defined at the top of this file.
$(NODE_STAMP): package-lock.json package.json tools/package.json site/package.json
	@npm ci
	@touch $(NODE_STAMP)

install: $(NODE_STAMP) ## Install the tools/ workspace (once per package-lock.json change)

tools-test: $(NODE_STAMP) ## Run the tools/ vitest suite with coverage; one file: T=gate
	@cd tools && if [ -n "$$T" ]; then npx vitest run "$$T"; else npx vitest run --coverage --passWithNoTests; fi

# The collecting driver (tools/src/run-gates.ts). It takes its gate list from
# docs/data/gates.json — each row's `local_command`, owned by its `local_target` — runs the
# gates concurrently, replays every failure in registry order and exits once. Nothing in this
# file names a gate: a row added to the registry joins `validate` with no edit here, and
# check-gates-sync fails if a target below stops calling the driver.
DRIVER := $(TSX) tools/src/run-gates.ts

validate: $(NODE_STAMP) ## Every registered gate in one pass, every finding reported (FAILFAST=1 stops at the first)
	@$(DRIVER)

validate-changed: $(NODE_STAMP) ## Only the gates that scan what this branch changed since its merge-base with main
	@$(DRIVER) --changed

fix: $(NODE_STAMP) ## Apply the deterministic repairs the fixable gates already know
	@$(DRIVER) --fix

gate: $(NODE_STAMP) ## Run one gate or generator alone — make gate G=check-json [ARGS=--check]
	@[ -n "$$G" ] || { echo 'usage: make gate G=<program under tools/src/gates or tools/src/gen> [ARGS=...]' >&2; exit 2; }; \
	f=""; \
	for d in gates gen; do [ -f "tools/src/$$d/$$G.ts" ] && f="tools/src/$$d/$$G.ts"; done; \
	[ -n "$$f" ] || { echo "no such gate: $$G (looked in tools/src/gates and tools/src/gen)" >&2; exit 2; }; \
	$(TSX) "$$f" $$ARGS

gates: $(NODE_STAMP) ## Regenerate docs/reference/gates.md and the triage page's blocks from docs/data/gates.json
	@$(TSX) tools/src/gen/gen-gates.ts

map: $(NODE_STAMP) ## Regenerate the page table in docs/README.md, the docs map, from docs/data/site-structure.json
	@$(TSX) tools/src/gen/gen-map.ts

glossary: $(NODE_STAMP) ## Regenerate docs/reference/glossary.md from docs/data/glossary.json
	@$(TSX) tools/src/gen/gen-vocabulary.ts

synonyms: $(NODE_STAMP) ## Regenerate docs/reference/search-synonyms.md from docs/data/search-synonyms.json
	@$(TSX) tools/src/gen/gen-search-synonyms.ts

# The product registry's online half, by hand: it needs the network, so it is no gate and never
# runs in make validate or CI (tools/src/gates/check-products.ts says why).
products: $(NODE_STAMP) ## Fetch every vendor URL in docs/data/products.json and name each that no longer answers
	@$(TSX) tools/src/gates/check-products.ts --online

prerequisites: $(NODE_STAMP) ## Regenerate docs/data/prerequisites.json and its reference page from docs/data/relations.json
	@$(TSX) tools/src/gen/gen-prerequisites.ts

taxonomy: $(NODE_STAMP) ## Regenerate docs/reference/tags.md from docs/data/tags.json
	@$(TSX) tools/src/gen/gen-taxonomy.ts

relations: $(NODE_STAMP) ## Splice every page's relationships block from docs/data/relations.json
	@$(TSX) tools/src/gen/gen-relations.ts

tours: $(NODE_STAMP) ## Splice the theme tours and member fluency blocks from docs/data/learning-paths.json
	@$(TSX) tools/src/gen/gen-tours.ts

# ---- site/ workspace: Astro + Starlight, built from docs/ into site/dist/ -----------------
# The build command (spec kb.site.build-command): lint over the whole workspace, the unit
# tests with coverage, then `npm run build`, whose npm pre and post scripts run the rest —
# prebuild mirrors docs/ and writes the hubs (tools/src/site/), then bundles the client;
# build type-checks and runs Astro; postbuild makes the pages portable, writes the manifest
# and the search payload, then formats every page (tools/src/site/site-format.ts) — and last
# the site gates, through the driver. Each step stops the
# command. `make validate` never runs a site gate: they need a built site, which is minutes
# of work for a change that touches no page (build-command-C6).
#
# Diagrams are drawn at build time in headless Chromium (rehype-mermaid). Playwright keeps
# its browsers outside the repository, so the stamp records only that this checkout asked
# for the revision its lockfile pins; `site-clean` never removes it, and a rebuild
# downloads nothing (build-command-C5).
CHROMIUM_STAMP := node_modules/.kb-chromium-stamp

$(CHROMIUM_STAMP): $(NODE_STAMP) package-lock.json
	@node_modules/.bin/playwright install chromium
	@touch $(CHROMIUM_STAMP)

site-deps: $(CHROMIUM_STAMP) ## Install the headless Chromium the site build draws its diagrams in (once per lockfile)

site-build: site-compile ## Build the site: lint, unit tests, generators, typecheck and Astro, post-build passes, then the site gates
	@$(DRIVER) --target site-build

# The build command's first steps alone, which CI runs as one step before its site-gate
# steps (.github/workflows/validate.yml, job `site`).
site-compile: $(CHROMIUM_STAMP) ## Lint, unit tests, then `npm run build` in site/ — the build without its gates
	@cd site && npm run lint
	@cd site && npm run test -- --coverage
	@cd site && npm run build

site-test: $(NODE_STAMP) ## The site workspace's vitest suite with coverage; one file: T=routes; more vitest flags: ARGS=…
	@cd site && if [ -n "$$T" ]; then npx vitest run "$$T"; else npx vitest run --coverage $$ARGS; fi

# What the build writes, deleted by the rules that define it: every path below is
# ignored, so `git clean -X` and .gitignore cannot disagree about what is output. Named
# folders only, never a bare site/, which would take the workspace's own sources with it.
# site/node_modules/.astro is Astro's render cache, not a dependency: it keeps each page's
# rendered HTML keyed on the page's source, so a changed remark or rehype plugin rebuilds
# nothing until it goes (build-command-C10). Every installed package stays.
site-clean: ## Delete the built site, Astro's caches, the bundle and every generated page (keeps installed packages)
	@git clean -Xdfq -- site/dist site/.astro site/node_modules/.astro site/public site/src/content/docs site/coverage

site-rebuild: ## site-clean, then the whole build from nothing
	@$(MAKE) --no-print-directory site-clean
	@$(MAKE) --no-print-directory site-build

site-dev: $(CHROMIUM_STAMP) ## Serve the site with live reload (astro dev: pre-build only, never the post-build passes)
	@cd site && npm run dev

site-open: ## Open the built site from disk, the way a reader without a server does
	@[ -f site/dist/index.html ] || { echo "run 'make site-build' first" >&2; exit 1; }
	@open site/dist/index.html 2>/dev/null || xdg-open site/dist/index.html

# The reader's flows over the built site in headless Chromium: the flows under tools/e2e/, each
# from disk and from a local server at a desktop and a phone width, and the few tagged @tablet
# again at 800px from the server, run through the gate wrapper tools/src/gates/check-site-e2e.ts.
# Its own target and its own run place: it reads the site `make site-build` wrote and never
# rebuilds it, and it stays out of the build's gate list.
site-e2e: $(NODE_STAMP) ## Run the reader's flows over the built site in a browser (after make site-build)
	@[ -f site/dist/index.html ] || { echo "run 'make site-build' first" >&2; exit 1; }
	@$(DRIVER) --target site-e2e

# The same flows, each run three times in a row: a flow that passes once and fails once in three is a
# flake, and this finds it before the gate does. Run it after adding or changing a flow. It calls
# Playwright directly, with the gate's config, so it skips the allowance check and prints a dot per run.
site-e2e-repeat: $(NODE_STAMP) ## Run every reader flow three times over the built site to find a flake (after adding a flow)
	@[ -f site/dist/index.html ] || { echo "run 'make site-build' first" >&2; exit 1; }
	@node node_modules/@playwright/test/cli.js test -c tools/e2e/playwright.config.ts --repeat-each=3 --reporter=dot

# Everything a change to the site owes before it merges, in the order each step needs the last:
# the build, the reader's flows over what it wrote, then every registered gate. It stops at
# the first red step.
verify: ## Build the site, run the reader's flows, then every gate: site-build, site-e2e, validate
	@$(MAKE) --no-print-directory site-build
	@$(MAKE) --no-print-directory site-e2e
	@$(MAKE) --no-print-directory validate

# Photographs of the built site for a visual audit (tools/src/site-shots.ts): seven pages,
# four widths, both themes, into a folder you name outside the repository. No gate: a
# person looks, and reports what they saw.
site-shots: $(CHROMIUM_STAMP) ## Photograph the built site: 7 pages x 4 widths x 2 themes; OUT=/tmp/kb-shots
	@[ -n "$$OUT" ] || { echo "usage: make site-shots OUT=/tmp/kb-shots" >&2; exit 2; }
	@$(TSX) tools/src/site-shots.ts --out "$$OUT"
