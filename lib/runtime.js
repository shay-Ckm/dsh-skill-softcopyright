/**
 * dsh-skill-softcopyright — L1 运行时适配层
 *
 * 解决三件事：
 *  1. **Python 在哪** —— 两条链（生成/校验链走随包 Python，渲染链走带 pywin32 的
 *     系统 Python），见设计文档 §5.2。
 *  2. **怎么跑子进程** —— 优先走 DSH 受管 seam `ctx.subprocess`，而不是裸
 *     `node:child_process`：受管 seam 有界收集输出、托管进程组、可终止、且不依赖
 *     受限模式下可能被拒的管道 stdio。
 *  3. **编码** —— Windows 上 Python 默认用 cp936 写 stdout，中文会乱码；显式注入
 *     `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`。
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Python 子进程的固定环境：保证 UTF-8 输出与不缓冲。 */
export const PYTHON_ENV = Object.freeze({
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
  PYTHONUNBUFFERED: '1'
});

/** 默认渲染链（已实测，见设计文档 §0.2）。 */
export const DEFAULT_RENDER_PYTHON = 'C:\\Python314\\python.exe';

/** 判断一个路径是否是可执行的普通文件。 */
export function isExecutableFile(path) {
  if (typeof path !== 'string' || path.length === 0) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * 定位随包 Python（生成/校验链）。
 *
 * 优先级链刻意不猜"系统 python"，也不 pip install —— 与官方 office 技能的纪律一致。
 *
 * @returns { path, source } —— source 说明它是怎么被找到的，便于诊断。
 * @throws 找不到时抛出带可操作指引的错误。
 */
export function resolveBundledPython(config = {}) {
  const explicit = config.pythonPath;
  if (explicit) {
    if (!isExecutableFile(explicit)) {
      throw new Error(
        `softcopyright: runtime.pythonPath is set to "${explicit}" but that is not a readable file`
      );
    }
    return { path: explicit, source: 'config.pythonPath' };
  }

  const candidates = [];

  // 1) 环境变量指示的 primary runtime payload
  const fromEnv = process.env.DSH_PRIMARY_RUNTIME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    candidates.push([join(fromEnv, 'dependencies', 'python', 'python.exe'), 'DSH_PRIMARY_RUNTIME']);
    candidates.push([join(fromEnv, 'python', 'python.exe'), 'DSH_PRIMARY_RUNTIME']);
  }

  // 2) Electron 打包形态：<resources>/runtime/primary-runtime/...
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    candidates.push([
      join(process.resourcesPath, 'runtime', 'primary-runtime', 'dependencies', 'python', 'python.exe'),
      'process.resourcesPath'
    ]);
  }

  // 3) 已安装到 Harness home 的 payload
  const dshHome = process.env.DSH_HOME;
  if (typeof dshHome === 'string' && dshHome.length > 0) {
    candidates.push([
      join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
      'DSH_HOME/dsh-runtimes'
    ]);
  }

  for (const [path, source] of candidates) {
    if (isExecutableFile(path)) return { path, source };
  }

  throw new Error(
    'softcopyright: cannot locate the bundled Python runtime. Tried: ' +
      (candidates.length === 0
        ? '(no candidate paths — DSH_PRIMARY_RUNTIME / process.resourcesPath / DSH_HOME are all unset)'
        : candidates.map(([p, s]) => `${p} (${s})`).join('; ')) +
      '. Fix: set runtime.pythonPath in the softcopyright settings section to an absolute python.exe path.'
  );
}

/**
 * 定位渲染链 Python（需要 pywin32 + Word）。
 * @returns { path, source }
 */
export function resolveRenderPython(config = {}) {
  const explicit = config.renderPythonPath;
  if (explicit) {
    if (!isExecutableFile(explicit)) {
      throw new Error(
        `softcopyright: runtime.renderPythonPath is set to "${explicit}" but that is not a readable file`
      );
    }
    return { path: explicit, source: 'config.renderPythonPath' };
  }
  if (isExecutableFile(DEFAULT_RENDER_PYTHON)) {
    return { path: DEFAULT_RENDER_PYTHON, source: 'default' };
  }
  throw new Error(
    `softcopyright: the render Python (needs pywin32 + Microsoft Word) was not found at the default ` +
      `"${DEFAULT_RENDER_PYTHON}". Real page counts and docx→PDF require it. ` +
      `Fix: set runtime.renderPythonPath to a python.exe that can \`import win32com.client\`.`
  );
}

/**
 * 两条链的名字。
 *
 * 用途由脚本的实际依赖决定（实测，见设计文档 §0.2/§0.4）：
 *  - `generate` 随包 Python —— 生成与校验 docx、打包、哈希。依赖冻结，可复现。
 *  - `render`   系统 Python（C:\Python314）—— Word COM 取真实页数、docx→PDF，
 *               以及 Playwright 真实界面截图（该链已装 playwright 1.62.0 + chromium）。
 */
export const CHAINS = Object.freeze({ generate: 'generate', render: 'render' });

/**
 * 按链名解析解释器。工具层按 action 选择链，而不是统一用一个解释器 ——
 * 用错链的表现是"脚本 import 失败"，归因成本很高，所以在解析层就分清。
 */
export function resolvePythonForChain(config, chain = CHAINS.generate) {
  return chain === CHAINS.render ? resolveRenderPython(config) : resolveBundledPython(config);
}

/** 从输出文本里取出最后一个 JSON 对象。脚本被允许在 JSON 之前打印人类可读日志。 */export function parseTrailingJson(text) {
  if (typeof text !== 'string') return undefined;
  const end = text.lastIndexOf('}');
  if (end < 0) return undefined;
  // 从末尾往前找配对的开括号，跳过字符串里的括号由 JSON.parse 兜底。
  for (let start = text.lastIndexOf('{', end); start >= 0; start = text.lastIndexOf('{', start - 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* 继续往前找 */
    }
  }
  return undefined;
}

/** 把受管 handle 的 collected 流读成文本。 */
function readCollected(handle, channel) {
  const stream = handle?.collected?.[channel];
  if (stream === undefined) return '';
  const slice = stream.readFrom(0);
  return typeof slice === 'string' ? slice : (slice?.text ?? '');
}

/**
 * 定位随包 Node（技能里的 `check_inline_js.js` 需要它）。
 *
 * 刻意不用 `process.execPath`：在 DSH Desktop 里那是 electron.exe，直接跑 `.js`
 * 需要 ELECTRON_RUN_AS_NODE 之类的额外条件，不可靠。优先用 payload 里的 Node。
 */
export function resolveBundledNode(config = {}) {
  const explicit = config.nodePath;
  if (explicit) {
    if (!isExecutableFile(explicit)) {
      throw new Error(
        `softcopyright: runtime.nodePath is set to "${explicit}" but that is not a readable file`
      );
    }
    return { path: explicit, source: 'config.nodePath' };
  }

  const suffix = join('dependencies', 'node', 'bin', 'node.exe');
  const candidates = [];
  const fromEnv = process.env.DSH_PRIMARY_RUNTIME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    candidates.push([join(fromEnv, suffix), 'DSH_PRIMARY_RUNTIME']);
  }
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    candidates.push([
      join(process.resourcesPath, 'runtime', 'primary-runtime', suffix),
      'process.resourcesPath'
    ]);
  }
  const dshHome = process.env.DSH_HOME;
  if (typeof dshHome === 'string' && dshHome.length > 0) {
    candidates.push([
      join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', suffix),
      'DSH_HOME/dsh-runtimes'
    ]);
  }
  for (const [path, source] of candidates) {
    if (isExecutableFile(path)) return { path, source };
  }
  throw new Error(
    'softcopyright: cannot locate the bundled Node runtime. Tried: ' +
      candidates.map(([p, s]) => `${p} (${s})`).join('; ') +
      '. Fix: set runtime.nodePath to an absolute node.exe path.'
  );
}

/**
 * 建立一个自管超时。
 *
 * 不依赖 provider 响应 `signal` 来终止子进程：abort 信号只是"请终止"，provider 实现
 * 可能有延迟或遗漏。因此超时回调**在 abort 之外还会主动调用 handle.terminate()**，
 * 双保险确保长时间运行的脚本不会挂死调用方。handle 在 spawn 之后才存在，故用闭包
 * 捕获一个可变引用。
 *
 * @returns { arm(handle), dispose(), isTimedOut() }
 */
function createTimeout(timeoutMs, controller) {
  let handle;
  let timedOut = false;
  const terminate = () => {
    try {
      handle?.terminate?.();
    } catch {
      /* 终止失败不掩盖超时本身 */
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`timed out after ${timeoutMs}ms`));
    terminate();
  }, timeoutMs);
  return {
    arm(value) {
      handle = value;
      // 极端情况：spawn 返回前就已超时，此时立即终止。
      if (timedOut) terminate();
    },
    dispose() {
      clearTimeout(timer);
    },
    isTimedOut: () => timedOut
  };
}

/**
 * 跑一次 Python 脚本并收集输出。
 *
 * 优先使用 `ctx.subprocess`（DSH 受管 seam）。若该服务未挂载，退回
 * `node:child_process.execFile` 并在结果里标注 `seam: 'node'`，让降级可见而非静默。
 *
 * @param ctx - cordis 上下文。
 * @param spec.script - 脚本绝对路径。
 * @param spec.args - 追加的 argv 元素。
 * @param spec.cwd - 子进程工作目录。
 * @param spec.signal - AbortSignal。
 * @param spec.timeoutMs - 超时；到期走 handle.terminate() / child.kill()。
 * @param spec.maxBytes - 单流输出上限，默认 4 MiB。
 * @param spec.pythonPath - 显式解释器路径，默认解析随包 Python。
 * @param spec.config - runtime 配置段。
 * @returns { exitCode, signal, stdout, stderr, json, seam, timedOut }
 */
export async function runPython(ctx, spec) {
  const {
    script,
    args = [],
    cwd,
    signal,
    timeoutMs = 60000,
    maxBytes = 4 * 1024 * 1024,
    pythonPath,
    chain = CHAINS.generate,
    config = {}
  } = spec;

  if (typeof script !== 'string' || script.length === 0) {
    throw new Error('softcopyright: runPython requires a script path');
  }
  if (!isExecutableFile(script)) {
    throw new Error(`softcopyright: script not found: ${script}`);
  }

  const python = pythonPath ?? resolvePythonForChain(config, chain).path;
  const argv = [python, script, ...args.map(String)];

  // 自管超时：受管 seam 只有 graceMs（终止宽限），没有 timeout 语义。
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timeout = createTimeout(timeoutMs, controller);
  let seamError;

  try {
    const subprocess = typeof ctx?.get === 'function' ? ctx.get('subprocess') : ctx?.subprocess;

    if (subprocess !== undefined && typeof subprocess.spawn === 'function') {
     try {
      const program =
        typeof subprocess.resolveExecutable === 'function'
          ? await subprocess.resolveExecutable(python)
          : python;

      const handle = subprocess.spawn({
        argv: [program, script, ...args.map(String)],
        // `cwd` 在 SubprocessSpawnSpec 里是**必填**的（不是可选）：缺省会同步抛错。
        cwd: cwd ?? process.cwd(),
        env: PYTHON_ENV,
        graceMs: 10000,
        signal: controller.signal,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes },
          stderr: { maxBytes }
        }
      });
      timeout.arm(handle);

      let exitCode;
      let exitSignal;
      try {
        const outcome = await handle.done;
        exitCode = outcome?.exitCode ?? null;
        exitSignal = outcome?.signal ?? null;
      } catch (error) {
        // 超时主动终止后，done 可能以拒绝收场；仍尽量把已收集的输出读出来。
        if (!timeout.isTimedOut()) throw error;
        exitCode = null;
        exitSignal = null;
      }
      const timedOut = timeout.isTimedOut();

      const stdout = readCollected(handle, 'stdout');
      const stderr = readCollected(handle, 'stderr');
      return {
        exitCode: timedOut ? null : exitCode,
        signal: exitSignal,
        stdout,
        stderr,
        json: parseTrailingJson(stdout),
        seam: 'subprocess',
        timedOut
      };
     } catch (error) {
       // 受管 seam 存在但调用失败：**不要静默降级**成 node 结果，否则真实原因被吞掉。
       seamError = error;
     }
    }

    if (seamError !== undefined) {
      const message = seamError?.message ?? String(seamError);
      return {
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: `softcopyright: the managed subprocess seam failed: ${message}`,
        json: undefined,
        seam: 'subprocess',
        seamFailed: true,
        error: message,
        timedOut: timeout.isTimedOut()
      };
    }

    // 退回 node:child_process。受限模式下管道 stdio 可能被拒，故把降级显式暴露出来。
    const { stdout, stderr } = await execFileAsync(argv[0], argv.slice(1), {
      cwd,
      env: { ...process.env, ...PYTHON_ENV },
      timeout: timeoutMs,
      maxBuffer: maxBytes,
      windowsHide: true,
      signal: controller.signal
    });
    return {
      exitCode: 0,
      signal: null,
      stdout,
      stderr,
      json: parseTrailingJson(stdout),
      seam: 'node',
      timedOut: timeout.isTimedOut()
    };
  } catch (error) {
    if (typeof error?.stdout === 'string' || typeof error?.stderr === 'string') {
      // execFile 非零退出：把输出交给调用方判断，而不是抛裸错误。
      return {
        exitCode: typeof error.code === 'number' ? error.code : 1,
        signal: null,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
        json: parseTrailingJson(error.stdout ?? ''),
        seam: 'node',
        timedOut: timeout.isTimedOut()
      };
    }
    throw error;
  } finally {
    timeout.dispose();
    if (signal !== undefined) signal.removeEventListener?.('abort', onAbort);
  }
}

/**
 * 体检：两条 Python 链的能力核对。
 *
 * 用一个内联 `-c` 程序探测每个解释器，返回结构化结论，供 `sc_doctor` 工具渲染。
 * 内联程序只用标准库，不依赖任何第三方包是否安装。
 */
export const PROBE_PROGRAM = [
  'import sys, json, importlib.util as u',
  'def has(m):',
  '    try: return bool(u.find_spec(m))',
  '    except Exception: return False',
  'import importlib.metadata as md',
  'def ver(p):',
  '    try: return md.version(p)',
  '    except Exception: return None',
  'print(json.dumps({',
  '  "executable": sys.executable,',
  '  "version": "%d.%d.%d" % sys.version_info[:3],',
  '  "hasPywin32": has("win32com"),',
  '  "hasDocx": has("docx"),',
  '  "hasLxml": has("lxml"),',
  '  "hasPIL": has("PIL"),',
  '  "hasPlaywright": has("playwright"),',
  '  "docxVersion": ver("python-docx"),',
  '  "pywin32Version": ver("pywin32"),',
  '  "stdoutEncoding": sys.stdout.encoding,',
  '}, ensure_ascii=False))'
].join('\n');

/**
 * 用 `python -c <program>` 探测解释器（内联程序，不需要脚本文件）。
 *
 * 单独实现而不是复用 {@link runPython}：`runPython` 的契约是"跑一个脚本文件"，
 * 而探测需要 `-c`。两者的 stdio 与终止语义一致。
 */
export async function runPythonInline(ctx, program, options = {}) {
  const {
    pythonPath,
    config = {},
    chain = CHAINS.generate,
    cwd,
    args = [],
    timeoutMs = 30000,
    signal,
    maxBytes = 1 * 1024 * 1024
  } = options;
  const python = pythonPath ?? resolvePythonForChain(config, chain).path;

  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timeout = createTimeout(timeoutMs, controller);
  let seamError;

  try {
    const subprocess = typeof ctx?.get === 'function' ? ctx.get('subprocess') : ctx?.subprocess;

    if (subprocess !== undefined && typeof subprocess.spawn === 'function') {
      try {
        const prog =
          typeof subprocess.resolveExecutable === 'function'
            ? await subprocess.resolveExecutable(python)
            : python;
        const handle = subprocess.spawn({
          argv: [prog, '-c', program, ...args.map(String)],
          // `cwd` 是 SubprocessSpawnSpec 的必填字段，缺省会同步抛错。
          cwd: cwd ?? process.cwd(),
          env: PYTHON_ENV,
          graceMs: 10000,
          signal: controller.signal,
          stdio: { stdin: 'ignore', stdout: { maxBytes }, stderr: { maxBytes } }
        });
        timeout.arm(handle);
        let exitCode = null;
        try {
          exitCode = (await handle.done)?.exitCode ?? null;
        } catch (error) {
          if (!timeout.isTimedOut()) throw error;
        }
        const timedOut = timeout.isTimedOut();
        const stdout = readCollected(handle, 'stdout');
        const stderr = readCollected(handle, 'stderr');
        return {
          exitCode: timedOut ? null : exitCode,
          stdout,
          stderr,
          json: parseTrailingJson(stdout),
          seam: 'subprocess',
          timedOut
        };
      } catch (error) {
        // 受管 seam 存在但调用失败：**不要静默降级**成 node 结果，否则真实原因被吞掉。
        // 记下来，等离开 seam 分支后作为 seamError 显式上报。
        seamError = error;
      }
    }

    if (seamError !== undefined) {
      const message = seamError?.message ?? String(seamError);
      return {
        exitCode: null,
        stdout: '',
        stderr: `softcopyright: the managed subprocess seam failed: ${message}`,
        json: undefined,
        seam: 'subprocess',
        seamFailed: true,
        error: message,
        timedOut: timeout.isTimedOut()
      };
    }

    const { stdout, stderr } = await execFileAsync(python, ['-c', program, ...args.map(String)], {
      env: { ...process.env, ...PYTHON_ENV },
      timeout: timeoutMs,
      maxBuffer: maxBytes,
      windowsHide: true,
      signal: controller.signal
    });
    return {
      exitCode: 0,
      stdout,
      stderr,
      json: parseTrailingJson(stdout),
      seam: 'node',
      timedOut: timeout.isTimedOut()
    };
  } catch (error) {
    if (typeof error?.stdout === 'string' || typeof error?.stderr === 'string') {
      return {
        exitCode: typeof error.code === 'number' ? error.code : 1,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
        json: parseTrailingJson(error.stdout ?? ''),
        seam: 'node',
        timedOut: timeout.isTimedOut()
      };
    }
    return {
      exitCode: null,
      stdout: '',
      stderr: error?.message ?? String(error),
      json: undefined,
      seam: 'node',
      timedOut: timeout.isTimedOut()
    };
  } finally {
    timeout.dispose();
    if (signal !== undefined) signal.removeEventListener?.('abort', onAbort);
  }
}

/** 便捷判断：某个路径下的技能脚本是否存在。 */
export function skillScript(skillDirectory, ...segments) {
  const path = join(skillDirectory, ...segments);
  return existsSync(path) ? path : undefined;
}
