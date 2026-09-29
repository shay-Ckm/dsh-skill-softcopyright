/**
 * 探针：用**真实 cordis 的 resolveConfig** 校验条目 config。
 *
 * 怀疑点：loader 不是直接调用 schema，而是走 cordis 的 `resolveConfig(schema, config)`。
 * 如果该路径抛错，条目会在 apply() 之前就失败 —— 那正好解释"连 M2 的 6 个工具都没了"。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');
const pkg = (name) => join(PLUGIN_ROOT, 'node_modules', ...name.split('/'));

const cordis = await import(pathToFileURL(join(pkg('@deepseek-ai/cordis'), 'lib', 'index.js')).href);
const mod = await import(pathToFileURL(join(PLUGIN_ROOT, 'lib', 'index.js')).href);
const { Config } = mod;

console.log('resolveConfig 可用:', typeof cordis.resolveConfig === 'function');

const cases = [
  ['空配置 {}', {}],
  ['profile 实际配置 {}', {}],
  ['带 pipeline 段', { pipeline: { commands: false } }],
  ['带 tools 段', { tools: { atlas: false } }],
  ['带 security 段', { security: { pathGuard: { allowlist: ['C:/x'] } } }]
];

let failed = 0;
for (const [label, raw] of cases) {
  // 1) 直接调用 schema
  let direct = 'ok';
  try {
    const v = Config(raw);
    direct = v === undefined ? 'returned undefined' : 'ok';
  } catch (error) {
    direct = `${error?.constructor?.name}: ${error?.message}`;
  }
  // 2) 走真实 cordis resolveConfig
  let viaCordis = 'ok';
  try {
    cordis.resolveConfig(Config, raw);
  } catch (error) {
    viaCordis = `${error?.constructor?.name}: ${error?.message}`;
  }
  const bad = direct !== 'ok' || viaCordis !== 'ok';
  if (bad) failed += 1;
  console.log(`${bad ? 'FAIL' : 'PASS'}  ${label}\n      直接调用: ${direct}\n      resolveConfig: ${viaCordis}`);
}

process.exit(failed === 0 ? 0 : 1);
