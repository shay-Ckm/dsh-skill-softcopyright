/**
 * dsh-skill-softcopyright —— 技能脚本执行器
 *
 * 把三段接起来：**路径守卫 → 受管子进程 seam → 输出解析器**。
 *
 * 关键设计点：
 * - **按 action 选解释器链**：`generate`（随包 Python，生成/校验）或
 *   `render`（`C:\Python314`，Word COM 取真实页数 / docx→PDF / Playwright 截图）。
 *   用错链的表现是"脚本 import 失败"，归因很贵，所以在解析层就分清。
 * - **用户提供的文件路径先过守卫**：`ctx.subprocess` 这条 seam 不带沙箱策略与审批，
 *   边界改在参数层做（见 lib/guard.js 的说明）。脚本自身的路径属插件只读资源，无条件放行。
 * - **`ran` 与 `ok` 分开**：多数校验脚本用退出码表达"校验结论"，但也有脚本恒退出 0
 *   （build_src_package 的 sdist 失败、gen_proof_docx 的保存失败都不改退出码），
 *   所以"脚本是否跑出结论"和"结论是否通过"必须分开表达。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CHAINS, runPython } from '../runtime.js';

/** 技能名 → 目录名。 */
export const SKILL_DIRS = {
  delivery: 'python-software-delivery',
  manual: 'manual-ui-screenshots',
  aigc: 'aigc-review-reduction',
  proof: 'software-copyright-aigc-appeal'
};

/** 按脚本后缀选默认解释器：`.js` 走 Node（随包 Node），其余走 Python。 */
function defaultChainFor(script) {
  return script.endsWith('.js') ? 'node' : CHAINS.generate;
}

/**
 * 建立脚本执行器。
 *
 * 刻意**不持有 guard**：守卫的边界是**每次调用**的会话工作区（`exec.agent.session.header.cwd`），
 * apply() 时还不知道。因此 guard 由 `run()` 逐次传入。
 *
 * @param options.assetRoot - 技能资产根目录（绝对路径）。
 * @param options.config - 本插件的 runtime 配置段。
 * @param options.nodePath - 随包 Node 可执行文件（跑 `.js` 脚本用）。
 * @param options.outputLimit - 回传给模型的原始输出上限（字符）。
 */
export function createScriptRunner(options) {
  const { assetRoot, config = {}, nodePath, outputLimit = 4000 } = options;

  /** 定位技能脚本；不存在即抛错（快速失败优于拼错路径）。 */
  function locate(skillKey, script) {
    const dir = SKILL_DIRS[skillKey];
    if (dir === undefined) throw new Error(`softcopyright: unknown skill key "${skillKey}"`);
    const path = join(assetRoot, dir, 'scripts', script);
    if (!existsSync(path)) {
      throw new Error(
        `softcopyright: bundled script not found: ${path} — the plugin assets are incomplete or the skill was updated`
      );
    }
    return { path, dir: join(assetRoot, dir) };
  }

  /** 截断过长的原始输出，并在末尾显式标注被截断。 */
  function clip(text) {
    if (typeof text !== 'string') return undefined;
    const trimmed = text.trim();
    if (trimmed.length === 0) return undefined;
    if (trimmed.length <= outputLimit) return trimmed;
    return `${trimmed.slice(0, outputLimit)}\n… [输出被截断，共 ${trimmed.length} 字符]`;
  }

  /**
   * 跑一个技能脚本并解析结果。
   *
   * @param spec.skill - `delivery` | `manual` | `aigc` | `proof`
   * @param spec.script - `scripts/` 下的文件名（`.py` 或 `.js`）
   * @param spec.args - 追加的 argv（**位置参数顺序必须与脚本一致**）
   * @param spec.chain - 覆盖默认链：`generate` | `render`
   * @param spec.parser - `lib/adapters/parse.js` 里的解析器
   * @param spec.pathArgs - 需要过守卫的用户路径：`[[label, value], ...]`
   * @param spec.cwd - 子进程工作目录（SubprocessSpawnSpec.cwd 必填）
   * @param spec.timeoutMs - 超时
   * @param spec.signal - 取消信号
   * @param spec.extraNotes - 附加提示
   */
  async function run(ctx, spec) {
    const {
      skill,
      script,
      args = [],
      chain,
      parser,
      pathArgs = [],
      guard,
      cwd,
      timeoutMs = config.defaultTimeoutMs ?? 60000,
      signal,
      extraNotes = []
    } = spec;

    const { path: scriptPath } = locate(skill, script);

    // 1) 路径守卫：只校验用户提供的路径；越界即抛错（拒绝而非静默放行）
    const guardResults = [];
    for (const [label, value] of pathArgs) {
      if (value === undefined || value === null || value === '') continue;
      if (guard === undefined) {
        guardResults.push({ ok: true, label, guarded: false, reason: 'no guard supplied' });
        continue;
      }
      guardResults.push(guard.assert(value, label));
    }
    const guardSkipped = guardResults.some((g) => g.guarded === false);

    // 2) 选链
    const useChain = chain ?? defaultChainFor(script);
    const python = config.pythonPath || undefined;
    const renderPython = config.renderPythonPath || undefined;
    let nodeExe;
    if (useChain === 'node') {
      // 延迟解析：Node 只在真跑 .js 脚本时才需要，不该让 apply() 因它失败
      nodeExe = typeof nodePath === 'function' ? nodePath() : nodePath;
      if (typeof nodeExe !== 'string' || nodeExe.length === 0) {
        throw new Error(
          'softcopyright: this action runs a .js script and needs the bundled Node runtime. ' +
            'Set runtime.nodePath to an absolute node.exe path.'
        );
      }
    }

    // 3) 执行
    const result = await runPython(ctx, {
      script: scriptPath,
      args: args.map(String),
      cwd,
      timeoutMs,
      signal,
      pythonPath: useChain === 'render' ? renderPython : useChain === 'node' ? nodeExe : python,
      config
    });

    const parsed = parser === undefined ? undefined : parser(result);
    const notes = [
      ...(parsed?.notes ?? []),
      ...extraNotes,
      // 强制标注页数来源，让"这次页数是估的"永远可见
      ...(parsed?.fields?.pagesSource ? [`pagesSource=${parsed.fields.pagesSource}`] : []),
      ...(result.seamFailed === true ? [`受管 seam 调用失败：${result.error ?? 'unknown'}`] : []),
      ...(result.seam === 'node' && spec.expectManagedSeam !== false
        ? ['子进程走了 node:child_process 回退路径（ctx.subprocess 未挂载？）']
        : []),
      ...(result.timedOut ? [`脚本在 ${timeoutMs}ms 后超时并被终止`] : []),
      ...(guardSkipped ? ['路径守卫被跳过（拿不到会话工作区）'] : [])
    ];

    // 未跑出结论（崩溃 / 用法错误）时，ok 必须是 false 且理由可读
    const ran = parsed === undefined ? result.exitCode === 0 : parsed.ran;
    const ok = parsed === undefined ? result.exitCode === 0 : parsed.ok;
    if (!ran) {
      notes.push(
        `脚本未给出可用结论（退出码 ${result.exitCode}${result.timedOut ? '，超时' : ''}）：` +
          clip(result.stderr)?.slice(0, 300) ?? '无 stderr'
      );
    }

    return {
      ran,
      ok,
      chain: useChain,
      fields: parsed?.fields ?? {},
      notes,
      // 原始输出（未截断）也回传：有些脚本把**机器可消费的数据打到 stdout**
      // （例如 collect_source_hashes.py 的 TSV），工具层需要把它落成文件。
      stdout: result.stdout,
      stderr: result.stderr,
      output: [clip(result.stdout), clip(result.stderr) ? `[stderr]\n${clip(result.stderr)}` : undefined]
        .filter(Boolean)
        .join('\n\n')
    };
  }

  return { run, locate, clip };
}

/** 把 `run()` 的结果转成工具信封需要的 `{ ok, fields, output, summary, notes }`。 */
export function toToolResult(runner, result, title) {
  const lines = [`${title}: ${result.ok ? 'OK' : 'FAILED'}`];
  for (const [key, value] of Object.entries(result.fields)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`  ${key}=${value.join(',')}`);
    } else {
      lines.push(`  ${key}=${value}`);
    }
  }
  if (result.notes?.length > 0) {
    lines.push('', '提示：');
    for (const note of result.notes) lines.push(`  ! ${note}`);
  }
  return {
    ok: result.ok,
    summary: lines.join('\n'),
    fields: Object.entries(result.fields)
      .filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0))
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`),
    output: result.output
  };
}
