/**
 * 静态守卫：`ctx.<name>` 属性访问必须在 `inject` 里，否则 cordis 会**直接抛错**。
 *
 * ## 为什么需要这个测试
 *
 * M3 上线后整插件 `fiberPhase: failed` —— 根因是 `lib/commands.js` 写了
 * `ctx.commands?.register`，而 cordis 对**未 inject 的服务**，属性访问本身就抛：
 *
 *     Error: cannot get property "commands" without inject
 *
 * 可选链救不了（getter 先抛）。代价：技能 + 8 个工具 + 命令**一起被回滚**，
 * 排查花了三轮重启（先排除四个候选、写三个探针都没命中，最后靠启动日志才定位）。
 *
 * 这种错**完全可以在提交前静态查出来** —— 就是这个文件的作用。
 *
 * ## 两个必须做到的细节（否则守卫本身不可信）
 *
 * 1. **剥掉注释**：第一版没剥，结果 3 处命中全在文档注释里（`ctx.shell`、`ctx.commands` 的
 *    说明文字）。会误报的守卫最终会被忽略 —— 所以必须先剥注释再扫。
 * 2. **自测**：守卫必须证明自己**真的能抓到**违规，否则它可能只是"空转通过"。
 *    因此下面用合成代码片段对它做正反用例。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');
const LIB = join(PLUGIN_ROOT, 'lib');

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
 * 允许用属性访问的名字。
 * 每一项都必须给出理由 —— 白名单是"声明一个例外"，不是"消掉一条告警"。
 */
const ALLOWED = new Map([
  ['logger', 'cordis Context 内置的 logger，不是服务，无需 inject'],
  ['get', 'ctx.get(name) 是**可选服务**的正确访问方式（返回 undefined 而不抛错）'],
  ['plugin', 'cordis Context 自身的插件加载 API'],
  ['effect', 'cordis 的 effect 注册 API'],
  ['inject', 'cordis 的 inject API'],
  ['scope', 'cordis 的 scope API'],
  ['emit', 'cordis 事件发射'],
  ['on', 'cordis 事件监听'],
  ['fiber', 'cordis 的 fiber 句柄'],
  ['root', 'cordis 根上下文引用'],
  [
    'subprocess',
    'lib/runtime.js 的**回退分支**专用：写成 `typeof ctx?.get === "function" ? ctx.get("subprocess") : ctx?.subprocess`。' +
      '真实 cordis ctx 一定有 get，因此走 ctx.get；只有 mock ctx 才走到属性访问'
  ]
]);

/**
 * 把注释内容替换成空格（**保留换行**，这样行号不变）。
 *
 * 只处理块注释与行注释，并在字符串字面量内跳过；不处理正则字面量
 * （`/a\/b/` 这类里出现 `//` 的极端情况会误判，本仓库无此写法）。
 */
function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        if (text[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          out += quote;
          i += 1;
          break;
        }
        out += text[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < n && text[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 匹配 `ctx.name` 与 `ctx?.name`。 */
const ACCESS_RE = /\bctx\??\.([A-Za-z_$][\w$]*)/g;

/**
 * 扫一段源码，返回 `{ seen, violations }`。
 * @param text - 源码文本（内部会先剥注释）。
 * @param injected - 插件声明的 inject 集合。
 */
function scan(text, injected) {
  const code = stripComments(text);
  const seen = new Map();
  const violations = [];
  for (const match of code.matchAll(ACCESS_RE)) {
    const name = match[1];
    const line = code.slice(0, match.index).split('\n').length;
    if (!seen.has(name)) seen.set(name, []);
    seen.get(name).push(line);
    if (!injected.has(name) && !ALLOWED.has(name)) violations.push({ name, line });
  }
  return { seen, violations };
}

function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(path);
  }
  return out;
}

console.log('dsh-skill-softcopyright —— ctx 属性访问静态守卫');

const mod = await import(pathToFileURL(join(LIB, 'index.js')).href);
const injected = new Set(mod.inject ?? []);
console.log(`\n插件 inject = [${[...injected].join(', ')}]`);

// ---------------------------------------------------------------- 守卫自测
console.log('\n=== 守卫自测（证明它真的能抓、且不误报）===');
{
  const cases = [
    ['真实违规被抓住', 'const r = ctx.commands.register({});', true, 'commands'],
    ['可选链违规也被抓住（M3 的真实写法）', 'if (typeof ctx.commands?.register !== "function") return;', true, 'commands'],
    ['ctx?.name 违规被抓住', 'const x = ctx?.shell;', true, 'shell'],
    ['行注释里的不算', '// ctx.commands 是陷阱\nconst x = 1;', false],
    ['块注释里的不算', '/* ctx.shell 只接受命令行 */\nconst x = 1;', false],
    ['JSDoc 里的不算', '/**\n * 用 ctx.commands 会抛错\n */\nconst x = 1;', false],
    ['已 inject 的不算', 'ctx.skills.registerProvider(f);', false],
    ['ctx.get 不算', 'const s = ctx.get("subprocess");', false],
    ['字符串里的不算（剥字符串内容）', 'const s = "ctx.commands";', false],
    ['白名单 subprocess 不算', 'const s = ctx?.subprocess;', false]
  ];
  for (const [label, source, shouldViolate, expectedName] of cases) {
    const { violations } = scan(source, injected);
    const ok = shouldViolate
      ? violations.length === 1 && violations[0].name === expectedName
      : violations.length === 0;
    check(`自测：${label}`, ok, JSON.stringify(violations));
  }
}

// ---------------------------------------------------------------- 真实扫描
console.log('\n=== 扫描 lib/ ===');
const allSeen = new Map();
const allViolations = [];
for (const file of collectFiles(LIB)) {
  const rel = relative(PLUGIN_ROOT, file).replace(/\\/g, '/');
  const { seen, violations } = scan(readFileSync(file, 'utf8'), injected);
  for (const [name, lines] of seen) {
    if (!allSeen.has(name)) allSeen.set(name, []);
    for (const line of lines) allSeen.get(name).push(`${rel}:${line}`);
  }
  for (const v of violations) allViolations.push(`${v.name} @ ${rel}:${v.line}`);
}

for (const [name, places] of [...allSeen.entries()].sort()) {
  const status = injected.has(name) ? 'inject' : ALLOWED.has(name) ? '白名单' : '★ 违规';
  console.log(
    `  ${name.padEnd(14)} ${status.padEnd(8)} ${places.slice(0, 3).join(', ')}${places.length > 3 ? ` …共 ${places.length} 处` : ''}`
  );
}

console.log('\n=== 断言 ===');
check('扫描到了 lib 下的源码', allSeen.size > 0);
check(
  '没有未 inject 的服务属性访问（M3 根因的整类守卫）',
  allViolations.length === 0,
  allViolations.join('; ')
);
check(
  'inject 含 skills / systemPrompt / tools',
  ['skills', 'systemPrompt', 'tools'].every((s) => injected.has(s))
);
check('★ 代码里没有 ctx.commands（M3 直接根因）', !allSeen.has('commands'), (allSeen.get('commands') ?? []).join(', '));
check('commands 只经 ctx.get 访问', allSeen.has('get'));
check(
  '每个白名单项都写了理由（白名单不是消音器）',
  [...ALLOWED.values()].every((reason) => typeof reason === 'string' && reason.length >= 8)
);

console.log('\n' + '='.repeat(64));
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
for (const f of failures) console.log(`  x ${f}`);
console.log('='.repeat(64));
process.exit(failures.length === 0 ? 0 : 1);
