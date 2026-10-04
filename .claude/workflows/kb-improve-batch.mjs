export const meta = {
  name: 'kb-improve-batch',
  description: 'Improve a batch of patterns-kb pages: six persona reviewers → one edit plan → kb-author, per page',
  whenToUse: 'An unattended kb-improve run over an id list, only when the owner asks for a workflow by name. It applies each plan without the judging the kb-improve skill does between hand-offs, so the interactive skill is the default. The caller resolves the ids first and runs make gen, make validate, the commits and the pull request after.',
  phases: [
    { title: 'Review', detail: 'one kb-persona-reviewer per reader per page' },
    { title: 'Synthesize', detail: 'one synthesizer per page merges and re-checks the findings' },
    { title: 'Apply', detail: 'one kb-author per page applies the edit plan' },
  ],
}

/* args: {
 *   ids:       ["circuit-breaker", "bulkhead", …]        required
 *   label:     "distributed-resilience"                  the area, kind or name for the branch and the pull request
 *   personas:  ["practitioner", …]                       optional, default all six
 *   maxEdits:  8                                         optional cap per page
 * }
 * Returns { label, pages: [{ id, reviews, kept, dropped, applied, skipped, validate, filesTouched }] } —
 * the orchestrator runs make gen and make validate once, stages the files named, and opens the pull request. */

const a = args ?? {}
if (!Array.isArray(a.ids) || a.ids.length === 0) {
  throw new Error('kb-improve-batch needs args.ids, a non-empty list of page ids')
}

const ALL_PERSONAS = ['practitioner', 'sceptic', 'senior-expert', 'architect', 'agent-consumer', 'plain-language']
const personas = Array.isArray(a.personas) && a.personas.length ? a.personas.filter((p) => ALL_PERSONAS.includes(p)) : ALL_PERSONAS
const maxEdits = Number.isInteger(a.maxEdits) && a.maxEdits > 0 ? a.maxEdits : 8

const PREAMBLE = `Work from the repo root. Read the page only through \`node scripts/kb.mjs\` (\`get <id> --block <b>\`, \`related\`, \`backlinks\`, \`refs\`). Never open a docs/**.md file or a site/*.html file to read. Your role brief is one section of .claude/skills/kb-improve/references/personas.md; read that section first and follow only it. Return the contract shape with no preamble and no narration — your output is consumed by an orchestrator, not read by a human.`

const SEVERITY = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
const CONFIDENCE = ['high', 'medium', 'low']
const ACTIONS = ['rewrite-prose', 'append-item', 'replace-item-text', 'writer-set', 'writer-explain', 'writer-wild', 'writer-production', 'link', 'unlink']

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['role', 'blocksRead', 'findings'],
  properties: {
    role: { type: 'string' },
    blocksRead: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array', maxItems: 8,
      items: {
        type: 'object', required: ['severity', 'anchor', 'problem', 'fix', 'rule', 'confidence'],
        properties: {
          severity: { type: 'string', enum: SEVERITY },
          anchor: { type: 'string', description: 'element or block id as kb.mjs get prints it, e.g. tradeoffs-con-2 or usage' },
          problem: { type: 'string' },
          fix: { type: 'string', description: 'at most 40 words, or one instruction a writer can run' },
          rule: { type: 'string', description: 'owning skill and the quoted Done-means item or section' },
          confidence: { type: 'string', enum: CONFIDENCE },
          evidence: { type: 'string' },
        },
      },
    },
    noneFound: { type: 'array', items: { type: 'string' }, description: 'blocks that hold for this reader' },
  },
}

const PLAN_SCHEMA = {
  type: 'object',
  required: ['id', 'edits', 'dropped', 'noFabricationCheck'],
  properties: {
    id: { type: 'string' },
    edits: {
      type: 'array', maxItems: maxEdits,
      items: {
        type: 'object', required: ['anchor', 'action', 'instruction', 'from', 'rule'],
        properties: {
          anchor: { type: 'string' },
          action: { type: 'string', enum: ACTIONS },
          instruction: { type: 'string', description: 'what the writer runs: the kb.mjs writer with its arguments, or the prose to put in place' },
          from: { type: 'array', items: { type: 'string' } },
          rule: { type: 'string' },
        },
      },
    },
    dropped: {
      type: 'array',
      items: {
        type: 'object', required: ['anchor', 'reason'],
        properties: { anchor: { type: 'string' }, reason: { type: 'string' } },
      },
    },
    noFabricationCheck: { type: 'string', description: 'every added name or number with its source, or "nothing added"' },
  },
}

const APPLY_SCHEMA = {
  type: 'object',
  required: ['id', 'applied', 'skipped', 'validate', 'filesTouched'],
  properties: {
    id: { type: 'string' },
    applied: { type: 'array', items: { type: 'string' }, description: 'one line per edit applied, by its E number' },
    skipped: {
      type: 'array',
      items: {
        type: 'object', required: ['anchor', 'reason'],
        properties: { anchor: { type: 'string' }, reason: { type: 'string' } },
      },
    },
    validate: { type: 'string', description: 'the output of node scripts/kb.mjs validate <id>, or "clean"' },
    filesTouched: { type: 'array', items: { type: 'string' } },
  },
}

/* One reviewer per persona, in parallel. The synthesizer needs all of them, so this is the
 * one genuine join per page; pages themselves never wait on each other. */
const review = (id) => parallel(personas.map((p) => () =>
  agent(`${PREAMBLE}

Review one page as one reader.

Page: ${id}
Role: ${p}
Owning block skills: the kind's block skill (kb-pattern-blocks, kb-hazard-blocks, kb-theme-blocks, kb-principle-blocks, the kb-design-* skills, kb-capability-blocks or kb-comparison-blocks), kb-explain for the explain block, kb-sketch for a code sketch. Find the kind with \`kb.mjs get ${id} --block description\`, whose header prints it.

Return at most 8 findings, most severe first, each anchored to an element or block id as kb.mjs prints it, with the fix in at most 40 words and the rule it cites. Propose no reorder, no deletion except of a claim you can show is false, and no new product, metric or number below high confidence with a source. An empty findings list with the blocks that hold is a valid answer.`,
    { label: `${id}:${p}`, phase: 'Review', agentType: 'kb-persona-reviewer', schema: FINDINGS_SCHEMA })
))

const synthesize = (id, reviews) => agent(`${PREAMBLE}

Role: synthesizer. Merge these reviews of one page into one edit plan, following the synthesizer section of the personas file step by step: normalize, dedupe, re-read every anchored block yourself with \`kb.mjs get ${id} --block <b>\` and drop what is not there, resolve conflicts in the stated order, then apply the hard rules.

Page: ${id}
Cap: at most ${maxEdits} edits, most severe first; the rest are dropped as "over cap".

Reviews:
${JSON.stringify(reviews, null, 1)}

Hard rules, which no severity overrides: never reorder, renumber or delete an existing list item (fix in place or append; delete only a claim shown false, and name it as a citation break); no fabrication (every added name or number appears in noFabricationCheck with its source, or the edit is dropped); generated blocks (relationships, tour, fluency) and hubs are never edited, an edge changes through link or unlink only; the gate limits hold (frontmatter description ≤160 chars, description block ≤80 words, explain 60–180 words with 2–4 costs of ≤25 words and an example ≤120 words, solves 3–5 phrases of ≤20 words, 2–5 closed-set tags, exactly three selfcheck questions, bold never italic, no glossary avoid-list word). Each edit's instruction must be something kb-author can run as written: the kb.mjs writer command with its arguments, or the exact prose to put in place of the anchored text.`,
  { label: `${id}:synthesize`, phase: 'Synthesize', agentType: 'kb-persona-reviewer', schema: PLAN_SCHEMA })

const apply = (id, plan) => agent(`Apply this edit plan to one patterns-kb page, ${id}, and nothing else. Read .claude/rules/markdown-authoring.md first. Read the page only through \`node scripts/kb.mjs get ${id} --block <b>\`; open the file only to edit block prose.

Edits, in order:
${JSON.stringify(plan.edits, null, 1)}

Rules: frontmatter, wild, production, explain and edges go through the kb.mjs writers (set, wild, production, explain, link, unlink); wild and production replace their whole block, so dump the current one with \`kb.mjs get ${id} --block wild --json\` or \`--block production --json\` first and re-supply every item. Other block prose is edited in the file under the owning skill's rules. Never touch a generated block (relationships, tour, fluency) or a hub. Never move, renumber or delete an existing list item; a replaced item keeps its position, a new item is appended. Add no name or number the plan does not carry. Run link and unlink last, then re-read \`kb.mjs related ${id}\`. Skip an edit you cannot apply as written and say why. Do not run make gen. Finish with \`node scripts/kb.mjs validate ${id}\` and report its output verbatim, and list every file you changed.`,
  { label: `${id}:apply`, phase: 'Apply', agentType: 'kb-author', schema: APPLY_SCHEMA })

const pages = await pipeline(
  a.ids,
  async (id) => {
    const reviews = (await review(id)).filter(Boolean)
    if (reviews.length < personas.length) {
      log(`WARNING: ${id}: ${personas.length - reviews.length} reader(s) returned nothing`)
    }
    return { id, reviews }
  },
  async ({ id, reviews }) => {
    const plan = reviews.length ? await synthesize(id, reviews) : null
    if (!plan) log(`WARNING: ${id}: no plan — nothing to apply`)
    return { id, reviews, plan }
  },
  async ({ id, reviews, plan }) => {
    const raised = reviews.reduce((n, r) => n + (r.findings?.length ?? 0), 0)
    const kept = plan?.edits?.length ?? 0
    const dropped = plan?.dropped ?? []
    if (!kept) {
      log(`${id}: ${raised} finding(s) raised, none kept — apply skipped`)
      return { id, reviews: reviews.length, raised, kept, dropped, applied: [], skipped: [], validate: 'not run', filesTouched: [] }
    }
    const result = await apply(id, plan)
    log(`${id}: ${raised} raised, ${kept} kept, ${dropped.length} dropped, ${result?.applied?.length ?? 0} applied — validate: ${result?.validate ?? 'no reply'}`)
    return {
      id, reviews: reviews.length, raised, kept, dropped,
      applied: result?.applied ?? [],
      skipped: result?.skipped ?? [],
      validate: result?.validate ?? 'no reply',
      filesTouched: result?.filesTouched ?? [],
      noFabricationCheck: plan.noFabricationCheck,
    }
  },
)

return { label: a.label ?? '', pages: pages.filter(Boolean) }
