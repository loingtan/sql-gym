// Loads lessons from content/<track>/NN-slug.md. Format (see README "Writing lessons"):
//   --- frontmatter (title, part, concept) ---
//   theory markdown ... ## Exercise: <title> (task, ```sql <field>``` blocks, ```meta```, > Hint: ...) ... ## Quiz
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { marked } from 'marked';
import { LOAD_KEYS } from './loadlab.js';

const ROOT = new URL('./content/', import.meta.url).pathname;
export const TRACKS = {
  perf: { dir: 'perf', title: 'Performance Lab', schema: 'perf' },
  ap: { dir: 'antipatterns', title: 'Antipatterns', schema: 'bugs' },
  pool: { dir: 'pooling', title: 'Connections & Pooling', schema: 'perf' },
};

const html = (tokens, links) => marked.parser(Object.assign(tokens, { links }));

function parseMeta(text) {
  const meta = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'forbid' || k === 'require' || k === 'goal') (meta[k] ??= []).push(v.trim());
    else meta[k] = v.trim();
  }
  return meta;
}

function parseExercise(title, tokens, links, unit, n) {
  const sql = {}, task = [], hints = [];
  let meta = {};
  for (const t of tokens) {
    const field = t.type === 'code' && t.lang?.match(/^sql\s+([\w-]+)$/)?.[1];
    if (field) sql[field] = t.text.trim();
    else if (t.type === 'code' && t.lang === 'meta') meta = parseMeta(t.text);
    else if (t.type === 'blockquote' && /^Hint:/i.test(t.text)) hints.push(marked.parse(t.text.replace(/^Hint:\s*/i, '')));
    else task.push(t);
  }
  const baseline = sql.baseline ?? null;
  const tunable = (meta.tunable ?? '').split(',').map(s => s.trim()).filter(Boolean);
  // "text | message": split on the LAST " | " so the text itself may contain a bar.
  const pair = r => {
    const i = r.lastIndexOf(' | ');
    return i < 0 ? [r, null] : [r.slice(0, i).trim(), r.slice(i + 3).trim()];
  };
  return {
    id: meta.id ?? `${unit.id}-${n}`,
    unitId: unit.id,
    n,
    title,
    kind: meta.kind ?? 'query',
    schema: meta.schema ?? unit.schema,
    taskHtml: html(task, links),
    hints,
    baseline,
    reference: sql.reference ?? baseline,
    starter: { setup: sql['starter-setup'] ?? '', query: sql.starter ?? baseline ?? sql.request ?? '' },
    solution: { setup: sql['solution-setup'] ?? '', query: sql.solution ?? sql.request ?? '' },
    // kind: load (see loadlab.js)
    request: sql.request ?? null,
    editQuery: meta['edit-query'] === 'true',
    tunable,
    params: meta,
    fixed: Object.fromEntries(LOAD_KEYS.filter(k => meta[k] != null && !tunable.includes(k)).map(k => [k, meta[k]])),
    goals: (meta.goal ?? []).map(g => ({ expr: pair(g)[0], msg: pair(g)[1] ?? pair(g)[0] })),
    template: sql.template ?? null,
    ordered: meta.ordered === 'true',
    speedup: meta.speedup ? Number(meta.speedup) : null,
    forbid: meta.forbid ?? [],
    require: (meta.require ?? []).map(r => ({ re: pair(r)[0], msg: pair(r)[1] ?? `Use ${pair(r)[0]}` })),
  };
}

function parseQuiz(tokens, links) {
  const out = [];
  let q;
  for (const t of tokens) {
    if (t.type === 'heading' && t.depth === 3) out.push(q = { qHtml: marked.parseInline(t.text), body: [], options: [], why: '' });
    else if (!q) continue;
    else if (t.type === 'list' && t.items.some(i => i.task)) q.options = t.items.map(i => ({ html: marked.parseInline(i.text), correct: i.checked }));
    else if (t.type === 'blockquote') q.why = marked.parse(t.text);
    else if (t.type !== 'space') q.body.push(t);
  }
  return out.map(({ body, ...q }) => ({ ...q, bodyHtml: html(body, links) }));
}

export function parseUnit(track, file, text) {
  const num = Number(file.match(/^(\d+)/)?.[1] ?? 0);
  const [, fm = '', body = text] = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/) ?? [];
  const front = parseMeta(fm);
  const [cTitle, cText] = (front.concept ?? '').split('|').map(s => s.trim());
  const unit = {
    id: `${track}-${String(num).padStart(2, '0')}`,
    track,
    number: num,
    title: front.title ?? file,
    part: front.part ?? '',
    schema: front.schema ?? TRACKS[track].schema,
    concept: cTitle ? { title: cTitle, text: cText ?? '' } : null,
  };
  const tokens = marked.lexer(body);
  const theory = [], exercises = [];
  let quiz = [];
  let section = { kind: 'theory', tokens: theory };
  const flush = () => {
    if (section.kind === 'exercise') exercises.push(parseExercise(section.title, section.tokens, tokens.links, unit, exercises.length + 1));
    if (section.kind === 'quiz') quiz = parseQuiz(section.tokens, tokens.links);
  };
  for (const t of tokens) {
    const ex = t.type === 'heading' && t.depth === 2 && t.text.match(/^Exercise:\s*(.*)$/i);
    const isQuiz = t.type === 'heading' && t.depth === 2 && /^Quiz$/i.test(t.text);
    if (ex || isQuiz) {
      flush();
      section = ex ? { kind: 'exercise', title: ex[1], tokens: [] } : { kind: 'quiz', tokens: [] };
    } else section.tokens.push(t);
  }
  flush();
  return { ...unit, theoryHtml: html(theory, tokens.links), exercises, quiz };
}

// Re-parse only when a lesson file changed, so lessons can be edited while the app runs.
let cache, stamp;
export function loadContent() {
  const files = Object.entries(TRACKS).flatMap(([track, t]) =>
    readdirSync(join(ROOT, t.dir)).filter(f => f.endsWith('.md')).sort().map(f => ({ track, path: join(ROOT, t.dir, f), f })));
  const s = files.map(x => x.path + statSync(x.path).mtimeMs).join();
  if (s !== stamp) {
    const units = files.map(x => parseUnit(x.track, x.f, readFileSync(x.path, 'utf8')));
    const exercises = new Map(units.flatMap(u => u.exercises.map(e => [e.id, e])));
    cache = { units, exercises };
    stamp = s;
  }
  return cache;
}
