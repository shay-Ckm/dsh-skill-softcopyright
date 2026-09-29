/**
 * 守卫：**每个工具的每个 action 都必须能真正跑起来**（而不是一调就 ReferenceError）。
 *
 * ## 为什么需要它
 *
 * 我用正则批量把 `projectRootOf(exec)` 改成 `projectRootOf(args, exec)` 时，
 * `sc_pipeline` 里有 3 个 action 的签名是 `run: async ({ exec })` —— 它们解构里**没有 args**，
 * 于是真机一调 `action=plan` 就报：
 *
 *     args is not defined
 *
 * 这类错（变量没接上、拼错名字、忘了解构）在单测里很容易漏，因为单测通常只测"我关心的那几条路"。
 * 这个 harness 反过来做：**把 schema 里声明的每个 action 都调到**，用桩子进程让它跑到
 * action 体内部，只要有 ReferenceError / TypeError 立刻暴露。
 *
 * 这也是 `sc_pipeline action=plan` 那次真机试用的直接产物 —— 所以它按 action 名分组断言，
 * 失败时能直接指出是哪个工具的哪个 action。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');
/** 会话工作区（插件的上上层）。**必须**落在工作区内 —— 路径守卫会拒绝工作区外的路径。 */
const WORKSPACE = join(PLUGIN_ROOT, '..', '..');
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

// 放在工作区内：第一版放在了 os.tmpdir()，被路径守卫正确拒绝 —— 那是**守卫在正常工作**，
// 是测试写错了位置。这里改用工作区内的临时目录。
const TMP = mkdtempSync(join(WORKSPACE, '.sc-actions-guard-'));

/** 桩子进程：不真跑 Python，只回空输出 + 退出码 0。 */
function makeSubprocessStub() {
  const specs = [];
  return {
    specs,
    async resolveExecutable(p) {
      return p;
    },
    spawn(spec) {
      specs.push(spec);
      const reader = () => ({
        readFrom: () => ({ text: '', nextOffset: 0, lossy: false })
      });
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: { stdout: reader(), stderr: reader() },
        terminate: () => {},
        waitForExit: () => Promise.resolve({ exitCode: 0, signal: null })
      };
    }
  };
}

function makeCtx() {
  const services = { subprocess: makeSubprocessStub() };
  const ctx = {
    registeredTools: [],
    skills: { registerProvider: () => () => {} },
    tools: { register: (t) => ctx.registeredTools.push(t) },
    systemPrompt: { section: () => () => {} },
    get: (name) => services[name],
    logger: { info: () => {}, warn: () => {} }
  };
  services.commands = { register: () => () => {} };
  return ctx;
}

const ctx = makeCtx();
mod.apply(ctx, {});

const exec = {
  signal: undefined,
  agent: { session: { header: { cwd: TMP } } }
};

/** 依参数类型造一个哑值；路径类一律落在临时项目目录内，避免污染真实位置。 */
function dummyFor(name, schema) {
  const type = schema?.type;
  if (type === 'number') return 1;
  if (type === 'boolean') return false;
  if (type === 'array') return [];
  if (name === 'action') return undefined;
  // projectRoot 决定守卫的根，必须给真实临时目录 —— 给 'x' 会让守卫以 'x' 为根，
  // 从而（正确地）拒绝 sourceDir。第一版就栽在这。
  if (name === 'projectRoot') return TMP;
  if (/dir$/i.test(name) || /Dir$/.test(name)) return join(TMP, name);
  if (/tsv|docx|html|json|js$/i.test(name)) return join(TMP, `${name}.out`);
  return 'x';
}

console.log('dsh-skill-softcopyright —— 全 action 可调用守卫');
console.log(`临时项目根：${TMP}`);

const toolNames = ctx.registeredTools.map((t) => t.name).sort();
check('注册了 8 个工具', toolNames.length === 8, toolNames.join(', '));

let totalActions = 0;
const crashDetail = [];

for (const tool of ctx.registeredTools.sort((a, b) => a.name.localeCompare(b.name))) {
  const props = tool.parameters?.properties ?? {};
  const actions = props.action?.enum ?? [];
  console.log(`\n=== ${tool.name}（${actions.length} 个 action） ===`);
  const bad = [];

  for (const action of actions) {
    totalActions += 1;
    // 把所有可传参数都填上哑值，确保能进到 action 体内部
    const args = { action };
    for (const [name, schema] of Object.entries(props)) {
      if (name === 'action') continue;
      const value = dummyFor(name, schema);
      if (value !== undefined) args[name] = value;
    }

    try {
      const result = await tool.execute(args, exec);
      const shapeOk = result !== null && typeof result === 'object' && typeof result.ok === 'boolean';
      if (!shapeOk) bad.push(`${action}: 返回形状不对 ${JSON.stringify(result)?.slice(0, 120)}`);
    } catch (error) {
      // 「缺少必填参数」是设计行为（工具会提示需要哪些参数）；其余异常都算问题
      const message = String(error?.message ?? error);
      const isExpectedUsageError = /requires:|requires one of|unknown action/i.test(message);
      if (isExpectedUsageError) {
        console.log(`    ok    ${action.padEnd(16)} （缺参被正确拦下）`);
        continue;
      }
      bad.push(`${action}: ${error?.constructor?.name}: ${message.slice(0, 160)}`);
    }
  }

  if (bad.length === 0) {
    console.log(`    ${actions.length} 个 action 全部可调用`);
  } else {
    for (const b of bad) console.log(`    FAIL  ${b}`);
    crashDetail.push(`${tool.name}: ${bad.join('; ')}`);
  }
  check(`${tool.name} 的 ${actions.length} 个 action 都能调用且返回合法信封`, bad.length === 0);
}

console.log('\n=== 断言 ===');
check('覆盖了 33 个 action', totalActions === 33, `实际 ${totalActions}`);
check(
  '★ 没有 "args is not defined" 这类未接上的变量（真机发现的 bug）',
  !crashDetail.some((d) => /is not defined/.test(d)),
  crashDetail.filter((d) => /is not defined/.test(d)).join('; ')
);
check('没有任何 action 抛出非预期异常', crashDetail.length === 0, crashDetail.join(' | '));

try {
  rmSync(TMP, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log('\n' + '='.repeat(64));
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
for (const f of failures) console.log(`  x ${f}`);
console.log('='.repeat(64));
process.exit(failures.length === 0 ? 0 : 1);
