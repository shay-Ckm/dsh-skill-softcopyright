/**
 * 探针：`apply()` 在**敌意/缺失的服务环境**下是否仍然完成注册。
 *
 * 这个文件的来历：M3 上线后整插件 `fiberPhase: failed` —— 根因是
 * `lib/commands.js` 里写了 `ctx.commands?.register`，而 cordis 对**未 inject 的服务**，
 * 属性访问本身就抛错：
 *
 *     Error: cannot get property "commands" without inject
 *
 * 可选链救不了（getter 先抛，`?.` 没机会生效），于是 `apply()` 抛错 →
 * cordis **回滚该插件全部注册** → 技能 + 8 个工具 + 命令一起消失。
 * 正确写法是服务契约写明的 `ctx.get('commands')`。
 *
 * 因此这里显式覆盖四种环境，其中第 1 种就是当时的真实故障条件。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');
const mod = await import(pathToFileURL(join(PLUGIN_ROOT, 'lib', 'index.js')).href);

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

/**
 * 造 mock ctx。
 * @param options.commandsMode - `'absent'` | `'ok'` | `'throwOnAccess'`（模拟未 inject）
 * @param options.throwOnRegister - 命令注册时抛错
 */
function makeCtx({ commandsMode = 'absent', throwOnRegister = false } = {}) {
  const ctx = {
    providers: [],
    registeredTools: [],
    sections: [],
    commandDefs: [],
    commandsAccessed: 0,
    services: {},
    skills: { registerProvider: (f) => ctx.providers.push(f()) },
    tools: { register: (t) => ctx.registeredTools.push(t) },
    systemPrompt: { section: (s) => ctx.sections.push(s) },
    get(name) {
      return ctx.services[name];
    },
    logger: { info: () => {}, warn: () => {} }
  };

  if (commandsMode === 'throwOnAccess') {
    // 精确复刻 cordis 的未 inject 行为：**读属性就抛**
    Object.defineProperty(ctx, 'commands', {
      configurable: true,
      get() {
        ctx.commandsAccessed += 1;
        throw new Error('cannot get property "commands" without inject');
      }
    });
  } else if (commandsMode === 'ok') {
    ctx.services.commands = {
      register: (definition) => {
        if (throwOnRegister) throw new Error('duplicate command name');
        ctx.commandDefs.push(definition);
        return () => {};
      }
    };
  }
  return ctx;
}

console.log('dsh-skill-softcopyright —— apply() 环境健壮性探针');

// ---------------- 1. 真实故障条件：访问 ctx.commands 抛错 ----------------
console.log('\n=== 1. ctx.commands 一读就抛（M3 真实故障条件） ===');
{
  const ctx = makeCtx({ commandsMode: 'throwOnAccess' });
  let threw = null;
  try {
    mod.apply(ctx, {});
  } catch (error) {
    threw = error;
  }
  check('apply() 不抛错', threw === null, threw?.message);
  check('8 个工具全部注册', ctx.registeredTools.length === 8, `实际 ${ctx.registeredTools.length}`);
  check('8 条 systemPrompt 段', ctx.sections.length === 8, `实际 ${ctx.sections.length}`);
  check('技能 provider 正常', ctx.providers.length === 1);
  check(
    '★ 根本没有去碰 ctx.commands（根因回归守卫）',
    ctx.commandsAccessed === 0,
    `被访问了 ${ctx.commandsAccessed} 次`
  );
}

// ---------------- 2. 命令服务正常 ----------------
console.log('\n=== 2. 命令服务正常 ===');
{
  const ctx = makeCtx({ commandsMode: 'ok' });
  mod.apply(ctx, {});
  check('8 个工具注册', ctx.registeredTools.length === 8);
  check('4 条命令注册', ctx.commandDefs.length === 4, `实际 ${ctx.commandDefs.length}`);
  check(
    '命令名符合 cordis 契约（^[a-z][a-z0-9_-]*$）',
    ctx.commandDefs.every((d) => /^[a-z][a-z0-9_-]*$/.test(d.name)),
    ctx.commandDefs.map((d) => d.name).join(', ')
  );
  check(
    '带 input 的命令 hint 非空',
    ctx.commandDefs.filter((d) => d.input !== undefined).every((d) => d.input.hint.trim().length > 0)
  );
}

// ---------------- 3. 命令注册抛错 ----------------
console.log('\n=== 3. 命令注册抛错（隔离而非连坐） ===');
{
  const ctx = makeCtx({ commandsMode: 'ok', throwOnRegister: true });
  let threw = null;
  try {
    mod.apply(ctx, {});
  } catch (error) {
    threw = error;
  }
  check('apply() 不抛错', threw === null, threw?.message);
  check('★ 工具不受命令失败影响（8 个）', ctx.registeredTools.length === 8, `实际 ${ctx.registeredTools.length}`);
}

// ---------------- 4. 某一个工具注册抛错 ----------------
console.log('\n=== 4. 某一个工具注册抛错 ===');
{
  const ctx = makeCtx({ commandsMode: 'ok' });
  let calls = 0;
  ctx.tools.register = (t) => {
    calls += 1;
    if (calls === 3) throw new Error('tool schema rejected');
    ctx.registeredTools.push(t);
  };
  mod.apply(ctx, {});
  check('其余工具仍注册（7 个）', ctx.registeredTools.length === 7, `实际 ${ctx.registeredTools.length}`);
}

// ---------------- 5. 测试进程不得污染宿主启动日志 ----------------
console.log('\n=== 5. 启动日志隔离（测试合成失败不得写进宿主日志）===');
{
  const { existsSync, readFileSync: readLog, statSync } = await import('node:fs');
  const { join: joinPath } = await import('node:path');
  const candidates = [
    process.env.DSH_HOME ? joinPath(process.env.DSH_HOME, 'softcopyright-boot.log') : null,
    process.env.USERPROFILE ? joinPath(process.env.USERPROFILE, 'softcopyright-boot.log') : null
  ].filter((p) => p !== null && existsSync(p));

  if (candidates.length === 0) {
    check('没有启动日志可查（跳过此项）', true);
  } else {
    const before = candidates.map((p) => statSync(p).size);
    // 制造一次必然的工具注册失败：如果写日志的门禁失效，它会被写进宿主日志
    const ctx = makeCtx({ commandsMode: 'ok' });
    let calls = 0;
    ctx.tools.register = (t) => {
      calls += 1;
      if (calls === 2) throw new Error('tool schema rejected');
      ctx.registeredTools.push(t);
    };
    mod.apply(ctx, {});
    const after = candidates.map((p) => statSync(p).size);
    check(
      '★ 测试里的合成失败没有写进宿主启动日志',
      before.every((n, i) => n === after[i]),
      `大小 ${before.join(',')} -> ${after.join(',')}`
    );
    console.log('      背景：不加这道门禁时，探针的合成失败会与真实宿主记录混在同一份日志里，');
    console.log('            而那份日志是定位 M3 事故（整插件 fiberPhase: failed）的唯一手段。');
  }
}

console.log('\n' + '='.repeat(60));
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
for (const f of failures) console.log(`  x ${f}`);
console.log('='.repeat(60));
process.exit(failures.length === 0 ? 0 : 1);
