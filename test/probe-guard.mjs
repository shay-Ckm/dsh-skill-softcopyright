/**
 * 路径守卫的安全性探针。
 *
 * 目的：验证守卫的两个可疑点，用可复现的证据说话，而不是靠读代码下结论。
 *   1. `enabled: false`（文档说是"只记录不拦截、用于排查与自救"）是否真的能关闭拦截？
 *   2. 符号链接 / 目录联接（junction）是否会绕过工作区边界？
 *      —— `path.resolve` 只做词法归一化，**不解析链接**。
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');
const { createPathGuard, isInside } = await import(
  pathToFileURL(join(PLUGIN_ROOT, 'lib', 'guard.js')).href
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

// 造一个"工作区"和"工作区外的敏感目录"
const base = join(tmpdir(), 'sc-guard-probe-' + Date.now());
const workspace = join(base, 'workspace');
const outside = join(base, 'outside');
mkdirSync(workspace, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, 'secret.txt'), 'secret', 'utf8');

console.log('路径守卫安全性探针');
console.log(`  工作区: ${workspace}`);
console.log(`  外部区: ${outside}\n`);

console.log('=== 1. 基本边界 ===');
{
  const guard = createPathGuard({ workspaceRoot: workspace });
  check('工作区内路径放行', guard.check(join(workspace, 'a.txt'), 'p').ok === true);
  check('工作区外路径拦截', guard.check(join(outside, 'secret.txt'), 'p').ok === false);
  check('用 .. 逃逸被拦截', guard.check(join(workspace, '..', 'outside', 'secret.txt'), 'p').ok === false);
  check('绝对路径指向外部被拦截', guard.check(outside, 'p').ok === false);
}

console.log('\n=== 2. enabled:false 是否真能关闭拦截（文档称"自救"用）===');
{
  const guard = createPathGuard({ workspaceRoot: workspace, enabled: false });
  const denied = guard.check(join(outside, 'secret.txt'), 'p');
  console.log(`      check()  -> ok=${denied.ok}`);
  check('check() 在 enabled:false 时应当放行', denied.ok === true, 'check() 完全没看 enabled');

  let threw = null;
  try {
    guard.assert(join(outside, 'secret.txt'), 'p');
  } catch (error) {
    threw = error;
  }
  check('assert() 在 enabled:false 时不应抛错', threw === null, threw?.message);
}

console.log('\n=== 3. 符号链接 / 目录联接是否绕过边界 ===');
{
  const link = join(workspace, 'link');
  let linked = false;
  try {
    // Windows 上 dir 类型默认会创建目录联接（junction），不需要管理员权限
    symlinkSync(outside, link, 'junction');
    linked = true;
  } catch (error) {
    console.log(`      [跳过] 无法创建链接：${error?.code ?? error?.message}`);
  }

  if (linked) {
    const guard = createPathGuard({ workspaceRoot: workspace });
    const viaLink = join(link, 'secret.txt');
    const result = guard.check(viaLink, 'p');
    console.log(`      通过链接访问: ${viaLink}`);
    console.log(`      check() -> ok=${result.ok}（target=${result.target}）`);
    check(
      '通过工作区内的链接访问外部文件应被拦截',
      result.ok === false,
      '链接未被解析，词法上仍在工作区内 —— 边界可被绕过'
    );
  }
}

console.log('\n=== 4. isInside 的词法边界 ===');
{
  check('同目录视为内部', isInside('/a/b', '/a/b') === true);
  check('前缀相似的兄弟目录不算内部', isInside('/a/b', '/a/bc') === false);
  check('父目录不算内部', isInside('/a/b', '/a') === false);
}

console.log('\n' + '='.repeat(64));
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
for (const f of failures) console.log(`  x ${f}`);
console.log('='.repeat(64));

try {
  rmSync(base, { recursive: true, force: true });
} catch {
  /* ignore */
}
process.exit(failures.length === 0 ? 0 : 1);
