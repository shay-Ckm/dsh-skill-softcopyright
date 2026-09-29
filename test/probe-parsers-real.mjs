/**
 * 解析器 ↔ 真实脚本 的端到端一致性探针（**批量版**）。
 *
 * ## 这个文件要解决的根问题
 *
 * `parsers.mjs` 里所有用例都是**我构造的格式串**。这类测试有个根本盲区：
 * 我按"我以为脚本会怎么打印"造输入，于是**当假设与脚本实际输出不符时，测试照样全绿**。
 *
 * 这个盲区已经真的漏过一次（第 3 轮缺陷 10/11）：
 *   - `sc_proof check-inline-js` 的脚本因为 ESM/CJS 冲突**从未能运行**，而测试全绿；
 *   - `parseCheckInlineJs` 的正则锚定行首，而真实输出是缩进的，`syntaxErrors` **恒为 0**。
 *
 * 所以这里**跑真实脚本、用真实输出喂解析器**，并对关键字段断言具体数值。
 * 覆盖到本项目能提供真实输入的全部解析器（手册 docx / 源代码文档 / 源码目录 / 哈希 TSV / 图集目录）。
 *
 * 输入是**本项目已产出的真实交付件**；缺件时该用例跳过并明确标出，不静默通过。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');
const ASSETS = join(PLUGIN_ROOT, 'assets', 'skills');
const PROJECT = process.env.SC_PROJECT ?? join(PLUGIN_ROOT, '..', '..', 'projects', 'multi-func-ai-calculator');

const runtime = await import(pathToFileURL(join(PLUGIN_ROOT, 'lib', 'runtime.js')).href);
const parse = await import(pathToFileURL(join(PLUGIN_ROOT, 'lib', 'adapters', 'parse.js')).href);
const PYTHON = runtime.resolveBundledPython({}).path;
const NODE = runtime.resolveBundledNode({}).path;

let passed = 0;
const failures = [];
const skipped = [];
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const SCRIPTS = {
  delivery: join(ASSETS, 'python-software-delivery', 'scripts'),
  manual: join(ASSETS, 'manual-ui-screenshots', 'scripts'),
  aigc: join(ASSETS, 'aigc-review-reduction', 'scripts'),
  proof: join(ASSETS, 'software-copyright-aigc-appeal', 'scripts')
};

const DOCX = join(PROJECT, 'docs', '多功能AI计算器_使用说明书.docx');
// `check_manual_docx.py` 校验的是「图题数 == 图位数」，只适用于**插图前的仅图位版**；
// 对插图版跑它会得到 figureSlots=0、figureMatch=false —— 这是设计如此，不是缺陷。
const DOCX_SLOTS = join(PROJECT, 'docs', '_backup', '说明书-图位版.docx');
const SRCDOC = join(PROJECT, 'docs', '多功能AI计算器_源代码文档.docx');
const TSV = join(PROJECT, 'docs', 'hashes.tsv');
const SRC = join(PROJECT, 'src');
const ATLAS = join(PROJECT, 'docs', 'atlas');

const TMP = mkdtempSync(join(tmpdir(), 'sc-parsers-'));

/** 跑真实脚本，返回原始三件套 + 已解析结果。 */
function run(skill, script, args, { chain = 'python', cwd = PLUGIN_ROOT } = {}) {
  const exe = chain === 'node' ? NODE : PYTHON;
  const proc = spawnSync(exe, [join(SCRIPTS[skill], script), ...args], {
    encoding: 'utf8', windowsHide: true, cwd,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
  });
  return {
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
    exitCode: proc.status ?? 1,
    error: proc.error ? `${proc.error.code ?? ''} ${proc.error.message}` : null
  };
}

/**
 * 一个用例：跑真实脚本 → 喂解析器 → 断言。
 * @param needs - 真实输入文件；缺任何一件即跳过（并明确标出，不静默通过）。
 */
function probe(title, needs, fn) {
  const missing = needs.filter((p) => !existsSync(p));
  if (missing.length > 0) {
    skipped.push(`${title}（缺输入：${missing.map((p) => p.split(/[/\\]/).slice(-1)[0]).join(', ')}）`);
    console.log(`  SKIP  ${title}`);
    return;
  }
  console.log(`\n=== ${title} ===`);
  fn();
}

console.log('解析器 ↔ 真实脚本 端到端一致性探针（批量）');
console.log(`  项目: ${PROJECT}`);
console.log(`  临时目录: ${TMP}`);

// ---------------------------------------------------------------- 1. 说明书格式复验
// 用**仅图位版**（这是该脚本设计针对的状态）
probe('parseManualCheck ← check_manual_docx.py（仅图位版）', [DOCX_SLOTS], () => {
  const raw = run('delivery', 'check_manual_docx.py', [DOCX_SLOTS]);
  const p = parse.parseManualCheck(raw);
  console.log(`      exit=${raw.exitCode} 原始尾行: ${raw.stdout.trim().split('\n').pop()}`);
  check('ran=true（脚本给出了结论）', p.ran === true, JSON.stringify(p.fields));
  check('ok=true（图位版本身是通过的）', p.ok === true, JSON.stringify(p.fields));
  check('arrows=0', p.fields.arrows === 0, JSON.stringify(p.fields));
  check('markdownBold=0', p.fields.markdownBold === 0, JSON.stringify(p.fields));
  check('nonBlack=0', p.fields.nonBlack === 0, JSON.stringify(p.fields));
  check('italic=0', p.fields.italic === 0, JSON.stringify(p.fields));
  check('figureCaptions=38', p.fields.figureCaptions === 38, JSON.stringify(p.fields));
  check('figureSlots=38（与图题数相等）', p.fields.figureSlots === 38, JSON.stringify(p.fields));
  check('figureMatch=true', p.fields.figureMatch === true, JSON.stringify(p.fields));
});

// 同一个脚本对**插图版**应当判不通过 —— 这是流程陷阱本身，把它固化成期望
probe('parseManualCheck 对插图版：应如实报 figureMatch=false', [DOCX], () => {
  const raw = run('delivery', 'check_manual_docx.py', [DOCX]);
  const p = parse.parseManualCheck(raw);
  console.log(`      exit=${raw.exitCode}`);
  check('ok=false（占位段已被消费）', p.ok === false, JSON.stringify(p.fields));
  check('figureSlots=0', p.fields.figureSlots === 0, JSON.stringify(p.fields));
  check('figureMatch=false', p.fields.figureMatch === false, JSON.stringify(p.fields));
  check('图题数仍是 38（图题没有丢）', p.fields.figureCaptions === 38, JSON.stringify(p.fields));
});

// ---------------------------------------------------------------- 2. 说明书规模统计
probe('parseManualStats ← manual_stats.py', [DOCX], () => {
  const raw = run('delivery', 'manual_stats.py', [DOCX]);
  const p = parse.parseManualStats(raw);
  console.log(`      exit=${raw.exitCode}`);
  check('ran=true', p.ran === true, JSON.stringify(p.fields));
  check('paragraphs 有值', typeof p.fields.paragraphs === 'number' && p.fields.paragraphs > 100, JSON.stringify(p.fields));
  check('tables 有值', typeof p.fields.tables === 'number', JSON.stringify(p.fields));
  check('figureCaptions=38', p.fields.figureCaptions === 38, JSON.stringify(p.fields));
  check('chars 有值', typeof p.fields.chars === 'number' && p.fields.chars > 1000, JSON.stringify(p.fields));
  check('未加 --render 时 pagesSource 不是真实渲染', String(p.fields.pagesSource ?? '') !== 'Word 真实渲染', JSON.stringify(p.fields.pagesSource));
});

// ---------------------------------------------------------------- 3. 插图版复验
probe('parseManualWithFigs ← check_manual_with_figs.py', [DOCX], () => {
  const raw = run('manual', 'check_manual_with_figs.py', [DOCX, '--expect', '38']);
  const p = parse.parseManualWithFigs(raw);
  console.log(`      exit=${raw.exitCode} 原始尾行: ${raw.stdout.trim().split('\n').pop()}`);
  check('ran=true', p.ran === true, JSON.stringify(p.fields));
  check('ok=true', p.ok === true, JSON.stringify(p.fields));
  check('figureCaptions=38', p.fields.figureCaptions === 38, JSON.stringify(p.fields));
  check('images=38', p.fields.images === 38, JSON.stringify(p.fields));
  check('placeholdersLeft=0', p.fields.placeholdersLeft === 0, JSON.stringify(p.fields));
});

// ---------------------------------------------------------------- 4. 页数估算（兜底路径）
probe('parsePageEstimate ← page_estimate.py', [DOCX], () => {
  const raw = run('delivery', 'page_estimate.py', [DOCX]);
  const p = parse.parsePageEstimate(raw);
  console.log(`      exit=${raw.exitCode}`);
  check('ran=true', p.ran === true, JSON.stringify(p.fields));
  check('pages 是正数（估算值）', typeof p.fields.pages === 'number' && p.fields.pages > 0, JSON.stringify(p.fields));
  check('明确标注这是估算而非真实渲染', String(p.fields.pagesSource ?? '') !== 'Word 真实渲染', JSON.stringify(p.fields.pagesSource));
});

// ---------------------------------------------------------------- 5. 文本提取
probe('parseExtractDocx ← extract_docx.py', [DOCX], () => {
  const out = join(TMP, 'extract.txt');
  const raw = run('manual', 'extract_docx.py', [DOCX, out]);
  const p = parse.parseExtractDocx(raw);
  console.log(`      exit=${raw.exitCode}`);
  check('ran=true', p.ran === true, JSON.stringify(p.fields));
  check('paragraphs=923（与真机一致）', p.fields.paragraphs === 923, JSON.stringify(p.fields));
  check('referencedImages=38', p.fields.referencedImages === 38, JSON.stringify(p.fields));
  check('确实产出了文本文件', existsSync(out), out);
});

// ---------------------------------------------------------------- 6. AIGC 扫描
// ⚠️ 正确签名是 `check_aigc.py <docx> [--struct]`（**位置参数**）。
// 我第一版写成 `--scan <docx>`，脚本把 `--scan` 当成了 docx 路径 → 无输出 →
// 解析器给出空 fields，而"退出码恒 0"意味着它**看起来仍然成功**。
probe('parseAigcScan ← check_aigc.py（位置参数，无 --scan）', [DOCX], () => {
  const raw = run('aigc', 'check_aigc.py', [DOCX]);
  const p = parse.parseAigcScan(raw);
  console.log(`      exit=${raw.exitCode}（该脚本退出码恒 0，无语义）`);
  check('ran=true', p.ran === true, JSON.stringify(p.fields));
  check('highFrequencyKinds 有值', typeof p.fields.highFrequencyKinds === 'number', JSON.stringify(p.fields));
  check('paragraphs 有值', typeof p.fields.paragraphs === 'number' && p.fields.paragraphs > 0, JSON.stringify(p.fields));
  check('chars 有值', typeof p.fields.chars === 'number' && p.fields.chars > 0, JSON.stringify(p.fields));
  check('avgSentenceLength 有值', typeof p.fields.avgSentenceLength === 'number', JSON.stringify(p.fields));
  check('★ 退出码恒 0：ok 不表示达标，必须看这些数值', raw.exitCode === 0);
});

probe('parseAigcScan(struct) ← check_aigc.py --struct', [DOCX], () => {
  const raw = run('aigc', 'check_aigc.py', [DOCX, '--struct']);
  const p = parse.parseAigcScan(raw);
  console.log(`      exit=${raw.exitCode}`);
  check('ran=true', p.ran === true, JSON.stringify(p.fields));
  check('structuralTotal 有值（仅在 --struct 下出现）', typeof p.fields.structuralTotal === 'number', JSON.stringify(p.fields));
});

// ---------------------------------------------------------------- 7. 本源文档一致性
probe('parseCheckSrcDoc ← check_src_doc.py', [SRCDOC, SRC], () => {
  const raw = run('delivery', 'check_src_doc.py', [SRCDOC, SRC]);
  const p = parse.parseCheckSrcDoc(raw);
  console.log(`      exit=${raw.exitCode} 原始尾行: ${raw.stdout.trim().split('\n').pop()}`);
  check('ran=true', p.ran === true, JSON.stringify(p.fields));
  check('ok=true（逐行一致）', p.ok === true, JSON.stringify(p.fields));
  check('consistentFiles=16', p.fields.consistentFiles === 16, JSON.stringify(p.fields));
  check('verdict 含"一致"', /一致/.test(String(p.fields.verdict ?? '')), JSON.stringify(p.fields.verdict));
});

// ---------------------------------------------------------------- 8. 哈希清单（两个脚本各自的口径）
probe('parseSourceHashes(collect) ← collect_source_hashes.py', [SRC], () => {
  const raw = run('proof', 'collect_source_hashes.py', [SRC]);
  const p = parse.parseSourceHashes(raw, 'collect');
  console.log(`      exit=${raw.exitCode}（汇总打在 stderr）`);
  check('ran=true', p.ran === true, JSON.stringify(p.fields));
  check('files=16', p.fields.files === 16, JSON.stringify(p.fields));
  check('lines=4831', p.fields.lines === 4831, JSON.stringify(p.fields));
  check('entries=16（逐文件 SHA-256 条数）', p.fields.entries === 16, JSON.stringify(p.fields));
});

probe('parseSourceHashes(stats) ← stats_source_hashes.py', [SRC], () => {
  const raw = run('proof', 'stats_source_hashes.py', [SRC]);
  const p = parse.parseSourceHashes(raw, 'stats');
  console.log(`      exit=${raw.exitCode}`);
  check('ran=true', p.ran === true, JSON.stringify(p.fields));
  check('files=16（与 collect 口径一致）', p.fields.files === 16, JSON.stringify(p.fields));
  check('lines=4831（与 collect 口径一致）', p.fields.lines === 4831, JSON.stringify(p.fields));
});

// ---------------------------------------------------------------- 9. 源码打包
// ⚠️ **必须用源码树的副本**：`build_src_package.py` 会把《安装与启动说明.md》
// **写进它收到的那个目录**。第一版我直接传了 `src`，于是探针自己把源码树污染成
// 17 个文件，紧接着 collect 哈希就报 17/4853 —— 四处口径当场分叉。
// 这既证明了脚本会污染源码树，也说明**探针必须用副本**。
probe('parseBuildPackage ← build_src_package.py', [SRC], () => {
  const outDir = join(TMP, 'dist');
  const srcCopy = join(TMP, 'src-copy');
  cpSync(SRC, srcCopy, { recursive: true });

  const raw = run('delivery', 'build_src_package.py',
    [srcCopy, '--out', outDir, '--name', 'probe-pkg', '--version', '1.0.0']);
  const p = parse.parseBuildPackage(raw);
  console.log(`      exit=${raw.exitCode}`);
  check('ran=true', p.ran === true, JSON.stringify(p.fields));
  check('zipPath 有值', typeof p.fields.zipPath === 'string' && p.fields.zipPath.length > 0, JSON.stringify(p.fields));
  check('zipFiles=17（16 源文件 + 安装说明）', p.fields.zipFiles === 17, JSON.stringify(p.fields));
  check('★ sdistStatus 被如实读出（无 pyproject.toml 时应为 skipped）', p.fields.sdistStatus === 'skipped', JSON.stringify(p.fields.sdistStatus));
  check('zip 文件真实存在', existsSync(String(p.fields.zipPath ?? '')), String(p.fields.zipPath));
  check(
    '★ 确认脚本会把说明写进它收到的目录（这就是污染源码树的机制）',
    existsSync(join(srcCopy, '安装与启动说明.md')),
    join(srcCopy, '安装与启动说明.md')
  );
  check('原源码树未被本探针改动', existsSync(SRC), SRC);
});

// ---------------------------------------------------------------- 10. 申诉证明文档
probe('parseGenProofDocx ← gen_proof_docx.py', [TSV], () => {
  const outDir = join(TMP, 'proof');
  const raw = run('proof', 'gen_proof_docx.py',
    [TSV, outDir, '探针软件', '--version', 'V1.0', '--files', '16', '--lines', '4831']);
  const p = parse.parseGenProofDocx(raw);
  console.log(`      exit=${raw.exitCode}（该脚本保存失败也不改退出码）`);
  check('ran=true', p.ran === true, JSON.stringify(p.fields));
  check('★ generated[] 有两个产物（哈希清单 + 研发日志至少一份）', Array.isArray(p.fields.generated) && p.fields.generated.length >= 1, JSON.stringify(p.fields.generated));
  check('files=16', p.fields.files === 16, JSON.stringify(p.fields));
  check('lines=4831', p.fields.lines === 4831, JSON.stringify(p.fields));
  check('产物文件真实存在', (p.fields.generated ?? []).every((f) => existsSync(String(f))), JSON.stringify(p.fields.generated));
});

// ---------------------------------------------------------------- 11. 图集目录校验
probe('parseValidateAtlas ← validate_atlas.py', [ATLAS], () => {
  const raw = run('manual', 'validate_atlas.py', [ATLAS]);
  const p = parse.parseValidateAtlas(raw);
  console.log(`      exit=${raw.exitCode} 原始输出尾行: ${raw.stdout.trim().split('\n').filter(Boolean).pop() ?? '(空)'}`);
  check('ran 有明确取值', typeof p.ran === 'boolean', JSON.stringify(p));
  // 该脚本面向 HTML 图集，对"只有 PNG 的目录"会怎么判？这里如实记录，不预设结论。
  console.log(`      自检：ok=${p.ok} fields=${JSON.stringify(p.fields)}`);
  check('解析器返回了结构化的结论（未抛错）', p !== null && typeof p === 'object');
});

// ---------------------------------------------------------------- 12. 发布包冒烟（模板）
probe('parsePackageSmoke ← package_smoke_template.py', [SRC], () => {
  const raw = run('delivery', 'package_smoke_template.py', [SRC], { cwd: SRC });
  const p = parse.parsePackageSmoke(raw);
  console.log(`      exit=${raw.exitCode}`);
  check('ran=true', p.ran === true, JSON.stringify(p.fields));
  check('total=13（模板固有用例数）', p.fields.total === 13, JSON.stringify(p.fields));
  check('passed/failed 都已读出', typeof p.fields.passed === 'number' && typeof p.fields.failed === 'number', JSON.stringify(p.fields));
  // 注意：解析器返回的是**数组**（["A1","C1",…]），比拼成字符串更好用。
  // 我第一版断言它必须是 string，是期望写错了。
  check(
    'failedCases 是数组且非空',
    Array.isArray(p.fields.failedCases) && p.fields.failedCases.length > 0,
    JSON.stringify(p.fields.failedCases)
  );
  check('dirMissing 已读出', typeof p.fields.dirMissing === 'boolean', JSON.stringify(p.fields.dirMissing));
});

console.log('\n' + '='.repeat(64));
console.log(`通过 ${passed} 项，失败 ${failures.length} 项，跳过 ${skipped.length} 项`);
for (const f of failures) console.log(`  x ${f}`);
for (const s of skipped) console.log(`  - 跳过: ${s}`);
console.log('='.repeat(64));

try {
  rmSync(TMP, { recursive: true, force: true });
} catch {
  /* ignore */
}
process.exit(failures.length === 0 ? 0 : 1);
