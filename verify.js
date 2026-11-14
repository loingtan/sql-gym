// Content check: every exercise's solution must pass, every slow starter must NOT pass,
// and every quiz question needs a correct option. Usage: node verify.js [id-prefix]
import { loadContent } from './content.js';
import { runExercise, pool } from './runner.js';

const prefix = process.argv[2] ?? '';
const problems = [];
const fail = (id, msg) => (problems.push(`${id}: ${msg}`), console.log(`  ✗ ${msg}`));

for (const u of loadContent().units.filter(u => u.id.startsWith(prefix) || u.exercises.some(e => e.id.startsWith(prefix)))) {
  console.log(`${u.id}  ${u.title}`);
  if (!u.concept) fail(u.id, 'missing concept in frontmatter');
  if (!u.exercises.length) fail(u.id, 'no exercises');
  u.quiz.forEach((q, i) => q.options.some(o => o.correct) || fail(u.id, `quiz question ${i + 1} has no [x] option`));

  for (const ex of u.exercises.filter(e => e.id.startsWith(prefix))) {
    if (!ex.reference && ex.kind !== 'load') { fail(ex.id, 'no reference or baseline query'); continue; }
    if (ex.kind === 'query' && !ex.solution.query) { fail(ex.id, 'no solution query'); continue; }
    const t0 = Date.now();
    const r = await runExercise(ex, ex.solution);
    const info = r.error ?? r.checks.map(c => `${c.ok ? '✓' : '✗'} ${c.label}${c.detail ? ` (${c.detail})` : ''}`).join(' · ');
    console.log(`  ${r.passed ? '✓' : '✗'} ${ex.id} solution  ${Date.now() - t0}ms  ${info}`);
    if (!r.passed) problems.push(`${ex.id}: solution does not pass`);

    // A starter that already passes means the exercise teaches nothing.
    if (ex.kind === 'load' || (ex.kind === 'query' && ex.starter.query && (ex.speedup || ex.forbid.length || ex.require.length))) {
      const s = await runExercise(ex, ex.starter);
      if (s.passed) fail(ex.id, 'the starter query already passes; tighten speedup/forbid/require');
      else if (s.error) fail(ex.id, `starter errors: ${s.error}`);
      else console.log(`    starter fails as intended (${s.checks.filter(c => !c.ok).map(c => c.label).join(', ')})`);
    }
  }
}

await pool.end();
console.log(problems.length ? `\n${problems.length} problem(s):\n${problems.join('\n')}` : '\nAll good.');
process.exit(problems.length ? 1 : 0);
