/**
 * dsh-skill-softcopyright —— 软件著作权交付流水线插件（入口）
 *
 * 分层（详见设计文档 §3.1）：
 *   L2 技能层   lib/skills.js        4 个交付技能，注册进 ctx.skills
 *   L1 运行时   lib/runtime.js       两条 Python 链 + 受管子进程 seam
 *   L3 工具层   lib/tools/*          1 体检 + 5 分组 + sc_audit + sc_pipeline
 *   L4 编排层   lib/pipeline/*       状态机 + 门禁 + 证据 + 四处口径审计
 *   L5 交互层   lib/commands.js      /sc-* 斜杠命令
 *
 * 本插件**不含客户端 half**（决策 Q7）：不声明 dsh.client，不需要前端构建链。
 *
 * ⚠️ 配置来源（M1 修正）：DSH 0.1.7-rc.2 中插件配置来自 **cordis patch 条目的
 * `config` 字段**，由 loader 依据本模块导出的 `Config` schema 校验后传给 `apply()`。
 * 早期版本使用的 `$DSH_HOME/settings.yaml` 段 + `installSettingsSection()` 已经不存在
 * （`@deepseek-ai/dsh-settings` 只导出 `SettingsConflictError / SettingsForms / redactSecrets`），
 * 本机 `settings.yaml` 也已被改名为 `settings.yaml.imported`（那是历史导入的残留）。
 * 因此本插件**不 import dsh-settings**，直接读 `apply()` 传入的 config。
 */
import z from '@deepseek-ai/schemastery';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createSkillProvider } from './skills.js';
import { DEFAULT_RENDER_PYTHON, resolveBundledNode } from './runtime.js';
import { createPathGuard } from './guard.js';
import { registerDoctorTool } from './tools/doctor.js';
import { buildGroupedTools, enabledGroupedTools } from './tools/groups.js';
import { registerAuditTool } from './tools/audit.js';
import { registerPipelineTool } from './tools/pipeline.js';
import { registerCommands } from './commands.js';
import { loadManifest } from './pipeline/manifest.js';
import { readState, recordEvidence } from './pipeline/store.js';

/** 插件短名，用于 loader 诊断。 */
export const name = 'skill-softcopyright';

/**
 * 激活前需要的服务。
 *
 * 刻意**不注入 `subprocess`**：`lib/runtime.js` 在它缺席时会退回 node:child_process
 * 并把降级显式标注出来，因此不该因为某个组合没挂子进程服务就拒绝激活。
 * `commands` 也**不注入**：组合里没挂命令服务时安静跳过。
 */
export const inject = ['skills', 'systemPrompt', 'tools'];

/** 包根目录（绝对路径）。 */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 包内技能资产目录（绝对路径）。 */
export const DEFAULT_ASSET_ROOT = join(PACKAGE_ROOT, 'assets', 'skills');

/** 包内流水线清单（绝对路径）。 */
export const DEFAULT_MANIFEST_PATH = join(PACKAGE_ROOT, 'assets', 'pipeline.yaml');

/**
 * 配置 schema。所有字段都有默认值，用户只写想改的。
 *
 * 这些字段目前**不是 volatile**：改动需要编辑 profile 的 `cordis.patch.yml` 并**重启进程**
 * （配置改动热生效，但模块代码改动不会）。若要支持 Settings 面板里热编辑，把字段包成
 * `.volatile()`（`@deepseek-ai/schemastery` 3.18.4 提供，等价 `meta.volatile = true`），
 * 并注意 volatile 值解析成引用、读取时要调 `.get()`。列为 M4 增强。
 */
export const Config = z
  .object({
    skills: z
      .object({
        enabled: z.boolean().default(true),
        assetRoot: z.string().default(''),
        injectToolGuide: z.boolean().default(true),
        enabledSkills: z.array(z.string()).default([])
      })
      .default({}),

    tools: z
      .object({
        doctor: z.boolean().default(true),
        manual: z.boolean().default(true),
        source: z.boolean().default(true),
        aigc: z.boolean().default(true),
        proof: z.boolean().default(true),
        atlas: z.boolean().default(true),
        audit: z.boolean().default(true),
        pipeline: z.boolean().default(true)
      })
      .default({}),

    pipeline: z
      .object({
        /** 空 = 包内 assets/pipeline.yaml */
        manifestPath: z.string().default(''),
        /** 是否启用门禁约束（false = 只记录状态，不拦推进） */
        enforceCheckpoint: z.boolean().default(true),
        /** 是否注册 /sc-* 斜杠命令 */
        commands: z.boolean().default(true),
        /** 是否把每次工具执行记为流水线证据（门禁据此判定） */
        recordEvidence: z.boolean().default(true),
        /** sc_pipeline 工具超时（与运行时超时分开，因为 advance 可能要跑审计） */
        timeoutMs: z.number().min(1).default(600000)
      })
      .default({}),

    manual: z
      .object({
        pageRender: z.boolean().default(true),
        expectedMinFigures: z.number().default(30),
        expectedMaxFigures: z.number().default(35),
        expectedPagesMin: z.number().default(30),
        expectedPagesMax: z.number().default(35),
        forbidArrows: z.boolean().default(true),
        forbidBoldMarkdown: z.boolean().default(true),
        forbidNonBlack: z.boolean().default(true),
        forbidItalic: z.boolean().default(true)
      })
      .default({}),

    aigc: z
      .object({
        vocabReductionTarget: z.number().default(0.5),
        structuralResidueTarget: z.number().default(0),
        protectTerms: z.array(z.string()).default([]),
        forbiddenPunctuation: z.array(z.string()).default(['→', '⇒'])
      })
      .default({}),

    source: z
      .object({
        includeExt: z.array(z.string()).default(['.py']),
        excludeDirs: z
          .array(z.string())
          .default(['docs', 'img', 'tests', 'scripts', 'tmp_*', '__pycache__', '*.egg-info', '.git', '.venv']),
        /** ★ P0 陷阱白名单：排除 `_*` 时绝不能吞掉 __init__.py */
        keepInitPy: z.boolean().default(true),
        /** 源代码文档排除 min.js；运行包必须保留 */
        keepThirdPartyMinJs: z.boolean().default(false)
      })
      .default({}),

    atlas: z
      .object({
        expectWidth: z.number().default(2559),
        expectHeight: z.number().default(1559),
        requireUniqueMd5: z.boolean().default(true),
        shootTimeoutMs: z.number().default(1800000)
      })
      .default({}),

    security: z
      .object({
        pathGuard: z
          .object({
            /**
             * 工具层通过 ctx.subprocess 直接 spawn（该 seam 不带沙箱策略与审批），
             * 因此边界改在参数层做：用户路径必须落在会话工作区或 allowlist 内。
             */
            enabled: z.boolean().default(true),
            allowlist: z.array(z.string()).default([])
          })
          .default({})
      })
      .default({}),

    runtime: z
      .object({
        pythonPath: z.string().default(''),
        renderPythonPath: z.string().default(DEFAULT_RENDER_PYTHON),
        nodePath: z.string().default(''),
        defaultTimeoutMs: z.number().min(1).default(60000),
        longTaskTimeoutMs: z.number().min(1).default(300000)
      })
      .default({}),
    diagnostics: z
      .object({
        bootLog: z
          .boolean()
          .default(true)
      })
      .default({})
  })
  .default({});

/** 把工具信封的 `key=value` 字段还原成对象（供证据/门禁取字段）。 */
export function fieldsToObject(fields) {
  const out = {};
  for (const line of fields ?? []) {
    const idx = typeof line === 'string' ? line.indexOf('=') : -1;
    if (idx <= 0) continue;
    const key = line.slice(0, idx);
    const raw = line.slice(idx + 1);
    if (raw === 'true') out[key] = true;
    else if (raw === 'false') out[key] = false;
    else if (raw !== '' && !Number.isNaN(Number(raw))) out[key] = Number(raw);
    else out[key] = raw;
  }
  return out;
}

/**
 * 启动日志的候选路径。
 *
 * ⚠️ **不能只依赖 `DSH_HOME`**：实测 DSH Desktop 的 Electron 主进程里**没有设置** `DSH_HOME`
 * （shell 里有，host 进程里没有），于是日志落到了 `USERPROFILE` 回退路径
 * （`C:\Users\L\softcopyright-boot.log`）而不是 `C:\Users\L\.dsh\` —— 我一开始没找到它。
 * 因此这里同时写多个候选位置，保证事后一定能找到。
 */
function bootLogPaths() {
  const out = [];
  const push = (dir) => {
    if (typeof dir === 'string' && dir.length > 0) out.push(join(dir, 'softcopyright-boot.log'));
  };
  push(process.env.DSH_HOME);
  push(process.env.USERPROFILE ?? process.env.HOME);
  try {
    push(tmpdir());
  } catch {
    /* ignore */
  }
  return [...new Set(out)];
}

/**
 * 判断当前进程是不是测试运行。
 *
 * ⚠️ 为什么需要：`writeBootLog` 对所有调用 `apply()` 的进程一视同仁，于是
 * **测试里故意制造的失败也会写进同一个启动日志**。实测踩到过：日志里出现
 * `failed=[register:sc_aigc]` + `tool schema rejected`，而堆栈指向
 * `test/probe-apply.mjs` —— 那是探针的合成失败，不是真实故障。
 * 启动日志是上次定位 M3 事故（整插件 fiberPhase: failed）的**唯一手段**，
 * 一旦被测试噪声淹没就失去价值。
 *
 * 宿主加载插件时 `process.argv[1]` 是 DSH 的入口，不会落在 `test/` 下，
 * 因此按 argv 判断可靠；也支持用环境变量显式关闭。
 */
function isTestProcess() {
  if (process.env.SC_BOOT_LOG === 'off') return true;
  return /[/\\]test[/\\][^/\\]*\.mjs$/.test(process.argv[1] ?? '');
}

/** 追加一条启动日志到所有候选位置。**绝不抛错**（诊断本身不该影响加载）。 */
function writeBootLog(text, enabled = true) {
  if (enabled !== true || isTestProcess()) return;
  // 带上 pid：日志可能被多个进程共写，没有 pid 就无法分辨来源
  const line = `${new Date().toISOString()} [pid ${process.pid}] ${text}\n`;
  for (const path of bootLogPaths()) {
    try {
      appendFileSync(path, line, 'utf8');
    } catch {
      /* 某个位置不可写就算了 */
    }
  }
}

/**
 * Cordis 插件入口。
 *
 * ⚠️ **每个 section 独立 try/catch**（M3 血的教训）：
 * cordis 在插件 `apply()` 抛错时会**回滚该插件的全部注册**。M3 上线后整插件
 * `fiberPhase: failed` —— 技能、8 个工具、命令**一起消失**，只因某一处抛错。
 * 一个可选的便利功能（斜杠命令）绝不该把核心能力一起带走。
 * 因此这里逐段隔离：某段失败只丢那段，其余照常注册，失败原因写进启动日志。
 *
 * @param ctx - 携带 skills / tools / systemPrompt（可选 commands）的上下文。
 * @param config - 由 loader 依据 {@link Config} 校验过的配置。
 */
export function apply(ctx, config = {}) {
  const effective = config ?? {};
  const logger = ctx.logger;
  const assetRoot = effective.skills?.assetRoot || DEFAULT_ASSET_ROOT;
  const ok = [];
  const failed = [];

  /** 跑一段注册；失败只记录，不向外抛。 */
  const step = (label, fn) => {
    try {
      const result = fn();
      ok.push(label);
      return result;
    } catch (error) {
      failed.push({
        label,
        error: `${error?.constructor?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
        stack: String(error?.stack ?? '').split('\n').slice(0, 6)
      });
      return undefined;
    }
  };

  // ---- L2 技能层 ----
  if (effective.skills?.enabled ?? true) {
    step('skills', () => {
      const provider = createSkillProvider({
        assetRoot,
        injectToolGuide: effective.skills?.injectToolGuide ?? true,
        enabledSkills: effective.skills?.enabledSkills ?? [],
        logger
      });
      ctx.skills.registerProvider(() => provider);
    });
  }

  // ---- L4 流水线清单（L3/L4 工具都要用）----
  const pipelineCfg = effective.pipeline ?? {};
  const manifestPath = pipelineCfg.manifestPath || DEFAULT_MANIFEST_PATH;
  const manifest = step('manifest', () =>
    loadManifest(isAbsolute(manifestPath) ? manifestPath : join(PACKAGE_ROOT, manifestPath))
  );

  const pathGuardCfg = effective.security?.pathGuard ?? {};
  const alwaysAllow = [assetRoot];

  /**
   * 逐次构造守卫：边界是**每次调用**的会话工作区。
   * apply() 时拿不到 session cwd，所以不能在这里定死。
   */
  const makeGuard = (sessionCwd) =>
    createPathGuard({
      enabled: pathGuardCfg.enabled ?? true,
      workspaceRoot:
        typeof sessionCwd === 'string' && sessionCwd.length > 0 ? sessionCwd : undefined,
      allowlist: pathGuardCfg.allowlist ?? [],
      alwaysAllow
    });

  /**
   * 证据钩子：把每次工具执行写进项目状态，门禁据此判定"这个校验跑过且通过了"。
   * 只有拿到会话工作区时才写；写失败不影响工具结果（由 registry 兜住）。
   */
  const onResult =
    pipelineCfg.recordEvidence === false
      ? undefined
      : ({ tool, action, envelope, exec, args }) => {
          // 项目根优先取本次调用的 projectRoot，否则会话工作区 —— 两者必须一致，否则在
          // 子项目布局下「证据」会与「流水线状态」落到不同文件里（fixture 暴露的问题）。
          const cwd = args?.projectRoot ?? exec?.agent?.session?.header?.cwd;
          if (typeof cwd !== 'string' || cwd.length === 0) return;
          recordEvidence(cwd, {
            tool,
            action,
            ok: envelope.ok,
            fields: fieldsToObject(envelope.fields),
            summary: typeof envelope.summary === 'string' ? envelope.summary.slice(0, 400) : undefined
          });
        };

  const toolsCfg = effective.tools ?? {};

  // ---- L3 工具层：逐段构建，坏一段不拖累其余 ----
  const entries = [];

  const grouped = step('tools:grouped', () =>
    enabledGroupedTools(
      buildGroupedTools({
        ctx,
        assetRoot,
        config: effective,
        makeGuard,
        onResult,
        // 延迟解析：只有真跑 .js 脚本时才需要 Node，不该让 apply() 因它失败
        nodePath: () => resolveBundledNode(effective.runtime ?? {}).path
      }),
      toolsCfg
    )
  );
  if (Array.isArray(grouped)) entries.push(...grouped);

  if (toolsCfg.audit ?? true) {
    const entry = step('tools:audit', () =>
      registerAuditTool(ctx, {
        assetRoot,
        config: effective,
        makeGuard,
        onResult,
        readStateFor: (projectRoot) => readState(projectRoot)
      })
    );
    if (entry !== undefined) entries.push(entry);
  }

  if ((toolsCfg.pipeline ?? true) && manifest !== undefined) {
    const entry = step('tools:pipeline', () =>
      registerPipelineTool(ctx, { manifest, config: effective, makeGuard, onResult })
    );
    if (entry !== undefined) entries.push(entry);
  }

  // ---- 注册到 ctx：每个工具与其 prompt 段各自隔离 ----
  for (const entry of entries) {
    step(`register:${entry.tool.name}`, () => {
      ctx.tools.register(entry.tool);
      if (entry.prompt !== undefined) {
        ctx.systemPrompt.section({ interpolate: false, ...entry.prompt });
      }
    });
  }

  if (toolsCfg.doctor ?? true) {
    step('tools:doctor', () =>
      registerDoctorTool(ctx, { assetRoot, config: effective.runtime ?? {} })
    );
  }

  // ---- L5 交互层：/sc-* 命令（**独立隔离**：失败绝不能带走技能与工具）----
  if ((pipelineCfg.commands ?? true) && manifest !== undefined) {
    step('commands', () => registerCommands(ctx, { manifest, config: effective }));
  }

  // ---- 启动日志：无论成败都留一条，便于事后定位 ----
  // doctor 是 registerDoctorTool 内部自行注册的，不在 register:* 标签里，单独加 1
  const toolCount =
    ok.filter((label) => label.startsWith('register:')).length + (ok.includes('tools:doctor') ? 1 : 0);
  // 测试进程一律不写（见 isTestProcess）；也允许用配置整体关闭
  const bootLogEnabled = effective.diagnostics?.bootLog ?? true;
  writeBootLog(
    `boot ok=[${ok.join(', ')}] failed=[${failed.map((f) => f.label).join(', ')}] tools=${toolCount}`,
    bootLogEnabled
  );
  for (const failure of failed) {
    writeBootLog(
      `  !! ${failure.label} -> ${failure.error}\n    ${failure.stack.join('\n    ')}`,
      bootLogEnabled
    );
    logger?.warn?.(`softcopyright: section "${failure.label}" failed: ${failure.error}`);
  }
  logger?.info?.(
    `softcopyright: ${toolCount} tool(s) registered` +
      (manifest === undefined
        ? '（⚠ pipeline.yaml 未加载，编排工具未注册）'
        : ` + pipeline ${manifest.phases.length} phases`) +
      (failed.length === 0 ? '' : `（${failed.length} 段失败，见 softcopyright-boot.log）`)
  );
}
