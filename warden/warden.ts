// Test Warden: deterministic review and triage for AI-generated Playwright tests.
//
//   node warden/warden.ts review <spec.md> <test-file>
//   node warden/warden.ts triage <chaos-mode> [test-path]
//
// Review runs the test file once with evidence collection on (WARDEN=1), then
// checks the code and the evidence against warden/RULES.md. Triage runs the
// suite under a chaos mode and classifies every failure. No model is asked for
// an opinion: the same spec, tests, and app always give the same report.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Severity = 'High' | 'Medium' | 'Low';
type Route = 'Human review required' | 'LLM review' | 'Automated check: may merge';

interface AuditMark { action: string; outcome: 'ALLOWED' | 'DENIED' }
interface RequestEntry {
  method: string; path: string; status: number; actor: string; role: string;
  kind: string; relation: string | null; target: string | null; audits: AuditMark[];
}
interface TestCase { title: string; line: number; body: string; status: string; error: string; requests: RequestEntry[] }
interface Finding { rule: string; severity: Severity; message: string; tests: string[] }
interface RuleResult { rule: string; name: string; severity: Severity; passed: boolean; detail: string }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = join(ROOT, 'warden', '.runs');

// ---------- running Playwright and reading its JSON report ----------

interface PwResult { status: string; error?: { message?: string }; attachments?: { name: string; body?: string }[] }
interface PwSpec { title: string; line: number; file: string; tests: { results: PwResult[] }[] }
interface PwSuite { specs?: PwSpec[]; suites?: PwSuite[] }

function runPlaywright(target: string, env: Record<string, string>, label: string): PwSpec[] {
  mkdirSync(RUNS, { recursive: true });
  const out = join(RUNS, `${label}.json`);
  if (existsSync(out)) rmSync(out);
  spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['playwright', 'test', target, '--reporter=json'], {
    cwd: ROOT,
    env: { ...process.env, ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: out },
    stdio: 'ignore',
  });
  if (!existsSync(out)) throw new Error(`Playwright produced no report for ${target}`);
  const report = JSON.parse(readFileSync(out, 'utf8')) as { suites: PwSuite[] };
  const specs: PwSpec[] = [];
  const walk = (s: PwSuite): void => { s.specs?.forEach((sp) => specs.push(sp)); s.suites?.forEach(walk); };
  report.suites.forEach(walk);
  return specs;
}

const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '');

// The body of the test() call that starts on `line` (1-based), by brace matching.
function testBody(source: string, line: number): string {
  const lines = source.split('\n');
  const start = lines.slice(0, line - 1).join('\n').length + 1;
  const open = source.indexOf('=> {', start);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open + 3; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') { depth--; if (depth === 0) return source.slice(open + 3, i + 1); }
  }
  return source.slice(open + 3);
}

function loadCases(specs: PwSpec[]): TestCase[] {
  const sources = new Map<string, string>();
  return specs.map((sp) => {
    const file = join(ROOT, 'tests', sp.file);
    const source = sources.get(file) ?? (existsSync(file) ? readFileSync(file, 'utf8') : '');
    sources.set(file, source);
    const result = sp.tests[0]?.results.at(-1);
    const evidence = result?.attachments?.find((a) => a.name === 'warden-requests')?.body;
    return {
      title: sp.title,
      line: sp.line,
      body: testBody(source, sp.line),
      status: result?.status ?? 'unknown',
      error: stripAnsi(result?.error?.message ?? '').split('\n').filter(Boolean).slice(0, 3).join(' | '),
      requests: evidence ? (JSON.parse(Buffer.from(evidence, 'base64').toString('utf8')) as RequestEntry[]) : [],
    };
  });
}

// ---------- reading the spec ----------

interface Spec {
  ticket: string; acs: string[]; edgeCases: string[]; auditsSignIn: boolean;
  matrix: { action: string; column: string; allowed: boolean }[];
}

function section(md: string, heading: RegExp): string {
  const start = md.search(heading);
  if (start < 0) return '';
  const rest = md.slice(start).split('\n').slice(1).join('\n');
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
}

function readSpec(path: string): Spec {
  const md = readFileSync(path, 'utf8');
  const ticket = /^# (\S+?):/m.exec(md)?.[1] ?? basename(path).split('-').slice(0, 2).join('-');
  const acs = [...md.matchAll(/^AC-(\d+)\./gm)].map((m) => `AC-${m[1]}`);
  const rows = section(md, /^## \d+\. Access rules/m).split('\n').filter((l) => l.trim().startsWith('|'));
  const columns = (rows[0] ?? '').split('|').map((c) => c.trim()).filter(Boolean).slice(1);
  const matrix = rows.slice(2).flatMap((row) => {
    const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
    return cells.slice(1).map((cell, i) => ({ action: cells[0], column: columns[i], allowed: /^yes/i.test(cell) }));
  });
  const edgeCases = section(md, /^## \d+\. Edge cases/m).split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
  const ac7 = /^AC-7\.[\s\S]*?(?=^AC-8\.)/m.exec(md)?.[0] ?? '';
  return { ticket, acs, edgeCases, matrix, auditsSignIn: /sign-in attempt/i.test(ac7) };
}

// ---------- review rules ----------

const QUALITY: { id: string; name: string; severity: Severity; pattern: RegExp }[] = [
  { id: 'Q1', name: 'No hard waits', severity: 'High', pattern: /waitForTimeout|networkidle|=>\s*setTimeout\(/ },
  { id: 'Q2', name: 'No hard-coded record IDs', severity: 'High', pattern: /\b(?:SH|CL)-\d+\b/ },
  { id: 'Q3', name: 'No test.only or test.skip', severity: 'High', pattern: /test\.(?:only|skip)\(/ },
  { id: 'Q4', name: 'No positional or layout-bound locators', severity: 'Medium', pattern: /\.(?:nth|first|last)\(|locator\(\s*['"`](?:\.|#|\/\/|xpath=)/ },
  { id: 'Q5', name: 'No one-time snapshot assertions', severity: 'Medium', pattern: /expect\(\s*await\s+[\w.()'"`, ]+\.(?:isVisible|isHidden|isEnabled|isDisabled|isChecked|textContent|innerText|inputValue)\(/ },
];

// Which tests prove each edge case. Matched on the test title.
const EDGE_MATCHERS: { when: RegExp; title: RegExp }[] = [
  { when: /twice|double click|two tabs/i, title: /twice|two tabs|same moment|simultaneous|double/i },
  { when: /session expired/i, title: /expired|session/i },
  { when: /does not exist/i, title: /does not exist|not exist|unknown|not found/i },
];

function cellEvidence(action: string, column: string, cases: TestCase[]): { covered: boolean; serverDenied: boolean } {
  const reqs = cases.flatMap((c) => c.requests.map((r) => ({ r, c })));
  const col = /scheduler/i.test(column) ? 'scheduler' : /other/i.test(column) ? 'other' : 'assigned';
  const denied = (r: RequestEntry): boolean => r.status === 403 || r.status === 409;
  let hits: { r: RequestEntry; c: TestCase }[] = [];
  if (/list/i.test(action)) {
    hits = reqs.filter(({ r }) => r.kind === 'list' && r.relation === (col === 'scheduler' ? 'scheduler' : 'caregiver'));
    if (col === 'other') hits = hits.filter(({ c }) => /toHaveCount\(0\)/.test(c.body));
    return { covered: hits.length > 0, serverDenied: true };
  }
  if (/confirm/i.test(action)) {
    const rel = { assigned: 'owner', other: 'other-caregiver', scheduler: 'scheduler' }[col];
    hits = reqs.filter(({ r }) => r.kind === 'confirm' && r.relation === rel);
  } else if (/client/i.test(action)) {
    const rel = { assigned: 'assigned', other: 'other-caregiver', scheduler: 'scheduler' }[col];
    hits = reqs.filter(({ r }) => r.kind === 'client' && r.relation === rel);
  } else if (/audit/i.test(action)) {
    const caregiverViews = reqs.filter(({ r }) => r.kind === 'audit' && r.relation === 'caregiver');
    const actors = [...new Set(caregiverViews.map(({ r }) => r.actor))];
    if (col === 'scheduler') hits = reqs.filter(({ r }) => r.kind === 'audit' && r.relation === 'scheduler');
    else if (col === 'assigned') hits = caregiverViews;
    else hits = actors.length >= 2 ? caregiverViews.filter(({ r }) => r.actor === actors[1]) : [];
  }
  return { covered: hits.length > 0, serverDenied: hits.some(({ r }) => denied(r)) };
}

function review(specPath: string, testPath: string): void {
  const spec = readSpec(join(ROOT, specPath));
  const source = readFileSync(join(ROOT, testPath), 'utf8');
  const version = basename(dirname(testPath));
  console.log(`Test Warden: reviewing ${testPath} against ${specPath}`);
  console.log('Running the tests once to collect evidence...');
  const cases = loadCases(runPlaywright(testPath, { WARDEN: '1', WARDEN_SELFTEST: '1', CHAOS: '' }, `review-${spec.ticket}-${version}`));
  const findings: Finding[] = [];
  const results: RuleResult[] = [];
  const add = (r: RuleResult, f?: Finding): void => { results.push(r); if (f) findings.push(f); };

  // Code quality (Q1–Q6)
  for (const q of QUALITY) {
    const bad = cases.filter((c) => q.pattern.test(c.body)).map((c) => c.title);
    const fileWide = q.id === 'Q3' && q.pattern.test(source);
    const passed = bad.length === 0 && !fileWide;
    add({ rule: q.id, name: q.name, severity: q.severity, passed, detail: passed ? 'None found' : `${bad.length || 'File-level'} occurrence(s)` },
      passed ? undefined : { rule: q.id, severity: q.severity, message: q.name, tests: bad });
  }
  const untagged = cases.filter((c) => !/^\[(?:AC-\d+|Edge)/i.test(c.title)).map((c) => c.title);
  add({ rule: 'Q6', name: 'Titles name their acceptance criterion', severity: 'Low', passed: untagged.length === 0, detail: untagged.length ? `${untagged.length} untagged` : 'All tagged' },
    untagged.length ? { rule: 'Q6', severity: 'Low', message: 'Test titles without an [AC-n] tag', tests: untagged } : undefined);

  // C1 traceability
  const missingAcs = spec.acs.filter((ac) => !cases.some((c) => c.title.includes(`[${ac}]`)));
  add({ rule: 'C1', name: 'Every acceptance criterion has a test', severity: 'High', passed: missingAcs.length === 0, detail: `${spec.acs.length - missingAcs.length} of ${spec.acs.length} ACs` },
    missingAcs.length ? { rule: 'C1', severity: 'High', message: `No test for ${missingAcs.join(', ')}`, tests: [] } : undefined);

  // C2 access matrix and C3 server enforcement
  const cells = spec.matrix.map((m) => ({ ...m, ...cellEvidence(m.action, m.column, cases) }));
  const uncovered = cells.filter((c) => !c.covered);
  add({ rule: 'C2', name: 'Every access-rules cell has a test', severity: 'High', passed: uncovered.length === 0, detail: `${cells.length - uncovered.length} of ${cells.length} cells` },
    uncovered.length ? { rule: 'C2', severity: 'High', message: 'Access-rules cells with no test', tests: uncovered.map((c) => `${c.column} × ${c.action}`) } : undefined);
  // A denied cell with no server evidence, where a test signed in as that role only
  // checked that the control was hidden: hidden in the interface is not enforced.
  const hiddenControl = (action: string): RegExp | null =>
    /confirm/i.test(action) ? /Confirm shift['"`][\s\S]{0,120}toHaveCount\(0\)/
      : /client/i.test(action) ? /getByRole\(\s*['"`]link['"`][\s\S]{0,160}toHaveCount\(0\)/
        : null;
  const hiddenOnly = (c: { column: string; action: string }): boolean => {
    const control = hiddenControl(c.action);
    const role = /scheduler/i.test(c.column) ? 'scheduler' : 'caregiver';
    return control !== null && cases.some((t) => t.requests.some((r) => r.role === role) && control.test(t.body));
  };
  const notEnforced = cells.filter((c) => !c.allowed && !/list/i.test(c.action) && ((c.covered && !c.serverDenied) || (!c.covered && hiddenOnly(c))));
  add({ rule: 'C3', name: 'Denials proven at the server', severity: 'High', passed: notEnforced.length === 0, detail: notEnforced.length ? `${notEnforced.length} denial(s) not proven` : 'Every tested denial got a 403 or 409 from the server' },
    notEnforced.length ? { rule: 'C3', severity: 'High', message: 'Denied cells tested without a server rejection', tests: notEnforced.map((c) => `${c.column} × ${c.action}`) } : undefined);

  // C4 denials audited: a test that caused a DENIED audit entry must assert one
  const unaudited = cases.filter((c) => c.requests.some((r) => r.audits.some((a) => a.outcome === 'DENIED')) && !(/DENIED/.test(c.body) && /readAudit/.test(c.body)));
  add({ rule: 'C4', name: 'Every denied attempt is checked in the audit trail', severity: 'High', passed: unaudited.length === 0, detail: unaudited.length ? `${unaudited.length} test(s) cause a denial but never check its audit entry` : 'All checked' },
    unaudited.length ? { rule: 'C4', severity: 'High', message: 'Tests that cause a denied attempt but never assert the DENIED audit entry', tests: unaudited.map((c) => `${c.title} (line ${c.line}): ${[...new Set(c.requests.flatMap((r) => r.audits.filter((a) => a.outcome === 'DENIED').map((a) => `${a.action} ${r.status}`)))].join(', ')}`) } : undefined);

  // C5 changes audited
  const changers = cases.filter((c) => c.requests.some((r) => r.audits.some((a) => a.action === 'SHIFT_CONFIRM' && a.outcome === 'ALLOWED')));
  const c5 = changers.some((c) => /ALLOWED/.test(c.body) && /readAudit/.test(c.body));
  add({ rule: 'C5', name: 'Successful changes are checked in the audit trail', severity: 'Medium', passed: c5, detail: c5 ? 'Confirmation audit entry asserted' : 'No test asserts the ALLOWED entry for a confirmation' },
    c5 ? undefined : { rule: 'C5', severity: 'Medium', message: 'No test asserts the ALLOWED audit entry for a confirmation', tests: [] });

  // C6 no PHI in the audit trail (follows helper functions defined in the file)
  const phiHelpers = [...source.matchAll(/function\s+(\w+)[^{]*\{[^}]*careNotes/g)].map((m) => m[1]);
  const phiCheck = cases.some((c) => /readAudit/.test(c.body) && /not\.toContain/.test(c.body) && (/careNotes/.test(c.body) || phiHelpers.some((h) => c.body.includes(`${h}(`))));
  add({ rule: 'C6', name: 'Audit trail checked for PHI', severity: 'High', passed: phiCheck, detail: phiCheck ? 'Client name, address, phone, and care notes checked' : 'No test checks the audit trail for client details' },
    phiCheck ? undefined : { rule: 'C6', severity: 'High', message: 'No test checks the audit trail for PHI', tests: [] });

  // C7 edge cases
  const missingEdges = spec.edgeCases.filter((e) => {
    const m = EDGE_MATCHERS.find((x) => x.when.test(e));
    return !m || !cases.some((c) => m.title.test(c.title));
  });
  add({ rule: 'C7', name: 'Every edge case has a test', severity: 'Medium', passed: missingEdges.length === 0, detail: `${spec.edgeCases.length - missingEdges.length} of ${spec.edgeCases.length} edge cases` },
    missingEdges.length ? { rule: 'C7', severity: 'Medium', message: 'Edge cases with no test', tests: missingEdges } : undefined);

  // C8 audited events the spec lists
  if (spec.auditsSignIn) {
    const signIn = (outcome: string): boolean => cases.some((c) => c.requests.some((r) => r.audits.some((a) => a.action === 'SIGN_IN' && a.outcome === outcome)) && /SIGN_IN/.test(c.body) && new RegExp(outcome).test(c.body));
    const missing = ['ALLOWED', 'DENIED'].filter((o) => !signIn(o));
    add({ rule: 'C8', name: 'Every audited event the spec lists is tested', severity: 'High', passed: missing.length === 0, detail: missing.length ? `Sign-in ${missing.join(' and ')} not asserted` : 'Sign-in allowed and denied both asserted' },
      missing.length ? { rule: 'C8', severity: 'High', message: `No test asserts the audit entry for a ${missing.map((m) => (m === 'ALLOWED' ? 'successful' : 'failed')).join(' or ')} sign-in`, tests: [] } : undefined);
  }

  const route: Route = findings.some((f) => f.severity === 'High') ? 'Human review required' : findings.length ? 'LLM review' : 'Automated check: may merge';
  const failed = cases.filter((c) => c.status !== 'passed' && c.status !== 'skipped');
  writeReport(spec, testPath, version, cases, results, findings, route, failed);

  console.log(`\n${cases.length} tests, ${failed.length} failed during the evidence run`);
  for (const r of results) console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.rule.padEnd(3)} ${r.name.padEnd(52)} ${r.detail}`);
  console.log(`\nRoute: ${route}`);
  console.log(`Report: warden/reviews/${spec.ticket}-${version}.md`);
}

function writeReport(spec: Spec, testPath: string, version: string, cases: TestCase[], results: RuleResult[], findings: Finding[], route: Route, failed: TestCase[]): void {
  const lines = [
    `# Test Warden review: ${spec.ticket}, ${version}`,
    '',
    `Test file: \`${testPath}\` (${cases.length} tests)  `,
    `Spec: ${spec.ticket}  `,
    `Rules: \`warden/RULES.md\`  `,
    `Generated: ${new Date().toISOString()} by \`node warden/warden.ts review\``,
    '',
    `## Route: ${route}`,
    '',
    findings.length ? `${findings.length} finding(s): ${findings.filter((f) => f.severity === 'High').length} high, ${findings.filter((f) => f.severity === 'Medium').length} medium, ${findings.filter((f) => f.severity === 'Low').length} low.` : 'No findings.',
    failed.length ? `\n**${failed.length} test(s) failed during the evidence run**, so some evidence may be missing: ${failed.map((c) => c.title).join('; ')}` : '',
    '',
    '## Results by rule',
    '',
    '| Rule | Check | Severity | Result | Detail |',
    '|---|---|---|---|---|',
    ...results.map((r) => `| ${r.rule} | ${r.name} | ${r.severity} | ${r.passed ? 'Pass' : '**Fail**'} | ${r.detail} |`),
    '',
  ];
  if (findings.length) {
    lines.push('## Findings', '');
    for (const f of findings) {
      lines.push(`### ${f.rule} (${f.severity.toLowerCase()}): ${f.message}`);
      lines.push(...(f.tests.length ? f.tests.map((t) => `- ${t}`) : ['- (whole suite)']), '');
    }
  }
  lines.push('## Access-rules evidence', '', '| Cell | Allowed by spec | Tested |', '|---|---|---|');
  for (const m of spec.matrix) {
    const e = cellEvidence(m.action, m.column, cases);
    lines.push(`| ${m.column} × ${m.action} | ${m.allowed ? 'Yes' : 'No'} | ${e.covered ? (m.allowed || /list/i.test(m.action) ? 'Yes' : e.serverDenied ? 'Yes, server rejected it' : 'Yes, but no server rejection') : '**No**'} |`);
  }
  mkdirSync(join(ROOT, 'warden', 'reviews'), { recursive: true });
  writeFileSync(join(ROOT, 'warden', 'reviews', `${spec.ticket}-${version}.md`), lines.join('\n') + '\n');
}

// ---------- triage ----------

async function triage(mode: string, target: string): Promise<void> {
  const reseed = mode.split(',').includes('reseed');
  const data = (await import(new URL('../app/data.js', import.meta.url).href)) as { buildSeed: (o: { reseed: boolean }) => { shifts: { id: string }[]; clients: { id: string }[] } };
  const seed = data.buildSeed({ reseed });
  const liveIds = new Set([...seed.shifts.map((s) => s.id), ...seed.clients.map((c) => c.id)]);
  const env: Record<string, string> = { CHAOS: mode === 'race' ? 'slow' : mode };
  if (mode === 'race') env.CHAOS_DELAY_MS = '3000';
  console.log(`Test Warden: triage of ${target} with CHAOS=${env.CHAOS}${env.CHAOS_DELAY_MS ? ` (delay ${env.CHAOS_DELAY_MS} ms)` : ''}`);
  const cases = loadCases(runPlaywright(target, env, `triage-${mode}`));
  const failed = cases.filter((c) => c.status !== 'passed' && c.status !== 'skipped');
  const rows = failed.map((c) => {
    const staleIds = [...new Set([...c.body.matchAll(/\b((?:SH|CL)-\d+)\b/g)].map((m) => m[1]))].filter((id) => !liveIds.has(id));
    if (staleIds.length) return { c, id: 'T2', cls: 'Data drift', next: `Hard-coded ${staleIds.join(', ')} not in the current data; read IDs from the seed` };
    if (/TimeoutError|Timeout \d+ms exceeded|Timed out \d+ms/.test(c.error)) return { c, id: 'T1', cls: 'Timing or environment', next: 'Check environment health and response times; never add a sleep' };
    if (/Expected[^|]*\b(?:200|303)\b[\s\S]*Received[^|]*\b(?:403|409)\b/.test(c.error)) return { c, id: 'T4', cls: 'Expected denial', next: 'The spec denies this; fix the test' };
    return { c, id: 'T3', cls: 'Real regression', next: 'File a defect with the trace; do not change the test' };
  });
  console.log(`\n${cases.length} tests, ${failed.length} failed\n`);
  for (const r of rows) console.log(`  ${r.id}  ${r.cls.padEnd(22)} ${r.c.title}\n      ${r.c.error.slice(0, 160)}\n      → ${r.next}`);
  const lines = [
    `# Test Warden triage: CHAOS=${mode}`, '',
    `Target: \`${target}\`  `, `Generated: ${new Date().toISOString()} by \`node warden/warden.ts triage\``, '',
    `${cases.length} tests, ${failed.length} failed.`, '',
    '| Rule | Classification | Test | Evidence | Next step |', '|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | ${r.cls} | ${r.c.title} | ${r.c.error.replace(/\|/g, '/').slice(0, 140)} | ${r.next} |`),
  ];
  mkdirSync(join(ROOT, 'warden', 'triage'), { recursive: true });
  writeFileSync(join(ROOT, 'warden', 'triage', `${mode}.md`), lines.join('\n') + '\n');
  console.log(`\nReport: warden/triage/${mode}.md`);
}

// ---------- entry point ----------

const [command, a, b] = process.argv.slice(2);
if (command === 'review' && a && b) review(a, b);
else if (command === 'triage' && a) await triage(a, b ?? 'tests');
else {
  console.log('Usage:\n  node warden/warden.ts review <spec.md> <test-file>\n  node warden/warden.ts triage <slow|race|broken|reseed> [test-path]');
  process.exitCode = 1;
}
