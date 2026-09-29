/**
 * 一次跑完所有 harness，汇总断言数。
 *
 * 用法（Windows，bundled node）：
 *   & "<bundled node>" test/run-all.mjs
 *
 * 说明：`e2e-fixture.mjs` 需要一个真实软著项目（默认 `_fixture/scdemo`），
 * 且该项目要先跑过一次 `sc_source action=gen-doc` 生成源代码文档。
 * 若目录不存在，它会自动跳过而不算失败。
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');
const WORKSPACE = join(PLUGIN_ROOT, '..', '..');
const FIXTURE = process.argv[2] ?? join(WORKSPACE, '_fixture', 'scdemo');

const SUITES = [
  ['harness.mjs', '技能层 / 运行时 / doctor-core'],
  ['parsers.mjs', '20 个脚本的解析器'],
  ['integration.mjs', 'apply() 装配（真实 schemastery + dsh-tools）'],
  ['pipeline.mjs', '清单校验 / 门禁矩阵 / 状态机'],
  ['probe-apply.mjs', '敌意服务环境（M3 根因回归守卫）'],
  ['ctx-access-guard.mjs', 'ctx 属性访问静态守卫（含自测）'],
  ['actions-invocable.mjs', '全部 33 个 action 可调用（真机 bug 产物）'],
  ['probe-guard.mjs', '路径守卫安全性（链接绕过 / enabled 开关 / 词法边界）'],
  ['probe-timeout.mjs', '超时与终止安全性（seam 装死 / 真实进程挂住 / 输出截断）'],
  ['probe-atlas-scale.mjs', '图集缩放脚本安全性（幂等 / 覆盖 / GBK 崩溃）'],
  ['probe-parser-real.mjs', '解析器↔真实脚本 端到端一致（内联 JS 检查）'],
  ['probe-parsers-real.mjs', '批量：12 个解析器 ↔ 真实脚本（含两份 docx / 源码 / TSV / 图集）']
];

const results = [];
let totalPassed = 0;

function run(file, args = []) {
  const proc = spawnSync(process.execPath, [join(HERE, file), ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1' }
  });
  const text = `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
  const m = text.match(/通过 (\d+) 项，失败 (\d+) 项/);
  return {
    passed: m ? Number(m[1]) : 0,
    failed: m ? Number(m[2]) : 1,
    exitCode: proc.status ?? 1,
    text
  };
}

console.log('dsh-skill-softcopyright —— 全量 harness');
console.log('='.repeat(72));

for (const [file, what] of SUITES) {
  const r = run(file);
  totalPassed += r.passed;
  results.push({ file, what, ...r, skipped: false });
  const mark = r.failed === 0 && r.exitCode === 0 ? 'OK  ' : 'FAIL';
  console.log(`${mark} ${file.padEnd(22)} ${String(r.passed).padStart(4)} 项   ${what}`);
  if (r.failed > 0 || r.exitCode !== 0) {
    for (const line of r.text.split('\n').filter((l) => l.includes('  x ') || l.includes('FAIL'))) {
      console.log(`      ${line.trim()}`);
    }
  }
}

// 端到端 harness 需要真实项目，缺了就跳过
const sourceDoc = join(FIXTURE, 'docs', '演示软件源代码文档.docx');
if (existsSync(FIXTURE) && existsSync(sourceDoc)) {
  const r = run('e2e-fixture.mjs', [FIXTURE]);
  totalPassed += r.passed;
  results.push({ file: 'e2e-fixture.mjs', what: '真实 docx + 真实脚本链', ...r, skipped: false });
  const mark = r.failed === 0 && r.exitCode === 0 ? 'OK  ' : 'FAIL';
  console.log(`${mark} ${'e2e-fixture.mjs'.padEnd(22)} ${String(r.passed).padStart(4)} 项   真实 docx + 真实脚本链`);
} else {
  results.push({ file: 'e2e-fixture.mjs', passed: 0, failed: 0, skipped: true });
  console.log(`SKIP ${'e2e-fixture.mjs'.padEnd(22)}    0 项   缺 fixture（先跑 python tools/make-sc-fixture.py 并生成源代码文档）`);
}

const failedSuites = results.filter((r) => !r.skipped && (r.failed > 0 || r.exitCode !== 0));
console.log('='.repeat(72));
console.log(`套件 ${results.filter((r) => !r.skipped).length} 个，断言 ${totalPassed} 项，失败套件 ${failedSuites.length} 个`);
process.exit(failedSuites.length === 0 ? 0 : 1);
