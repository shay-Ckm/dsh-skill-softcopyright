/**
 * 图集 HTML 缩放脚本（scale_units.py）的安全探针。
 *
 * 为什么查：`sc_atlas action=scale` 映射到这个脚本，而它是**写操作**。
 * 读实现时看到三处可疑，全部用真实脚本在真实文件上验证：
 *   1. 不传第三个参数时 `target = src` —— 原地覆盖，原比例还能恢复吗？
 *   2. 只做正则替换、**不记录已应用的倍数** —— 跑两次会不会叠加？
 *   3. 成功信息里有「✔」—— 在中文 Windows 的 GBK 控制台下会不会出问题？
 *      而插件的 `runPython` 强制了 UTF-8，所以这一条**在插件里被掩盖**，
 *      但技能说明要求用户直接用 `python scripts/scale_units.py` 跑 —— 那时就会暴露。
 *
 * 本探针刻意分两种环境跑：加 UTF-8 的（与插件一致）与裸跑的，以区分"脚本缺陷"
 * 与"插件加固掩盖了脚本缺陷"。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');
const SCALE = join(
  PLUGIN_ROOT, 'assets', 'skills', 'manual-ui-screenshots', 'scripts', 'scale_units.py'
);

// ⚠️ 不要硬编码 Python 路径。第一版写死了 app 目录旁边那份（PowerShell 看它存在，
// 但 Node 的 spawnSync 报 ENOENT），白费一轮排查。改用插件自己的解析器 ——
// 它知道随包运行时的真实位置，顺带把解析器本身也测到了。
const { resolveBundledPython } = await import(
  pathToFileURL(join(PLUGIN_ROOT, 'lib', 'runtime.js')).href
);
const PYTHON = resolveBundledPython({}).path;

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

const HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
.shot { width: 100cqw; height: 100cqh; }
.title { font-size: 3.2cqw; }
.btn { padding: 1.1cqh 2.4cqw; }
</style></head><body>
<div class="shot"><h1 class="title">界面图集</h1><button class="btn">计算</button></div>
<script>
// 说明：容器宽 100cqw、高 100cqh —— 这行注释里的数字同样会被替换
var layout = { chartHeight: 42.5 };   // 不带单位的字面量，不应被改动
</script>
</body></html>`;

const dir = mkdtempSync(join(tmpdir(), 'sc-scale-'));
let counter = 0;
/** 每个用例用独立副本，避免互相污染。 */
function fresh(name) {
  counter += 1;
  const path = join(dir, `${name}-${counter}.html`);
  writeFileSync(path, HTML, 'utf8');
  return path;
}

/**
 * 跑脚本。
 * @param utf8 - true 时按插件 `runPython` 的做法强制 UTF-8（PYTHONUTF8 / PYTHONIOENCODING）。
 */
function run(args, { utf8 = true } = {}) {
  const env = { ...process.env };
  if (utf8) {
    env.PYTHONUTF8 = '1';
    env.PYTHONIOENCODING = 'utf-8';
  } else {
    delete env.PYTHONUTF8;
    env.PYTHONIOENCODING = 'gbk'; // 显式模拟中文 Windows 控制台
  }
  const proc = spawnSync(PYTHON, [SCALE, ...args], { encoding: 'utf8', windowsHide: true, env });
  return {
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
    code: proc.status ?? 1,
    error: proc.error ? `${proc.error.code ?? ''} ${proc.error.message}` : null
  };
}

function describe(result) {
  if (result.error) return `spawn 失败：${result.error}`;
  const err = String(result.stderr).trim().split('\n').slice(-2).join(' / ');
  return err ? `exit=${result.code} ${err}` : `exit=${result.code}`;
}

const shotWidth = (text) => {
  const m = text.match(/\.shot\s*\{\s*width:\s*([0-9.]+)cqw/);
  return m ? Number(m[1]) : null;
};
const chartHeight = (text) => {
  const m = text.match(/chartHeight:\s*([0-9.]+)/);
  return m ? Number(m[1]) : null;
};

console.log('scale_units.py 安全探针');
console.log(`  解释器: ${PYTHON}\n`);

// ---------------------------------------------------------------- 0. GBK 控制台
console.log('=== 0. 裸跑（模拟中文 Windows 控制台，不强制 UTF-8）===');
{
  const file = fresh('gbk');
  const result = run([file, '1.5'], { utf8: false });
  const after = readFileSync(file, 'utf8');
  console.log(`      exit=${result.code}，.shot 宽度 = ${shotWidth(after)}cqw`);
  const gbkCrash = /UnicodeEncodeError|gbk.?codec/i.test(result.stderr);
  check('★ 复现：成功打印里的「✔」在 GBK 下抛 UnicodeEncodeError', gbkCrash, describe(result));
  check('★ 但文件**已经写成功**（缩放已生效）', shotWidth(after) === 150, String(shotWidth(after)));
  check('★ 于是表现为"失败"，实际是"成功但退出码为 1"', result.code !== 0 && shotWidth(after) === 150);
  console.log('      → 危险点：用户以为失败会重跑，而重跑会叠加（见用例 2）');
}

// ---------------------------------------------------------------- 1. 原地覆盖
console.log('\n=== 1. 原地覆盖：原始比例还能恢复吗（加 UTF-8，与插件一致）===');
{
  const file = fresh('overwrite');
  check('初始 .shot = 100cqw', shotWidth(readFileSync(file, 'utf8')) === 100);
  const result = run([file, '1.5']);
  const after = readFileSync(file, 'utf8');
  check('脚本正常退出（插件强制 UTF-8，避开了用例 0 的崩溃）', result.code === 0, describe(result));
  check('确实缩放了（100 → 150）', shotWidth(after) === 150, String(shotWidth(after)));
  check('★ 不传输出路径时原地覆盖、**无备份**（原比例不可恢复）', !after.includes('width: 100cqw'));
}

// ---------------------------------------------------------------- 2. 幂等性
console.log('\n=== 2. 幂等性：再跑一次会不会叠加 ===');
{
  const file = fresh('idempotent');
  run([file, '1.5']);
  check('第一次后 = 150cqw', shotWidth(readFileSync(file, 'utf8')) === 150);
  const second = run([file, '1.5']);
  const after = readFileSync(file, 'utf8');
  console.log(`      再跑一次 1.5 → ${shotWidth(after)}cqw`);
  check('第二次也正常退出', second.code === 0, describe(second));
  check(
    '★ 不幂等：重复执行静默叠加为 2.25 倍（文件里不记录已缩放倍数）',
    shotWidth(after) === 225,
    `实际 ${shotWidth(after)}cqw`
  );
}

// ---------------------------------------------------------------- 3. 正则范围
console.log('\n=== 3. 正则作用范围 ===');
{
  const file = fresh('regex');
  run([file, '1.5']);
  const after = readFileSync(file, 'utf8');
  check('CSS 里的 cqw/cqh 被缩放', after.includes('width: 150cqw'));
  check(
    '不带单位的 JS 字面量不受影响（正则只匹配「数字+cqw/cqh」）',
    chartHeight(after) === 42.5,
    `实际 ${chartHeight(after)}`
  );
  check(
    '★ 但注释里的 cqw 数字也被改写（正则作用于全文，不区分 CSS/JS/注释）',
    after.includes('宽 150cqw'),
    '注释未被改写说明正则有范围限制'
  );
}

// ---------------------------------------------------------------- 4. 输出到新文件
console.log('\n=== 4. 指定输出路径（安全用法）===');
{
  const source = fresh('copy');
  const out = join(dir, 'scaled-result.html');
  const result = run([source, '1.5', out]);
  check('执行成功', result.code === 0, describe(result));
  check('原文件保持不变', shotWidth(readFileSync(source, 'utf8')) === 100);
  check('新文件是缩放后的', shotWidth(readFileSync(out, 'utf8')) === 150);
  console.log('      → 结论：给出输出路径是安全用法；默认原地覆盖且不可逆、不幂等');
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
