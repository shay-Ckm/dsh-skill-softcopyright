/**
 * dsh-skill-softcopyright —— L3 工具层：5 个 action 分组工具
 *
 * 分组而非一脚本一工具，是为了控制**常驻每次请求的 schema token**（设计文档 §3.3）。
 * 输出信封与 schema 形状由 `registry.js` 统一保证。
 *
 * 每个 action 的关键决策都标在注释里，尤其是：
 * - 走哪条解释器链（generate / render / node）
 * - 哪些路径要过守卫
 * - 哪些脚本的退出码**不可**当结论用（恒 0），必须靠解析器替它判
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  parseAigcScan,
  parseBuildPackage,
  parseCheckInlineJs,
  parseCheckSrcDoc,
  parseExtractDocx,
  parseGenProofDocx,
  parseGenSrcDocx,
  parseInsertAtlas,
  parseManualCheck,
  parseManualStats,
  parseManualWithFigs,
  parsePageEstimate,
  parsePackageSmoke,
  parseProbeResidue,
  parseRenderDocxPdf,
  parseScaleUnits,
  parseShootRealUi,
  parseSourceHashes,
  parseValidateAtlas,
  parseValidateHtml
} from '../adapters/parse.js';
import { buildActionTool } from './registry.js';
import { createScriptRunner, toToolResult } from './scripts.js';

/**
 * 去掉 UTF-8 BOM，返回是否改写过文件。
 *
 * 为什么需要：`gen_proof_docx.py` 用 `json.load(open(p, encoding="utf-8"))` 读配置，
 * **带 BOM 的 JSON 会直接抛 JSONDecodeError**（"Unexpected UTF-8 BOM (decode using utf-8-sig)"）。
 * 而 Windows 上 PowerShell 的 `Set-Content -Encoding utf8`、以及记事本「UTF-8」都会写 BOM ——
 * 真实用户几乎必然踩到，而报错只是一条难懂的 Python traceback。
 * JSON 规范（RFC 8259）本就规定 JSON 文本不得含 BOM，所以移除是纯修复，不改语义。
 */
export function stripUtf8Bom(path) {
  try {
    const buf = readFileSync(path);
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      writeFileSync(path, buf.subarray(3));
      return true;
    }
  } catch {
    /* 读不到就交给脚本自己报错 */
  }
  return false;
}

/**
 * 采图脚本所在的技能目录名（与 scripts.js 的 SKILL_DIRS.manual 一致）。
 */
const SHOOT_SKILL_DIR = 'manual-ui-screenshots';

/**
 * 检查采图脚本是否仍是"未按项目改写"的模板。
 *
 * 技能包里那份 `shoot_real_ui.py` 把 BASE/SCREENS 硬编码成作者自己项目的值
 * （`127.0.0.1:5090`、选择器 `pcRun` / `perception`、以及一行"按说明书图位清单继续补全"的 TODO）。
 * 直接跑这种模板会去连不存在的端口、点不存在的元素，而脚本**可能仍然成功退出** ——
 * 用户拿到错的图或空图集却看不到任何报错。工具描述里的警告挡不住，所以在调用前拦。
 *
 * @returns `{ readable, customized?, hits?, path, error? }`
 */
function inspectShootTemplate(scriptPath) {
  let text;
  try {
    text = readFileSync(scriptPath, 'utf8');
  } catch (error) {
    return { readable: false, path: scriptPath, error: error?.message ?? String(error) };
  }
  const markers = [
    { needle: '127.0.0.1:5090', what: 'BASE 仍是模板默认端口 5090（不是本项目应用的地址）' },
    { needle: 'pcRun', what: 'SCREENS 仍引用模板项目的按钮 id（pcRun）' },
    { needle: 'perception', what: 'SCREENS 仍引用模板项目的面板选择器（perception）' },
    { needle: 'TODO: 按说明书图位清单继续补全', what: 'SCREENS 仍是未补全的模板清单' }
  ];
  const hits = markers.filter((m) => text.includes(m.needle)).map((m) => m.what);
  return { readable: true, customized: hits.length === 0, hits, path: scriptPath };
}

/** 复用参数定义，避免 5 个工具各写一份漂移的文案。 */
const P = {
  docx: { type: 'string', description: '目标 docx 的路径（经文件系统后端解析）' },
  docxOut: { type: 'string', description: '输出 docx/PDF 的路径' },
  expect: { type: 'number', description: '期望的图数；0 或不传 = 用文档内计数自我一致判定' },
  atlasDir: { type: 'string', description: '图集 PNG 目录（如 docs/atlas）' },
  backup: { type: 'boolean', description: '插入前先备份为 _仅图位版.docx（强烈建议开启）' },
  width: { type: 'number', description: '插图宽度 cm，默认 14.6（A4 页宽 21 减左右边距）' },
  pad: { type: 'number', description: '截图文件名数字补零位数，默认 2' },
  imagesDir: { type: 'string', description: '把 docx 内嵌图片解压到该目录' },
  txtOut: { type: 'string', description: '提取出的纯文本输出路径' },
  sourceDir: { type: 'string', description: '源程序目录（软著口径：只含软件本体运行源码）' },
  outPath: { type: 'string', description: '输出文件路径' },
  title: { type: 'string', description: '源代码文档封面的软件名' },
  version: { type: 'string', description: '版本号，如 V1.0' },
  name: { type: 'string', description: '运行包名（不含扩展名）' },
  outDir: { type: 'string', description: '输出目录' },
  sdistOnly: { type: 'boolean', description: '只构建 sdist，不生成 zip' },
  backup: {
    type: 'boolean',
    description:
      'insert-atlas：插图前是否备份为 <同名>_仅图位版.docx。默认开启（插图会删除占位段，不可逆）；仅在明确不需要重跑时传 false'
  },
  allowOverwrite: {
    type: 'boolean',
    description:
      'scale：是否允许**原地覆盖**输入 HTML。默认 false —— 该脚本无备份、不可逆且不幂等（重复执行会叠加倍数），因此未指定 outPath 时必须显式同意覆盖'
  },
  prefix: { type: 'string', description: '哈希清单里相对路径的前缀（如 source/）' },
  oldDocx: { type: 'string', description: '旧版 docx，用于计算 AI 高频词降幅' },
  report: { type: 'string', description: '检测平台导出的标红报告 docx' },
  newDocx: { type: 'string', description: '改写后的 docx' },
  colors: { type: 'string', description: '要检查的标红颜色，逗号分隔，默认「红,橙,紫」' },
  tsv: { type: 'string', description: 'collect-hashes 产出的 TSV 路径' },
  software: { type: 'string', description: '软件名（用于证明文档标题与文件名）' },
  date: { type: 'string', description: '出具日期，如「2026 年 8 月 18 日」' },
  period: { type: 'string', description: '研发周期描述' },
  owner: { type: 'string', description: '著作权人（法律事实，请由用户提供，勿代填）' },
  fileCount: { type: 'number', description: '源文件数（须与四处口径一致）' },
  lineCount: { type: 'number', description: '代码行数（须与四处口径一致）' },
  configJson: { type: 'string', description: '功能说明/技术栈的 JSON 配置路径' },
  logJson: { type: 'string', description: '研发日志内容的 JSON 配置路径' },
  html: { type: 'string', description: '图集 HTML 路径' },
  total: { type: 'number', description: '目标图数' },
  start: { type: 'number', description: '起始图号，默认 1' },
  factor: { type: 'number', description: '缩放倍率，默认 1.5' },
  calib: { type: 'string', description: '参考 docx，用于校准页数模型' },
  render: { type: 'boolean', description: '用 Word COM 取真实页数（本机可用，强烈建议开启）' },
  struct: { type: 'boolean', description: '追加 21 类结构性问题扫描' },
  listTargets: { type: 'boolean', description: '列出可改写的目标段落（输出量大，按需开启）' },
  javascript: { type: 'string', description: '待做语法检查的前端 JS 文件' },
  outTsv: {
    type: 'string',
    description:
      'collect-hashes：把 stdout 的 TSV 写到该文件。sc_proof gen-docx 需要这个文件作为输入 —— 脚本只把 TSV 打到 stdout，不落盘'
  },
  projectRoot: {
    type: 'string',
    description:
      '软著项目根目录（放 docs/ 与源程序目录的那一层）。默认 = 会话工作区；当项目是工作区的子目录时必须显式指定'
  }
};

/**
 * 构建 5 个分组工具。
 *
 * @param options.ctx - 插件 apply() 拿到的 cordis 上下文（工具执行时用它取服务；
 *   `exec` 上没有 `ctx`，必须走闭包）。
 * @param options.assetRoot - 技能资产根目录。
 * @param options.config - 本插件配置（含 runtime 与各工具段）。
 * @param options.makeGuard - `(sessionCwd) => guard`：守卫边界是**每次调用**的会话工作区，
 *   所以逐次构造，而不是 apply() 时定死。
 * @param options.nodePath - 随包 Node 可执行文件（`check_inline_js.js` 用）。
 * @param options.onResult - 证据记录钩子，透传给每个工具的 `buildActionTool`。
 * @returns `[{ tool, prompt }, ...]`
 */
export function buildGroupedTools(options) {
  const { ctx, assetRoot, config = {}, makeGuard, nodePath, onResult } = options;
  const runtime = config.runtime ?? {};
  const sourceCfg = config.source ?? {};
  const manualCfg = config.manual ?? {};
  const aigcCfg = config.aigc ?? {};
  const atlasCfg = config.atlas ?? {};

  /**
   * 统一注入证据钩子 + 可选 `projectRoot`，避免 5 个调用点各写一遍。
   * `projectRoot` 是横切参数：既用于路径守卫/glob 基准，也决定**证据写进哪个项目**的状态文件
   * （与流水线状态保持一致，否则子项目布局下两者会错位）。
   */
  const mk = (toolOptions) =>
    buildActionTool({ sharedParams: ['projectRoot'], ...toolOptions, onResult });

  const runner = createScriptRunner({ assetRoot, config: runtime, nodePath });
  const long = runtime.longTaskTimeoutMs ?? 300000;
  const normal = runtime.defaultTimeoutMs ?? 60000;

  /** 会话工作区：既是子进程 cwd，也是路径守卫的边界。 */
  const cwdOf = (exec) => exec?.agent?.session?.header?.cwd;

  /**
   * 统一包装：构造守卫 → 跑脚本 → 转工具信封。
   * @param exec - 工具执行上下文。
   * @param spec - 传给 runner 的规格；可带 `toolArgs`（原始工具参数，供 afterRun 用）。
   * @param title - 渲染标题。
   * @param afterRun - 可选 `(raw, exec) => string[]`：拿到**未截断**的原始结果做副作用
   *   （例如把 stdout 的 TSV 落盘），返回附加提示。
   */
  const invoke = async (exec, spec, title, afterRun) => {
    const cwd = spec.cwd ?? cwdOf(exec);
    const raw = await runner.run(ctx, {
      ...spec,
      signal: exec.signal,
      cwd,
      guard: makeGuard === undefined ? undefined : makeGuard(cwd)
    });
    if (typeof afterRun === 'function') {
      const extra = await afterRun(raw, exec);
      if (Array.isArray(extra) && extra.length > 0) raw.notes = [...(raw.notes ?? []), ...extra];
    }
    return toToolResult(runner, raw, title);
  };

  // ============================================================ sc_manual
  const manual = mk({
    name: 'sc_manual',
    description:
      'Inspect and edit the software-copyright manual (使用说明书) and produce page counts. Actions: ' +
      'check (format compliance: forbidden arrows/Markdown bold/non-black/italic, figure-caption vs figure-slot count), ' +
      'stats (paragraph/table/figure/char counts and the REAL page count via Word COM), ' +
      'check-figs (verify the illustrated manual: figure captions == images, numbering continuous, placeholder slots removed), ' +
      'insert-atlas (insert docs/atlas PNGs into the figure slots and delete placeholder paragraphs), ' +
      'extract (dump docx paragraphs and optionally extract embedded images), ' +
      'render-pdf (docx→PDF with real page count). ' +
      'ALWAYS prefer action=stats with render=true over any per-page character estimate: the skill explicitly forbids estimating.',
    prompt: {
      name: 'tool:sc_manual',
      order: 220,
      text:
        'Use sc_manual for every 使用说明书 (manual) check, statistic, atlas insertion, text extraction, and PDF render. ' +
        'Real page counts come from Word COM: call sc_manual action=stats with render=true and read pagesSource — never accept a per-page character estimate. ' +
        'The completion criterion for the UI atlas step is the ILLUSTRATED manual docx (action=check-figs passes), not a generated atlas HTML.'
    },
    params: P,
    actions: {
      check: {
        summary: '说明书格式复验（符号/字体/图题=图位）',
        uses: ['docx'],
        run: async ({ args, exec }) =>
          invoke(exec, {
            skill: 'delivery',
            script: 'check_manual_docx.py',
            args: [args.docx],
            parser: parseManualCheck,
            pathArgs: [['docx', args.docx]],
            timeoutMs: normal
          }, '说明书格式复验')
      },
      stats: {
        summary: '规模统计 + 真实页数（默认走 Word COM）',
        uses: ['docx'],
        run: async ({ args, exec }) => {
          const argv = [args.docx];
          if (args.calib !== undefined && args.calib !== '') argv.push('--calib', args.calib);
          const useRender = args.render !== false && manualCfg.pageRender !== false;
          if (useRender) argv.push('--render');
          return invoke(exec, {
            // 只有 Word COM 需要渲染链；不带 --render 时脚本纯读 docx，用生成链即可。
            skill: 'delivery',
            script: 'manual_stats.py',
            args: argv,
            chain: useRender ? 'render' : undefined,
            parser: parseManualStats,
            pathArgs: [
              ['docx', args.docx],
              ['calib', args.calib]
            ],
            timeoutMs: useRender ? long : normal
          }, '说明书规模统计');
        }
      },
      'check-figs': {
        summary: '插图版复验：图题数 == 图片数',
        uses: ['docx'],
        run: async ({ args, exec }) => {
          const argv = [args.docx];
          if (args.expect !== undefined) argv.push('--expect', String(args.expect));
          return invoke(exec, {
            skill: 'manual',
            script: 'check_manual_with_figs.py',
            args: argv,
            parser: parseManualWithFigs,
            pathArgs: [['docx', args.docx]],
            timeoutMs: normal
          }, '插图版说明书复验');
        }
      },
      'insert-atlas': {
        summary: '把图集回填进说明书（写操作）',
        uses: ['docx', 'atlasDir'],
        optional: ['backup'],
        concurrencySafe: false,
        run: async ({ args, exec }) => {
          const argv = [args.docx, args.atlasDir];
          if (args.width !== undefined) argv.push('--width', String(args.width));
          if (args.expect !== undefined) argv.push('--expect', String(args.expect));
          if (args.pad !== undefined) argv.push('--pad', String(args.pad));

          // ⚠️ **默认开启备份**。脚本的 --backup 是**可选项**，不传就不生成
          // `<name>_仅图位版.docx`；但插图是不可逆的（占位段会被删掉），
          // 而脚本自己打印的提示又写着"重跑前请从备份恢复" ——
          // 不默认备份就会出现"提示让你从一份从未生成的备份恢复"。
          // 只有在调用方显式 backup=false 时才跳过。
          const wantBackup = args.backup !== false;
          if (wantBackup) argv.push('--backup');

          return invoke(exec, {
            skill: 'manual',
            script: 'insert_atlas_into_manual.py',
            args: argv,
            parser: parseInsertAtlas,
            pathArgs: [
              ['docx', args.docx],
              ['atlasDir', args.atlasDir]
            ],
            extraNotes: [
              wantBackup
                ? '已在插图前备份为 <同名>_仅图位版.docx；需要重跑时从该备份恢复，否则会二次插图'
                : '⚠ 本次未备份（backup=false）。插图不可逆，重跑前无备份可恢复',
              '插图会显著增加页数（实测约每图 0.4 页）；页数有约束时请先确认再插图',
              '插图后应改用 sc_manual action=check-figs 复验；再对插图版跑 action=check 会得到 figureSlots=0、figureMatch=false（占位段已被消费），并把 p5-1 的门禁证据污染掉'
            ],
            timeoutMs: normal
          }, '图集回填说明书');
        }
      },
      extract: {
        summary: '提取 docx 文本与内嵌图片',
        uses: ['docx', 'txtOut', 'imagesDir'],
        optional: ['txtOut', 'imagesDir'],
        concurrencySafe: false,
        run: async ({ args, exec }) => {
          // ⚠️ **必须替调用方把输出路径定下来**。脚本不传 txtOut 时会把文本写到
          // **子进程的当前目录**（= 会话工作区根），实测在工作区根留下了一个 48 KB 的
          // `多功能AI计算器_使用说明书.txt` —— 与用户项目毫无关系的位置。
          // 只把这件事写成"提示"是不够的（位置是悄悄选的，提示是事后才看到的），
          // 所以这里默认落在 **docx 同目录、同名 .txt**，符合任何人的直觉。
          const txtOut =
            args.txtOut !== undefined && args.txtOut !== ''
              ? args.txtOut
              : join(dirname(args.docx), `${basename(args.docx).replace(/\.[^.]+$/, '')}.txt`);

          const argv = [args.docx, txtOut];
          if (args.imagesDir !== undefined && args.imagesDir !== '') {
            argv.push('--images', args.imagesDir);
          }
          return invoke(exec, {
            skill: 'manual',
            script: 'extract_docx.py',
            args: argv,
            parser: parseExtractDocx,
            pathArgs: [
              ['docx', args.docx],
              ['txtOut', txtOut],
              ['imagesDir', args.imagesDir]
            ],
            extraNotes: [
              args.txtOut !== undefined && args.txtOut !== ''
                ? `文本写到指定的 ${txtOut}`
                : `未指定 txtOut，已默认写到 docx 同目录：${txtOut}（脚本自身会写到子进程 cwd，那会落在会话工作区根）`
            ],
            timeoutMs: normal
          }, 'docx 文本提取');
        }
      },
      'render-pdf': {
        summary: 'docx→PDF 并取真实页数（Word COM）',
        uses: ['docx'],
        run: async ({ args, exec }) => {
          const argv = [args.docx];
          if (args.docxOut !== undefined && args.docxOut !== '') argv.push(args.docxOut);
          return invoke(exec, {
            skill: 'delivery',
            script: 'render_docx_pdf.py',
            args: argv,
            chain: 'render',
            parser: parseRenderDocxPdf,
            pathArgs: [
              ['docx', args.docx],
              ['docxOut', args.docxOut]
            ],
            timeoutMs: long
          }, 'docx→PDF 渲染');
        }
      }
    },
    timeoutMs: long,
    kind: 'manual'
  });

  // ============================================================ sc_source
  const source = mk({
    name: 'sc_source',
    description:
      'Source-code deliverables for software copyright (软著). Actions: ' +
      'gen-doc (generate 源代码文档.docx and print the authoritative file/line counts), ' +
      'check-doc (verify the document matches the sources line by line), ' +
      'build-package (zip + sdist + start.bat; note sdist failure does NOT change the exit code), ' +
      'smoke (run the release-package smoke template inside a clean extracted directory), ' +
      'collect-hashes (per-file SHA-256 TSV + totals), ' +
      'stats-hashes (quick file/line/byte totals). ' +
      'The file/line counts printed here are the SINGLE SOURCE OF TRUTH for the four-way consistency rule ' +
      '(source tree == source doc cover == hash listing == dev log); do not recompute them elsewhere.',
    prompt: {
      name: 'tool:sc_source',
      order: 221,
      text:
        'Use sc_source for every software-copyright source deliverable and for the file/line counts that must stay identical across ' +
        'the source tree, the source-code document cover, the hash listing, and the dev log. ' +
        'build-package can "succeed" with exit code 0 while its sdist step failed — always read the sdistStatus field. ' +
        'smoke runs the bundled template, whose required-file assertions are hard-coded for one project; expect to adjust them per project.'
    },
    params: P,
    actions: {
      'gen-doc': {
        summary: '生成源代码文档 docx（并给出权威 N 文件/M 行）',
        uses: ['sourceDir', 'outPath'],
        concurrencySafe: false,
        run: async ({ args, exec }) => {
          const argv = [args.sourceDir, args.outPath];
          if (args.title !== undefined && args.title !== '') argv.push('--title', args.title);
          if (args.version !== undefined && args.version !== '') argv.push('--version', args.version);
          return invoke(exec, {
            skill: 'delivery',
            script: 'gen_src_docx.py',
            args: argv,
            parser: parseGenSrcDocx,
            pathArgs: [
              ['sourceDir', args.sourceDir],
              ['outPath', args.outPath]
            ],
            extraNotes: [
              '只收录软件本体运行源码：排除 tests/、scripts/、docs/、img/、tmp_*、第三方压缩库',
              '生成后必须跑 check-doc 逐行比对'
            ],
            timeoutMs: normal
          }, '生成源代码文档');
        }
      },
      'check-doc': {
        summary: '源代码文档 ↔ 源码逐行比对',
        uses: ['docx', 'sourceDir'],
        run: async ({ args, exec }) =>
          invoke(exec, {
            skill: 'delivery',
            script: 'check_src_doc.py',
            args: [args.docx, args.sourceDir],
            parser: parseCheckSrcDoc,
            pathArgs: [
              ['docx', args.docx],
              ['sourceDir', args.sourceDir]
            ],
            timeoutMs: normal
          }, '源代码文档一致性校验')
      },
      'build-package': {
        summary: '源码打包（zip + sdist），sdist 失败不改退出码',
        // outDir / name / version / sdistOnly 都是可选的：
        // 注意脚本的 `--out` 参数**必须**接上 args.outDir，否则发布包会被丢进
        // `<sourceDir>/dist/`（源码树内部），既不好看又容易被后续扫描反复碰到。
        uses: ['sourceDir', 'outDir', 'name', 'version'],
        optional: ['outDir', 'name', 'version', 'sdistOnly'],
        concurrencySafe: false,
        run: async ({ args, exec }) => {
          const argv = [args.sourceDir];
          if (args.outDir !== undefined && args.outDir !== '') argv.push('--out', args.outDir);
          if (args.name !== undefined && args.name !== '') argv.push('--name', args.name);
          if (args.version !== undefined && args.version !== '') argv.push('--version', args.version);
          if (args.sdistOnly === true) argv.push('--sdist-only');

          // 打包前记录说明文件是否已存在：只有"本次新建"的才在打包后移走，
          // 用户自己写的同名文件不能动。
          const readmePath = join(args.sourceDir, '安装与启动说明.md');
          const readmeExistedBefore = existsSync(readmePath);

          return invoke(exec, {
            skill: 'delivery',
            script: 'build_src_package.py',
            args: argv,
            parser: parseBuildPackage,
            pathArgs: [
              ['sourceDir', args.sourceDir],
              ['outDir', args.outDir]
            ],
            extraNotes: [
              'P0 陷阱：排除 `_*` 前缀时必须只作用于非 .py 文件，否则 __init__.py 被吞、整个包目录消失',
              '运行包必须保留 echarts.min.js 等前端库；「排除 min.js」只适用于源代码文档'
            ],
            // ⚠️ 脚本会把《安装与启动说明.md》**写进它收到的源码目录**。实测这会污染源码树：
            // 多出一个 .md 后，哈希脚本（收录规则比本插件配置更宽）就会多算一个文件，
            // 于是「哈希清单」与其余三处口径当场分叉（实测 17/4853 vs 16/4831）。
            // 若该文件是本次打包**新建**的（打包前不存在），就把它移到输出目录 —— 那才是它该在的地方。
            afterRun: async () => {
              const notes = [];
              if (!readmeExistedBefore && existsSync(readmePath)) {
                const target = join(args.outDir ?? args.sourceDir, '安装与启动说明.md');
                try {
                  renameSync(readmePath, target);
                  notes.push(
                    `打包脚本会把《安装与启动说明.md》写进源码目录，已移出到 ${target} —— ` +
                      '否则源码树多一个文件，哈希清单会与其余三处口径分叉'
                  );
                } catch (error) {
                  notes.push(
                    `⚠ 打包脚本在源码目录留下了《安装与启动说明.md》，移动失败：${error?.message ?? error}；` +
                      '它会污染源码口径，请手动处理'
                  );
                }
              }
              return notes;
            },
            timeoutMs: long
          }, '源码打包');
        }
      },
      smoke: {
        summary: '发布包冒烟（在解压目录内以该目录为 cwd 运行）',
        uses: ['sourceDir'],
        run: async ({ args, exec }) =>
          invoke(exec, {
            skill: 'delivery',
            script: 'package_smoke_template.py',
            args: [args.sourceDir],
            parser: parsePackageSmoke,
            pathArgs: [['sourceDir', args.sourceDir]],
            // 技能要求：把冒烟脚本复制进解压目录，并以该目录为 cwd 运行，彻底脱离开发树
            cwd: args.sourceDir,
            extraNotes: [
              '以解压目录为 cwd 运行，才能抓到"开发树能跑、交付包不能跑"的丢包问题',
              // 这条提示很重要：模板的断言是给别的项目写的，失败率高不等于交付包坏了。
              // 实测换项目后 total=13 passed=3 failed=10（23.1%），而同一份包在干净目录里
              // 实际能正常运行 —— 若不加这句，很容易把"模板不匹配"误读成"包损坏"。
              '⚠ 本脚本是**模板**：必需文件清单与模块名（如 A1/C/D 组的断言）是给另一个项目硬编码的。' +
                '若 dirMissing=false 而失败项集中在 A1、C*、D*，那是**模板与本项目不匹配，不代表交付包损坏** —— ' +
                '请按提示改这三处断言，或改用真实冒烟（解压到干净目录、实际启动、验接口）'
            ],
            timeoutMs: long
          }, '发布包冒烟')
      },
      'collect-hashes': {
        summary: '逐文件 SHA-256 + 汇总（汇总在 stderr；可用 outTsv 落盘）',
        uses: ['sourceDir', 'outTsv'],
        optional: ['outTsv'],
        run: async ({ args, exec }) => {
          const argv = [args.sourceDir];
          if (args.prefix !== undefined && args.prefix !== '') argv.push('--prefix', args.prefix);
          return invoke(
            exec,
            {
              skill: 'proof',
              script: 'collect_source_hashes.py',
              args: argv,
              parser: (r) => parseSourceHashes(r, 'collect'),
              pathArgs: [['sourceDir', args.sourceDir]],
              extraNotes: ['汇总统计打在 stderr（# TOTAL_FILES=…），解析器已同时捕获两个流'],
              timeoutMs: normal
            },
            '源文件哈希清单',
            // 脚本只把 TSV 打到 stdout；而 sc_proof gen-docx 需要一个 TSV **文件**。
            // 这里替它落盘，否则 p5-5 的哈希清单 docx 根本没法生成。
            async (raw) => {
              if (args.outTsv === undefined || args.outTsv === '') return [];
              const guard = makeGuard?.(raw.__cwd ?? cwdOf(exec));
              const target = args.outTsv;
              try {
                guard?.assert(target, 'outTsv');
                // ⚠️ **必须按配置的源码范围过滤**。`collect_source_hashes.py` 有它自己的
                // 收录规则（比本插件的 `source.includeExt` 更宽）：源码树里只要混进一个
                // 非源码文件（打包副产物、说明文档、压缩包等），哈希清单就会多算文件，
                // 于是「哈希清单」这一处与源代码文档封面、研发日志、源程序目录**四处不一致**。
                // 实测就撞到过：源码树里残留了打包留下的 `安装与启动说明.md` 与 `dist/*.zip`，
                // 哈希清单报 18 文件，而其余三处报 16。
                // 这里统一按 declare 的范围过滤，让四处口径不可能分叉。
                const include = new Set(
                  (sourceCfg.includeExt ?? ['.py']).map((ext) => String(ext).toLowerCase())
                );
                const excludeDirs = sourceCfg.excludeDirs ?? [];
                const keepInitPy = sourceCfg.keepInitPy !== false;
                const inExcludedDir = (relative) => {
                  const segments = relative.split('/').slice(0, -1);
                  return segments.some((segment) =>
                    excludeDirs.some((pattern) =>
                      String(pattern).endsWith('*')
                        ? segment.startsWith(String(pattern).slice(0, -1))
                        : segment === pattern
                    )
                  );
                };

                const kept = [];
                let dropped = 0;
                for (const line of String(raw.stdout ?? '').split(/\r?\n/)) {
                  if (line.trim() === '') continue;
                  const relative = line.split('\t')[0];
                  const dot = relative.lastIndexOf('.');
                  const ext = dot >= 0 ? relative.slice(dot).toLowerCase() : '';
                  const isInit = /(^|\/)__init__\.py$/.test(relative);
                  if (
                    inExcludedDir(relative) ||
                    (isInit ? !keepInitPy : !include.has(ext))
                  ) {
                    dropped += 1;
                    continue;
                  }
                  kept.push(line);
                }

                mkdirSync(dirname(target), { recursive: true });
                writeFileSync(target, kept.join('\n') + (kept.length > 0 ? '\n' : ''), 'utf8');

                const notes = [
                  `TSV 已写入 ${target}（${kept.length} 行）`,
                  'sc_proof action=gen-docx 可直接用这个文件作为 tsv 参数'
                ];
                if (dropped > 0) {
                  notes.push(
                    `已按源码范围剔除 ${dropped} 个非源码文件（哈希脚本自带的收录规则比配置更宽）——` +
                      '这一步保证哈希清单与源代码文档封面、研发日志、源程序目录四处口径一致'
                  );
                }
                return notes;
              } catch (error) {
                return [`TSV 落盘失败（${target}）：${error?.message ?? String(error)}`];
              }
            }
          );
        }
      },
      'stats-hashes': {
        summary: '文件/行/字节汇总（键名与 collect 不同）',
        uses: ['sourceDir'],
        run: async ({ args, exec }) =>
          invoke(exec, {
            skill: 'proof',
            script: 'stats_source_hashes.py',
            args: [args.sourceDir],
            parser: (r) => parseSourceHashes(r, 'stats'),
            pathArgs: [['sourceDir', args.sourceDir]],
            timeoutMs: normal
          }, '哈希统计')
      }
    },
    timeoutMs: long,
    kind: 'source'
  });

  // ============================================================ sc_aigc
  const aigc = mk({
    name: 'sc_aigc',
    description:
      'Audit and reduce AIGC (AI-generated) traces in Chinese technical docx. Actions: ' +
      'scan (count AI high-frequency words, template phrases, sentence-length distribution, and optionally the vocab-reduction percentage against an older revision), ' +
      'struct (add the 21-class structural AI-style scan), ' +
      'probe (verify that every red/orange/purple-flagged paragraph from a detection-platform report is gone from the rewritten docx). ' +
      'IMPORTANT: check_aigc always exits 0 — its exit code carries NO pass/fail meaning. Compare the returned numbers against the configured targets yourself. ' +
      'Also: when the report contains zero flagged paragraphs, probe reports 0 residue trivially; that is NOT evidence of success.',
    prompt: {
      name: 'tool:sc_aigc',
      order: 222,
      text:
        'Use sc_aigc for all AIGC-trace work on the manual (降 AIGC 率). The scanner exits 0 regardless of the result, so judge success by comparing ' +
        'reductionPct against aigc.vocabReductionTarget and structuralTotal against aigc.structuralResidueTarget. ' +
        'When rewriting, keep the structure invariant (figure captions, image count, table count, heading tree) and re-run sc_manual action=check-figs afterwards. ' +
        'Technical terms and specification-style prose must be protected, not rewritten just because they hit an AI word list.'
    },
    params: P,
    actions: {
      scan: {
        summary: 'AI 高频词/模板句式/句长分布扫描（可对比旧版降幅）',
        uses: ['docx'],
        run: async ({ args, exec }) => {
          const argv = [args.docx];
          if (args.listTargets === true) argv.push('--list');
          if (args.oldDocx !== undefined && args.oldDocx !== '') argv.push('--old', args.oldDocx);
          return invoke(exec, {
            skill: 'aigc',
            script: 'check_aigc.py',
            args: argv,
            parser: parseAigcScan,
            pathArgs: [
              ['docx', args.docx],
              ['oldDocx', args.oldDocx]
            ],
            extraNotes: [
              `词汇级降幅目标 ≥ ${Math.round((aigcCfg.vocabReductionTarget ?? 0.5) * 100)}%（配置 aigc.vocabReductionTarget）`,
              '退出码恒 0，不代表达标；请比对上面数值'
            ],
            timeoutMs: normal
          }, 'AIGC 扫描');
        }
      },
      struct: {
        summary: '追加 21 类结构性问题扫描',
        uses: ['docx'],
        run: async ({ args, exec }) => {
          const argv = [args.docx, '--struct'];
          if (args.oldDocx !== undefined && args.oldDocx !== '') argv.push('--old', args.oldDocx);
          return invoke(exec, {
            skill: 'aigc',
            script: 'check_aigc.py',
            args: argv,
            parser: parseAigcScan,
            pathArgs: [
              ['docx', args.docx],
              ['oldDocx', args.oldDocx]
            ],
            extraNotes: [
              `结构性残留目标 = ${aigcCfg.structuralResidueTarget ?? 0}（配置 aigc.structuralResidueTarget）`,
              '技术文档中的被动语态、参数枚举等属合理表达，命中后需人工判断'
            ],
            timeoutMs: normal
          }, 'AIGC 结构扫描');
        }
      },
      probe: {
        summary: '标红段残留探针（报告 vs 改写后）',
        uses: ['report', 'newDocx'],
        run: async ({ args, exec }) => {
          const argv = [args.report, args.newDocx];
          if (args.colors !== undefined && args.colors !== '') argv.push('--colors', args.colors);
          return invoke(exec, {
            skill: 'aigc',
            script: 'probe_residue.py',
            args: argv,
            parser: parseProbeResidue,
            pathArgs: [
              ['report', args.report],
              ['newDocx', args.newDocx]
            ],
            timeoutMs: normal
          }, '标红段残留探针');
        }
      }
    },
    timeoutMs: long,
    kind: 'aigc'
  });

  // ============================================================ sc_proof
  const proof = mk({
    name: 'sc_proof',
    description:
      'Evidence documents for an AIGC correction notice (AIGC 申诉证明). Actions: ' +
      'gen-docx (generate the source-file hash listing and/or the project dev log as docx from a collect-hashes TSV), ' +
      'gen-html (HTML intermediate; only for complex CSS layout), ' +
      'page-estimate (layout-model page estimate — a fallback only; prefer sc_manual stats with render=true), ' +
      'check-inline-js (parse every inline <script> in an HTML file to catch syntax errors that would blank the atlas charts). ' +
      'Legal facts (copyright owner, development period) must come from the user — leave placeholders rather than inventing them. ' +
      'gen_proof_docx always exits 0 even when saving fails, so check the returned generated[] list.',
    prompt: {
      name: 'tool:sc_proof',
      order: 223,
      text:
        'Use sc_proof for AIGC-appeal evidence documents (hash listing + dev log), for the HTML intermediate, for inline-JS syntax checks on the atlas, ' +
        'and for layout-model page estimates. Never fill in copyright owner or development period yourself: leave the placeholder and ask the user. ' +
        'The file/line counts you pass here must equal those reported by sc_source — they are the same four-way consistency contract.'
    },
    params: P,
    actions: {
      'gen-docx': {
        summary: '生成哈希清单/研发日志 docx（保存失败不改退出码）',
        uses: ['tsv', 'outDir', 'software'],
        concurrencySafe: false,
        run: async ({ args, exec }) => {
          const argv = [args.tsv, args.outDir, args.software];
          for (const [flag, value] of [
            ['--version', args.version],
            ['--date', args.date],
            ['--period', args.period],
            ['--owner', args.owner],
            ['--config', args.configJson],
            ['--log', args.logJson]
          ]) {
            if (value !== undefined && value !== '') argv.push(flag, value);
          }
          if (args.fileCount !== undefined) argv.push('--files', String(args.fileCount));
          if (args.lineCount !== undefined) argv.push('--lines', String(args.lineCount));
          // 配置 JSON 若带 UTF-8 BOM，脚本会崩；这里先修掉（见 stripUtf8Bom 注释）
          const bomFixed = [];
          for (const [label, value] of [
            ['configJson', args.configJson],
            ['logJson', args.logJson]
          ]) {
            if (value !== undefined && value !== '' && stripUtf8Bom(value)) bomFixed.push(label);
          }
          return invoke(exec, {
            skill: 'proof',
            script: 'gen_proof_docx.py',
            args: argv,
            parser: parseGenProofDocx,
            pathArgs: [
              ['tsv', args.tsv],
              ['outDir', args.outDir],
              ['configJson', args.configJson],
              ['logJson', args.logJson]
            ],
            extraNotes: [
              '著作权人/研发周期属法律事实，请留占位符并请用户确认',
              '研发日志写成"做决策"口吻，禁止以"实现 xxx"开头，并写入真实函数名/接口路径以便交叉核验',
              '源文件数/代码行数必须与源代码文档封面、哈希清单、源程序目录四处一致',
              ...(bomFixed.length === 0
                ? []
                : [`已自动移除 ${bomFixed.join(', ')} 的 UTF-8 BOM（脚本用 encoding="utf-8" 读取，带 BOM 会崩）`])
            ],
            timeoutMs: normal
          }, '生成申诉证明文档');
        }
      },
      'gen-html': {
        summary: 'HTML 中转产物（仅复杂 CSS 排版时用）',
        uses: ['tsv', 'outPath', 'configJson'],
        concurrencySafe: false,
        run: async ({ args, exec }) =>
          invoke(exec, {
            skill: 'proof',
            script: 'gen_proof_html.py',
            args: [args.tsv, args.outPath, '--config', args.configJson],
            // 该脚本输出格式未纳入精读范围，不做正则解析，只回原始 stdout
            parser: undefined,
            pathArgs: [
              ['tsv', args.tsv],
              ['outPath', args.outPath],
              ['configJson', args.configJson]
            ],
            extraNotes: ['首选中路是 gen-docx（python-docx 直生）；HTML 中转仅在需要复杂 CSS 时使用'],
            timeoutMs: normal
          }, '生成证明文档 HTML')
      },
      'page-estimate': {
        summary: '排版模型估算页数（兜底，优先用 sc_manual stats）',
        uses: ['docx'],
        run: async ({ args, exec }) => {
          const argv = [args.docx];
          if (args.calib !== undefined && args.calib !== '') argv.push('--calib', args.calib);
          return invoke(exec, {
            skill: 'delivery',
            script: 'page_estimate.py',
            args: argv,
            parser: parsePageEstimate,
            pathArgs: [
              ['docx', args.docx],
              ['calib', args.calib]
            ],
            extraNotes: ['这是估算值；技能明确要求页数以真实渲染为准，请优先 sc_manual action=stats render=true'],
            timeoutMs: normal
          }, '页数估算');
        }
      },
      'check-inline-js': {
        summary: '图集 HTML 的内联 JS 语法检查（防整图空白）',
        uses: ['html'],
        run: async ({ args, exec }) =>
          invoke(exec, {
            skill: 'delivery',
            script: 'check_inline_js.js',
            args: [args.html],
            chain: 'node',
            parser: parseCheckInlineJs,
            pathArgs: [['html', args.html]],
            extraNotes: ['图表 init 脚本若有 ReferenceError 会导致整图空白，肉眼不一定看得出'],
            timeoutMs: normal
          }, '内联 JS 语法检查')
      }
    },
    timeoutMs: long,
    kind: 'proof'
  });

  // ============================================================ sc_atlas
  const atlas = mk({
    name: 'sc_atlas',
    description:
      'UI screenshot atlas (界面图集) for software copyright. Actions: ' +
      'validate (atlas HTML: screenshot containers == figure captions, numbering continuous, every chart div has an init reference, 2559x1559 declared), ' +
      'check-html (container/anchor/placeholder/unclosed-tag check against a target figure count), ' +
      'scale (multiply cqw/cqh units in the HTML), ' +
      'shoot (drive REAL Chrome/Edge via Playwright on the running app and capture 2559x1559 screens, then enforce md5 uniqueness). ' +
      'shoot runs on the render Python chain (which has Playwright) and takes minutes. ' +
      'IMPORTANT: shoot_real_ui.py carries its configuration (ROOT/OUT/BASE/SCREENS) hard-coded at the top of the file, so it must be reviewed per project before use.',
    prompt: {
      name: 'tool:sc_atlas',
      order: 224,
      text:
        'Use sc_atlas for the UI figure atlas. Prefer action=shoot (real screenshots of the running app via Playwright + real Chrome) over rebuilding interfaces by hand. ' +
        'After shooting, always run action=validate and require md5 uniqueness: under a 2559x1559 viewport pages often do not scroll, so scroll-top/scroll-bottom pairs can produce identical images that Word then de-duplicates, ' +
        'showing up as "37 captions but 36 images". The atlas step is only finished when sc_manual action=insert-atlas has inserted the images into the manual and action=check-figs passes.'
    },
    params: P,
    actions: {
      validate: {
        summary: '图集 HTML 静态一致性校验',
        uses: ['html'],
        run: async ({ args, exec }) => {
          const argv = [args.html];
          if (args.expect !== undefined) argv.push(String(args.expect));
          return invoke(exec, {
            skill: 'manual',
            script: 'validate_atlas.py',
            args: argv,
            parser: parseValidateAtlas,
            pathArgs: [['html', args.html]],
            timeoutMs: normal
          }, '图集静态校验');
        }
      },
      'check-html': {
        summary: 'HTML 容器/锚点/占位文字/未闭合标签校验',
        uses: ['html'],
        run: async ({ args, exec }) => {
          const argv = [args.html];
          if (args.total !== undefined) argv.push(String(args.total));
          if (args.start !== undefined) argv.push(String(args.start));
          return invoke(exec, {
            skill: 'manual',
            script: 'validate_html.py',
            args: argv,
            parser: parseValidateHtml,
            pathArgs: [['html', args.html]],
            timeoutMs: normal
          }, '图集 HTML 校验');
        }
      },
      scale: {
        summary: '缩放 HTML 的 cqw/cqh 单位（写操作）',
        uses: ['html'],
        optional: ['factor', 'outPath', 'allowOverwrite'],
        concurrencySafe: false,
        run: async ({ args, exec }) => {
          const hasOutput = args.outPath !== undefined && args.outPath !== '';
          const explicitOverwrite = args.allowOverwrite === true;

          // ⚠️ **默认拒绝原地覆盖**（探针实测确认的两个性质）：
          //   1. 脚本**不幂等**：同样参数跑两次会静默叠加（1.5 两次 = 2.25 倍），
          //      文件里没有任何"已缩放倍数"的记录；
          //   2. 不传输出路径时 `target = src`，**原地覆盖且无备份**，原比例不可恢复。
          // 更糟的是上游脚本在成功打印里用了「✔」，在 GBK 控制台会抛 UnicodeEncodeError
          // —— 文件其实**已经写成功**，却以 exit=1 结束。用户以为失败、于是重跑一次，
          // 恰好触发上面第 1 条，把图放大到 2.25 倍。
          // 所以这里要求调用方**显式**选择：给输出路径，或者明确同意覆盖。
          if (!hasOutput && !explicitOverwrite) {
            return {
              ok: false,
              summary:
                'sc_atlas scale 已拦下：未指定 outPath 时该脚本会**原地覆盖**输入文件，\n' +
                '而它是**不可逆**的（无备份），且**不幂等**（同样参数跑两次会叠加：\n' +
                '1.5 两次即 2.25 倍，文件里不记录已缩放倍数）。\n\n' +
                '请二选一：\n' +
                '  - 传 outPath 输出到新文件（推荐）；或\n' +
                '  - 传 allowOverwrite=true，明确同意覆盖原文件。\n\n' +
                '另注：缩放作用于全文所有「数字+cqw/cqh」，包括注释与 JS 字符串字面量。',
              fields: [`html=${args.html}`, `factor=${args.factor ?? 1.5}`, 'needsOutPathOrOverwrite=true']
            };
          }

          const argv = [args.html];
          if (args.factor !== undefined) argv.push(String(args.factor));
          if (hasOutput) argv.push(args.outPath);
          return invoke(exec, {
            skill: 'manual',
            script: 'scale_units.py',
            args: argv,
            parser: parseScaleUnits,
            pathArgs: [
              ['html', args.html],
              ['outPath', args.outPath]
            ],
            extraNotes: [
              hasOutput
                ? `输出到新文件 ${args.outPath}，原文件不动`
                : `⚠ 已按 allowOverwrite=true **原地覆盖** ${args.html}，原比例不再可恢复`,
              '该脚本**不幂等**：不要对同一个文件重复执行，否则倍数会叠加（1.5 两次 = 2.25 倍）',
              '缩放作用于全文所有「数字+cqw/cqh」，注释与 JS 字符串字面量也会被改写'
            ],
            timeoutMs: normal
          }, '图集单位缩放');
        }
      },
      shoot: {
        summary: 'Playwright 驱动真实浏览器逐屏截图（渲染链，耗时长）',
        uses: [],
        concurrencySafe: false,
        run: async ({ args, exec }) => {
          // ⚠️ **前置检查：拒绝直接运行"未按项目改写"的模板脚本。**
          //
          // 技能包里那份 `shoot_real_ui.py` 把 ROOT/OUT/BASE/SCREENS **硬编码成作者自己项目的值**
          // （BASE 指向 127.0.0.1:5090，SCREENS 引用 `pcRun` / `perception` 这类别的项目的选择器）。
          // 直接跑它，要么去连一个不存在的端口、要么点不存在的元素 —— 而无论哪种，
          // 脚本都可能"成功退出"，用户拿到的是错的图或者空的图集，**却没有任何报错**。
          // 只把警告写在工具描述里挡不住这种情况，所以这里直接拦住并给出改造指引。
          const inspect = inspectShootTemplate(join(assetRoot, SHOOT_SKILL_DIR, 'scripts', 'shoot_real_ui.py'));
          if (inspect.readable && !inspect.customized) {
            return {
              ok: false,
              summary:
                'sc_atlas shoot 已拦下：技能包里的 shoot_real_ui.py **仍是未按项目改写的模板**。\n' +
                `  脚本：${inspect.path}\n` +
                '  命中模板特征：\n' +
                inspect.hits.map((h) => `    - ${h}`).join('\n') +
                '\n\n正确做法（技能说明也是这么要求的）：\n' +
                '  1. 把该脚本**复制**到项目 `scripts/shoot_real_ui.py`；\n' +
                '  2. 改配置区：ROOT / OUT / BASE（指向本机正在运行的应用地址）/ SCREENS；\n' +
                '  3. 用渲染链的 Python 直接跑项目里那份（本项目做法见 docs 里的进度记录）。\n' +
                '这样既不改动技能包，也保证拍到的是本项目真实的运行界面。',
              fields: [`templateHits=${inspect.hits.length}`, `script=${inspect.path}`]
            };
          }
          if (!inspect.readable) {
            return {
              ok: false,
              summary: `sc_atlas shoot 无法读取脚本 ${inspect.path}：${inspect.error}`,
              fields: []
            };
          }
          return invoke(exec, {
            skill: 'manual',
            script: 'shoot_real_ui.py',
            args: [],
            chain: 'render',
            parser: parseShootRealUi,
            extraNotes: [
              '该脚本的 ROOT/OUT/BASE/SCREENS 配置硬编码在文件顶部，必须先按项目改好再运行',
              '必须用真实 Chrome/Edge（channel），用 Playwright 自带 chromium 或无头 GPU 会整屏全黑',
              '2559×1559 视口下页面常不滚动，滚顶/滚底易拍出同 md5 的图；脚本末尾的 md5 唯一性校验必须过',
              'md5 唯一 ≠ 有内容：滚到内容之外会得到几乎全白的图但 md5 仍然唯一，务必肉眼抽查文件最小的几张'
            ],
            timeoutMs: atlasCfg.shootTimeoutMs ?? 1800000
          }, '真实界面截图');
        }
      }
    },
    timeoutMs: 1800000,
    kind: 'atlas'
  });

  return [manual, source, aigc, proof, atlas];
}

/** 按配置开关过滤要注册的工具（`tools.<flag> === false` 即不注册）。 */
export function enabledGroupedTools(tools, toolsConfig = {}) {
  const flagOf = {
    sc_manual: 'manual',
    sc_source: 'source',
    sc_aigc: 'aigc',
    sc_proof: 'proof',
    sc_atlas: 'atlas'
  };
  return tools.filter(({ tool }) => toolsConfig[flagOf[tool.name]] !== false);
}
