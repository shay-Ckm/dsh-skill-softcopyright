/**
 * dsh-skill-softcopyright —— 编排层 harness（M3）
 *
 * 覆盖 M3 的逻辑核心：清单校验、产物匹配、状态与证据、**门禁矩阵**、状态机推进。
 * 全部是纯逻辑（文件系统用临时目录），因此能脱离 DSH 快速跑。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');
const MANIFEST = join(PLUGIN_ROOT, 'assets', 'pipeline.yaml');

let passed = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}
const load = (rel) => import(pathToFileURL(join(PLUGIN_ROOT, rel)).href);

const { loadManifest, validateManifest, topologicalOrder, phaseById } = await load('lib/pipeline/manifest.js');
const { globToRegExp, matchArtifacts, evaluateGate, nextPhase, blockedPhases } = await load('lib/pipeline/gates.js');
const {
  emptyState, readState, writeState, recordEvidence, phaseState, updatePhase, setSharedFacts, resolveValue, PHASE_STATUS
} = await load('lib/pipeline/store.js');
const { advance, checkpoint, skip, statusReport, planReport, recomputeFacts } = await load('lib/pipeline/machine.js');
const { collectSourceStats, parseDeclaredCounts, countHashEntries, countSourceLines } = await load('lib/audit/consistency.js');

console.log('dsh-skill-softcopyright —— 编排层 harness（M3）');

// 临时项目根
const ROOT = mkdtempSync(join(tmpdir(), 'sc-m3-'));
console.log(`临时项目根 : ${ROOT}`);
const mk = (rel, content = 'x') => {
  const full = join(ROOT, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return full;
};

// ---------------------------------------------------------------- 清单
section('manifest：真实清单通过校验');
const manifest = loadManifest(MANIFEST);
check('10 个阶段', manifest.phases.length === 10, String(manifest.phases.length));
check('拓扑序以 p1 开头、p5-6 结尾', topologicalOrder(manifest)[0] === 'p1-requirements' && topologicalOrder(manifest).at(-1) === 'p5-6-delivery');
check('两个按需阶段', manifest.phases.filter((p) => p.optional).map((p) => p.id).join(',') === 'p5-4-aigc,p5-5-proof');
check('两个不变量', manifest.invariants.length === 2);
check('默认链式依赖（p5-2 依赖 p5-1）', phaseById(manifest, 'p5-2-atlas').requires.includes('p5-1-manual'));

section('manifest：坏清单必须快速失败');
const badCases = [
  ['版本不对', { version: 2, phases: [] }],
  ['phases 为空', { version: 1, phases: [] }],
  ['id 非 kebab-case', { version: 1, phases: [{ id: 'Bad_ID', title: 't', skill: 'python-software-delivery' }] }],
  ['id 重复', { version: 1, phases: [
    { id: 'a', title: 't', skill: 'python-software-delivery' },
    { id: 'a', title: 't2', skill: 'python-software-delivery' }
  ] }],
  ['未知技能', { version: 1, phases: [{ id: 'a', title: 't', skill: 'no-such-skill' }] }],
  ['未知判据 kind', { version: 1, phases: [{ id: 'a', title: 't', skill: 'python-software-delivery', measure: [{ kind: 'nope' }] }] }],
  ['requires 指向不存在', { version: 1, phases: [{ id: 'a', title: 't', skill: 'python-software-delivery', requires: ['ghost'] }] }],
  ['requires 成环', { version: 1, phases: [
    { id: 'a', title: 't', skill: 'python-software-delivery', requires: ['b'] },
    { id: 'b', title: 't', skill: 'python-software-delivery', requires: ['a'] }
  ] }],
  ['不变量 kind 未知', { version: 1, phases: [{ id: 'a', title: 't', skill: 'python-software-delivery' }], invariants: [{ id: 'x', kind: 'bogus' }] }],
  ['field-equals 缺 path', { version: 1, phases: [{ id: 'a', title: 't', skill: 'python-software-delivery', measure: [{ kind: 'field-equals' }] }] }]
];
for (const [label, raw] of badCases) {
  let message = '';
  try {
    validateManifest(raw);
  } catch (error) {
    message = error.message;
  }
  check(`拒绝：${label}`, message.startsWith('softcopyright: pipeline manifest invalid'), message || '(未抛错)');
}

// ---------------------------------------------------------------- glob 与产物
section('gates：glob 与产物匹配');
check('glob 精确名', globToRegExp('a.zip').test('a.zip') === true);
check('glob 通配', globToRegExp('*.zip').test('x.zip') === true);
check('glob 中文通配', globToRegExp('*说明书*.docx').test('电池BMS说明书_插图版.docx') === true);
check('glob 不跨目录', globToRegExp('*.zip').test('dist/x.zip') === false);

mk('dist/app.zip');
mk('docs/电池BMS说明书.docx');
mk('docs/电池BMS说明书_插图版.docx');
mk('docs/电池BMS源代码文档.docx');
check('匹配 dist/*.zip', matchArtifacts(ROOT, ['dist/*.zip']).length === 1);
check('匹配 docs/*说明书*.docx（含插图版）', matchArtifacts(ROOT, ['docs/*说明书*.docx']).length === 2);
check('不存在的 glob 返回空', matchArtifacts(ROOT, ['dist/*.tar.gz']).length === 0);

// ---------------------------------------------------------------- store
section('store：状态、证据、口径取值');
{
  const state = emptyState(ROOT);
  check('空状态 phases 为空对象', Object.keys(state.phases).length === 0);
  recordEvidence(ROOT, { tool: 'sc_manual', action: 'check', ok: true, fields: { arrows: 0, figureCaptions: 37 } });
  const reloaded = readState(ROOT);
  check('证据可读回', reloaded.evidence['sc_manual.check']?.ok === true);
  check('resolveValue 走 evidence', resolveValue(reloaded, 'evidence', 'sc_manual.check.figureCaptions') === 37);
  check('resolveValue 缺字段返回 undefined', resolveValue(reloaded, 'evidence', 'sc_manual.check.nope') === undefined);
  setSharedFacts(reloaded, { sourceFiles: 26, sourceLines: 4103, scope: 'D:/proj' });
  writeState(ROOT, reloaded);
  const after = readState(ROOT);
  check('sharedFacts 持久化', after.sharedFacts.sourceFiles === 26 && after.sharedFacts.sourceLines === 4103);
  check('resolveValue 走 sharedFacts', resolveValue(after, 'sharedFacts', 'sourceFiles') === 26);
  check('stateLoad 标记为 ok', after._load === 'ok');
}

// ---------------------------------------------------------------- 门禁矩阵
section('gates：门禁矩阵');
{
  const phase = phaseById(manifest, 'p5-2-atlas'); // artifacts: 说明书 docx; evidence: sc_manual.check-figs; measure: figures==images, placeholders==0
  const baseState = readState(ROOT);
  const opts = { projectRoot: ROOT, confirmedByUser: true };

  // 1) 缺证据
  let gate = evaluateGate(phase, baseState, opts);
  check('缺证据 → 不通过', gate.ok === false);
  check('缺证据给了 fix 指引', gate.blockers.some((b) => b.kind === 'evidence' && /check-figs/.test(b.fix ?? '')));

  // 2) 证据不通过
  recordEvidence(ROOT, { tool: 'sc_manual', action: 'check-figs', ok: false, fields: {} });
  gate = evaluateGate(phase, readState(ROOT), opts);
  check('证据 FAILED → 不通过', gate.ok === false && gate.blockers.some((b) => /上次结果是 FAILED/.test(b.message)));

  // 3) 证据通过但字段不等
  recordEvidence(ROOT, { tool: 'sc_manual', action: 'check-figs', ok: true, fields: { figureCaptions: 37, images: 36, placeholdersLeft: 0 } });
  gate = evaluateGate(phase, readState(ROOT), opts);
  check('图题≠图片 → 不通过', gate.ok === false && gate.blockers.some((b) => /!=/.test(b.message)));

  // 4) 字段相等但残留占位段非 0
  recordEvidence(ROOT, { tool: 'sc_manual', action: 'check-figs', ok: true, fields: { figureCaptions: 37, images: 37, placeholdersLeft: 3 } });
  gate = evaluateGate(phase, readState(ROOT), opts);
  check('残留占位段>0 → 不通过', gate.ok === false && gate.blockers.some((b) => /placeholdersLeft/.test(b.message)));

  // 5) 全过
  recordEvidence(ROOT, { tool: 'sc_manual', action: 'check-figs', ok: true, fields: { figureCaptions: 37, images: 37, placeholdersLeft: 0 } });
  gate = evaluateGate(phase, readState(ROOT), opts);
  check('图题==图片 且 占位段=0 → 通过', gate.ok === true, JSON.stringify(gate.blockers));

  // 6) 证据新鲜度：阶段开始时间晚于证据时间 → 必须视为过期
  const staleState = readState(ROOT);
  updatePhase(staleState, phase.id, { startedAt: new Date(Date.now() + 60_000).toISOString() });
  gate = evaluateGate(phase, staleState, opts);
  check('证据早于阶段开始 → 判定过期', gate.ok === false && gate.blockers.some((b) => /证据过期/.test(b.message)));
}

section('gates：user-confirmed 与 pages-measured');
{
  const phase = phaseById(manifest, 'p5-1-manual');
  const state = readState(ROOT);
  recordEvidence(ROOT, { tool: 'sc_manual', action: 'check', ok: true, fields: { figureCaptions: 37, figureSlots: 37 } });
  recordEvidence(ROOT, { tool: 'sc_source', action: 'stats-hashes', ok: true, fields: {} });
  const fresh = readState(ROOT);

  // 没有用户确认（p5-1 未显式写 user-confirmed 判据，靠 mustStopAfter 自带该约束）
  let gate = evaluateGate(phase, fresh, { projectRoot: ROOT, confirmedByUser: false });
  check('缺用户确认 → 不通过（mustStopAfter 自带 Checkpoint 约束）', gate.ok === false && gate.blockers.some((b) => b.kind === 'checkpoint'), JSON.stringify(gate.blockers));

  // 有确认但没页数证据
  gate = evaluateGate(phase, fresh, { projectRoot: ROOT, confirmedByUser: true });
  check('缺页数证据 → 不通过', gate.ok === false && gate.blockers.some((b) => /没有页数证据/.test(b.message)));

  // 页数来源是经验法 → 拒绝（技能明确不推荐）
  recordEvidence(ROOT, { tool: 'sc_manual', action: 'stats', ok: true, fields: { pages: 45, pagesSource: '校准法' } });
  gate = evaluateGate(phase, readState(ROOT), { projectRoot: ROOT, confirmedByUser: true });
  check('页数来源为经验法 → 不通过', gate.ok === false && gate.blockers.some((b) => /不是真实渲染/.test(b.message)));

  // 真实渲染 → 通过
  recordEvidence(ROOT, { tool: 'sc_manual', action: 'stats', ok: true, fields: { pages: 45, pagesSource: 'Word 真实渲染' } });
  gate = evaluateGate(phase, readState(ROOT), { projectRoot: ROOT, confirmedByUser: true });
  check('真实渲染页数 + 用户确认 → 通过', gate.ok === true, JSON.stringify(gate.blockers));
}

section('gates：产物缺失与四处口径判据');
{
  const phase = phaseById(manifest, 'p5-5-proof');
  const state = readState(ROOT);
  // 只创建了说明书，没有哈希清单/研发日志
  let gate = evaluateGate(phase, state, { projectRoot: ROOT, confirmedByUser: true });
  check('缺哈希清单/研发日志 → 不通过', gate.ok === false && gate.blockers.some((b) => b.kind === 'artifacts'));

  mk('docs/电池BMS源程序文件目录结构及哈希值清单.docx');
  mk('docs/电池BMS项目研发日志.docx');
  gate = evaluateGate(phase, readState(ROOT), { projectRoot: ROOT, confirmedByUser: true });
  check('产物齐了但没做四处审计 → 不通过', gate.ok === false && gate.blockers.some((b) => /未做四处口径审计/.test(b.message)));

  gate = evaluateGate(phase, readState(ROOT), {
    projectRoot: ROOT,
    confirmedByUser: true,
    fourWay: { ok: false, summary: 'devLog 报 29/4338，其余报 26/4103', fixHint: '重新生成研发日志' }
  });
  check('四处不一致 → 不通过', gate.ok === false && gate.blockers.some((b) => /29\/4338/.test(b.message)));

  // p5-5 还要求 collect-hashes 证据
  recordEvidence(ROOT, { tool: 'sc_source', action: 'collect-hashes', ok: true, fields: { files: 26, lines: 4103 } });
  gate = evaluateGate(phase, readState(ROOT), {
    projectRoot: ROOT,
    confirmedByUser: true,
    fourWay: { ok: true, summary: '26 个源文件 / 4103 行，4 处一致' }
  });
  check('四处一致 + 产物齐 + 证据 + 确认 → 通过', gate.ok === true, JSON.stringify(gate.blockers));
}

// ---------------------------------------------------------------- 状态机
section('machine：推进、阻塞、按需跳过');
{
  const state = readState(ROOT);
  check('nextPhase 指向 p1（都还没做）', nextPhase(manifest, state)?.id === 'p1-requirements');
  check('p5-2 被 p5-1 阻塞', blockedPhases(manifest, state).some((b) => b.id === 'p5-2-atlas' && b.missing.includes('p5-1-manual')));

  // 直接跳到 p5-2 必须被拒（前置未完成）
  const jump = advance(manifest, state, { to: 'p5-2-atlas', projectRoot: ROOT, confirmedByUser: true });
  check('跨阶段跳进被拒', jump.ok === false && /blocked by unfinished prerequisites/.test(jump.reason));
  check('拒绝时给出缺失前置', jump.missing.includes('p5-1-manual'));

  // p1：没有用户确认 → 不推进，但标记 waiting-user
  const noConfirm = advance(manifest, state, { to: 'p1-requirements', projectRoot: ROOT, confirmedByUser: false });
  check('p1 无确认 → 不推进', noConfirm.ok === false && noConfirm.gateFailed === true);
  check('门禁失败时报出缺什么', noConfirm.blockers.some((b) => /尚未获得用户确认/.test(b.message)));
  check('状态被置为 waiting-user', phaseState(readState(ROOT), 'p1-requirements').status === PHASE_STATUS.waitingUser);

  // p1：有确认 → 推进
  const ok = advance(manifest, readState(ROOT), { to: 'p1-requirements', projectRoot: ROOT, confirmedByUser: true });
  check('p1 有确认 → 推进成功', ok.ok === true, JSON.stringify(ok.blockers));
  check('推进后 next 指向 p2', ok.next?.id === 'p2-development');
  check('状态落盘为 done', phaseState(readState(ROOT), 'p1-requirements').status === PHASE_STATUS.done);
  check('记录 confirmedAt', typeof phaseState(readState(ROOT), 'p1-requirements').confirmedAt === 'string');

  // 重复推进同一阶段 → 拒绝
  const again = advance(manifest, readState(ROOT), { to: 'p1-requirements', projectRoot: ROOT, confirmedByUser: true });
  check('重复推进已完成阶段被拒', again.ok === false && /already done/.test(again.reason));

  // 按需阶段：非按需不可跳过
  const noSkip = skip(manifest, readState(ROOT), { phaseId: 'p2-development', projectRoot: ROOT });
  check('非按需阶段不可跳过', noSkip.ok === false && noSkip.optional === false);

  // status 报告
  const report = statusReport(manifest, readState(ROOT));
  check('status 报告 doneCount=1', report.doneCount === 1, String(report.doneCount));
  check('status 报告含 10 行', report.rows.length === 10);
  const plan = planReport(manifest, readState(ROOT), { projectRoot: ROOT });
  check('plan 报告 10 个阶段', plan.phases.length === 10);
}

section('machine：recompute-facts 写入权威口径');
{
  mk('src/main.py', 'a\nb\nc\n');
  mk('src/core/__init__.py', 'x\n');
  mk('src/core/algo.py', '1\n2\n');
  mk('src/docs/should_be_excluded.py', 'x\n');
  mk('src/tests/test_x.py', 'x\n');
  mk('src/tmp_scratch/a.py', 'x\n');
  const state = readState(ROOT);
  const facts = recomputeFacts(state, {
    projectRoot: ROOT,
    sourceDir: join(ROOT, 'src'),
    sourceRules: { includeExt: ['.py'], excludeDirs: ['docs', 'tests', 'tmp_*', '__pycache__'], keepInitPy: true }
  });
  check('统计到 3 个文件（main + __init__ + algo）', facts.files === 3, JSON.stringify(facts));
  check('行数 3+1+2=6', facts.lines === 6, String(facts.lines));
  check('sharedFacts 已落盘', readState(ROOT).sharedFacts.sourceFiles === 3);
  check('__init__.py 未被排除（P0 陷阱防护）', collectSourceStats(join(ROOT, 'src'), { includeExt: ['.py'], excludeDirs: ['docs', 'tests', 'tmp_*'], keepInitPy: true }).files === 3);
  check(
    '关掉白名单后 __init__.py 会被排除（对照）',
    collectSourceStats(join(ROOT, 'src'), { includeExt: ['.py'], excludeDirs: ['docs', 'tests', 'tmp_*'], keepInitPy: false }).files === 2
  );
}

// ---------------------------------------------------------------- 审计辅助
section('audit：行数口径必须与上游 splitlines/readlines 一致');
{
  // 上游 gen_src_docx.py 用 f.read().splitlines()，collect_source_hashes.py 用 fh.readlines()，
  // 两者对行数的判定相同：结尾换行符不产生额外一行。这里逐条锁住。
  check('"a\\nb\\nc\\n" → 3 行（结尾换行不多算）', countSourceLines('a\nb\nc\n') === 3, String(countSourceLines('a\nb\nc\n')));
  check('"a\\nb" → 2 行（无结尾换行）', countSourceLines('a\nb') === 2);
  check('"x\\n" → 1 行', countSourceLines('x\n') === 1);
  check('空文件 → 0 行', countSourceLines('') === 0);
  check('内部空行照数 "a\\n\\nb" → 3', countSourceLines('a\n\nb') === 3);
  check('CRLF "a\\r\\nb\\r\\n" → 2', countSourceLines('a\r\nb\r\n') === 2);
  check('仅换行符 "\\n" → 1', countSourceLines('\n') === 1);
  check('两个结尾换行 "a\\n\\n" → 2（与 splitlines 一致）', countSourceLines('a\n\n') === 2);
}

section('audit：口径文本解析');
{
  check('解析「共 26 个源文件，4103 行代码」', JSON.stringify(parseDeclaredCounts(['封面：共 26 个源文件，4103 行代码'])) === JSON.stringify({ files: 26, lines: 4103, raw: '共 26 个源文件，4103 行代码' }));
  check('解析「文件数: 26 | 总行数: 4103」', parseDeclaredCounts(['文件数: 26 | 总行数: 4103'])?.files === 26);
  check('解析逗号变体', parseDeclaredCounts(['共 29 个源文件, 4338 行代码'])?.lines === 4338);
  check('只有文件数也能解析', parseDeclaredCounts(['共 17 个源文件'])?.files === 17);
  check('无声明返回 undefined', parseDeclaredCounts(['随便一段话']) === undefined);
  check('数 SHA-256 条目', countHashEntries([`${'a'.repeat(64)} ${'b'.repeat(64)}`]) === 2);
  check('非 64 位十六进制不算条目', countHashEntries(['abc123']) === 0);
}

// ---------------------------------------------------------------- 收尾
rmSync(ROOT, { recursive: true, force: true });
console.log('\n' + '='.repeat(64));
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  console.log('\n失败：');
  for (const f of failures) console.log(`  x ${f}`);
}
console.log('='.repeat(64));
process.exit(failures.length === 0 ? 0 : 1);
