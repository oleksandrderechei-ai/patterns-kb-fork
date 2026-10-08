#!/usr/bin/env node
// kb-fact-check/fetch.mjs — resolve KB ids to trusted sources and fetch them into tmp/.
//
// Node built-ins + global fetch, plus node-html-parser from the tools workspace (used only to
// reduce alt-source HTML to text); nothing to install beyond the repo's own `npm ci`. Never calls Date.now()/new Date() — pass --captured-at <ISO> for a stamp,
// otherwise "unknown". Change detection is by sha256 of the body, so re-fetching unchanged
// content yields a zero-line diff. All JSON is written with a fixed key order + trailing "\n".
//
// The markdown pages under docs/ are the source; this tool only reads the KB (via scripts/kb.mjs)
// and writes to gitignored tmp/kb-fact-check/. It NEVER writes to docs/ or site/. See .claude/skills/
// kb-fact-check/SKILL.md for the workflow and the anti-fabrication rules.
//
//   node .claude/skills/kb-fact-check/fetch.mjs plan     [--only a,b] [--kb-json <f>]
//   node .claude/skills/kb-fact-check/fetch.mjs resolve  [--only a,b] [--delay-ms N]
//   node .claude/skills/kb-fact-check/fetch.mjs pin <id> --wikipedia "<Exact Title>"
//   node .claude/skills/kb-fact-check/fetch.mjs pin <id> --none --reason "<why>"
//   node .claude/skills/kb-fact-check/fetch.mjs alt add <id> --url <u> --label "<why>" [--tier N] [--sid <s>]
//   node .claude/skills/kb-fact-check/fetch.mjs fetch    [--only a,b] [--refresh] [--force]
//   node .claude/skills/kb-fact-check/fetch.mjs status   [--only a,b] [--json]
//
// Exit codes: 0 ok / 1 usage-or-io error / 2 work pending / 4 network gave up after retries.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- paths / repo root

const HERE = dirname(fileURLToPath(import.meta.url));

function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "scripts", "kb.mjs")) && existsSync(join(dir, "tools", "package.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  die(`could not locate repo root walking up from ${start} (need scripts/kb.mjs)`);
}

const argv = process.argv.slice(2);
const REPO = optVal("--repo") ? pathResolve(optVal("--repo")) : findRepoRoot(HERE);
const OUT = join(REPO, "tmp", "kb-fact-check");
const SOURCES_ALLOWLIST = join(HERE, "sources.json");
const INDEX_PATH = join(OUT, "index.json");
const RUNLOG_PATH = join(OUT, "run.log.jsonl");
const KB = join(REPO, "scripts", "kb.mjs");
// node-html-parser is a dependency of the tools workspace; resolve it from there.
const requireFromTools = createRequire(join(REPO, "tools", "package.json"));

// ---------------------------------------------------------------- constants

const CONTACT = optVal("--user-agent") ??
  "software-design-atlas-factcheck/0.1 (https://github.com/odere-pro/software-design-atlas; odere.pub@gmail.com) node/26";
const HEADERS = { "User-Agent": CONTACT, "Accept-Encoding": "gzip" };
const WP = "https://en.wikipedia.org/w/api.php";
const DELAY_MS = Number(optVal("--delay-ms") ?? 1000);
const MAX_RETRIES = Number(optVal("--max-retries") ?? 4);
const CAPTURED_AT = optVal("--captured-at") ?? "unknown";
const TITLE_BATCH = 45; // < the 50 hard limit, safety margin

// software/CS topic gate — strict, for pattern/hazard/principle/theme
const GATE_STRICT = /software|programming|program\b|computer|comput|algorithm|design pattern|anti-?pattern|concurrenc|distributed|database|data structure|cryptograph|network|cache|messag|architectur|scalab|consistency/i;
// loose gate for design pages (they map to companies / products / physical domains)
const GATE_LOOSE = /software|internet|web\b|technolog|compan|websit|mobile app|application|service|platform|comput|database|algorithm/i;

const BAND_CONTEXT = {
  gof: "object-oriented programming design pattern",
  enterprise: "enterprise application architecture",
  architecture: "software architecture",
  distributed: "distributed systems",
  concurrency: "concurrent programming",
  messaging: "message queue enterprise integration",
  caching: "cache computing",
  ddd: "domain-driven design",
  functional: "functional programming",
  testing: "software unit testing",
  security: "software security pattern",
  frontend: "web frontend architecture",
  ml: "machine learning",
  hazard: "software anti-pattern",
  theme: "software",
  principle: "software design principle",
  design: "system architecture",
};

// ---------------------------------------------------------------- tiny utils

function die(msg) { process.stderr.write(`fetch.mjs: ${msg}\n`); process.exit(1); }
function info(msg) { process.stderr.write(`${msg}\n`); }

function optVal(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
function hasFlag(flag) { return argv.includes(flag); }
function onlySet() {
  const v = optVal("--only");
  return v ? new Set(v.split(",").map(s => s.trim()).filter(Boolean)) : null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha256 = s => createHash("sha256").update(s).digest("hex");

function ensureDir(p) { mkdirSync(p, { recursive: true }); }
function readJson(p, fallback) {
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch (e) { die(`bad JSON in ${p}: ${e.message}`); }
}
// deterministic stringify: sort object keys, arrays keep order
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = stable(v[k]);
    return o;
  }
  return v;
}
function writeJson(p, obj) { ensureDir(dirname(p)); writeFileSync(p, JSON.stringify(stable(obj), null, 2) + "\n"); }
function writeText(p, s) { ensureDir(dirname(p)); writeFileSync(p, s); }

// one-line whitespace-collapsed match target for the eval-check quote gate
const norm = s => s.replace(/\s+/g, " ").trim();

function sentenceCase(s) { return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); }
function slugHost(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean).pop() || "index";
    return `${u.hostname.replace(/^www\./, "")}--${seg}`.replace(/[^a-z0-9._-]+/gi, "-").toLowerCase();
  } catch { return "source"; }
}

let LOG_SEQ = 0;
function runlog(rec) {
  ensureDir(OUT);
  writeFileSync(RUNLOG_PATH, JSON.stringify({ seq: LOG_SEQ++, ...rec }) + "\n", { flag: "a" });
}

// ---------------------------------------------------------------- HTTP with politeness + retry

async function httpGet(url, { json = false } = {}) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res, body, err;
    const t0 = process.hrtime.bigint();
    try {
      res = await fetch(url, { headers: HEADERS, redirect: "follow" });
      body = await res.text();
    } catch (e) { err = e; }
    const ms = Number((process.hrtime.bigint() - (t0)) / 1000000n);
    if (err) {
      runlog({ url, error: String(err.message || err), attempt, elapsedMs: ms });
      if (attempt === MAX_RETRIES) return { ok: false, status: 0, error: String(err.message || err) };
      await sleep(DELAY_MS * (attempt + 1));
      continue;
    }
    runlog({ url, http: res.status, bytes: body.length, attempt, elapsedMs: ms });
    if (res.status === 429 || res.status === 503) {
      const ra = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : DELAY_MS * Math.pow(2, attempt);
      if (attempt === MAX_RETRIES) return { ok: false, status: res.status, error: "rate-limited" };
      await sleep(wait);
      continue;
    }
    const ret = { ok: res.ok, status: res.status, headers: res.headers, body, finalUrl: res.url };
    if (json) { try { ret.json = JSON.parse(body); } catch (e) { ret.ok = false; ret.error = "bad-json"; } }
    return ret;
  }
  return { ok: false, status: 0, error: "exhausted" };
}

// ---------------------------------------------------------------- KB reading

function kbLs(kbJsonOverride) {
  if (kbJsonOverride) return readJson(pathResolve(kbJsonOverride), null) ?? die(`cannot read ${kbJsonOverride}`);
  const out = execFileSync("node", [KB, "ls", "--json"], { cwd: REPO, maxBuffer: 1 << 28 }).toString();
  return JSON.parse(out);
}

// ---------------------------------------------------------------- Wikipedia resolver

// candidate titles for a KB row, most-specific software-y forms first, aliases last
function candidates(row) {
  const n = row.name.replace(/\s*\(.*\)$/, "").trim();
  const c = [n, sentenceCase(n)];
  if (row.kind === "pattern") c.push(`${n} pattern`, `${sentenceCase(n)} pattern`, `${n} (design pattern)`, `${sentenceCase(n)} (design pattern)`, `${n} (computer science)`);
  if (row.kind === "principle") c.push(`${n} principle`, `${sentenceCase(n)} principle`);
  if (row.kind === "hazard") c.push(`${n} (anti-pattern)`, sentenceCase(n));
  if (row.band === "functional") c.push(`${n} (functional programming)`, `${sentenceCase(n)} (functional programming)`);
  const seen = new Set(), out = [];
  for (const t of c) { const k = t.trim(); if (k && !seen.has(k)) { seen.add(k); out.push(k); } }
  return { primary: out, aliases: (row.aliases ?? []).filter(a => !seen.has(a)) };
}

function gateFor(kind) { return kind === "design" ? GATE_LOOSE : GATE_STRICT; }

function relevant(page, kind) {
  const gate = gateFor(kind);
  const desc = page.description ?? page.pageprops?.["wikibase-shortdesc"] ?? "";
  const cats = (page.categories ?? []).map(c => (c.title || "").replace(/^Category:/, "")).join(" ");
  return gate.test(`${desc} ${cats}`);
}
function isDisambig(page) { return page.pageprops && "disambiguation" in page.pageprops; }

// batched probe: returns Map<requestedTitle, resolvedPageObject|null>, plus redirect/normalize maps
async function probeTitles(titles) {
  const byTitle = new Map();
  const normMap = new Map(), redirMap = new Map();
  for (let i = 0; i < titles.length; i += TITLE_BATCH) {
    const batch = titles.slice(i, i + TITLE_BATCH);
    const q = new URLSearchParams({
      action: "query", format: "json", formatversion: "2", redirects: "1",
      titles: batch.join("|"),
      prop: "pageprops|info|categories|description",
      ppprop: "disambiguation", inprop: "url", cllimit: "max", clshow: "!hidden", maxlag: "5",
    });
    const r = await httpGet(`${WP}?${q}`, { json: true });
    if (!r.ok || !r.json?.query) { info(`  probe failed (${r.status})`); continue; }
    const Q = r.json.query;
    for (const nn of Q.normalized ?? []) normMap.set(nn.from, nn.to);
    for (const rr of Q.redirects ?? []) redirMap.set(rr.from, { to: rr.to, tofragment: rr.tofragment });
    // map each resolved page back to every requested title that points at it
    const pagesByTitle = new Map();
    for (const p of Q.pages ?? []) pagesByTitle.set(p.title, p);
    for (const t of batch) {
      let cur = t;
      if (normMap.has(cur)) cur = normMap.get(cur);
      const redir = redirMap.get(cur);
      const finalTitle = redir ? redir.to : cur;
      const page = pagesByTitle.get(finalTitle) ?? pagesByTitle.get(cur) ?? null;
      byTitle.set(t, page ? { ...page, _via: redir ? "redirect" : "direct", _redirectFrom: redir ? cur : undefined, _fragment: redir?.tofragment } : null);
    }
    await sleep(DELAY_MS);
  }
  return byTitle;
}

async function nearmatch(query) {
  const q = new URLSearchParams({ action: "query", format: "json", formatversion: "2", list: "search", srsearch: query, srwhat: "nearmatch", srlimit: "1" });
  const r = await httpGet(`${WP}?${q}`, { json: true });
  await sleep(DELAY_MS);
  const hit = r.json?.query?.search?.[0];
  return hit ? hit.title : null;
}

async function searchTop(query, n = 5) {
  const q = new URLSearchParams({ action: "query", format: "json", formatversion: "2", generator: "search", gsrsearch: query, gsrnamespace: "0", gsrlimit: String(n), prop: "pageprops|info|categories|description", ppprop: "disambiguation", inprop: "url", cllimit: "max", clshow: "!hidden" });
  const r = await httpGet(`${WP}?${q}`, { json: true });
  await sleep(DELAY_MS);
  const pages = r.json?.query?.pages ?? [];
  return pages.sort((a, b) => (a.index ?? 99) - (b.index ?? 99));
}

function accept(page, how, tried) {
  return {
    status: "ok", how,
    title: page.title, pageid: page.pageid, revid: page.lastrevid ?? null,
    url: page.canonicalurl ?? page.fullurl ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`,
    qid: page.pageprops?.wikibase_item ?? null,
    shortdesc: page.description ?? page.pageprops?.["wikibase-shortdesc"] ?? null,
    categories: (page.categories ?? []).map(c => (c.title || "").replace(/^Category:/, "")),
    fragment: page._fragment ?? null,
    useForEvaluation: true,
    tried, rejected: [],
  };
}

async function resolveOne(row) {
  const r = await resolveInner(row);
  // Designs map to companies (Bitly) or physical domains (Parking lot), never architecture —
  // ~5% EXACT. Quarantine any hit as ADJACENT so it never drives evaluation; designs are judged
  // internally (demonstrates-edges + estimation arithmetic), not against Wikipedia.
  if (row.kind === "design" && r.status === "ok") {
    return { ...r, status: "adjacent", useForEvaluation: false, adjacentReason: "design pages get internal-only evaluation; the resolved article is the company/domain, not the architecture" };
  }
  return r;
}

async function resolveInner(row) {
  const { primary, aliases } = candidates(row);
  const tried = [];
  const rejected = [];

  // stage 1 — primary candidates built from the name (batched)
  const probe = await probeTitles(primary);
  // prefer a QUALIFIED title over the bare name when both resolve (saves circuit-breaker, monad…)
  const ordered = [...primary].sort((a, b) => (b.length - a.length)); // longer (qualified) first
  for (const t of ordered) {
    tried.push(t);
    const p = probe.get(t);
    if (!p || p.missing) continue;
    if (p.ns !== 0) { rejected.push({ title: p.title, reason: `ns=${p.ns}` }); continue; }
    if (isDisambig(p)) { rejected.push({ title: p.title, reason: "disambiguation" }); continue; }
    if (!relevant(p, row.kind)) { rejected.push({ title: p.title, reason: `wrong-sense: ${p.description ?? "?"}` }); continue; }
    return { ...accept(p, p._via === "redirect" ? "redirect" : "direct", tried), rejected };
  }

  // stage 2 — aliases, gated
  if (aliases.length) {
    const aprobe = await probeTitles(aliases.flatMap(a => [a, sentenceCase(a)]));
    for (const a of aliases.flatMap(a => [a, sentenceCase(a)])) {
      tried.push(a);
      const p = aprobe.get(a);
      if (!p || p.missing || p.ns !== 0) continue;
      if (isDisambig(p)) { rejected.push({ title: p.title, reason: "disambiguation(alias)" }); continue; }
      if (!relevant(p, row.kind)) { rejected.push({ title: p.title, reason: `wrong-sense(alias): ${p.description ?? "?"}` }); continue; }
      return { ...accept(p, "alias", tried), rejected };
    }
  }

  // stage 3 — nearmatch on name, then name + " pattern"
  for (const nm of [row.name, `${row.name} pattern`]) {
    const hit = await nearmatch(nm);
    tried.push(`nearmatch:${nm}`);
    if (!hit) continue;
    const p2 = (await probeTitles([hit])).get(hit);
    if (!p2 || p2.missing || p2.ns !== 0 || isDisambig(p2)) continue;
    if (!relevant(p2, row.kind)) { rejected.push({ title: p2.title, reason: "wrong-sense(nearmatch)" }); continue; }
    return { ...accept(p2, "nearmatch", tried), rejected };
  }

  // stage 4 — full-text search with band context
  const ctx = BAND_CONTEXT[row.band] ?? BAND_CONTEXT[row.kind] ?? "software";
  const hits = await searchTop(`${row.name} ${ctx}`, 5);
  tried.push(`search:${row.name} ${ctx}`);
  for (const p of hits) {
    if (p.ns !== 0 || isDisambig(p)) continue;
    if (!relevant(p, row.kind)) continue;
    // similarity guard: share a content word with the KB name
    const nameWords = new Set(row.name.toLowerCase().split(/\W+/).filter(w => w.length > 2));
    const titleWords = p.title.toLowerCase().split(/\W+/);
    if (!titleWords.some(w => nameWords.has(w))) { rejected.push({ title: p.title, reason: "search-low-similarity" }); continue; }
    return { ...accept(p, "search", tried), rejected };
  }

  return { status: "none", how: "exhausted", tried, rejected, useForEvaluation: false };
}

// ---------------------------------------------------------------- Wikipedia body fetch

async function fetchWikiBody(res) {
  // full plaintext extract — strictly one title per request
  const q = new URLSearchParams({ action: "query", format: "json", formatversion: "2", prop: "extracts", explaintext: "1", redirects: "1", titles: res.title, maxlag: "5" });
  const r = await httpGet(`${WP}?${q}`, { json: true });
  await sleep(DELAY_MS);
  const page = r.json?.query?.pages?.[0];
  const extract = page?.extract ?? "";
  // TOC via tocdata
  const tq = new URLSearchParams({ action: "parse", format: "json", formatversion: "2", page: res.title, prop: "tocdata", redirects: "1" });
  const tr = await httpGet(`${WP}?${tq}`, { json: true });
  await sleep(DELAY_MS);
  const toc = (tr.json?.parse?.tocdata?.sections ?? []).map(s => ({ level: s.hLevel, line: s.line, anchor: s.anchor }));
  return { extract, toc, revid: page?.revid ?? res.revid ?? null };
}

// ---------------------------------------------------------------- alt-source HTML → text

let _parse = null;
async function htmlToText(html) {
  if (!_parse) ({ parse: _parse } = requireFromTools("node-html-parser"));
  const root = _parse(html, { comment: false });
  const scope = root.querySelector("main") ?? root.querySelector("article") ?? root.querySelector("body") ?? root;
  for (const n of scope.querySelectorAll("script, style, nav, header, footer, aside, form, svg, noscript, .sidebar, .toc, .navbox")) n.remove();
  // structuredText inserts newlines around block elements
  const txt = scope.structuredText || scope.text || "";
  return txt.split("\n").map(l => l.replace(/[ \t]+/g, " ").trimEnd()).filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n").trim();
}

// ---------------------------------------------------------------- index model

function loadIndex() { return readJson(INDEX_PATH, { schemaVersion: 1, generatedAt: CAPTURED_AT, entries: {} }); }
function saveIndex(idx) { idx.generatedAt = CAPTURED_AT; writeJson(INDEX_PATH, idx); }

function selectIds(idx, only) {
  const ids = Object.keys(idx.entries);
  return only ? ids.filter(id => only.has(id)) : ids;
}

// ---------------------------------------------------------------- subcommands

function cmdPlan() {
  const only = onlySet();
  const rows = kbLs(optVal("--kb-json"));
  const allow = readJson(SOURCES_ALLOWLIST, { sources: {} }).sources ?? {};
  const idx = loadIndex();
  let n = 0;
  for (const row of rows) {
    if (only && !only.has(row.id)) continue;
    const prev = idx.entries[row.id] ?? {};
    idx.entries[row.id] = {
      id: row.id, kind: row.kind, band: row.band, name: row.name,
      essence: row.essence, path: row.path, aliases: row.aliases ?? [],
      wikipedia: prev.wikipedia ?? null,
      noSourceReason: prev.noSourceReason ?? null,
      alt: mergeAlt(prev.alt ?? [], allow[row.id] ?? []),
      phase: prev.phase ?? "planned",
    };
    n++;
  }
  saveIndex(idx);
  info(`plan: ${n} id(s) seeded → ${INDEX_PATH}`);
}

function mergeAlt(existing, allowRows) {
  const byUrl = new Map(existing.map(a => [a.url, a]));
  for (const a of allowRows) {
    const sid = a.sid ?? slugHost(a.url);
    if (!byUrl.has(a.url)) byUrl.set(a.url, { sid, url: a.url, host: hostOf(a.url), label: a.label ?? "", tier: a.tier ?? 3, status: "planned", sha256: null, bytes: 0, fetchedAt: null });
  }
  return [...byUrl.values()].sort((x, y) => x.sid.localeCompare(y.sid));
}
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "?"; } }

async function cmdResolve() {
  const only = onlySet();
  const idx = loadIndex();
  const ids = selectIds(idx, only);
  if (!ids.length) die("nothing to resolve (run `plan` first, or check --only)");
  let pending = 0;
  for (const id of ids) {
    const e = idx.entries[id];
    if (e.wikipedia && e.wikipedia.status === "pinned") { info(`  ${id}: pinned, skip`); continue; }
    info(`resolve ${id} (${e.kind}/${e.band})`);
    const r = await resolveOne(e);
    e.wikipedia = r;
    e.phase = "resolved";
    if (r.status === "ok") info(`  → ${r.title} [${r.how}] pageid=${r.pageid}`);
    else if (r.status === "adjacent") info(`  → ADJACENT ${r.title} (quarantined, internal-only eval)`);
    else { info(`  → NONE (tried ${r.tried.length})`); pending++; }
    saveIndex(idx);
  }
  info(`resolve: ${ids.length} done, ${pending} with no Wikipedia article`);
}

function cmdPin() {
  const id = argv[1];
  if (!id || id.startsWith("--")) die("usage: pin <id> --wikipedia \"<Title>\" | --none --reason \"<why>\"");
  const idx = loadIndex();
  const e = idx.entries[id];
  if (!e) die(`unknown id: ${id} (run plan first)`);
  if (hasFlag("--none")) {
    const reason = optVal("--reason") ?? "no trustworthy source";
    e.wikipedia = { status: "none", how: "pinned", pinned: true, tried: [], rejected: [], useForEvaluation: false };
    e.noSourceReason = reason;
    e.phase = "resolved";
    saveIndex(idx);
    info(`pin: ${id} → no source (${reason})`);
    return;
  }
  const title = optVal("--wikipedia");
  if (!title) die("pin needs --wikipedia \"<Title>\" or --none");
  e.wikipedia = { status: "pinned", how: "pinned", title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`, useForEvaluation: true, tried: [], rejected: [] };
  e.phase = "resolved";
  saveIndex(idx);
  info(`pin: ${id} → ${title}`);
}

function cmdAlt() {
  const sub = argv[1];
  if (sub !== "add") die("usage: alt add <id> --url <u> --label \"<why>\" [--tier N] [--sid <s>]");
  const id = argv[2];
  const url = optVal("--url");
  if (!id || !url) die("alt add needs <id> and --url");
  const idx = loadIndex();
  const e = idx.entries[id];
  if (!e) die(`unknown id: ${id}`);
  const sid = optVal("--sid") ?? slugHost(url);
  if (!e.alt.some(a => a.url === url)) {
    e.alt.push({ sid, url, host: hostOf(url), label: optVal("--label") ?? "", tier: Number(optVal("--tier") ?? 3), status: "planned", sha256: null, bytes: 0, fetchedAt: null });
    e.alt.sort((x, y) => x.sid.localeCompare(y.sid));
  }
  saveIndex(idx);
  info(`alt: ${id} += ${sid} (${url})`);
}

async function cmdFetch() {
  const only = onlySet();
  const refresh = hasFlag("--refresh");
  const force = hasFlag("--force");
  const idx = loadIndex();
  const ids = selectIds(idx, only);
  if (!ids.length) die("nothing to fetch (run resolve first, or check --only)");
  let networkFailed = false;

  for (const id of ids) {
    const e = idx.entries[id];
    const dir = join(OUT, "sources", id);
    const provenance = [];

    // --- Wikipedia lane ---
    const w = e.wikipedia;
    if (w && (w.status === "ok" || w.status === "pinned") && w.useForEvaluation !== false) {
      const metaPath = join(dir, "wikipedia.meta.json");
      const prev = readJson(metaPath, null);
      const unchanged = !refresh && !force && prev && w.revid && prev.revid === w.revid;
      if (unchanged) {
        info(`  ${id}: wikipedia unchanged (revid ${w.revid}), skip`);
        provenance.push(prev.provenance);
      } else {
        info(`fetch ${id}: wikipedia "${w.title}"`);
        const body = await fetchWikiBody(w);
        if (!body.extract) { info(`  ! empty extract for ${w.title}`); networkFailed = networkFailed || false; }
        const raw = body.extract;
        writeText(join(dir, "wikipedia.raw.txt"), `> Source: ${w.url}\n> Wikipedia — CC BY-SA 4.0 — revid ${body.revid ?? "?"}\n\n${raw}\n`);
        writeText(join(dir, "wikipedia.norm.txt"), norm(raw) + "\n");
        const prov = { sid: "wikipedia", tier: 2, title: w.title, url: w.url, fetchVia: "action-api:extracts+tocdata", revid: body.revid, license: "CC BY-SA 4.0", bytes: raw.length, sha256: sha256(raw), toc: body.toc, fetchedAt: CAPTURED_AT };
        writeJson(metaPath, { revid: body.revid, provenance: prov });
        provenance.push(prov);
        w.revid = body.revid ?? w.revid;
      }
    } else if (w && (w.status === "none")) {
      info(`  ${id}: no Wikipedia source (${e.noSourceReason ?? "none"})`);
    }

    // --- alt lane ---
    for (const a of e.alt ?? []) {
      const outRaw = join(dir, `${a.sid}.raw.txt`);
      if (!force && !refresh && a.status === "ok" && existsSync(outRaw)) { info(`  ${id}: ${a.sid} cached`); provenance.push(altProv(a)); continue; }
      info(`fetch ${id}: alt ${a.sid} (${a.url})`);
      const r = await httpGet(a.url);
      if (!r.ok) {
        a.status = r.status === 0 ? "network-error" : `http-${r.status}`;
        info(`  ! ${a.sid} → ${a.status}`);
        if (r.status === 0) networkFailed = true;
        continue;
      }
      // guard against tiny redirect/SPA stubs
      if (r.body.length < 400) { a.status = "stub"; info(`  ! ${a.sid} looks like a ${r.body.length}b stub, skipped`); continue; }
      const ctype = (r.headers.get("content-type") || "").toLowerCase();
      let text = r.body;
      if (ctype.includes("html") || /^\s*</.test(r.body)) text = await htmlToText(r.body);
      writeText(outRaw, `> Source: ${a.url}\n> ${a.label} — tier ${a.tier}\n\n${text}\n`);
      writeText(join(dir, `${a.sid}.norm.txt`), norm(text) + "\n");
      a.status = "ok"; a.bytes = text.length; a.sha256 = sha256(text); a.fetchedAt = CAPTURED_AT; a.finalUrl = r.finalUrl;
      provenance.push(altProv(a));
    }

    writeJson(join(dir, "sources.json"), { kbId: id, fetchedAt: CAPTURED_AT, sources: provenance.filter(Boolean) });
    e.phase = "fetched";
    saveIndex(idx);
  }
  if (networkFailed) { info("fetch: some sources failed after retries (exit 4)"); process.exit(4); }
  info(`fetch: ${ids.length} id(s) processed`);
}
function altProv(a) { return { sid: a.sid, tier: a.tier, title: a.label, url: a.url, fetchVia: "http-get", license: "see source ToS", bytes: a.bytes, sha256: a.sha256, fetchedAt: a.fetchedAt }; }

function cmdStatus() {
  const only = onlySet();
  const asJson = hasFlag("--json");
  const idx = loadIndex();
  const ids = selectIds(idx, only);
  const pending = [];
  for (const id of ids) {
    const e = idx.entries[id];
    let phase = e.phase ?? "planned";
    if (phase !== "fetched") pending.push({ id, kind: e.kind, band: e.band, phase });
  }
  if (asJson) {
    process.stdout.write(JSON.stringify({ total: ids.length, done: ids.length - pending.length, pending: pending.length, pendingIds: pending }, null, 2) + "\n");
  } else {
    info(`status: ${ids.length - pending.length}/${ids.length} fetched`);
    for (const p of pending.slice(0, 30)) info(`  pending ${p.id} (${p.phase})`);
    if (pending.length > 30) info(`  … +${pending.length - 30} more`);
  }
  process.exit(pending.length ? 2 : 0);
}

// ---------------------------------------------------------------- dispatch

const CMD = argv[0];
try {
  if (CMD === "plan") cmdPlan();
  else if (CMD === "resolve") await cmdResolve();
  else if (CMD === "pin") cmdPin();
  else if (CMD === "alt") cmdAlt();
  else if (CMD === "fetch") await cmdFetch();
  else if (CMD === "status") cmdStatus();
  else { info("usage: fetch.mjs plan|resolve|pin|alt|fetch|status  (see header)"); process.exit(1); }
} catch (e) {
  die(e.stack || String(e));
}
