/**
 * M4 端到端 harness：在**真实 docx + 真实脚本链**上验证四处口径审计。
 *
 * 为什么需要它：`sc_audit` 的 docx 读取（内联 python 程序 + 封面数字解析）从来没在
 * 真机上跑过 —— 之前的 parser harness 只喂合成字符串。这里用真机生成的 docx 验证。
 *
 * 用法：node test/e2e-fixture.mjs <fixture项目根>
 * 前置：tools/make-sc-fixture.py 已生成 fixture，且已跑过 sc_source action=gen-doc。
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');
const FIXTURE = process.argv[2] ?? join(PLUGIN_ROOT, '..', '..', '_fixture', 'scdemo');
const PYTHON =
  'E:\\Users\\L\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\dependencies\\python\\python.exe';

const { auditFourWay, collectSourceStats, countSourceLines } = await import(
  pathToFileURL(join(PLUGIN_ROOT, 'lib', 'audit', 'consistency.js')).href
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

/** 形状替身：用 node:child_process 实现 ctx.subprocess 的契约。 */
function makeCtx() {
  const services = {
    subprocess: {
      async resolveExecutable(p) {
        return p;
      },
      spawn(spec) {
        const child = spawn(spec.argv[0], spec.argv.slice(1), {
          cwd: spec.cwd,
          env: { ...process.env, ...(spec.env ?? {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        });
        const bufs = { stdout: [], stderr: [] };
        child.stdout.on('data', (d) => bufs.stdout.push(d));
        child.stderr.on('data', (d) => bufs.stderr.push(d));
        const terminate = () => {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
        };
        if (spec.signal) {
          if (spec.signal.aborted) terminate();
          else spec.signal.addEventListener('abort', terminate, { once: true });
        }
        const done = new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
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
          terminate,
          waitForExit: () => done
        };
      }
    }
  };
  return { get: (n) => services[n] };
}

console.log('dsh-skill-softcopyright —— M4 端到端 harness（真实 docx）');
console.log(`fixture : ${FIXTURE}`);

const SRC = join(FIXTURE, 'src');
const DOCS = join(FIXTURE, 'docs');
const sourceDoc = join(DOCS, '演示软件源代码文档.docx');

console.log('\n=== 前置检查 ===');
check('fixture src 存在', existsSync(SRC));
check('源代码文档 docx 存在（需先跑 sc_source gen-doc）', existsSync(sourceDoc), sourceDoc);
if (!existsSync(sourceDoc)) {
  console.log('\n缺少 docx，先运行 sc_source action=gen-doc 再跑本 harness。');
  process.exit(1);
}

console.log('\n=== 源程序目录统计（与脚本口径对照） ===');
const tree = collectSourceStats(SRC, { includeExt: ['.py'], excludeDirs: ['__pycache__'], keepInitPy: true });
check('统计到 4 个源文件', tree.files === 4, String(tree.files));
check('代码行数与 gen_src_docx 一致（50）', tree.lines === 50, String(tree.lines));

console.log('\n=== auditFourWay：读真实 docx 封面 ===');
const ctx = makeCtx();
const result = await auditFourWay(ctx, {
  projectRoot: FIXTURE,
  sourceDir: SRC,
  sourceRules: { includeExt: ['.py'], excludeDirs: ['__pycache__'], keepInitPy: true },
  docs: { sourceDoc },
  pythonPath: PYTHON,
  timeoutMs: 60000
});

console.log(`  摘要: ${result.summary}`);
for (const [key, obs] of Object.entries(result.observations)) {
  console.log(`  ${key}: ${obs.error ?? (obs.missing ? 'missing' : `files=${obs.files ?? '?'} lines=${obs.lines ?? '?'}`)}`);
}

check('源程序目录口径 = 4/50', result.observations.sourceTree.files === 4 && result.observations.sourceTree.lines === 50);
check('源代码文档封面被成功读取（不是 missing）', result.observations.sourceDocCover?.missing !== true);
check('封面无读取错误', result.observations.sourceDocCover?.error === undefined, result.observations.sourceDocCover?.error);
check(
  '★ 封面解析出 4 个源文件 / 50 行（与源程序目录一致）',
  result.observations.sourceDocCover?.files === 4 && result.observations.sourceDocCover?.lines === 50,
  JSON.stringify(result.observations.sourceDocCover)
);
check('封面原文声明被记录', typeof result.observations.sourceDocCover?.declared === 'string', result.observations.sourceDocCover?.declared);

console.log('\n' + '='.repeat(60));
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
for (const f of failures) console.log(`  x ${f}`);
console.log('='.repeat(60));
process.exit(failures.length === 0 ? 0 : 1);
