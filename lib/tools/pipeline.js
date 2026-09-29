/**
 * `sc_pipeline` —— 流水线状态机工具（细粒度、核心）
 *
 * 它把 SKILL.md 的「10 步链路 + 每阶段必须停下等用户确认」变成**可执行约束**：
 * 推进必须调用 `advance`，而它要求门禁全过 **且** `confirmedByUser === true`。
 *
 * 为什么不做成 `agent/pre-step` 硬拦截（设计文档 §3.4）：那属于深度干预 agent 循环，
 * 调试与误伤成本都高，且会和 Aegis / browser-skill 抢同一个接缝。中约束 + `sc_audit`
 * 的组合足够 —— **绕过去会被审计抓出来**。
 *
 * 写操作（advance/checkpoint/skip/reset/recompute-facts），不可并发。
 */
import { advance, checkpoint, planReport, recomputeFacts, reset, skip, statusReport } from '../pipeline/machine.js';
import { readState } from '../pipeline/store.js';
import { auditFourWay } from '../audit/consistency.js';
import { resolveBundledPython } from '../runtime.js';
import { buildActionTool } from './registry.js';

const P = {
  to: { type: 'string', description: '目标阶段 id（不传 = 下一个就绪阶段）' },
  phaseId: { type: 'string', description: '阶段 id（checkpoint/skip 用）' },
  confirmedByUser: {
    type: 'boolean',
    description: '用户是否已明确确认本阶段结果。**必须只在用户真的回复确认后传 true**'
  },
  note: { type: 'string', description: '给状态文件留一条备注' },
  sourceDir: { type: 'string', description: '源程序目录（recompute-facts 用；软著口径）' },
  softwareName: { type: 'string', description: '软件名，记入状态便于汇报' },
  projectRoot: { type: 'string', description: '软著项目根目录（状态文件与 docs/ 所在层）。默认 = 会话工作区；项目是工作区子目录时必须显式指定' }
};

/**
 * 注册 `sc_pipeline`。
 * @param ctx - cordis 上下文。
 * @param options.manifest - 已校验的流水线清单。
 * @param options.config - 本插件配置。
 * @param options.makeGuard - `(sessionCwd) => guard`
 */
export function registerPipelineTool(ctx, options) {
  const { manifest, config = {}, makeGuard, onResult } = options;
  const pipelineCfg = config.pipeline ?? {};
  const sourceCfg = config.source ?? {};
  const runtime = config.runtime ?? {};

  /** 拿会话工作区；拿不到就没法定位状态文件。 */
  const projectRootOf = (args, exec) => args?.projectRoot ?? exec?.agent?.session?.header?.cwd;

  const renderStatus = (report) => {
    const lines = [
      `流水线状态（${manifest.project}）`
    ];
    // 状态文件读不出来时必须**大声说**：store 的设计是"损坏就当全新、不抛错"，
    // 但那样会让用户觉得进度"凭空没了"。这里把原因显式呈现出来。
    const load = report.stateLoad;
    if (load !== undefined && load !== 'ok' && load !== 'fresh') {
      lines.push(`  ⚠ 状态文件未能正常读取：${load}`);
      lines.push('    进度可能已被重置。请检查 .dsh/softcopyright/state.json 是否损坏；');
      lines.push('    若确有损坏，修好后重跑 sc_pipeline action=recompute-facts 重建口径。');
    }
    lines.push(
      `  进度：${report.doneCount}/${report.total} 阶段完成`,
      `  当前：${report.current === undefined ? '（全部完成）' : `${report.current.id} ${report.current.title}`}`,
      ''
    );
    for (const row of report.rows) {
      lines.push(`  ${row.mark} ${row.id.padEnd(16)} ${row.title}${row.optional ? '（按需）' : ''}`);
    }
    const facts = report.sharedFacts ?? {};
    if (facts.sourceFiles !== undefined) {
      lines.push('', `  共享口径：${facts.sourceFiles} 个源文件 / ${facts.sourceLines} 行代码`);
      lines.push(`  口径范围：${facts.scope ?? '-'}`);
    } else {
      lines.push('', '  共享口径：尚未记录（跑 sc_pipeline action=recompute-facts）');
    }
    if (report.blocked.length > 0) {
      lines.push('', '  被前置阻塞：');
      for (const b of report.blocked) lines.push(`    ${b.id} ← 缺 ${b.missing.join(', ')}`);
    }
    return lines.join('\n');
  };

  const { tool, prompt } = buildActionTool({
    name: 'sc_pipeline',
    description:
      'Drive the 10-step software-copyright delivery pipeline and enforce its checkpoint rule. Actions: ' +
      'status (current phase, per-phase state, shared file/line facts, blocked phases), ' +
      'plan (topological order with each phase gate readiness and blockers), ' +
      'advance (move to the next phase ONLY when its gate passes AND confirmedByUser is true — otherwise it reports exactly what is missing), ' +
      'checkpoint (mark the current phase as reported-and-awaiting-user without advancing), ' +
      'skip (skip an optional phase such as the on-demand AIGC phases), ' +
      'recompute-facts (recompute the authoritative N-files/M-lines from the source tree into sharedFacts), ' +
      'reset (clear the pipeline state). ' +
      'The pipeline rule is strict: never advance several phases at once, and never pass confirmedByUser=true without an explicit user confirmation.',
    prompt: {
      name: 'tool:sc_pipeline',
      order: 226,
      text:
        'Use sc_pipeline to track and gate the software-copyright delivery. Before starting any delivery, read action=status. ' +
        'At the end of every phase: report results, then STOP — call action=advance with confirmedByUser=true only after the user has explicitly confirmed. ' +
        'If advance refuses, follow the reported fix list instead of forcing progress. ' +
        'Call action=recompute-facts right after the source scope is fixed, so sharedFacts stays the single source of truth for the four-way numbers.'
    },
    params: P,
    sharedParams: ['projectRoot'],
    actions: {
      status: {
        summary: '当前阶段/进度/共享口径/阻塞项',
        uses: [],
        concurrencySafe: true,
        run: async ({ args, exec }) => {
          const projectRoot = projectRootOf(args, exec);
          if (projectRoot === undefined) return { ok: false, summary: '需要会话工作区才能定位状态文件', fields: [] };
          const state = readState(projectRoot);
          const report = statusReport(manifest, state);
          return {
            ok: true,
            summary: renderStatus(report),
            fields: [
              `done=${report.doneCount}/${report.total}`,
              `current=${report.current?.id ?? 'none'}`,
              `stateLoad=${report.stateLoad ?? 'ok'}`,
              ...(report.sharedFacts?.sourceFiles === undefined
                ? []
                : [`sourceFiles=${report.sharedFacts.sourceFiles}`, `sourceLines=${report.sharedFacts.sourceLines}`])
            ]
          };
        }
      },
      plan: {
        summary: '拓扑推进计划 + 每阶段门禁就绪度',
        uses: [],
        concurrencySafe: true,
        run: async ({ args, exec }) => {
          const projectRoot = projectRootOf(args, exec);
          if (projectRoot === undefined) return { ok: false, summary: '需要会话工作区', fields: [] };
          const state = readState(projectRoot);
          const report = planReport(manifest, state, { projectRoot });
          const lines = [`推进计划（拓扑序，共 ${report.order.length} 阶段）`, ''];
          for (const phase of report.phases) {
            lines.push(`  ${phase.id.padEnd(16)} ${phase.title}`);
            lines.push(
              `    requires: ${phase.requires.length === 0 ? '（无）' : phase.requires.join(', ')}` +
                `  必须停下: ${phase.mustStopAfter ? '是' : '否'}${phase.optional ? '  按需' : ''}`
            );
            if (phase.gateOk === false) {
              for (const blocker of phase.blockers ?? []) lines.push(`    └ 未过：${blocker}`);
            } else if (phase.gateOk === true) {
              lines.push('    └ 门禁已就绪');
            }
          }
          return { ok: true, summary: lines.join('\n'), fields: [`phases=${report.order.length}`] };
        }
      },
      advance: {
        summary: '推进（门禁 + 用户确认双条件）',
        uses: [],
        concurrencySafe: false,
        run: async ({ args, exec }) => {
          const projectRoot = projectRootOf(args, exec);
          if (projectRoot === undefined) return { ok: false, summary: '需要会话工作区', fields: [] };
          const state = readState(projectRoot);

          // 目标阶段若含 four-way 判据，先跑审计把结果喂给门禁
          const targetId = args.to;
          const phase = targetId === undefined
            ? manifest.phases.find((p) => p.requires.every((d) => {
                const s = state.phases?.[d]?.status;
                return s === 'done' || s === 'skipped';
              }) && state.phases?.[p.id]?.status !== 'done')
            : manifest.phases[manifest.index[targetId]];
          let fourWay;
          if (phase !== undefined && phase.measure.some((m) => m.kind === 'four-way-consistency')) {
            const sourceDir = args.sourceDir ?? state.sharedFacts?.scope;
            if (sourceDir !== undefined) {
              const guard = makeGuard?.(projectRoot);
              guard?.assert(sourceDir, 'sourceDir');
              const docsDir = 'docs';
              const { matchArtifacts } = await import('../pipeline/gates.js');
              const pick = (needle) => matchArtifacts(projectRoot, [`${docsDir}/*${needle}*.docx`])[0];
              fourWay = await auditFourWay(ctx, {
                projectRoot,
                sourceDir,
                sourceRules: sourceCfg,
                docs: { sourceDoc: pick('源代码文档'), hashListing: pick('哈希值清单'), devLog: pick('研发日志') },
                pythonPath: resolveBundledPython(runtime).path,
                expected: state.sharedFacts,
                signal: exec?.signal
              });
            }
          }

          if (args.softwareName !== undefined && state.softwareName !== args.softwareName) {
            state.softwareName = args.softwareName;
          }

          const result = advance(manifest, state, {
            to: args.to,
            projectRoot,
            confirmedByUser: args.confirmedByUser === true,
            fourWay
          });

          const fields = [];
          if (result.phase !== undefined) fields.push(`phase=${result.phase}`);
          for (const blocker of result.blockers ?? []) fields.push(`blocker=${blocker.message}`);

          if (result.ok === true) {
            const lines = [`推进成功：${result.phase} ${result.title}`, ''];
            for (const check of result.checks ?? []) lines.push(`  [x] ${check.detail}`);
            if (result.next !== undefined) {
              lines.push('', `下一步：${result.next.id} ${result.next.title}` +
                (result.next.ref === undefined ? '' : `（${result.next.ref}）`));
            }
            if (result.mustStopAfter) {
              lines.push('', '⚑ 本阶段完成后**必须停下汇报，等用户明确确认**再继续（Checkpoint 铁律）。');
            }
            return { ok: true, summary: lines.join('\n'), fields };
          }

          if (result.gateFailed === true) {
            const lines = [`门禁未过：${result.phase} ${result.title}`, ''];
            for (const check of result.checks ?? []) {
              lines.push(`  ${check.ok ? '[x]' : '[ ]'} ${check.kind}: ${check.detail}`);
            }
            lines.push('', '补齐：');
            for (const blocker of result.blockers ?? []) {
              lines.push(`  - ${blocker.message}`);
              if (blocker.fix) lines.push(`    → ${blocker.fix}`);
            }
            return { ok: false, summary: lines.join('\n'), fields };
          }

          const lines = [`未推进：${result.reason ?? 'unknown'}`, ''];
          if (result.missing !== undefined) lines.push(`  缺少前置：${result.missing.join(', ')}`);
          if (result.available !== undefined) lines.push(`  可选阶段：${result.available.join(', ')}`);
          if (result.fixHint !== undefined) lines.push(`  → ${result.fixHint}`);
          return { ok: false, summary: lines.join('\n'), fields };
        }
      },
      checkpoint: {
        summary: '标记"已汇报、等用户确认"（不推进）',
        uses: [],
        concurrencySafe: false,
        run: async ({ args, exec }) => {
          const projectRoot = projectRootOf(args, exec);
          if (projectRoot === undefined) return { ok: false, summary: '需要会话工作区', fields: [] };
          const state = readState(projectRoot);
          const result = checkpoint(manifest, state, { phaseId: args.phaseId, projectRoot, note: args.note });
          return {
            ok: result.ok === true,
            summary: result.ok
              ? `已标记等待用户确认：${result.phase} ${result.title}\n\n请把本阶段结果汇报给用户，等明确确认后再 advance。`
              : `未标记：${result.reason}`,
            fields: result.ok ? [`phase=${result.phase}`] : []
          };
        }
      },
      skip: {
        summary: '跳过按需阶段（如降 AIGC / 申诉证明）',
        uses: ['phaseId'],
        concurrencySafe: false,
        run: async ({ args, exec }) => {
          const projectRoot = projectRootOf(args, exec);
          if (projectRoot === undefined) return { ok: false, summary: '需要会话工作区', fields: [] };
          const state = readState(projectRoot);
          const result = skip(manifest, state, { phaseId: args.phaseId, projectRoot });
          return {
            ok: result.ok === true,
            summary: result.ok
              ? `已跳过按需阶段 ${result.phase}${result.next === undefined ? '' : `；下一步：${result.next}`}`
              : `未跳过：${result.reason}`,
            fields: result.ok ? [`skipped=${result.phase}`] : []
          };
        }
      },
      'recompute-facts': {
        summary: '从源程序目录重算权威 N 文件/M 行并写入 sharedFacts',
        uses: ['sourceDir'],
        concurrencySafe: false,
        run: async ({ args, exec }) => {
          const projectRoot = projectRootOf(args, exec);
          if (projectRoot === undefined) return { ok: false, summary: '需要会话工作区', fields: [] };
          const guard = makeGuard?.(projectRoot);
          guard?.assert(args.sourceDir, 'sourceDir');
          const state = readState(projectRoot);
          const facts = recomputeFacts(state, { projectRoot, sourceDir: args.sourceDir, sourceRules: sourceCfg });
          return {
            ok: true,
            summary:
              `权威口径已写入 sharedFacts\n  sourceFiles=${facts.files}\n  sourceLines=${facts.lines}\n  sourceBytes=${facts.bytes}\n` +
              `  范围：${facts.scope}\n\n` +
              '接下来请让源代码文档封面、哈希清单、研发日志都以这组数字重新生成（四处一致是送审硬要求）。',
            fields: [`sourceFiles=${facts.files}`, `sourceLines=${facts.lines}`, `sourceBytes=${facts.bytes}`]
          };
        }
      },
      reset: {
        summary: '清空流水线状态（需谨慎）',
        uses: [],
        concurrencySafe: false,
        run: async ({ args, exec }) => {
          const projectRoot = projectRootOf(args, exec);
          if (projectRoot === undefined) return { ok: false, summary: '需要会话工作区', fields: [] };
          reset(projectRoot);
          return { ok: true, summary: `已清空 ${projectRoot}\\.dsh\\softcopyright\\state.json`, fields: [] };
        }
      }
    },
    timeoutMs: pipelineCfg.timeoutMs ?? 600000,
    kind: 'pipeline',
    onResult
  });

  return { tool, prompt };
}
