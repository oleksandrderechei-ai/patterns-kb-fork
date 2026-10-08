#!/usr/bin/env node
// kb-fact-check/eval-check.mjs — the mechanical guardrail gate for findings files.
//
// A finding is only actionable if it survives these checks. Runs Node built-ins only (reads the
// repo's docs/data/content-model.json and tags.json for BLOCKS/TAGS/RELATION_TYPES). It never trusts the evaluator's prose — it
// re-verifies every quote and anchor against ground truth on disk / from scripts/kb.mjs.
//
//   node .claude/skills/kb-fact-check/eval-check.mjs [--only a,b] [--json]
//   node .claude/skills/kb-fact-check/eval-check.mjs --self-check [--only a,b] [--json]
//
// Gates (see SKILL.md §guardrails):
//   G1 quote-or-drop     every sources[].quote is a verbatim substring of the stored .norm.txt
//   G2 anchor-or-drop    kb.block ∈ BLOCKS[kind]; kb.quote is a substring of that block's joined text;
//                        kb.anchor is an element id of the page, and sits inside kb.block
//   G3 prove-the-absence every missing-*/… absence needs absenceEvidence, terms genuinely absent
//   G4 no-laundering     no 8-word shingle of proposedFix.intent appears in any stored source
//   G5 severity-ceiling  CRITICAL/HIGH needs ≥2 sources or 1 tier-1 source
//   G6 closed-enums      dimension ∈ DIMENSIONS; tag-gap tag ∈ TAGS; relationship verb ∈ RELATION_TYPES
//   G7 restraint         a page with ≥5 findings and 0 notes is flagged for re-review
//
// The page is read as data, through `kb.mjs record <id>` (contract kb-record/1, schema
// tools/src/contract/schema/kb-record-1.json). G2 and G3 judge words against the record's own
// text, and G2 judges an anchor against the record's `anchors` map.
//
// Exit: 0 all clean · 2 nothing to check (no findings yet) · 3 one or more issues.
//
// --self-check runs the page read, G2 and G3 over findings built from two real pages (default
// circuit-breaker and bitly, or the ids of --only): some are clean, each of the others carries one
// seeded fault. It exits 0 when every finding gets the verdict it was built for, else 3. A page
// takes part only if it has two blocks with citable elements, a list of plain items and a figure
// with code; the two defaults have all of them. G1, G4 and G5 read stored sources, and G6 and G7
// judge no page words, so none of them is exercised.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "scripts", "kb.mjs"))) return dir;
    const up = dirname(dir); if (up === dir) break; dir = up;
  }
  console.error("eval-check.mjs: cannot find repo root"); process.exit(1);
}
const REPO = findRepoRoot(HERE);
const OUT = join(REPO, "tmp", "kb-fact-check");
const FINDINGS = join(OUT, "findings");
const KB = join(REPO, "scripts", "kb.mjs");
// The closed vocabularies come from the data files the build checks: the blocks per kind and the
// relation verbs from content-model.json, the page tags from tags.json.
const readData = (name) => JSON.parse(readFileSync(join(REPO, "docs", "data", `${name}.json`), "utf8"));
const CONTENT_MODEL = readData("content-model");
const BLOCKS = Object.fromEntries(CONTENT_MODEL.kinds.map((k) => [k.id, k.blocks]));
const TAGS = new Set(readData("tags").terms.map((t) => t.id));
const RELATION_TYPES = Object.fromEntries(CONTENT_MODEL.relations.verbs.map((v) => [v.id, v]));

const DIMENSIONS = new Set([
  "factual-error", "wild-false", "production-false", "relationship-wrong", "essence-mismatch",
  "solves-defect", "wild-stale", "missing-tradeoff", "missing-variation", "missing-relationship",
  "block-gap", "provenance-gap", "alias-gap", "tag-gap",
  "estimation-arithmetic", "demonstrates-unsupported", "demonstrates-missing", "tour-stale", "decide-stale",
  "kb-ahead", "source-weak", "verified-clean",
]);
const NOTE_DIMS = new Set(["kb-ahead", "source-weak", "verified-clean"]);
// self-evidencing design/theme checks — the KB's own blocks are the evidence, no external source needed
const INTERNAL_DIMS = new Set(["estimation-arithmetic", "demonstrates-unsupported", "demonstrates-missing", "tour-stale", "decide-stale"]);
const MISSING_DIMS = new Set(["missing-tradeoff", "missing-variation", "missing-relationship", "block-gap", "alias-gap", "provenance-gap", "tag-gap"]);
const SEVERITIES = new Set(["CRITICAL", "HIGH", "MEDIUM", "LOW", "NOTE"]);

function hasFlag(f) { return argv.includes(f); }
function optVal(f) { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined; }
const only = (() => { const v = optVal("--only"); return v ? new Set(v.split(",").map(s => s.trim())) : null; })();
const asJson = hasFlag("--json");

const norm = s => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

// The page as data, cached per id. `kb.mjs record` exits 1 and says why on stderr for an id the KB
// does not hold; that comes back as `error`, so a findings file for a missing page is one problem
// line and the run goes on. The record carries diagram and sketch source in `code`, so no flag is
// needed to make a diagram's labels visible.
const recordCache = new Map();
function kbRecord(id) {
  if (recordCache.has(id)) return recordCache.get(id);
  let entry;
  try {
    const out = execFileSync("node", [KB, "record", id], { cwd: REPO, maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "pipe"] });
    entry = { rec: JSON.parse(out.toString()) };
  } catch (e) {
    entry = { error: String(e.stderr || e.message).trim().split("\n")[0] };
  }
  recordCache.set(id, entry);
  return entry;
}

// The JOINED TEXT of some nodes is the one string every quote and every absent term is judged
// against. It is every `text` and every `code` string found under the nodes, in the order the
// record lists them, which is page order, each string one piece and the pieces joined by a single
// space. `text` is what the page shows with its markup removed: a paragraph, a heading, a group
// heading, the first paragraph of a list item, a table cell, a caption, a sketch's summary. `code`
// is the source of a diagram, a sketch or a fence, so a quote of a diagram label can be checked.
// Nothing else counts: `md` (the markup as written), `lead` (a copy of the words an item opens
// with), ids, fingerprints and every other key hold no words of their own. The joined text of a
// block is that of its `content`, so the block's own heading is not in it. A caller folds the result
// with `norm` before comparing, so spacing and case never decide a match.
function joinedText(nodes) {
  const pieces = [];
  const visit = (n) => {
    if (Array.isArray(n)) n.forEach(visit);
    else if (n && typeof n === "object") {
      for (const [key, value] of Object.entries(n)) {
        if ((key === "text" || key === "code") && typeof value === "string") pieces.push(value);
        else visit(value);
      }
    }
  };
  visit(nodes);
  return pieces.join(" ");
}

// An anchor's JSON Pointer is `/blocks/<i>` for block i itself and `/blocks/<i>/…` for anything in it.
const inBlock = (pointer, i) => pointer === `/blocks/${i}` || pointer.startsWith(`/blocks/${i}/`);

// stored normalised source text, cached per id
const srcCache = new Map();
function srcText(id, sid) {
  const key = `${id}/${sid}`;
  if (srcCache.has(key)) return srcCache.get(key);
  const dir = join(OUT, "sources", id);
  let text = "";
  const wiki = join(dir, "wikipedia.norm.txt");
  const alt = join(dir, `${sid}.norm.txt`);
  if (sid === "wikipedia" && existsSync(wiki)) text = readFileSync(wiki, "utf8");
  else if (existsSync(alt)) text = readFileSync(alt, "utf8");
  const n = norm(text);
  srcCache.set(key, n);
  return n;
}
function allSrcText(id) {
  const dir = join(OUT, "sources", id);
  if (!existsSync(dir)) return "";
  return readdirSync(dir).filter(f => f.endsWith(".norm.txt")).map(f => norm(readFileSync(join(dir, f), "utf8"))).join("  ");
}

function collectFindingsFiles() {
  if (!existsSync(FINDINGS)) return [];
  const out = [];
  for (const kind of readdirSync(FINDINGS)) {
    const kdir = join(FINDINGS, kind);
    if (!existsSync(kdir) || !readdirSync(kdir)) continue;
    for (const f of readdirSync(kdir)) {
      if (!f.endsWith(".eval.json")) continue;
      const id = f.replace(/\.eval\.json$/, "");
      if (only && !only.has(id)) continue;
      out.push({ id, path: join(kdir, f) });
    }
  }
  return out;
}

function shingles(text, n = 8) {
  const w = norm(text).split(" ").filter(Boolean);
  const out = [];
  for (let i = 0; i + n <= w.length; i++) out.push(w.slice(i, i + n).join(" "));
  return out;
}

function checkFile({ id, path }, problems) {
  let doc;
  try { doc = JSON.parse(readFileSync(path, "utf8")); } catch (e) { problems.push(`${id}: unreadable findings file (${e.message})`); return; }
  checkDoc(id, doc, problems);
}

// Every check that needs the page, over one parsed findings document. Kept apart from the file read
// so --self-check can feed it findings built in memory.
function checkDoc(id, doc, problems) {
  const { rec, error } = kbRecord(id);
  if (!rec) { problems.push(`${id}: no page record (${error})`); return; }
  const blocks = new Map(rec.blocks.map((b, i) => [b.name, { i, text: norm(joinedText(b.content)) }]));
  const validBlocks = new Set(BLOCKS[rec.kind] ?? []);
  const pageText = norm(joinedText([rec.intro, rec.blocks.map((b) => b.content)]));
  const findings = doc.findings ?? [];
  const notes = doc.notes ?? [];

  // G7 restraint
  if (findings.filter(f => !NOTE_DIMS.has(f.dimension)).length >= 5 && notes.length === 0)
    problems.push(`${id}: WARN restraint — ${findings.length} findings, 0 notes (probably rationalising every divergence)`);

  for (const f of [...findings, ...notes]) {
    const at = `${id}/${f.fid ?? "?"}`;
    // G6 closed enums
    if (!DIMENSIONS.has(f.dimension)) { problems.push(`${at}: dimension "${f.dimension}" not in closed set`); continue; }
    if (f.severity && !SEVERITIES.has(f.severity)) problems.push(`${at}: severity "${f.severity}" invalid`);
    const isNote = NOTE_DIMS.has(f.dimension);

    // G2 anchor-or-drop — an ACTIONABLE finding must target a real block whose joined text carries
    // its quote, and an anchor must be an element id of the record that sits inside that block (a
    // block's own name is one). NOTES are provenance, not edits (a verified-clean note may cite page
    // metadata like an alias), so they skip block and anchor validation — but their source quotes
    // are still gated by G1 below.
    const kbref = f.kb ?? {};
    if (!isNote) {
      const block = blocks.get(kbref.block);
      if (kbref.block && !validBlocks.has(kbref.block)) problems.push(`${at}: kb.block "${kbref.block}" not a ${rec.kind} block`);
      else if (kbref.block && !block) problems.push(`${at}: kb.block "${kbref.block}" absent on this page`);
      if (kbref.quote && block && !block.text.includes(norm(kbref.quote)))
        problems.push(`${at}: kb.quote not found in block "${kbref.block}"`);
      if (kbref.anchor) {
        const pointer = Object.hasOwn(rec.anchors, kbref.anchor) ? rec.anchors[kbref.anchor] : null;
        if (!pointer) problems.push(`${at}: kb.anchor "${kbref.anchor}" is not an element id of this page`);
        else if (block && !inBlock(pointer, block.i)) problems.push(`${at}: kb.anchor "${kbref.anchor}" is in another block than kb.block "${kbref.block}"`);
      }
    }

    // G1 quote-or-drop — every source quote must be a substring of that stored source
    for (const s of f.sources ?? []) {
      if (!s.quote) { problems.push(`${at}: source ${s.sid} has no quote`); continue; }
      const hay = srcText(id, s.sid);
      if (!hay) { problems.push(`${at}: source ${s.sid} has no stored .norm.txt`); continue; }
      if (!hay.includes(norm(s.quote))) problems.push(`${at}: source quote (${s.sid}) not a substring of stored text`);
    }

    // G3 prove-the-absence
    if (MISSING_DIMS.has(f.dimension)) {
      const ae = kbref.absenceEvidence;
      if (!ae) { problems.push(`${at}: ${f.dimension} needs kb.absenceEvidence`); }
      else {
        if ((ae.blocksSearched ?? []).length < 3) problems.push(`${at}: absenceEvidence.blocksSearched < 3`);
        for (const term of ae.termsAbsent ?? []) {
          if (pageText.includes(norm(term))) problems.push(`${at}: claims "${term}" absent but it IS present on the page`);
        }
      }
    }

    // G5 severity ceiling (external-corroboration rule; internal design/theme checks are exempt)
    if ((f.severity === "CRITICAL" || f.severity === "HIGH") && !isNote && !INTERNAL_DIMS.has(f.dimension)) {
      const srcs = f.sources ?? [];
      const tier1 = srcs.some(s => Number(s.tier) === 1);
      if (srcs.length < 2 && !tier1) problems.push(`${at}: ${f.severity} needs ≥2 sources or 1 tier-1 (has ${srcs.length}, tier1=${tier1})`);
    }

    // G6 relationship verb / tag closure
    if (f.dimension === "missing-relationship" || f.dimension === "relationship-wrong") {
      const verb = f.proposedFix?.verb ?? f.verb;
      if (verb && !(verb in RELATION_TYPES)) problems.push(`${at}: relation verb "${verb}" not in the closed verb list`);
    }
    if (f.dimension === "tag-gap") {
      const tag = f.proposedFix?.tag ?? f.tag;
      if (tag && !TAGS.has(tag)) problems.push(`${at}: tag "${tag}" not in the closed TAGS vocabulary`);
    }

    // G4 no-laundering — intent must not reproduce an 8-word run of any source
    const intent = f.proposedFix?.intent;
    if (intent) {
      const hay = allSrcText(id);
      for (const sh of shingles(intent, 8)) { if (hay.includes(sh)) { problems.push(`${at}: proposedFix.intent reproduces source text verbatim ("${sh.slice(0, 40)}…")`); break; } }
    }
  }
}

// ---- self-check
//
// Findings are built from each page's own record, so a quote or an anchor is real whatever the
// page says. A clean finding must give no problem; a seeded one must give exactly one, and it
// must carry the message named for it.

const SELF_PAGES = ["circuit-breaker", "bitly"];
const wordsOf = (text) => text.split(/\s+/).filter(Boolean);
const firstWords = (text, n) => wordsOf(text).slice(0, n).join(" ");
const lastWords = (text, n) => wordsOf(text).slice(-n).join(" ");
const longestLine = (code) => code.split("\n").map((l) => l.trim()).reduce((a, b) => (b.length > a.length ? b : a), "");

// Every node under `nodes` that `want` accepts, in page order.
function collect(nodes, want) {
  const out = [];
  const visit = (n) => {
    if (Array.isArray(n)) n.forEach(visit);
    else if (n && typeof n === "object") { if (want(n)) out.push(n); Object.values(n).forEach(visit); }
  };
  visit(nodes);
  return out;
}

// The cases for one page: { name, doc, expect }, `expect` null for a clean finding, else the text
// the one problem must hold. Throws a plain Error when the page lacks the material for a case.
function selfCases(id, rec) {
  const need = (value, what) => {
    if (value === undefined) throw new Error(`${id} has no ${what}, which a self-check case needs`);
    return value;
  };
  const citable = (b) => collect(b.content, (n) => typeof n.id === "string" && typeof n.text === "string" && wordsOf(n.text).length >= 6);
  const withElements = rec.blocks.filter((b) => citable(b).length > 0);
  const blockA = need(withElements[0], "block with a citable element");
  const blockB = need(withElements[1], "second block with a citable element");
  const [elA, elB] = [citable(blockA)[0], citable(blockB)[0]];
  const pair = need(rec.blocks.flatMap((b) => collect(b.content, (n) => n.type === "list" && n.items?.length >= 2
    && n.items[0].content.length === 0 && wordsOf(n.items[0].text).length >= 3 && wordsOf(n.items[1].text).length >= 3)
    .map((list) => ({ block: b, list }))).at(0), "list of plain items");
  const figure = need(rec.blocks.flatMap((b) => collect(b.content, (n) => n.type === "figure" && typeof n.code === "string" && n.code.trim().length >= 8)
    .map((fig) => ({ block: b, fig }))).at(0), "figure with code");
  const [first, second] = pair.list.items;

  const finding = (name, kb, extra = {}) => ({ fid: `${id}-selfcheck-${name}`, dimension: "factual-error", severity: "MEDIUM", kb, ...extra });
  const one = (name, kb, expect, extra) => ({ name, doc: { findings: [finding(name, kb, extra)] }, expect });
  const absence = (terms) => ({ absenceEvidence: { blocksSearched: rec.blocks.slice(0, 3).map((b) => b.name), termsAbsent: terms, findQuery: "self-check" } });
  const quoteA = firstWords(elA.text, 6);
  return [
    one("quote-in-block", { block: blockA.name, anchor: elA.id, quote: quoteA }, null),
    // The end of one item and the start of the next, which the joined text puts one space apart.
    one("quote-across-two-items", { block: pair.block.name, anchor: first.id ?? undefined, quote: `${lastWords(first.text, 3)} ${firstWords(second.text, 3)}` }, null),
    one("quote-from-diagram-code", { block: figure.block.name, anchor: figure.fig.id ?? undefined, quote: longestLine(figure.fig.code) }, null),
    one("anchor-is-the-block-name", { block: blockA.name, anchor: blockA.name, quote: quoteA }, null),
    { name: "note-skips-block-and-anchor", doc: { findings: [], notes: [{ fid: `${id}-selfcheck-note`, dimension: "verified-clean", severity: "NOTE", kb: { block: "no-such-block", anchor: "no-such-element", quote: "words that are not on the page" } }] }, expect: null },
    one("quote-not-on-the-page", { block: blockA.name, anchor: elA.id, quote: "words that are not on the page" }, `kb.quote not found in block "${blockA.name}"`),
    one("quote-from-another-block", { block: blockA.name, anchor: elA.id, quote: firstWords(elB.text, 8) }, `kb.quote not found in block "${blockA.name}"`),
    one("anchor-not-on-the-page", { block: blockA.name, anchor: "no-such-element-99", quote: quoteA }, "is not an element id of this page"),
    one("anchor-in-another-block", { block: blockA.name, anchor: elB.id, quote: quoteA }, "is in another block than kb.block"),
    one("block-not-of-this-kind", { block: "no-such-block", anchor: elA.id, quote: quoteA }, `not a ${rec.kind} block`),
    one("absence-holds", absence(["qqxzv wkjzq"]), null, { dimension: "missing-tradeoff" }),
    one("absence-is-false", absence([firstWords(elA.text, 3)]), "IS present on the page", { dimension: "missing-tradeoff" }),
  ];
}

// Runs every case over the ids, then one findings document for a page that does not exist.
function selfCheck(ids) {
  const failures = [];
  let cases = 0;
  const run = (id, c) => {
    cases++;
    const problems = [];
    checkDoc(id, c.doc, problems);
    const ok = c.expect === null ? problems.length === 0 : problems.length === 1 && problems[0].includes(c.expect);
    if (!ok) failures.push(`${id}/${c.name}: expected ${c.expect === null ? "no problem" : `one problem holding "${c.expect}"`}, got ${problems.length ? problems.join(" | ") : "none"}`);
  };
  for (const id of ids) {
    const { rec, error } = kbRecord(id);
    if (!rec) { failures.push(`${id}: no page record (${error})`); continue; }
    try { selfCases(id, rec).forEach((c) => run(id, c)); } catch (e) { failures.push(e.message); }
  }
  run("no-such-page", { name: "page-does-not-exist", doc: { findings: [] }, expect: "no page record" });
  return { cases, failures };
}

// ---- run
if (hasFlag("--self-check")) {
  const ids = only ? [...only] : SELF_PAGES;
  const { cases, failures } = selfCheck(ids);
  if (asJson) {
    process.stdout.write(JSON.stringify({ status: failures.length ? "issues" : "clean", pages: ids, cases, problems: failures }, null, 2) + "\n");
  } else if (!failures.length) {
    console.error(`eval-check: self-check OK — ${cases} case(s) over ${ids.length} page(s), each got the verdict it was built for.`);
  } else {
    console.error(`eval-check: self-check found ${failures.length} wrong verdict(s) in ${cases} case(s):`);
    for (const p of failures) console.error(`  - ${p}`);
  }
  process.exit(failures.length ? 3 : 0);
}
const files = collectFindingsFiles();
if (!files.length) {
  if (asJson) process.stdout.write(JSON.stringify({ status: "pending", files: 0 }, null, 2) + "\n");
  else console.error("eval-check: no findings files yet (pending)");
  process.exit(2);
}
const problems = [];
for (const f of files) checkFile(f, problems);
const hard = problems.filter(p => !p.includes("WARN"));
if (asJson) {
  process.stdout.write(JSON.stringify({ status: hard.length ? "issues" : "clean", files: files.length, problems }, null, 2) + "\n");
} else {
  if (!problems.length) console.error(`eval-check: OK — ${files.length} findings file(s), all gates pass.`);
  else { console.error(`eval-check: ${problems.length} issue(s) across ${files.length} file(s):`); for (const p of problems) console.error(`  - ${p}`); }
}
process.exit(hard.length ? 3 : 0);
