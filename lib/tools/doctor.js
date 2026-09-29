/**
 * `sc_doctor` 工具注册层 —— 唯一 import `@deepseek-ai/dsh-tools` 的地方。
 *
 * 体检逻辑在 `./doctor-core.js`（可在 DSH 之外测试），本文件只负责把它包成 DSH 工具。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { formatDoctor, runDoctor } from './doctor-core.js';

/**
 * 注册 `sc_doctor` 工具：只读、并发安全、不写任何文件。
 * @param ctx - cordis 上下文。
 * @param options.assetRoot - 技能资产根目录。
 * @param options.config - runtime 配置段（由 `apply()` 从 cordis 条目 config 取得）。
 */
export function registerDoctorTool(ctx, options) {
  const { assetRoot, config = {} } = options;

  ctx.systemPrompt.section({
    name: 'tool:sc_doctor',
    order: 210,
    // 段文本默认会做 {{name}} 变量插值；本段是纯静态说明，关掉更安全。
    interpolate: false,
    text:
      'Use the sc_doctor tool to diagnose the softcopyright plugin before starting any software-copyright delivery workflow, ' +
      'and whenever a document, atlas, hash, or page-count step fails unexpectedly. It reports which Python interpreters were found ' +
      '(the bundled generation/validation chain and the pywin32 + Microsoft Word render chain), whether real page counts and ' +
      'docx→PDF are available, whether the managed subprocess seam is mounted, and whether the bundled skill assets are intact.'
  });

  ctx.tools.register(
    defineTool({
      name: 'sc_doctor',
      description:
        'Diagnose the softcopyright delivery plugin (read-only). Reports: the bundled generation/validation Python chain and its ' +
        'python-docx availability; the render Python chain with pywin32 (Word COM) availability for real page counts and docx→PDF; ' +
        'the managed subprocess seam status; and the integrity of the four bundled skill assets. Run this when a softcopyright ' +
        'step fails or when the user asks why page counts or PDF export are unavailable.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            report: { type: 'string', required: true },
            warnings: { type: 'array', required: true, items: { type: 'string' } }
          }
        },
        render: (_args, value) => [{ type: 'text', text: value.report }]
      },
      isConcurrencySafe: () => true,
      timeoutMs: 120000,
      async execute(_args, exec) {
        const report = await runDoctor(ctx, {
          assetRoot,
          config,
          signal: exec.signal,
          // 会话工作区作为子进程 cwd：SubprocessSpawnSpec.cwd 是必填字段。
          cwd: exec.agent?.session?.header?.cwd
        });
        return {
          ok: report.ok,
          report: formatDoctor(report),
          warnings: report.warnings
        };
      },
      presentCall() {
        return { card: 'generic', title: '软著插件体检', kind: 'doctor' };
      }
    })
  );
}
