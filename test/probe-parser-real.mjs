/**
 * 解析器 ↔ 真实脚本 的端到端一致性探针（内联 JS 语法检查）。
 *
 * ## 为什么需要「真实脚本」而不是合成字符串
 *
 * `parsers.mjs` 里所有用例都是**我构造的格式串**。这类测试有一个根本盲区：
 * 我按"我以为脚本会怎么打印"来构造输入，于是**当我的假设与脚本实际输出不一致时，
 * 测试照样全绿**。
 *
 * 这个盲区真的漏过一次：`parseCheckInlineJs` 的明细正则写成了 `^inline script #…`
 * 锚定行首，而真实脚本打印的是**两空格缩进**的 `  inline script #1: SYNTAX ERROR …`。
 * 结果是 `syntaxErrors` **恒为 0** —— 判定（FAILED）对，字段是假的。
 * 合成测试永远发现不了，因为它喂的是"没有缩进"的字符串。
 *
 * 所以这里**跑真实脚本**，用它真实的输出喂解析器，再断言字段。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');
const SCRIPT = join(
  PLUGIN_ROOT, 'assets', 'skills', 'python-software-delivery', 'scripts', 'check_inline_js.js'
);

const { resolveBundledNode } = await import(pathToFileURL(join(PLUGIN_ROOT, 'lib', 'runtime.js')).href);
const NODE = resolveBundledNode({}).path;
const { parseCheckInlineJs } = await import(
  pathToFileURL(join(PLUGIN_ROOT, 'lib', 'adapters', 'parse.js')).href
);

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

const dir = mkdtempSync(join(tmpdir(), 'sc-inlinejs-'));

const GOOD = `<!DOCTYPE html><html><body>
<div id="chart1"></div>
<script>var chart = { init: function () { return 1; } }; chart.init();</script>
</body></html>`;

const BAD = `<!DOCTYPE html><html><body>
<div id="chart1"></div>
<script>
(function () {
  var series = [{ name: 'a', data: [1, 2, 3] }];
  console.log(series));
})();
</script>
</body></html>`;

const MIXED = `<!DOCTYPE html><html><body>
<script>var ok1 = 1;</script>
<script>var broken = ((((;</script>
<script>var ok2 = 2;</script>
</body></html>`;

/** 跑真实脚本，并把真实输出喂给解析器。 */
function runReal(html, name) {
  const file = join(dir, `${name}.html`);
  writeFileSync(file, html, 'utf8');
  const proc = spawnSync(NODE, [SCRIPT, file], { encoding: 'utf8', windowsHide: true });
  const result = parseCheckInlineJs({ stdout: proc.stdout ?? '', stderr: proc.stderr ?? '', exitCode: proc.status ?? 1 });
  return { raw: proc.stdout ?? '', parsed: result };
}

console.log('解析器 ↔ 真实脚本 端到端一致性探针（内联 JS 语法检查）');
console.log(`  脚本: ${SCRIPT.split(/[/\\]/).slice(-1)[0]}\n`);

console.log('=== 1. 语法正确：字段与判定都应为通过 ===');
{
  const { raw, parsed } = runReal(GOOD, 'good');
  console.log(`      原始输出: ${raw.trim().split('\n').pop()}`);
  check('ok = true', parsed.ok === true, String(parsed.ok));
  check('syntaxErrors = 0', parsed.fields.syntaxErrors === 0, JSON.stringify(parsed.fields));
  check('blocks = 1（内联脚本块数）', parsed.fields.blocks === 1, JSON.stringify(parsed.fields));
}

console.log('\n=== 2. 有语法错误：★ 字段必须如实反映，不能恒为 0 ===');
{
  const { raw, parsed } = runReal(BAD, 'bad');
  console.log(`      原始输出: ${raw.trim().split('\n').join(' | ')}`);
  check('ok = false', parsed.ok === false, String(parsed.ok));
  check(
    '★ syntaxErrors = 1（修复前恒为 0 —— 判定对、字段假）',
    parsed.fields.syntaxErrors === 1,
    JSON.stringify(parsed.fields)
  );
  check('blocks = 1', parsed.fields.blocks === 1, JSON.stringify(parsed.fields));
  // 注意：note 里是**具体的语法错误信息**（正则捕获 `-> ` 之后的部分），
  // 不含字面量 "SYNTAX ERROR"。第一版我断言找 "SYNTAX ERROR"，是期望写错了。
  check(
    'notes 带上了具体错误位置与原因',
    parsed.notes.length === 1 && parsed.notes[0].startsWith('#1:') && parsed.notes[0].length > 5,
    JSON.stringify(parsed.notes)
  );
}

console.log('\n=== 3. 一个文件里好坏混排：块数与错误数都要对 ===');
{
  const { parsed } = runReal(MIXED, 'mixed');
  check('ok = false', parsed.ok === false);
  check('syntaxErrors = 1（只数坏的那块）', parsed.fields.syntaxErrors === 1, JSON.stringify(parsed.fields));
  check('blocks = 1（脚本的汇总只统计失败块数，不是总块数）', parsed.fields.blocks === 1, JSON.stringify(parsed.fields));
}

console.log('\n' + '='.repeat(64));
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
for (const f of failures) console.log(`  x ${f}`);
console.log('='.repeat(64));

try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* ignore */
}
process.exit(failures.length === 0 ? 0 : 1);
