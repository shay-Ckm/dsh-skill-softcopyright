/**
 * dsh-skill-softcopyright —— 四处口径一致性审计
 *
 * **这是原技能包里完全没有的能力**（设计文档 §5.3.4）。
 *
 * 软著送审的硬要求：四个地方必须报出**同一组「N 个源文件 / M 行代码」**
 *   1. 源程序目录（实际文件系统）
 *   2. 源代码文档 docx 封面
 *   3. 哈希值清单 docx
 *   4. 项目研发日志 docx
 *
 * SKILL.md 里写着"任何一步收窄范围，其余三处同步改"，但**没有任何脚本负责交叉校验** ——
 * 用户历史上实测过 29/4338 → 26/4103 → 17/2324 两轮收窄，全靠人肉核对。这里把它机械化。
 *
 * 读 docx 用**内联 python 程序**（复用 `runPythonInline`），不依赖任何技能脚本的输出格式，
 * 因此上游脚本改版不会影响审计。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { runPythonInline } from '../runtime.js';

/** 把 docx 段落文本以 JSON 数组输出的小程序（只用 python-docx，随包自带）。 */
const DOCX_TEXT_PROGRAM = [
  'import sys, json',
  'from docx import Document',
  'doc = Document(sys.argv[1])',
  'paras = [p.text for p in doc.paragraphs if p.text and p.text.strip()]',
  'print(json.dumps(paras, ensure_ascii=False))'
].join('\n');

/** 把 docx 表格+段落一并输出（哈希清单的条目可能在表格里）。 */
const DOCX_FULL_PROGRAM = [
  'import sys, json',
  'from docx import Document',
  'doc = Document(sys.argv[1])',
  'out = {"paragraphs": [p.text for p in doc.paragraphs if p.text and p.text.strip()],',
  '       "tables": [[[c.text for c in row.cells] for row in t.rows] for t in doc.tables]}',
  'print(json.dumps(out, ensure_ascii=False))'
].join('\n');

/**
 * 读取 docx 的全部文本（段落 + 表格单元格），供各种口径解析。
 * @returns `{ paragraphs, tables, flat }`；失败返回 `{ error }`。
 */
export async function readDocxText(ctx, options) {
  const { docxPath, pythonPath, cwd, signal, timeoutMs = 60000 } = options;
  const result = await runPythonInline(ctx, DOCX_FULL_PROGRAM, {
    pythonPath,
    cwd,
    args: [docxPath],
    signal,
    timeoutMs,
    maxBytes: 8 * 1024 * 1024
  });
  if (result.json === undefined) {
    return {
      error:
        `cannot read ${docxPath}: ` +
        (result.stderr?.trim().slice(0, 300) || `exit ${result.exitCode}`)
    };
  }
  const paragraphs = result.json.paragraphs ?? [];
  const tables = result.json.tables ?? [];
  const flat = [...paragraphs, ...tables.flat(3)].filter((t) => typeof t === 'string');
  return { paragraphs, tables, flat };
}

/**
 * 统计代码行数 —— **必须与上游脚本口径一致**。
 *
 * 上游用的是 Python 的 `f.read().splitlines()`（gen_src_docx.py）与
 * `fh.readlines()`（collect_source_hashes.py），两者对行数的判定相同：
 * 结尾换行符**不**产生额外一行，所以 `"a\nb\nc\n"` 是 **3 行**而不是 4 行。
 *
 * 第一版我写的是 `text.split(/\r?\n/).length`，会多算 1 行 —— 而「M 行代码」正是
 * 报给软著审查、并被本模块四处交叉核对的数字之一。口径不一致会让审计**误报不一致**，
 * 恰好与它的用途相反。这里显式实现 splitlines 语义，并用测试锁住。
 *
 * 与 splitlines 的差别只在极端控制字符（\v \f \x1c \x85 \u2028 等）；源码文件不会出现。
 */
export function countSourceLines(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const parts = text.split(/\r\n|\r|\n/);
  // 只丢掉「结尾换行符造成的」那一个空元素，内部空行照数（与 splitlines 一致）
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

/** 统计目录下符合软著口径的源文件数与代码行数。 */
export function collectSourceStats(sourceDir, rules = {}) {
  const includeExt = rules.includeExt ?? ['.py'];
  const excludeDirs = rules.excludeDirs ?? [];
  const keepInitPy = rules.keepInitPy !== false;

  /** excludeDirs 支持 `tmp_*` 这类前缀通配。 */
  const excluded = (name) =>
    excludeDirs.some((pattern) => {
      if (typeof pattern !== 'string' || pattern.length === 0) return false;
      if (pattern.includes('*')) {
        const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
        return re.test(name);
      }
      return name.toLowerCase() === pattern.toLowerCase();
    });

  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (excluded(entry.name)) continue;
        walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      // ★ P0 陷阱：排除规则绝不能吞掉 __init__.py（否则整个包目录会从交付包消失）
      const isInit = entry.name === '__init__.py';
      if (!isInit && excluded(entry.name)) continue;
      if (!isInit && !includeExt.includes(extname(entry.name))) continue;
      if (isInit && !keepInitPy) continue;
      const path = join(dir, entry.name);
      let text = '';
      let bytes = 0;
      try {
        bytes = statSync(path).size;
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      files.push({
        path,
        bytes,
        lines: countSourceLines(text)
      });
    }
  };
  walk(sourceDir);

  return {
    files: files.length,
    lines: files.reduce((n, f) => n + f.lines, 0),
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    entries: files
  };
}

/** 从任意文本集合里找「共 N 个源文件，M 行代码」这类声明。 */
export function parseDeclaredCounts(texts) {
  const joined = Array.isArray(texts) ? texts.join('\n') : String(texts ?? '');
  const patterns = [
    /共\s*(\d+)\s*个源文件[，,、\s]*(\d+)\s*行代码/,
    /(\d+)\s*个源文件[，,、\s]*(\d+)\s*行代码/,
    /源文件[数：:\s]*(\d+)[\s\S]{0,20}?代码行数[：:\s]*(\d+)/,
    /文件数[：:\s]*(\d+)[\s\S]{0,20}?(?:总)?行数[：:\s]*(\d+)/
  ];
  for (const pattern of patterns) {
    const m = pattern.exec(joined);
    if (m !== null) return { files: Number(m[1]), lines: Number(m[2]), raw: m[0].trim() };
  }
  // 只声明了文件数也算部分信息
  const onlyFiles = /(\d+)\s*个源文件/.exec(joined);
  if (onlyFiles !== null) return { files: Number(onlyFiles[1]), lines: undefined, raw: onlyFiles[0].trim() };
  return undefined;
}

/** 数一份文档里 SHA-256 条目数（哈希清单的体量口径）。 */
export function countHashEntries(texts) {
  const joined = Array.isArray(texts) ? texts.join('\n') : String(texts ?? '');
  const matches = joined.match(/\b[0-9a-f]{64}\b/gi);
  return matches === null ? 0 : matches.length;
}

/**
 * 执行四处口径审计。
 *
 * @param ctx - cordis 上下文（取 subprocess seam）。
 * @param options.projectRoot - 项目根。
 * @param options.sourceDir - 源程序目录（软著口径：只含软件本体运行源码）。
 * @param options.sourceRules - `{ includeExt, excludeDirs, keepInitPy }`。
 * @param options.docs - `{ sourceDoc, hashListing, devLog }` 三份 docx 路径（可为空）。
 * @param options.pythonPath - 生成链 Python（读 docx 用）。
 * @param options.expected - 可选：调用方已知的期望值（来自 sharedFacts），用于交叉核对。
 */
export async function auditFourWay(ctx, options) {
  const {
    projectRoot,
    sourceDir,
    sourceRules = {},
    docs = {},
    pythonPath,
    signal,
    expected,
    timeoutMs = 60000
  } = options;

  const observations = {};
  const notes = [];

  // ---- 1) 源程序目录 ----
  let tree;
  try {
    tree = collectSourceStats(sourceDir, sourceRules);
    observations.sourceTree = { files: tree.files, lines: tree.lines, bytes: tree.bytes, scope: sourceDir };
  } catch (error) {
    observations.sourceTree = { error: error?.message ?? String(error) };
    notes.push(`源程序目录不可读：${sourceDir}`);
  }

  // ---- 2/3/4) 三份 docx ----
  const readOne = async (label, path, parse) => {
    if (path === undefined || path === null || path === '') {
      observations[label] = { missing: true };
      return;
    }
    const text = await readDocxText(ctx, { docxPath: path, pythonPath, cwd: projectRoot, signal, timeoutMs });
    if (text.error !== undefined) {
      observations[label] = { path, error: text.error };
      notes.push(`${label} 读取失败：${text.error}`);
      return;
    }
    observations[label] = { path, ...parse(text) };
  };

  await readOne('sourceDocCover', docs.sourceDoc, (text) => {
    const declared = parseDeclaredCounts(text.flat);
    return declared === undefined
      ? { declared: undefined, note: '封面未找到「共 N 个源文件，M 行代码」声明' }
      : { files: declared.files, lines: declared.lines, declared: declared.raw };
  });

  await readOne('hashListing', docs.hashListing, (text) => {
    const declared = parseDeclaredCounts(text.flat);
    return {
      hashEntries: countHashEntries(text.flat),
      files: declared?.files,
      lines: declared?.lines,
      declared: declared?.raw
    };
  });

  await readOne('devLog', docs.devLog, (text) => {
    const declared = parseDeclaredCounts(text.flat);
    return declared === undefined
      ? { declared: undefined, note: '研发日志未找到文件数/行数声明' }
      : { files: declared.files, lines: declared.lines, declared: declared.raw };
  });

  // ---- 交叉比对 ----
  const comparable = ['sourceTree', 'sourceDocCover', 'hashListing', 'devLog'];
  const present = comparable.filter((k) => observations[k] !== undefined && observations[k].error === undefined && observations[k].missing !== true);
  const fileValues = new Map();
  const lineValues = new Map();
  for (const key of present) {
    const o = observations[key];
    if (typeof o.files === 'number') {
      if (!fileValues.has(o.files)) fileValues.set(o.files, []);
      fileValues.get(o.files).push(key);
    }
    if (typeof o.lines === 'number') {
      if (!lineValues.has(o.lines)) lineValues.set(o.lines, []);
      lineValues.get(o.lines).push(key);
    }
  }
  // 哈希清单的"文件数"若来自哈希条目数，也算一个文件口径
  if (typeof observations.hashListing?.hashEntries === 'number' && observations.hashListing.hashEntries > 0) {
    const v = observations.hashListing.hashEntries;
    if (!fileValues.has(v)) fileValues.set(v, []);
    fileValues.get(v).push('hashListing(hashEntries)');
  }

  const okFiles = fileValues.size <= 1 && present.length >= 2;
  const okLines = lineValues.size <= 1 && [...lineValues.keys()].length > 0;

  const blockers = [];
  if (fileValues.size > 1) {
    blockers.push(
      [...fileValues.entries()].map(([v, keys]) => `${keys.join(' / ')} 报 ${v} 个源文件`).join('；')
    );
  }
  if (lineValues.size > 1) {
    blockers.push([...lineValues.entries()].map(([v, keys]) => `${keys.join(' / ')} 报 ${v} 行代码`).join('；'));
  }
  if (present.length < 2) {
    blockers.push(`可比较的口径不足（只有 ${present.length} 处），无法交叉核对`);
  }
  if (expected !== undefined && typeof expected.sourceFiles === 'number' && tree !== undefined) {
    if (expected.sourceFiles !== tree.files || expected.sourceLines !== tree.lines) {
      blockers.push(
        `sharedFacts 记录的 ${expected.sourceFiles}/${expected.sourceLines} 与源程序目录实测 ${tree.files}/${tree.lines} 不一致`
      );
    }
  }

  const summary =
    blockers.length === 0
      ? `${tree?.files ?? '?'} 个源文件 / ${tree?.lines ?? '?'} 行代码，${present.length} 处口径一致`
      : blockers.join(' | ');

  return {
    ok: blockers.length === 0,
    observations,
    blocks: blockers,
    notes,
    summary,
    fixHint:
      blockers.length === 0
        ? undefined
        : '以源程序目录实测值为准，重新生成其余三处（sc_source gen-doc / collect-hashes、sc_proof gen-docx），勿手改单个文档'
  };
}

export { DOCX_TEXT_PROGRAM, DOCX_FULL_PROGRAM };
