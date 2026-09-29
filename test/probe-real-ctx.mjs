/**
 * 高保真复现：用**真实 cordis Context + 真实 @deepseek-ai/dsh-tools**（而非桩）跑 apply()。
 *
 * 为什么需要它：integration.mjs 的 ctx.tools / ctx.commands 都是桩，注册期校验完全没跑到。
 * M3 上线后插件 fiberPhase = failed（apply 抛错、cordis 回滚全部注册），而 harness 全绿 ——
 * 说明盲区就在"真实的 register 实现"上。这里把真实实现装进来复现。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');
const pkg = (name) => join(PLUGIN_ROOT, 'node_modules', ...name.split('/'));

const { Context } = await import(pathToFileURL(join(pkg('@deepseek-ai/cordis'), 'lib', 'index.js')).href);
const dshTools = await import(pathToFileURL(join(pkg('@deepseek-ai/dsh-tools'), 'lib', 'index.js')).href);
const mod = await import(pathToFileURL(join(PLUGIN_ROOT, 'lib', 'index.js')).href);

console.log('cordis Context / dsh-tools 已加载');
console.log('dsh-tools 导出含 ToolRuntime:', typeof dshTools.ToolRuntime === 'function');

/** 造一个真实 cordis 上下文，并把真实 ToolRuntime 装成 ctx.tools。 */
async function buildCtx({ withCommands = true } = {}) {
  const root = new Context();
  root.plugin(dshTools.ToolRuntime, {});
  await root.start?.();
  // 等 fiber 激活
  for (let i = 0; i < 50 && root.get('tools') === undefined; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const tools = root.get('tools');
  console.log(`  ctx.get('tools') = ${tools === undefined ? 'undefined' : tools.constructor.name}`);

  // 用真实 ctx 作底座，再补上 skills / systemPrompt / commands
  const providers = [];
  const sections = [];
  const commands = [];
  root.provide?.('skills', {
    registerProvider: (f) => {
      providers.push(f());
      return () => {};
    }
  });
  if (root.get('skills') === undefined) {
    // 有些版本 provide 需要不同签名；退化为直接挂属性
    root.skills = {
      registerProvider: (f) => {
        providers.push(f());
        return () => {};
      }
    };
  }
  const sp = {
    section: (s) => {
      sections.push(s);
      return () => {};
    }
  };
  try {
    root.provide('systemPrompt', sp);
  } catch {
    root.systemPrompt = sp;
  }
  if (root.get('systemPrompt') === undefined) root.systemPrompt = sp;

  if (withCommands) {
    const cmds = {
      register: (definition) => {
        commands.push(definition);
        return () => {};
      }
    };
    try {
      root.provide('commands', cmds);
    } catch {
      root.commands = cmds;
    }
    if (root.get('commands') === undefined) root.commands = cmds;
  }

  return { ctx: root, providers, sections, commands };
}

console.log('\n=== 用真实 ToolRuntime 跑 apply() ===');
const { ctx, providers, sections, commands } = await buildCtx({ withCommands: true });
try {
  mod.apply(ctx, {});
  const tools = ctx.get('tools');
  const names = tools?.view?.({})?.tools ? [...tools.view({}).tools.keys()] : undefined;
  console.log('apply() 成功');
  console.log(`  providers=${providers.length} sections=${sections.length} commands=${commands.length}`);
  console.log(`  已注册工具（真实注册表）: ${names === undefined ? '(无法枚举)' : names.filter((n) => n.startsWith('sc_')).join(', ')}`);
} catch (error) {
  console.log(`apply() 抛错 → ${error?.constructor?.name}: ${error?.message}`);
  console.log(String(error?.stack ?? '').split('\n').slice(0, 12).map((l) => `  ${l}`).join('\n'));
  process.exit(1);
}
process.exit(0);
