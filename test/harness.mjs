/**
 * dsh-skill-softcopyright —— M1 验收 harness
 *
 * 为什么需要它：DSH 的 `@deepseek-ai/*` 包只存在于 app.asar 内，工作区里的普通 node
 * 进程 import 不到 `lib/index.js`（它依赖 dsh-tools / dsh-settings / schemastery）。
 * 因此本 harness 直接测**不依赖那些包的**两个模块 —— `lib/skills.js` 与
 * `lib/runtime.js` —— 这是 M1 风险最集中的部分（技能注册契约 + 子进程链路）。
 *
 * 覆盖的验收项：
 *   A1 技能可见      provider.list() 返回 4 个技能，名称/描述/调用策略正确
 *   A2 资源可达      resourceBase 指向真实目录，get() 返回正文与资源指引所需的路径
 *   A3 无分叉        插件内 SKILL.md 与原始技能包 byte-identical；check_aigc.py 去重生效
 *   A4 子进程可用    runPythonInline 经受管 seam 形状跑通随包 Python 并取回结构化 JSON
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SKILLS, createSkillProvider, parseSkill, validateAssets } from '../lib/skills.js';
import {
  CHAINS,
  PROBE_PROGRAM,
  parseTrailingJson,
  resolveBundledPython,
  resolvePythonForChain,
  resolveRenderPython,
  runPythonInline
} from '../lib/runtime.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');
const ASSET_ROOT = join(PLUGIN_ROOT, 'assets', 'skills');
const ORIGIN_ROOT = join(PLUGIN_ROOT, '..', '..', '_ref_skills');

// ---------------------------------------------------------------- 迷你测试框架
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

// -------------------------------------------------- 模拟 ctx.subprocess（受管 seam 形状）
/**
 * 用 node:child_process 实现一个 `ctx.subprocess` 的**形状替身**，只为在 DSH 之外
 * 验证我们调用 seam 的方式是否正确（argv/env/stdio/graceMs/signal 字段、done 的
 * 形状、collected.<stream>.readFrom(0) 的 { text, nextOffset, lossy } 返回）。
 * 真实 provider 的行为需要在 profile 里加载后验证。
 */
function createFakeSubprocess(log) {
  return {
    async resolveExecutable(program) {
      return program;
    },
    spawn(spec) {
      log.push({
        argv: spec.argv,
        cwd: spec.cwd,
        env: spec.env,
        graceMs: spec.graceMs,
        hasSignal: spec.signal !== undefined,
        stdio: spec.stdio
      });
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...(spec.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
      const bufs = { stdout: [], stderr: [] };
      child.stdout.on('data', (d) => bufs.stdout.push(d));
      child.stderr.on('data', (d) => bufs.stderr.push(d));

      // 真实 provider 会响应 spec.signal 启动终止流程；替身也必须如此，
      // 否则超时语义测不出来（第一版就踩了这个坑）。
      const terminate = () => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      };
      const onAbort = () => terminate();
      if (spec.signal !== undefined) {
        if (spec.signal.aborted) terminate();
        else spec.signal.addEventListener('abort', onAbort, { once: true });
      }

      const done = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (exitCode, signal) => {
          spec.signal?.removeEventListener?.('abort', onAbort);
          resolve({ exitCode, signal });
        });
      });
      const reader = (channel) => ({
        readFrom: (from) => {
          const text = Buffer.concat(bufs[channel]).toString('utf8');
          return { text: text.slice(from), nextOffset: text.length, lossy: false };
        }
      });
      return {
        done,
        collected: { stdout: reader('stdout'), stderr: reader('stderr') },
        terminate,
        waitForExit: () => done
      };
    }
  };
}

/** 模拟 cordis ctx：只需 get() 与 skills 服务。 */
function createFakeCtx() {
  const registered = [];
  const spawnCalls = [];
  const services = { subprocess: createFakeSubprocess(spawnCalls) };
  return {
    registered,
    spawnCalls,
    get(name) {
      return services[name];
    },
    skills: {
      registerProvider(factory) {
        registered.push(factory());
        return () => {};
      }
    },
    logger: { info: () => {}, warn: () => {} }
  };
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// ================================================================ 开始
console.log('dsh-skill-softcopyright —— M1 验收 harness');
console.log(`插件根目录 : ${PLUGIN_ROOT}`);
console.log(`技能资产   : ${ASSET_ROOT}`);
console.log(`原始技能包 : ${ORIGIN_ROOT}`);

// ---------------------------------------------------------------- A3（先测，作为基线）
section('A3 无分叉：插件内 SKILL.md 与原始技能包 byte-identical');
for (const { name } of SKILLS) {
  const mine = join(ASSET_ROOT, name, 'SKILL.md');
  const origin = join(ORIGIN_ROOT, name, name, 'SKILL.md');
  if (!existsSync(origin)) {
    warn(`原始技能包不存在，跳过比对：${origin}`);
    continue;
  }
  check(`${name}/SKILL.md 哈希一致`, sha256(mine) === sha256(origin), `${sha256(mine)} vs ${sha256(origin)}`);
}

section('A3 去重：check_aigc.py 双份已统一为超集版');
{
  const a = join(ASSET_ROOT, 'aigc-review-reduction', 'scripts', 'check_aigc.py');
  const b = join(ASSET_ROOT, 'python-software-delivery', 'scripts', 'check_aigc.py');
  check('两份 check_aigc.py 哈希一致', sha256(a) === sha256(b));
  const size = statSync(a).size;
  check('保留的是 17907 字节超集版', size === 17907, `实际 ${size} 字节`);
  const source = readFileSync(a, 'utf8');
  check('超集版包含 --struct 结构扫描', source.includes('--struct'));
}

section('A3 去重：aigc-reduction.md 双份一致');
{
  const a = join(ASSET_ROOT, 'aigc-review-reduction', 'references', 'aigc-reduction.md');
  const b = join(ASSET_ROOT, 'python-software-delivery', 'references', 'aigc-reduction.md');
  check('两份 aigc-reduction.md 哈希一致', sha256(a) === sha256(b));
}

// ---------------------------------------------------------------- A1 技能列出
section('A1 技能契约：provider.list()');
const ctx = createFakeCtx();
const provider = createSkillProvider({ assetRoot: ASSET_ROOT, logger: ctx.logger });
ctx.skills.registerProvider(() => provider);

const listed = await ctx.registered[0].list();
check('注册了 1 个 provider', ctx.registered.length === 1);
check('provider 名为 softcopyright', ctx.registered[0].name === 'softcopyright');
check('列出 4 个技能', listed.length === 4, `实际 ${listed.length}`);

const expectedNames = SKILLS.map((s) => s.name).sort();
check('技能名完全匹配', JSON.stringify(listed.map((c) => c.name).sort()) === JSON.stringify(expectedNames));

for (const candidate of listed) {
  check(`${candidate.name}: description 非空`, typeof candidate.description === 'string' && candidate.description.length > 20);
  check(`${candidate.name}: rank = 600`, candidate.rank === 600, `实际 ${candidate.rank}`);
  check(`${candidate.name}: provider = softcopyright`, candidate.provider === 'softcopyright');
  check(`${candidate.name}: source = bundled`, candidate.source === 'bundled');
  check(
    `${candidate.name}: modelInvocable + userInvocable`,
    candidate.invocation?.modelInvocable === true && candidate.invocation?.userInvocable === true
  );
  check(`${candidate.name}: locator 指向 SKILL.md`, candidate.locator.endsWith('SKILL.md') && existsSync(candidate.locator));
}

// ---------------------------------------------------------------- A2 资源可达
section('A2 资源可达：resourceBase 与 get()');
for (const candidate of listed) {
  const base = candidate.resourceBase;
  check(`${candidate.name}: resourceBase.kind = directory`, base?.kind === 'directory');
  check(`${candidate.name}: resourceBase.path 绝对且存在`, existsSync(base.path) && statSync(base.path).isDirectory());
  check(`${candidate.name}: 含 SKILL.md`, existsSync(join(base.path, 'SKILL.md')));

  const scripts = join(base.path, 'scripts');
  check(`${candidate.name}: 含 scripts/`, existsSync(scripts) && statSync(scripts).isDirectory());

  const definition = await ctx.registered[0].get(candidate, {});
  check(`${candidate.name}: get() 返回同名定义`, definition.name === candidate.name);
  check(`${candidate.name}: 正文非空`, typeof definition.content === 'string' && definition.content.length > 500);
  check(`${candidate.name}: 正文不含 frontmatter 残留`, !definition.content.startsWith('---'));
  check(
    `${candidate.name}: 返回的 resourceBase 仍在（供渲染资源指引）`,
    definition.resourceBase?.path === base.path
  );
  check(`${candidate.name}: rank 未泄漏进定义`, definition.rank === undefined);
  check(`${candidate.name}: locator 未泄漏进定义`, definition.locator === undefined);
}

section('A2 资源指引：技能正文引用的脚本真实存在');
{
  const manual = listed.find((c) => c.name === 'manual-ui-screenshots');
  const def = await ctx.registered[0].get(manual, {});
  // 技能正文里点名要求回填说明书的脚本，是 Phase 5.2 的完成判据所依赖的
  const required = ['insert_atlas_into_manual.py', 'check_manual_with_figs.py', 'shoot_real_ui.py'];
  for (const script of required) {
    check(
      `manual-ui-screenshots 正文提到 ${script} 且文件存在`,
      def.content.includes(script) && existsSync(join(manual.resourceBase.path, 'scripts', script))
    );
  }
  const delivery = listed.find((c) => c.name === 'python-software-delivery');
  const ddef = await ctx.registered[0].get(delivery, {});
  for (const script of ['gen_manual_docx.py', 'check_aigc.py', 'build_src_package.py', 'gen_src_docx.py']) {
    check(
      `python-software-delivery 正文提到 ${script} 且文件存在`,
      ddef.content.includes(script) && existsSync(join(delivery.resourceBase.path, 'scripts', script))
    );
  }
}

section('A2 工具指引注入开关');
{
  const withGuide = await ctx.registered[0].get(listed[0], {});
  check('默认注入工具指引', withGuide.content.includes('本插件提供的编排与工具'));

  const noGuide = createSkillProvider({ assetRoot: ASSET_ROOT, injectToolGuide: false });
  const without = await noGuide.get(listed[0], {});
  check('injectToolGuide=false 时不注入', !without.content.includes('本插件提供的编排与工具'));
  check('关闭注入后正文仍非空', without.content.length > 500);
}

section('A2 配置：enabledSkills 筛选与未知名校验');
{
  const only = createSkillProvider({ assetRoot: ASSET_ROOT, enabledSkills: ['aigc-review-reduction'] });
  const subset = await only.list();
  check('enabledSkills 只启用指定技能', subset.length === 1 && subset[0].name === 'aigc-review-reduction');

  let threw = false;
  try {
    createSkillProvider({ assetRoot: ASSET_ROOT, enabledSkills: ['no-such-skill'] });
  } catch (error) {
    threw = /unknown skills/.test(error.message);
  }
  check('未知技能名抛错', threw);
}

section('启动期严格校验：坏 assetRoot 必须快速失败');
{
  let msg = '';
  try {
    validateAssets('C:\\definitely\\not\\here');
  } catch (error) {
    msg = error.message;
  }
  check('不存在的 assetRoot 抛错且信息可操作', /cannot read|incomplete/.test(msg), msg);

  let relMsg = '';
  try {
    validateAssets('relative/path');
  } catch (error) {
    relMsg = error.message;
  }
  check('相对路径 assetRoot 抛错', /absolute/.test(relMsg), relMsg);
}

// ---------------------------------------------------------------- 解析器
section('parseSkill / parseTrailingJson');
{
  const parsed = parseSkill('---\nname: x\ndescription: hello\n---\n\nbody\n', 'x');
  check('parseSkill 取出 description', parsed.description === 'hello');
  check('parseSkill 去掉 frontmatter', parsed.content === 'body');

  let threw = false;
  try {
    parseSkill('no frontmatter', 'x');
  } catch {
    threw = true;
  }
  check('无 frontmatter 抛错', threw);

  check('提取尾部 JSON', parseTrailingJson('log line\n{"a":1}')?.a === 1);
  check('跳过内层花括号的干扰', parseTrailingJson('x {"note":"{","a":2}')?.a === 2);
  check('无 JSON 返回 undefined', parseTrailingJson('plain text') === undefined);
}

// ---------------------------------------------------------------- A4 子进程链路
section('A4 子进程链路：解析两条 Python 链');
let bundled = null;
try {
  bundled = resolveBundledPython({});
  check('找到随包 Python', existsSync(bundled.path), bundled.path);
  check('随包 Python 来源可追溯', typeof bundled.source === 'string' && bundled.source.length > 0, bundled.source);
} catch (error) {
  check('找到随包 Python', false, error.message);
}

let render = null;
try {
  render = resolveRenderPython({});
  check('找到渲染链 Python', existsSync(render.path), render.path);
} catch (error) {
  warn(`未找到渲染链 Python：${error.message}`);
}

section('A4 子进程链路：经受管 seam 跑通随包 Python');
if (bundled !== null) {
  const result = await runPythonInline(ctx, PROBE_PROGRAM, { pythonPath: bundled.path });
  check('退出码为 0', result.exitCode === 0, `exitCode=${result.exitCode} stderr=${result.stderr?.slice(0, 300)}`);
  check('走到了受管 seam（非 node 回退）', result.seam === 'subprocess', `实际 ${result.seam}`);
  check('拿到结构化 JSON', result.json !== undefined);
  check('检测到 python-docx', result.json?.hasDocx === true);
  check('stdout 编码为 UTF-8', /utf-?8/i.test(result.json?.stdoutEncoding ?? ''), String(result.json?.stdoutEncoding));
  check('随包链无 pywin32（预期）', result.json?.hasPywin32 === false);

  const call = ctx.spawnCalls.at(-1);
  check('spawn 请求带 argv', Array.isArray(call?.argv) && call.argv.length === 3 && call.argv[1] === '-c');
  check(
    'spawn 请求带必填 cwd（回归守卫：缺 cwd 会同步抛错）',
    typeof call?.cwd === 'string' && call.cwd.length > 0,
    String(call?.cwd)
  );
  check('spawn 请求带 graceMs', typeof call?.graceMs === 'number' && call.graceMs > 0);
  check('spawn 请求带 stdio 三路定义', call?.stdio?.stdin === 'ignore' && call?.stdio?.stdout?.maxBytes > 0);
  check('spawn 请求注入 UTF-8 环境', call?.env?.PYTHONUTF8 === '1' && call?.env?.PYTHONIOENCODING === 'utf-8');
  check('spawn 请求带 abort signal', call?.hasSignal === true);
}

if (render !== null) {
  const result = await runPythonInline(ctx, PROBE_PROGRAM, { pythonPath: render.path });
  check('渲染链可执行', result.exitCode === 0, `exitCode=${result.exitCode}`);
  check('渲染链有 pywin32', result.json?.hasPywin32 === true);
  const sameDocx = result.json?.docxVersion === undefined || true;
  if (sameDocx) {
    console.log(`  INFO  渲染链 python-docx = ${result.json?.docxVersion}`);
  }
}

section('A4 中文输出不被编码破坏（UTF-8 端到端）');
if (bundled !== null) {
  const result = await runPythonInline(ctx, 'import json; print(json.dumps({"t":"中文测试·箭头→"}, ensure_ascii=False))', {
    pythonPath: bundled.path
  });
  check('中文原样取回', result.json?.t === '中文测试·箭头→', JSON.stringify(result.json));
}

section('A4 超时与错误语义');
if (bundled !== null) {
  const result = await runPythonInline(ctx, 'while True: pass', { pythonPath: bundled.path, timeoutMs: 3000 });
  check('超时被标记', result.timedOut === true);
  check('超时不抛裸错误', result !== undefined);

  const bad = await runPythonInline(ctx, 'raise SystemExit(3)', { pythonPath: bundled.path });
  check('非零退出码可读回', bad.exitCode === 3, `exitCode=${bad.exitCode}`);
}

section('A4 受管 seam 缺席时显式降级');
{
  const noSeamCtx = { get: () => undefined };
  const result = await runPythonInline(noSeamCtx, 'print(1)', {
    pythonPath: bundled?.path ?? 'python'
  });
  check('降级到 node:child_process 且标注 seam=node', result.seam === 'node', `实际 ${result.seam}`);
}

// ---------------------------------------------------------------- sc_doctor 体检
section('sc_doctor 体检逻辑（doctor-core，真机环境）');
{
  const { runDoctor, formatDoctor, countFiles } = await import('../lib/tools/doctor-core.js');
  const report = await runDoctor(ctx, { assetRoot: ASSET_ROOT, config: {} });

  check('产出结构化报告', typeof report === 'object' && Array.isArray(report.warnings));
  check('生成/校验链可用', report.bundledPython.ok === true, JSON.stringify(report.bundledPython).slice(0, 240));
  check('生成链检测到 python-docx', report.bundledPython.hasDocx === true);
  check(
    '生成链 stdout 编码为 UTF-8',
    /utf-?8/i.test(report.bundledPython.stdoutEncoding ?? ''),
    String(report.bundledPython.stdoutEncoding)
  );
  check('渲染链 pywin32 可用', report.renderPython.hasPywin32 === true);
  check('探知到受管 subprocess seam', report.subprocessSeam === true);
  check(
    '技能资产完整（>40 文件）',
    report.assets.ok === true && report.assets.totalFiles > 40,
    `totalFiles=${report.assets.totalFiles}`
  );
  check('四个技能都在报告里', report.assets.skills.length === 4);
  check('整体判定 ok', report.ok === true, report.warnings.join(' | '));
  check(
    '渲染链 playwright 状态被探知',
    typeof report.renderPython.hasPlaywright === 'boolean',
    String(report.renderPython.hasPlaywright)
  );
  if (report.renderPython.hasPlaywright === true) {
    console.log(
      '  INFO  渲染链已装 playwright → 界面图集「真实运行截图」可直接走渲染链，无需 bsk、无需新装（Q8）'
    );
  } else {
    check('playwright 缺失被记录为警告', report.warnings.some((w) => /playwright/.test(w)));
  }

  check(
    'CHAINS: generate 链解析到随包 Python',
    resolvePythonForChain({}, CHAINS.generate).path === report.bundledPython.path
  );
  check(
    'CHAINS: render 链解析到渲染 Python',
    resolvePythonForChain({}, CHAINS.render).path === report.renderPython.path
  );

  const text = formatDoctor(report);
  check('渲染文本含两条链段落', text.includes('生成/校验链') && text.includes('渲染链'));
  check('渲染文本含资产明细', text.includes('python-software-delivery'));
  check('渲染文本含结论行', text.includes('结论：'));

  const counts = countFiles(join(ASSET_ROOT, 'python-software-delivery'));
  check('countFiles 统计到文件与字节', counts.files > 10 && counts.bytes > 1000, JSON.stringify(counts));
}

// ---------------------------------------------------------------- 汇总
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
