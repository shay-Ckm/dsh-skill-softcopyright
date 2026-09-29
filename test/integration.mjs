/**
 * dsh-skill-softcopyright —— 集成 harness（在 DSH 之外验证 `lib/index.js`）
 *
 * 与 `harness.mjs` 的分工：
 *   harness.mjs      测不依赖 `@deepseek-ai/*` 的模块（skills / runtime / doctor-core）
 *   integration.mjs  用**真实官方包**（@deepseek-ai/schemastery、@deepseek-ai/dsh-tools）
 *                    加载 lib/index.js 并执行 apply()，验证插件真的能装配起来
 *
 * 这个文件的存在理由：M1 交付时 `lib/index.js` 只能做语法检查，因为官方包只在
 * app.asar 内。把官方包抽到 node_modules 后就能真跑 —— 而它立刻抓到了一个会让
 * 插件加载即失败的 bug（import 了 dsh-settings 里根本不存在的导出）。
 *
 * 前置：node_modules/@deepseek-ai/ 下的 4 个包已由 tools 脚本从 app.asar 抽出。
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');
const ASSET_ROOT = join(PLUGIN_ROOT, 'assets', 'skills');

let passed = 0;
const failures = [];
const warnings = [];

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
function warn(message) {
  warnings.push(message);
  console.log(`  WARN  ${message}`);
}

console.log('dsh-skill-softcopyright —— 集成 harness');
console.log(`插件根目录 : ${PLUGIN_ROOT}`);

// ------------------------------------------------------------ 依赖可用性
section('依赖：真实官方包是否可解析');
const pkgRoot = join(PLUGIN_ROOT, 'node_modules', '@deepseek-ai');
for (const p of ['schemastery', 'dsh-tools', 'dsh-util-values', 'dsh-brand']) {
  check(`${p} 已就位`, existsSync(join(pkgRoot, p, 'package.json')));
}

// ------------------------------------------------------------ 导入（这一步本身就是测试）
section('导入 lib/index.js（真实 schemastery + dsh-tools）');
let mod;
try {
  mod = await import(pathToFileURL(join(PLUGIN_ROOT, 'lib', 'index.js')).href);
  check('模块导入成功', true);
} catch (error) {
  check('模块导入成功', false, error?.message);
  console.log('\n导入失败，后续无法继续。');
  process.exit(1);
}

check('导出 name', mod.name === 'skill-softcopyright', String(mod.name));
check(
  '导出 inject 含 skills/systemPrompt/tools',
  Array.isArray(mod.inject) &&
    ['skills', 'systemPrompt', 'tools'].every((s) => mod.inject.includes(s)),
  JSON.stringify(mod.inject)
);
check('inject 不含 subprocess（保持可选）', !mod.inject.includes('subprocess'));
check('导出 apply 函数', typeof mod.apply === 'function');
check('导出 DEFAULT_ASSET_ROOT 且指向真实目录', existsSync(mod.DEFAULT_ASSET_ROOT));

// ------------------------------------------------------------ Config schema
section('Config schema（schemastery 真实校验）');
const { Config } = mod;
check('Config 存在', Config !== undefined);
{
  // 空对象应被填满默认值 —— 这一步同时验证 schema 本身合法、嵌套 .default({}) 生效
  const filled = Config({});
  check('空配置解析成功', filled !== undefined);
  check('skills.enabled 默认 true', filled?.skills?.enabled === true);
  check('skills.assetRoot 默认空串', filled?.skills?.assetRoot === '');
  check('skills.injectToolGuide 默认 true', filled?.skills?.injectToolGuide === true);
  check('skills.enabledSkills 默认空数组', Array.isArray(filled?.skills?.enabledSkills) && filled.skills.enabledSkills.length === 0);
  check('tools.doctor 默认 true', filled?.tools?.doctor === true);
  check('runtime.pythonPath 默认空串', filled?.runtime?.pythonPath === '');
  check(
    'runtime.renderPythonPath 默认为已实测路径',
    filled?.runtime?.renderPythonPath === 'C:\\Python314\\python.exe',
    String(filled?.runtime?.renderPythonPath)
  );
  check('runtime.defaultTimeoutMs 默认 60000', filled?.runtime?.defaultTimeoutMs === 60000);

  // 部分覆盖：只写想改的
  const partial = Config({ skills: { injectToolGuide: false }, runtime: { defaultTimeoutMs: 1234 } });
  check('部分覆盖生效', partial?.skills?.injectToolGuide === false);
  check('未覆盖字段仍取默认值', partial?.skills?.enabled === true);
  check('覆盖数字字段生效', partial?.runtime?.defaultTimeoutMs === 1234);

  // 类型错误应被拒
  let threw = false;
  try {
    Config({ tools: { doctor: 'yes-please' } });
  } catch {
    threw = true;
  }
  check('类型错误被 schema 拒绝', threw);
}

// ------------------------------------------------------------ apply() 装配
/** 模拟 cordis ctx：捕获 provider / tool / systemPrompt section 注册。 */
function makeCtx() {
  const ctx = {
    providers: [],
    registeredTools: [],
    sections: [],
    services: {},
    skills: { registerProvider: (f) => ctx.providers.push(f()) },
    tools: { register: (t) => ctx.registeredTools.push(t) },
    systemPrompt: { section: (s) => ctx.sections.push(s) },
    get(name) {
      return ctx.services[name];
    },
    logger: { info: () => {}, warn: () => {} }
  };
  return ctx;
}

section('apply()：默认配置装配');
{
  const ctx = makeCtx();
  mod.apply(ctx, {});
  check('注册了 1 个 skill provider', ctx.providers.length === 1, `实际 ${ctx.providers.length}`);
  check('注册了 8 个工具', ctx.registeredTools.length === 8, `实际 ${ctx.registeredTools.length}`);
  // 按名字取，不用下标 —— 注册顺序在隔离重构后变了（doctor 现在最后注册）
  const doctor = ctx.registeredTools.find((t) => t.name === 'sc_doctor');
  check('sc_doctor 已注册', doctor !== undefined);
  check('工具描述非空', (doctor?.description ?? '').length > 50);
  // 注意：defineTool 会把 isConcurrencySafe 包成 (args) => 先校验 args 再回调。
  // 这属于 dsh-tools 的内部包装行为，这里只断言"对我们的工具传合法实参时判定为可并发"。
  check('工具标记为并发安全', doctor?.isConcurrencySafe?.({}) === true);
  check('工具声明了超时', typeof doctor?.timeoutMs === 'number');
  check('工具定义了 output schema', doctor?.output?.schema !== undefined);
  check('工具定义了 presentCall', typeof doctor?.presentCall === 'function');
  check('每个工具都注册了 systemPrompt 段', ctx.sections.length === ctx.registeredTools.length);
  check(
    '段名与工具名一一对应',
    ctx.registeredTools.every((t) => ctx.sections.some((s) => s.name === `tool:${t.name}`))
  );
  check('所有段 order 都是有限数字', ctx.sections.every((s) => Number.isFinite(s.order)));
  check('所有段都关闭了变量插值', ctx.sections.every((s) => s.interpolate === false));
  check('所有段文本非空', ctx.sections.every((s) => (s.text ?? '').length > 50));

  const listed = await ctx.providers[0].list();
  check('provider 提供 4 个技能', listed.length === 4, `实际 ${listed.length}`);
  check('provider 名为 softcopyright', ctx.providers[0].name === 'softcopyright');
}

section('apply()：M2 五个分组工具的形状');
{
  const ctx = makeCtx();
  mod.apply(ctx, {});
  const byName = new Map(ctx.registeredTools.map((t) => [t.name, t]));

  check('注册了 8 个工具（doctor + 5 分组 + audit + pipeline）', ctx.registeredTools.length === 8, `实际 ${ctx.registeredTools.length}`);
  for (const toolName of ['sc_doctor', 'sc_manual', 'sc_source', 'sc_aigc', 'sc_proof', 'sc_atlas', 'sc_audit', 'sc_pipeline']) {
    check(`${toolName} 已注册`, byName.has(toolName));
  }

  // 每个分组工具都必须：action 为枚举必填、参数表含 action、描述够长、超时为正
  const expectedActions = {
    sc_manual: ['check', 'stats', 'check-figs', 'insert-atlas', 'extract', 'render-pdf'],
    sc_source: ['gen-doc', 'check-doc', 'build-package', 'smoke', 'collect-hashes', 'stats-hashes'],
    sc_aigc: ['scan', 'struct', 'probe'],
    sc_proof: ['gen-docx', 'gen-html', 'page-estimate', 'check-inline-js'],
    sc_atlas: ['validate', 'check-html', 'scale', 'shoot']
  };
  for (const [toolName, actions] of Object.entries(expectedActions)) {
    const tool = byName.get(toolName);
    const enums = tool?.parameters?.properties?.action?.enum ?? [];
    check(
      `${toolName} action 枚举完整（${actions.length} 个）`,
      actions.every((a) => enums.includes(a)) && enums.length === actions.length,
      JSON.stringify(enums)
    );
    check(`${toolName} action 必填`, (tool?.parameters?.required ?? []).includes('action'));
    check(`${toolName} 描述足够长`, (tool?.description ?? '').length > 150);
    check(`${toolName} 超时为正`, typeof tool?.timeoutMs === 'number' && tool.timeoutMs > 0);
    check(`${toolName} 没有多余参数泄漏进 schema`, Object.keys(tool.parameters.properties).length <= 30);
  }

  // 写操作必须声明不可并发
  check('insert-atlas 不可并发', byName.get('sc_manual').isConcurrencySafe({ action: 'insert-atlas' }) === false);
  check('check 可并发', byName.get('sc_manual').isConcurrencySafe({ action: 'check' }) === true);
  check('build-package 不可并发', byName.get('sc_source').isConcurrencySafe({ action: 'build-package' }) === false);
  check('shoot 不可并发且超时很长', byName.get('sc_atlas').isConcurrencySafe({ action: 'shoot' }) === false && byName.get('sc_atlas').timeoutMs >= 600000);

  // 缺参数必须在 schema 层或 execute 层报出可操作错误
  let missingParam = '';
  try {
    await byName.get('sc_manual').execute({ action: 'check' }, {});
  } catch (error) {
    missingParam = error.message;
  }
  check('sc_manual check 缺 docx 时报错', /requires: docx/.test(missingParam), missingParam);

  // 路径守卫：越界路径必须被拒（这是 ctx.subprocess 无沙箱策略后的替代边界）
  let guardRefusal = '';
  try {
    await byName.get('sc_manual').execute(
      { action: 'check', docx: 'C:/Windows/System32/config/SAM' },
      { agent: { session: { header: { cwd: 'C:/work/session' } } } }
    );
  } catch (error) {
    guardRefusal = error.message;
  }
  check('会话工作区外的 docx 被路径守卫拒绝', /outside the allowed roots/.test(guardRefusal), guardRefusal);
}

section('apply()：配置开关生效');
{
  const off = makeCtx();
  mod.apply(off, { skills: { enabled: false }, tools: { doctor: false } });
  check('skills.enabled=false 时不注册 provider', off.providers.length === 0);
  check('只关 doctor 时其余 7 个工具仍在', off.registeredTools.length === 7, `实际 ${off.registeredTools.length}`);
  check('doctor 确实被关掉', !off.registeredTools.some((t) => t.name === 'sc_doctor'));

  const allOff = makeCtx();
  mod.apply(allOff, {
    skills: { enabled: false },
    tools: {
      doctor: false,
      manual: false,
      source: false,
      aigc: false,
      proof: false,
      atlas: false,
      audit: false,
      pipeline: false
    }
  });
  check('全部关掉时零工具', allOff.registeredTools.length === 0, `实际 ${allOff.registeredTools.length}`);

  const onlyDoctor = makeCtx();
  mod.apply(onlyDoctor, {
    skills: { enabled: false },
    tools: { manual: false, source: false, aigc: false, proof: false, atlas: false, audit: false, pipeline: false }
  });
  check('只留 doctor 时恰好 1 个工具', onlyDoctor.registeredTools.length === 1, `实际 ${onlyDoctor.registeredTools.length}`);

  const noPipeline = makeCtx();
  mod.apply(noPipeline, { skills: { enabled: false }, tools: { doctor: false, audit: false, pipeline: false } });
  check('关掉编排工具后只剩 5 个分组工具', noPipeline.registeredTools.length === 5, `实际 ${noPipeline.registeredTools.length}`);

  const noGuide = makeCtx();
  mod.apply(noGuide, { skills: { injectToolGuide: false } });
  const def = await noGuide.providers[0].get((await noGuide.providers[0].list())[0], {});
  check('injectToolGuide=false 时正文无工具指引', !def.content.includes('本插件提供的编排与工具'));

  const subset = makeCtx();
  mod.apply(subset, { skills: { enabledSkills: ['aigc-review-reduction'] } });
  const subsetList = await subset.providers[0].list();
  check('enabledSkills 生效', subsetList.length === 1 && subsetList[0].name === 'aigc-review-reduction');

  // M3 教训：apply() 内的每一段都独立隔离，**不再向外抛错** ——
  // cordis 在 apply 抛错时会回滚该插件的全部注册，曾导致技能 + 8 工具 + 命令一起消失
  // （真机 fiberPhase: failed）。现在坏配置只丢那一项（并写进启动日志），其余照常注册。
  const badSkills = makeCtx();
  let threw = false;
  try {
    mod.apply(badSkills, { skills: { enabledSkills: ['nope'] } });
  } catch {
    threw = true;
  }
  check('未知 enabledSkills 不再让 apply 抛错（隔离而非连坐）', threw === false);
  check('但该段失败后确实没注册 provider', badSkills.providers.length === 0, `实际 ${badSkills.providers.length}`);
  check('其余工具仍照常注册（8 个）', badSkills.registeredTools.length === 8, `实际 ${badSkills.registeredTools.length}`);
}

section('apply()：sc_doctor 工具真的能执行（含真实子进程）');
{
  const ctx = makeCtx();
  // 提供受管子进程 seam 的形状替身需要 node:child_process，这里直接给真实实现
  const { spawn } = await import('node:child_process');
  const spawnSpecs = [];
  ctx.services.subprocess = {
    async resolveExecutable(p) {
      return p;
    },
    spawn(spec) {
      spawnSpecs.push(spec);
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...(spec.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
      const bufs = { stdout: [], stderr: [] };
      child.stdout.on('data', (d) => bufs.stdout.push(d));
      child.stderr.on('data', (d) => bufs.stderr.push(d));
      const onAbort = () => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      };
      if (spec.signal) {
        if (spec.signal.aborted) onAbort();
        else spec.signal.addEventListener('abort', onAbort, { once: true });
      }
      const done = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (exitCode, signal) => {
          spec.signal?.removeEventListener?.('abort', onAbort);
          resolve({ exitCode, signal });
        });
      });
      const reader = (ch) => ({
        readFrom: (from) => {
          const text = Buffer.concat(bufs[ch]).toString('utf8');
          return { text: text.slice(from), nextOffset: text.length, lossy: false };
        }
      });
      return {
        done,
        collected: { stdout: reader('stdout'), stderr: reader('stderr') },
        terminate: onAbort,
        waitForExit: () => done
      };
    }
  };

  mod.apply(ctx, {});
  // 按名字取：隔离重构后 doctor 最后注册，不再位于下标 0
  const tool = ctx.registeredTools.find((t) => t.name === 'sc_doctor');
  check('工具 execute 是函数', typeof tool?.execute === 'function');

  const execCtx = { signal: undefined };
  const result = await tool.execute({}, execCtx);
  check('execute 返回结构化结果', result !== undefined && typeof result.report === 'string');
  check('结果 ok=true', result.ok === true, JSON.stringify(result.warnings));
  check('报告文本含两条链', result.report.includes('生成/校验链') && result.report.includes('渲染链'));
  check('报告含资产明细', result.report.includes('python-software-delivery'));
  check('warnings 是数组', Array.isArray(result.warnings));
  check(
    '所有 spawn 请求都带了必填 cwd（回归守卫）',
    spawnSpecs.length > 0 && spawnSpecs.every((s) => typeof s.cwd === 'string' && s.cwd.length > 0),
    JSON.stringify(spawnSpecs.map((s) => s.cwd))
  );
  check(
    'apply 时未走 seam 失败分支',
    spawnSpecs.length > 0 && !result.warnings.some((w) => /seam 调用失败/.test(w)),
    result.warnings.join(' | ')
  );

  // output.render 契约
  const rendered = tool.output.render({}, result);
  check('output.render 产出文本块', Array.isArray(rendered) && rendered[0]?.type === 'text');
  check('渲染文本与报告一致', rendered[0].text === result.report);

  // presentCall 契约
  const card = tool.presentCall({});
  check('presentCall 返回卡片描述', typeof card?.title === 'string' && card.title.length > 0);
}

// ------------------------------------------------------------ M2 基建：路径守卫
section('M2 基建：lib/guard.js 路径守卫');
{
  const { isInside, createPathGuard } = await import(pathToFileURL(join(PLUGIN_ROOT, 'lib', 'guard.js')).href);

  const ws = resolve('C:/work/session');
  check('isInside 接受自身', isInside(ws, ws) === true);
  check('isInside 接受子路径', isInside(ws, join(ws, 'docs', 'a.docx')) === true);
  check('isInside 拒绝父级', isInside(ws, resolve('C:/work')) === false);
  check('isInside 拒绝同前缀不同目录', isInside(ws, resolve('C:/work/session-evil/a')) === false);
  check('isInside 大小写不敏感（Windows）', isInside(ws, resolve('C:/WORK/SESSION/a')) === true);

  const guard = createPathGuard({
    workspaceRoot: ws,
    alwaysAllow: [ASSET_ROOT],
    allowlist: ['C:/shared-output']
  });

  check('工作区内放行', guard.check(join(ws, 'docs', 'x.docx'), 'docx').ok === true);
  check(
    '插件资源目录无条件放行',
    guard.check(join(ASSET_ROOT, 'python-software-delivery', 'scripts', 'check_aigc.py'), 'script').ok === true
  );
  check('allowlist 放行', guard.check('C:/shared-output/r.docx', 'docx').ok === true);

  const outside = guard.check('C:/Windows/System32/config/SAM', 'docx');
  check('工作区外拒绝', outside.ok === false);
  check('拒绝理由含可操作提示', /allowlist|outside the allowed roots/.test(outside.reason), outside.reason);

  let threw = false;
  try {
    guard.assert('C:/Windows/System32/config/SAM', 'docx');
  } catch (error) {
    threw = /outside the allowed roots/.test(error.message);
  }
  check('assert 越界时抛错', threw);

  const noBoundary = createPathGuard({});
  check('无边界信息时不拦截但标记 guarded=false', noBoundary.check('C:/anywhere/x.docx').guarded === false);
  check('守卫可自述边界', Array.isArray(guard.describe().roots) && guard.describe().roots.length === 3);
}

// ------------------------------------------------------------ M2 基建：分组工具工厂
section('M2 基建：lib/tools/registry.js（对真实 defineTool 校验 schema）');
{
  const { buildActionTool, toFields } = await import(
    pathToFileURL(join(PLUGIN_ROOT, 'lib', 'tools', 'registry.js')).href
  );

  const params = {
    docx: { type: 'string', description: 'docx 路径' },
    expect: { type: 'number', description: '期望图数' },
    flag: { type: 'boolean', description: '开关' }
  };

  const runs = [];
  const { tool, prompt } = buildActionTool({
    name: 'sc_probe_test',
    description: '测试用分组工具',
    prompt: { name: 'tool:sc_probe_test', order: 299, text: 'probe prompt' },
    params,
    actions: {
      alpha: {
        summary: '需要 docx',
        uses: ['docx'],
        run: async ({ args }) => {
          runs.push(['alpha', args.docx]);
          return { ok: true, fields: toFields({ docx: args.docx, n: 3 }), output: 'raw-alpha' };
        }
      },
      beta: {
        summary: '需要 docx 与 expect，写操作',
        uses: ['docx', 'expect'],
        concurrencySafe: false,
        run: async ({ args }) => {
          runs.push(['beta', args.expect]);
          return { ok: false, fields: toFields({ expect: args.expect }) };
        }
      }
    }
  });

  // 关键断言：真实 defineTool 接受了我们的 schema（M1 的教训：schema 不合规会加载即失败）
  check('真实 defineTool 接受该 schema', tool !== undefined);
  check(
    '参数表含 action 与"被 action 引用"的参数（未引用的 flag 不进表）',
    Object.keys(tool.parameters.properties).sort().join(',') === 'action,docx,expect'
  );
  check('action 有 enum', Array.isArray(tool.parameters.properties.action.enum));
  check('action 是必填', (tool.parameters.required ?? []).includes('action'));
  check('docx 未被标记必填（必填性由 action 决定）', !(tool.parameters.required ?? []).includes('docx'));
  check('prompt 原样返回给调用方', prompt?.name === 'tool:sc_probe_test');
  check('output schema 通过校验', tool.output?.schema?.type === 'object');
  check('render 是函数', typeof tool.output.render === 'function');

  const okResult = await tool.execute({ action: 'alpha', docx: 'D:/a.docx' }, {});
  check('execute 分发到 alpha', runs.at(-1)[0] === 'alpha');
  check('返回信封含 ok/action/summary/fields', okResult.ok === true && okResult.action === 'alpha');
  check('字段被拼成 key=value', okResult.fields.includes('docx=D:/a.docx') && okResult.fields.includes('n=3'));
  check('output 透传原始 stdout', okResult.output === 'raw-alpha');
  check('未提供 summary 时自动兜底渲染', /sc_probe_test alpha: OK/.test(okResult.summary), okResult.summary);

  const failResult = await tool.execute({ action: 'beta', docx: 'D:/b.docx', expect: 37 }, {});
  check('execute 分发到 beta 且 ok=false 透传', failResult.ok === false && failResult.action === 'beta');
  // beta 不返回 output —— 信封里绝不能因此出现 `output: undefined`。
  // DSH 要求工具输出是 lossless JSON；实测真机报错：
  //   tool "sc_pipeline" returned invalid output: value is not lossless JSON
  check('未返回 output 时信封里没有 output 键', !('output' in failResult), Object.keys(failResult).join(','));
  check(
    '信封里不含任何 undefined 值（lossless JSON 守卫）',
    Object.values(failResult).every((v) => v !== undefined)
  );

  let missing = '';
  try {
    await tool.execute({ action: 'beta', docx: 'D:/b.docx' }, {});
  } catch (error) {
    missing = error.message;
  }
  check('缺必需参数时报可操作错误', /requires: expect/.test(missing), missing);

  // 注意：enum 校验由真实 defineTool 在 execute 之前完成，所以未知 action 根本到不了
  // buildActionTool 里的兜底分支 —— 这是更好的结果（schema 层拦截）。运行时那条兜底
  // 分支只在工具被直接调用（绕过 defineTool）时才生效。
  let badAction = '';
  try {
    await tool.execute({ action: 'gamma' }, {});
  } catch (error) {
    badAction = error.message;
  }
  check(
    '未知 action 在 schema 层被拦下并列出可选值',
    /must be one of/.test(badAction) && /alpha/.test(badAction) && /beta/.test(badAction),
    badAction
  );

  check('并发安全按 action 判定（alpha 可并发）', tool.isConcurrencySafe({ action: 'alpha' }) === true);
  check('并发安全按 action 判定（beta 不可并发）', tool.isConcurrencySafe({ action: 'beta' }) === false);

  const rendered = tool.output.render({ action: 'alpha' }, okResult);
  check('render 输出文本块', Array.isArray(rendered) && rendered[0]?.type === 'text');

  const card2 = tool.presentCall({ action: 'alpha' });
  check('presentCall 标题含 action', typeof card2?.title === 'string' && card2.title.includes('alpha'));

  let declaredCheck = false;
  try {
    buildActionTool({
      name: 'x',
      description: 'd',
      params,
      actions: { a: { summary: 's', uses: ['nope'], run: async () => ({}) } }
    });
  } catch (error) {
    declaredCheck = /undeclared params: nope/.test(error.message);
  }
  check('引用未声明参数时构建即失败', declaredCheck);

  check('toFields 跳过空值', toFields({ a: undefined, b: null, c: 1 }).join('|') === 'c=1');
  check('toFields 展开数组', toFields({ a: ['x', 'y'] }).join('|') === 'a=x,y');
}

// ------------------------------------------------------------ M4 基建：BOM 修复
section('M4：stripUtf8Bom（gen_proof_docx 的 BOM 陷阱）');
{
  const { stripUtf8Bom } = await import(pathToFileURL(join(PLUGIN_ROOT, 'lib', 'tools', 'groups.js')).href);
  const os = await import('node:os');
  const fs = await import('node:fs');
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'sc-bom-'));
  const withBom = join(dir, 'bom.json');
  const plain = join(dir, 'plain.json');
  fs.writeFileSync(withBom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}', 'utf8')]));
  fs.writeFileSync(plain, '{"a":1}', 'utf8');

  check('带 BOM 的文件被识别并改写', stripUtf8Bom(withBom) === true);
  check('改写后内容与原 JSON 一致（仅去掉 BOM）', fs.readFileSync(withBom, 'utf8') === '{"a":1}');
  check('再次调用返回 false（幂等）', stripUtf8Bom(withBom) === false);
  check('无 BOM 的文件返回 false', stripUtf8Bom(plain) === false);
  check('不存在的路径不抛错', stripUtf8Bom(join(dir, 'nope.json')) === false);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n' + '='.repeat(64));
console.log(`通过 ${passed} 项，失败 ${failures.length} 项，警告 ${warnings.length} 项`);
if (warnings.length > 0) {
  console.log('\n警告：');
  for (const w of warnings) console.log(`  ! ${w}`);
}
if (failures.length > 0) {
  console.log('\n失败：');
  for (const f of failures) console.log(`  x ${f}`);
}
console.log('='.repeat(64));
process.exit(failures.length === 0 ? 0 : 1);
