/**
 * `sc_audit` —— 四处口径一致性审计工具（细粒度、高频）
 *
 * 原技能包里**没有**这个能力：SKILL.md 写着"源程序目录 = 源代码文档封面 = 哈希清单 =
 * 研发日志，四处必须一致"，但没有任何脚本负责交叉校验。这里把它机械化，
 * 并接到流水线门禁（`four-way-consistency` 判据）上。
 *
 * 只读，可并发。
 */
import { join } from 'node:path';
import { auditFourWay, collectSourceStats } from '../audit/consistency.js';
import { matchArtifacts } from '../pipeline/gates.js';
import { buildActionTool } from './registry.js';
import { resolveBundledPython } from '../runtime.js';

const P = {
  sourceDir: { type: 'string', description: '源程序目录（软著口径：只含软件本体运行源码）' },
  docsDir: { type: 'string', description: '交付文档目录，默认 docs' },
  sourceDoc: { type: 'string', description: '源代码文档 docx 路径（不传则按 docs/*源代码文档*.docx 猜）' },
  hashListing: { type: 'string', description: '哈希值清单 docx 路径（不传则按 docs/*哈希值清单*.docx 猜）' },
  devLog: { type: 'string', description: '研发日志 docx 路径（不传则按 docs/*研发日志*.docx 猜）' },
  projectRoot: {
    type: 'string',
    description:
      '软著项目根目录（放 docs/ 与源程序目录的那一层），也是流水线状态文件的位置。默认 = 会话工作区；**当项目是工作区的子目录时必须显式指定**，否则 docs/*.docx 会找不到'
  }
};

/** 解析本次调用的项目根：显式 projectRoot 优先，否则会话工作区。 */
function projectRootOf(args, exec) {
  return args.projectRoot ?? exec?.agent?.session?.header?.cwd;
}

/** 在 docs 目录里按文件名特征找一份 docx。 */
function guessDoc(projectRoot, docsDir, needle) {
  const hits = matchArtifacts(projectRoot, [`${docsDir}/*${needle}*.docx`]);
  return hits.length > 0 ? hits[0] : undefined;
}

/**
 * 注册 `sc_audit`。
 * @param ctx - cordis 上下文。
 * @param options.assetRoot - 技能资产目录。
 * @param options.config - 本插件配置。
 * @param options.makeGuard - `(sessionCwd) => guard`
 * @param options.state - 可选：读 sharedFacts 用的状态读取器 `(projectRoot) => state`
 */
export function registerAuditTool(ctx, options) {
  const { config = {}, makeGuard, readStateFor, onResult } = options;
  const runtime = config.runtime ?? {};
  const sourceCfg = config.source ?? {};

  const resolveSourceDir = (args, state) =>
    args.sourceDir ?? state?.sharedFacts?.scope ?? undefined;

  const { tool, prompt } = buildActionTool({
    name: 'sc_audit',
    description:
      'Audit the four-way consistency contract that software-copyright review requires: ' +
      'the source tree, the source-code document cover, the hash listing, and the dev log must all report the SAME ' +
      '"N source files / M lines of code". Actions: ' +
      'four-way (read the source tree plus the three docx and cross-check both numbers, reporting which places disagree), ' +
      'source-scope (report only what the configured exclusion rules currently collect — cheap, no docx read), ' +
      'figures (cross-check the atlas PNG count against the illustrated manual figure counts). ' +
      'Run this whenever any of those four places is regenerated, and as the delivery self-check. Read-only.',
    prompt: {
      name: 'tool:sc_audit',
      order: 225,
      text:
        'Use sc_audit to verify the four-way consistency contract (source tree == source-code document cover == hash listing == dev log) ' +
        'before delivering anything, and after regenerating any one of those places. ' +
        'When it reports a mismatch, fix by REGENERATING the stale documents from the source tree (sc_source gen-doc / collect-hashes, sc_proof gen-docx) — ' +
        'never hand-edit a single document, and never narrow the source scope in only one place.'
    },
    params: P,
    actions: {
      'four-way': {
        summary: '四处口径交叉审计（源程序目录 vs 三份 docx）',
        uses: ['projectRoot'],
        optional: ['projectRoot'],
        run: async ({ args, exec }) => {
          const projectRoot = projectRootOf(args, exec);
          const guard = makeGuard?.(projectRoot);
          if (guard !== undefined) {
            if (args.sourceDir !== undefined) guard.assert(args.sourceDir, 'sourceDir');
            if (args.projectRoot !== undefined) guard.assert(args.projectRoot, 'projectRoot');
            for (const [label, value] of [
              ['sourceDoc', args.sourceDoc],
              ['hashListing', args.hashListing],
              ['devLog', args.devLog]
            ]) {
              if (value !== undefined && value !== '') guard.assert(value, label);
            }
          }
          if (projectRoot === undefined) {
            return {
              ok: false,
              summary:
                'sc_audit 需要项目根：请传 projectRoot，或确保能取到会话工作区（exec.agent.session.header.cwd）',
              fields: []
            };
          }
          const state = readStateFor?.(projectRoot);
          const sourceDir = resolveSourceDir(args, state);
          if (sourceDir === undefined) {
            return {
              ok: false,
              summary: '未提供 sourceDir，且 sharedFacts 里也没有记录源程序目录。请先运行 sc_pipeline action=recompute-facts。',
              fields: []
            };
          }
          const docsDir = args.docsDir ?? 'docs';
          const result = await auditFourWay(ctx, {
            projectRoot,
            sourceDir,
            sourceRules: sourceCfg,
            docs: {
              sourceDoc: args.sourceDoc ?? guessDoc(projectRoot, docsDir, '源代码文档'),
              hashListing: args.hashListing ?? guessDoc(projectRoot, docsDir, '哈希值清单'),
              devLog: args.devLog ?? guessDoc(projectRoot, docsDir, '研发日志')
            },
            pythonPath: resolveBundledPython(runtime).path,
            expected: state?.sharedFacts,
            signal: exec?.signal
          });

          const fields = [];
          for (const [key, obs] of Object.entries(result.observations)) {
            if (obs.error !== undefined) {
              fields.push(`${key}=ERROR:${obs.error}`);
            } else if (obs.missing === true) {
              fields.push(`${key}=missing`);
            } else {
              fields.push(
                `${key}=files:${obs.files ?? '?'},lines:${obs.lines ?? '?'}` +
                  (obs.hashEntries === undefined ? '' : `,hashEntries:${obs.hashEntries}`)
              );
            }
          }
          for (const block of result.blocks) fields.push(`mismatch=${block}`);

          const lines = [`四处口径审计: ${result.ok ? 'OK' : 'FAILED'}`, `  ${result.summary}`];
          for (const field of fields) lines.push(`  ${field}`);
          if (result.notes.length > 0) {
            lines.push('', '提示：');
            for (const note of result.notes) lines.push(`  ! ${note}`);
          }
          if (!result.ok && result.fixHint !== undefined) lines.push('', `修复：${result.fixHint}`);

          return { ok: result.ok, summary: lines.join('\n'), fields };
        }
      },
      'source-scope': {
        summary: '只报告当前排除规则收到的源程序范围（不读 docx）',
        uses: ['sourceDir', 'projectRoot'],
        optional: ['projectRoot'],
        run: async ({ args, exec }) => {
          const projectRoot = projectRootOf(args, exec);
          const guard = makeGuard?.(projectRoot);
          if (guard !== undefined) guard.assert(args.sourceDir, 'sourceDir');
          const tree = collectSourceStats(args.sourceDir, sourceCfg);
          const fields = [`files=${tree.files}`, `lines=${tree.lines}`, `bytes=${tree.bytes}`];
          return {
            ok: tree.files > 0,
            summary:
              `源程序范围（按当前排除规则）\n  files=${tree.files}\n  lines=${tree.lines}\n  bytes=${tree.bytes}\n` +
              `  排除目录：${(sourceCfg.excludeDirs ?? []).join(', ')}\n` +
              `  __init__.py 白名单：${sourceCfg.keepInitPy !== false ? '开启（P0 陷阱防护）' : '关闭 ⚠'}`,
            fields
          };
        }
      },
      figures: {
        summary: '图集屏数 vs 说明书图题/图片数交叉核对',
        uses: ['projectRoot'],
        optional: ['projectRoot'],
        run: async ({ args, exec }) => {
          const projectRoot = projectRootOf(args, exec);
          if (projectRoot === undefined) {
            return { ok: false, summary: 'sc_audit 需要项目根（传 projectRoot 或提供会话工作区）', fields: [] };
          }
          const state = readStateFor?.(projectRoot);
          const atlas = matchArtifacts(projectRoot, ['docs/atlas/*.png', 'docs/atlas/*.PNG']);
          const figs = state?.evidence?.['sc_manual.check-figs']?.fields;
          const figCaptions = state?.evidence?.['sc_manual.check']?.fields?.figureCaptions;
          const fields = [`atlasPng=${atlas.length}`, `projectRoot=${projectRoot}`];
          if (figs !== undefined) {
            fields.push(`manualImages=${figs.images ?? '?'}`, `manualFigureCaptions=${figs.figureCaptions ?? '?'}`);
          }
          if (figCaptions !== undefined) fields.push(`manualSlotFigureCaptions=${figCaptions}`);
          const consistent =
            figs === undefined
              ? atlas.length > 0
              : atlas.length === figs.images && figs.figureCaptions === figs.images;
          if (!consistent) {
            fields.push('mismatch=图集 PNG 数与说明书图片/图题数不一致（目标：三者相等）');
          }
          return {
            ok: consistent,
            summary:
              `图数一致性: ${consistent ? 'OK' : 'FAILED'}\n` +
              fields.map((f) => `  ${f}`).join('\n') +
              (consistent ? '' : '\n\n提示：图集屏数 = 说明书图位数 = docx 内图片数，三者必须相等；' +
                '图题≠图片通常是重复截图被 Word 去重，先对 docs/atlas/*.png 做 md5 查重'),
            fields
          };
        }
      }
    },
    timeoutMs: (config.runtime?.longTaskTimeoutMs ?? 300000),
    kind: 'audit',
    onResult
  });

  return { tool, prompt };
}

export { P as AUDIT_PARAMS, join };
