/**
 * dsh-skill-softcopyright —— `/sc-*` 斜杠命令
 *
 * 用 cordis 的 commands 服务注册：**不产生模型消息**，纯人机交互（设计文档 §5.6）。
 * 用途是"不开新对话就能查状态、跑审计"。
 *
 * ⚠️ 访问该服务必须用 `ctx.get('commands')` 而非 `ctx.commands` —— 见 registerCommands 内的注释
 * （M3 整插件失效事故的根因）。
 *
 * 命令语法约束（来自 `dsh-commands`）：斜杠在字节 0，名字只能小写字母/数字/`_`/`-`，
 * 之后是空白或输入结束；同名重复注册在同一 scope 会抛错。
 */
import { auditFourWay } from './audit/consistency.js';
import { matchArtifacts } from './pipeline/gates.js';
import { readState, resetState, updatePhase } from './pipeline/store.js';
import { statusReport } from './pipeline/machine.js';
import { resolveBundledPython } from './runtime.js';

/** 从 exec/agent 里取会话工作区。命令 handler 拿到的是 `{ agent, rawInput }`。 */
function cwdOf(agent) {
  return agent?.session?.header?.cwd;
}

/**
 * 注册 `/sc-*` 命令。
 * @param ctx - cordis 上下文。
 * @param options.manifest - 流水线清单。
 * @param options.config - 本插件配置。
 */
export function registerCommands(ctx, options) {
  const { manifest, config = {} } = options;

  // ⚠️ **必须走 `ctx.get('commands')`，不能用 `ctx.commands`**（M3 事故根因）。
  // cordis 对未 `inject` 的服务，属性访问本身就**抛错**：
  //   Error: cannot get property "commands" without inject
  // 可选链 `ctx.commands?.register` 救不了 —— getter 先抛，`?.` 根本没机会生效。
  // 服务契约里 optional 访问也正是写明 `ctx.get("commands")` + undefined 检查。
  const commands = typeof ctx.get === 'function' ? ctx.get('commands') : undefined;
  if (commands === undefined || typeof commands.register !== 'function') return; // 组合没挂命令服务就安静跳过

  const sourceCfg = config.source ?? {};
  const runtime = config.runtime ?? {};

  const pick = (projectRoot, needle) => matchArtifacts(projectRoot, [`docs/*${needle}*.docx`])[0];

  commands.register({
    name: 'sc-status',
    description: '查看软著交付流水线的当前阶段、进度与共享口径',
    handler: ({ agent }) => {
      const cwd = cwdOf(agent);
      if (cwd === undefined) return { kind: 'error', text: '拿不到会话工作区' };
      const state = readState(cwd);
      const report = statusReport(manifest, state);
      const lines = [
        `进度：${report.doneCount}/${report.total}`,
        `当前：${report.current === undefined ? '（全部完成）' : `${report.current.id} ${report.current.title}`}`
      ];
      for (const row of report.rows) {
        lines.push(`${row.mark} ${row.id.padEnd(16)} ${row.title}${row.optional ? '（按需）' : ''}`);
      }
      const facts = report.sharedFacts ?? {};
      lines.push(
        facts.sourceFiles === undefined
          ? '共享口径：未记录'
          : `共享口径：${facts.sourceFiles} 个源文件 / ${facts.sourceLines} 行（${facts.scope ?? '-'}）`
      );
      return { kind: 'success', text: lines.join('\n') };
    }
  });

  commands.register({
    name: 'sc-audit',
    description: '立刻跑四处口径一致性审计（不打扰模型）',
    handler: async ({ agent }) => {
      const cwd = cwdOf(agent);
      if (cwd === undefined) return { kind: 'error', text: '拿不到会话工作区' };
      const state = readState(cwd);
      const sourceDir = state.sharedFacts?.scope;
      if (sourceDir === undefined) {
        return {
          kind: 'error',
          text: 'sharedFacts 里没有源程序目录。先让 agent 跑 sc_pipeline action=recompute-facts。'
        };
      }
      const result = await auditFourWay(ctx, {
        projectRoot: cwd,
        sourceDir,
        sourceRules: sourceCfg,
        docs: {
          sourceDoc: pick(cwd, '源代码文档'),
          hashListing: pick(cwd, '哈希值清单'),
          devLog: pick(cwd, '研发日志')
        },
        pythonPath: resolveBundledPython(runtime).path,
        expected: state.sharedFacts
      });
      const lines = [result.ok ? '四处口径一致 ✅' : '四处口径不一致 ❌', result.summary];
      for (const [key, obs] of Object.entries(result.observations)) {
        if (obs.missing === true) lines.push(`  ${key}: 缺失`);
        else if (obs.error !== undefined) lines.push(`  ${key}: 读取失败`);
        else lines.push(`  ${key}: ${obs.files ?? '?'} 文件 / ${obs.lines ?? '?'} 行`);
      }
      if (!result.ok && result.fixHint !== undefined) lines.push(`修复：${result.fixHint}`);
      return { kind: result.ok ? 'success' : 'error', text: lines.join('\n') };
    }
  });

  commands.register({
    name: 'sc-milestone',
    description: '手动把某阶段标记为已汇报（等价于在对话里说"继续"，但更明确）',
    input: { hint: '<phaseId>' },
    handler: ({ agent, rawInput }) => {
      const cwd = cwdOf(agent);
      if (cwd === undefined) return { kind: 'error', text: '拿不到会话工作区' };
      const phaseId = String(rawInput ?? '').trim();
      if (phaseId.length === 0) {
        return { kind: 'error', text: `用法：/sc-milestone <phaseId>\n可选：${manifest.phases.map((p) => p.id).join(', ')}` };
      }
      if (manifest.index[phaseId] === undefined) {
        return { kind: 'error', text: `未知阶段 "${phaseId}"；可选：${manifest.phases.map((p) => p.id).join(', ')}` };
      }
      const state = readState(cwd);
      updatePhase(state, phaseId, { status: 'waiting-user', reportedAt: new Date().toISOString() });
      return {
        kind: 'success',
        text: `已把 ${phaseId} 标记为"已汇报、等确认"。推进仍需 agent 调用 sc_pipeline action=advance 且门禁全过。`
      };
    }
  });

  commands.register({
    name: 'sc-reset',
    description: '清空软著交付流水线状态（不可撤销）',
    input: { hint: 'confirm' },
    handler: ({ agent, rawInput }) => {
      const cwd = cwdOf(agent);
      if (cwd === undefined) return { kind: 'error', text: '拿不到会话工作区' };
      if (String(rawInput ?? '').trim() !== 'confirm') {
        return { kind: 'error', text: '这会清空 .dsh/softcopyright/state.json。确认请执行：/sc-reset confirm' };
      }
      resetState(cwd);
      return { kind: 'success', text: '已清空流水线状态。' };
    }
  });
}
