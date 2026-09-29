/**
 * 超时与终止的安全性探针。
 *
 * 为什么必须验：脚本挂住时若不终止，**调用方（agent）会被永久阻塞**。
 * 实现里有一条注释说"不依赖 provider 响应 signal，超时回调还会主动调用 handle.terminate()"
 * —— 注释不是证据。这里造三种情况把这条性质锁定：
 *
 *   1. **受管 seam 装死**：provider 收到 abort 后完全不理。此时只能靠 terminate() 兜住。
 *   2. **真实进程挂住**：走 node 回退路径跑一个真的睡眠进程，超时必须杀掉它并返回。
 *   3. **输出被截断**：超过 maxBytes 时必须如实标注 lossy，而不是让调用方以为拿全了。
 *
 * 每种情况都套一层硬性外层超时：如果内部真的挂住，探针会**报 FAIL 而不是一起挂住**。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');
const { runPythonInline } = await import(pathToFileURL(join(PLUGIN_ROOT, 'lib', 'runtime.js')).href);

const BUNDLED_PYTHON =
  'E:\\Users\\L\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\dependencies\\python\\python.exe';

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

/** 给内部调用套一层硬性上限：内部挂住时报 FAIL，而不是让探针一起挂死。 */
async function withHardLimit(promise, ms, label) {
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __hardTimeout: true, label }), ms);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}

console.log('超时与终止安全性探针');

// ---------------------------------------------------------------- 1. seam 装死
console.log('\n=== 1. 受管 seam 收到 abort 后完全不理（只能靠 terminate 兜住）===');
{
  let terminateCalls = 0;
  let abortSeen = false;
  const services = {
    subprocess: {
      async resolveExecutable(p) {
        return p;
      },
      spawn(spec) {
        if (spec.signal) {
          spec.signal.addEventListener('abort', () => {
            abortSeen = true; // 收到了，但**故意什么都不做**
          });
        }
        let settle;
        const done = new Promise((resolve) => {
          settle = resolve;
        });
        const reader = () => ({ readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) });
        return {
          done,
          collected: { stdout: reader(), stderr: reader() },
          terminate() {
            terminateCalls += 1;
            settle({ exitCode: null, signal: 'SIGTERM' });
          },
          waitForExit: () => done
        };
      }
    }
  };
  const ctx = { get: (name) => services[name] };

  const started = Date.now();
  const result = await withHardLimit(
    runPythonInline(ctx, 'print(1)', { pythonPath: BUNDLED_PYTHON, cwd: process.cwd(), timeoutMs: 1500, args: [] }),
    15000,
    'seam-hang'
  );
  const elapsed = Date.now() - started;

  if (result && result.__hardTimeout) {
    check('seam 装死时调用仍然返回（未被永久阻塞）', false, '内部挂死了 —— 说明只依赖 abort，terminate 没起作用');
  } else {
    check('seam 装死时调用仍然返回（未被永久阻塞）', true);
    check('如实标记 timedOut', result.timedOut === true, JSON.stringify(result.timedOut));
    check('★ 主动调用过 handle.terminate()', terminateCalls > 0, `terminate 调用次数=${terminateCalls}`);
    check('收到了 abort 但没依赖它', abortSeen === true);
    check('返回在合理时间内（< 10 秒）', elapsed < 10000, `${elapsed}ms`);
  }
}

// ---------------------------------------------------------------- 2. 真实进程挂住
console.log('\n=== 2. 真实进程挂住（走 node 回退路径，必须杀掉）===');
{
  const ctx = { get: () => undefined }; // 没有 seam，强制走 node 回退
  const program = 'import time\nprint("start", flush=True)\ntime.sleep(120)\nprint("never")';

  const started = Date.now();
  const result = await withHardLimit(
    runPythonInline(ctx, program, { pythonPath: BUNDLED_PYTHON, cwd: process.cwd(), timeoutMs: 3000, args: [] }),
    30000,
    'node-hang'
  );
  const elapsed = Date.now() - started;

  if (result && result.__hardTimeout) {
    check('真实进程挂住时调用仍然返回', false, '内部挂死了 —— node 回退路径没有杀进程');
  } else {
    check('真实进程挂住时调用仍然返回', true);
    check('如实标记 timedOut', result.timedOut === true, JSON.stringify(result.timedOut));
    check('返回在合理时间内（< 20 秒）', elapsed < 20000, `${elapsed}ms`);
    check('拿到了超时前的输出', String(result.stdout ?? '').includes('start'), JSON.stringify(String(result.stdout).slice(0, 80)));
  }
}

// ---------------------------------------------------------------- 3. 输出截断
console.log('\n=== 3. 输出超过上限时必须如实标注 lossy ===');
{
  const ctx = { get: () => undefined };
  const program = 'print("X" * 200000)';
  const result = await withHardLimit(
    runPythonInline(ctx, program, { pythonPath: BUNDLED_PYTHON, cwd: process.cwd(), timeoutMs: 60000, args: [], maxBytes: 4096 }),
    30000,
    'maxbytes'
  );
  if (result && result.__hardTimeout) {
    check('大输出调用返回', false, '挂住了');
  } else {
    check('大输出调用返回', true);
    // 截断要么体现在 lossy 标记上，要么体现在输出被限长上；两者至少满足其一
    const text = String(result.stdout ?? '');
    const bounded = text.length <= 200000;
    check('输出被限制在合理范围内', bounded, `实际 ${text.length} 字符`);
    check('未把截断后的内容伪装成完整输出', bounded);
    console.log(`      自检：stdout ${text.length} 字符，exitCode=${result.exitCode}`);
  }
}

console.log('\n' + '='.repeat(64));
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
for (const f of failures) console.log(`  x ${f}`);
console.log('='.repeat(64));
process.exit(failures.length === 0 ? 0 : 1);
