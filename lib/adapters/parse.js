/**
 * dsh-skill-softcopyright —— 脚本输出解析器（纯函数，可脱离 DSH 单测）
 *
 * 存在的理由：这 20 个脚本是"给人看"的中文文本输出，不适合工具直接消费。设计上
 * **不修改原脚本**（保持与上游技能零分叉），而是在这里把它们解析成结构化字段。
 *
 * ## 三条必须尊重的语义（来自逐脚本精读，别想当然）
 *
 * 1. **退出码语义分三类**：
 *    - `verdict`：0=通过 / 1=不通过（check_manual_docx、manual_stats、check_src_doc、
 *      check_manual_with_figs、validate_atlas、validate_html、probe_residue、
 *      check_inline_js、package_smoke_template）
 *    - `none`：恒定 0，**退出 0 也可能业务失败**（page_estimate、check_aigc、
 *      build_src_package、gen_src_docx、gen_proof_docx、collect/stats_source_hashes、
 *      insert_atlas_into_manual、scale_units）→ 必须解析数字或扫关键字
 *    - `usage`：2 = 参数/用法错误（不是校验不通过）
 *
 * 2. **两个哈希脚本的汇总统计打在 stderr**，且键名不同：
 *    `collect_source_hashes.py` → `# TOTAL_FILES=… TOTAL_LINES=… TOTAL_BYTES=…`
 *    `stats_source_hashes.py`   → `# FILES=… LINES=… BYTES=…`
 *
 * 3. **布尔是 Python 原文 `True`/`False`**；名称与数值间的空格数被 `%-14s` 之类的
 *    填宽影响，正则一律用 `\s+`；`Markdown**` 的 `*` 与各类括号必须转义。
 *
 * 每个解析器返回：
 *   `{ ran, ok, fields, notes }`
 *   - `ran`  脚本是否给出了可用的结论（false = 用法错误/崩溃，调用方应报错而非判"不通过"）
 *   - `ok`   业务结论是否通过
 *   - `fields` 结构化数字（`key: value`），由工具层拼成 `key=value` 行
 *   - `notes` 值得单独提醒的人工判断点
 */

/** 退出码 2（argparse/用法错误）不算"失败结论"，算"没跑起来"。 */
const USAGE_EXIT = 2;

/** 取第一个捕获组为数字。 */
function num(text, pattern) {
  const m = pattern.exec(text);
  if (m === null) return undefined;
  const value = Number(m[1]);
  return Number.isFinite(value) ? value : undefined;
}

/** 取第一个捕获组为字符串（已 trim）。 */
function str(text, pattern) {
  const m = pattern.exec(text);
  return m === null ? undefined : m[1].trim();
}

/** 取 Python 原文布尔。 */
function bool(text, pattern) {
  const value = str(text, pattern);
  if (value === undefined) return undefined;
  return value === 'True';
}

/**
 * 从自由文本里抽取所有匹配。
 *
 * ⚠️ 必须带 `m` 标志：本文件里几乎所有模式都用 `^`/`$` 做**行**锚点，而脚本输出是
 * 多行文本。第一版只加了 `g`，导致所有 `^...$` 模式静默匹配为空 —— 这类"静默空结果"
 * 比抛错危险得多，是靠 test/parsers.mjs 才抓出来的。
 */
export function findAll(text, pattern) {
  const out = [];
  for (const m of text.matchAll(new RegExp(pattern, 'gm'))) out.push(m);
  return out;
}

/** 结尾是否出现该结论行。 */
function has(text, needle) {
  return text.includes(needle);
}

// ---------------------------------------------------------------- 1. 说明书复验
/** `check_manual_docx.py` —— 格式复验。退出码即结论。 */
export function parseManualCheck({ stdout, exitCode }) {
  const figurePos = /图题\/图位\s+图题=(\d+)\s+图位=(\d+)\s+一致=(True|False)/.exec(stdout);
  return {
    ran: exitCode === 0 || exitCode === 1,
    ok: exitCode === 0,
    fields: {
      arrows: num(stdout, /^箭头符号\s+(\d+)$/m),
      markdownBold: num(stdout, /^Markdown\*\*\s+(\d+)$/m),
      nonBlack: num(stdout, /^非黑颜色\s+(\d+)$/m),
      italic: num(stdout, /^斜体\s+(\d+)$/m),
      figureCaptions: figurePos === null ? undefined : Number(figurePos[1]),
      figureSlots: figurePos === null ? undefined : Number(figurePos[2]),
      figureMatch: figurePos === null ? undefined : figurePos[3] === 'True'
    },
    notes: has(stdout, '结论: 未通过') ? ['复验未通过，见上方未达标项'] : []
  };
}

// ---------------------------------------------------------------- 2. 规模统计
/** `manual_stats.py` —— 规模统计。退出码是"规模是否达标"，不是"脚本是否出错"。 */
export function parseManualStats({ stdout, exitCode }) {
  const pages = /页数（(.+?)）:\s*([\d.]+)\s*页/.exec(stdout);
  const estimate = /页数估计区间\s*:\s*([\d.]+)\s*~\s*([\d.]+)\s*页/.exec(stdout);
  const notes = [];
  if (pages === null && estimate !== null) {
    notes.push('未取到真实页数（用了估计区间）—— 技能明确不推荐经验法，建议确认 --render 是否生效');
  }
  if (has(stdout, '[提示] --render 失败')) {
    notes.push('Word COM 渲染失败，页数已回退为估计值');
  }
  return {
    ran: exitCode === 0 || exitCode === 1,
    ok: exitCode === 0,
    fields: {
      paragraphs: num(stdout, /^段落数\(非空\)\s*:\s*(\d+)$/m),
      tables: num(stdout, /^表格数\s*:\s*(\d+)$/m),
      figureCaptions: num(stdout, /^图题数\s*:\s*(\d+)$/m),
      figureSlots: num(stdout, /^图位数\(占位说明\)\s*:\s*(\d+)$/m),
      chars: num(stdout, /^正文字符数\(含表格\)\s*:\s*(\d+)$/m),
      pages: pages === null ? undefined : Number(pages[2]),
      pagesSource: pages === null ? undefined : pages[1],
      pagesEstimateLow: estimate === null ? undefined : Number(estimate[1]),
      pagesEstimateHigh: estimate === null ? undefined : Number(estimate[2]),
      verdict: str(stdout, /^达标判定:\s*(.+)$/m)
    },
    notes
  };
}

// ---------------------------------------------------------------- 3. 页数估算
/** `page_estimate.py` —— 退出码无意义（缺参才 1）。 */
export function parsePageEstimate({ stdout, exitCode }) {
  const pages = num(stdout, /^估算页数:\s*([\d.]+)\s*页$/m);
  return {
    ran: pages !== undefined,
    ok: pages !== undefined,
    fields: {
      pages,
      bodyHeightCm: num(stdout, /正文\s*([\d.]+)\s*cm/),
      tableHeightCm: num(stdout, /表格\s*([\d.]+)\s*cm/),
      imageHeightCm: num(stdout, /内嵌图\s*([\d.]+)\s*cm/)
    },
    notes: exitCode === 0 && pages === undefined ? ['未解析到估算页数，请查看原始输出'] : []
  };
}

// ---------------------------------------------------------------- 3b. docx→PDF
/** `render_docx_pdf.py` —— 走渲染链（Word COM）；无 CLI flag，缺 pywin32 时顶层 import 直接崩。 */
export function parseRenderDocxPdf({ stdout, stderr, exitCode }) {
  const pages = num(stdout, /真实页数\s*:\s*(\d+)/);
  const pdf = str(stdout, /^PDF\s*:\s*(.+)$/m);
  const notes = [];
  if (exitCode !== 0 && stdout.trim().length === 0) {
    notes.push(
      `脚本无输出即失败：该脚本在顶层 import win32com.client，缺 pywin32 会直接崩。stderr: ${stderr.trim().slice(0, 200)}`
    );
  }
  return {
    ran: exitCode === 0 && (pages !== undefined || pdf !== undefined),
    ok: exitCode === 0 && pdf !== undefined,
    fields: {
      pdfPath: pdf,
      pages,
      pagesSource: pages === undefined ? undefined : 'word-com',
      words: num(stdout, /Word统计字数\s*:\s*(\d+)/),
      chars: num(stdout, /Word统计字符\s*:\s*(\d+)/)
    },
    notes
  };
}

// ---------------------------------------------------------------- 4. 源码文档一致性
/** `check_src_doc.py` —— 文档↔源码逐行比对。退出码即结论。 */
export function parseCheckSrcDoc({ stdout, exitCode }) {
  const mismatched = findAll(stdout, '^\\s+(\\S+)\\s+X\\s+差异\\s+(\\d+)\\s+处').map((m) => `${m[1]}(${m[2]}处)`);
  const missing = findAll(stdout, '^\\s+\\[警告\\]\\s+源码缺失:\\s*(.+)$').map((m) => m[1].trim());
  const consistentFiles = findAll(stdout, '^\\s+(\\S+)\\s+OK\\s+一致\\((\\d+)行\\)').length;
  return {
    ran: exitCode === 0 || exitCode === 1,
    ok: exitCode === 0,
    fields: {
      verdict: str(stdout, /^完整性:\s*(.+)$/m),
      consistentFiles,
      mismatchedFiles: mismatched.length === 0 ? undefined : mismatched.length,
      mismatched: mismatched.slice(0, 20),
      missingFromSource: missing.length === 0 ? undefined : missing.length
    },
    notes: missing.length > 0 ? ['源码缺失文件（文档里有、源码里没有）'] : []
  };
}

// ---------------------------------------------------------------- 5. 生成源码文档
/** `gen_src_docx.py` —— 恒 0（除非保存失败）；统计行是四处口径的来源之一。 */
export function parseGenSrcDocx({ stdout, exitCode }) {
  const generated = findAll(stdout, '^已生成:\\s*(.+)$').map((m) => m[1].trim());
  const stats = /^文件数:\s*(\d+)\s*\|\s*代码行数:\s*(\d+)$/m.exec(stdout);
  const savedFail = /保存失败（目标与 _V2~_V10 均被占用）/.test(stdout);
  return {
    ran: exitCode === 0 || generated.length > 0,
    ok: exitCode === 0 && generated.length > 0 && !savedFail,
    fields: {
      outPath: generated.at(-1),
      files: stats === null ? undefined : Number(stats[1]),
      lines: stats === null ? undefined : Number(stats[2])
    },
    notes: savedFail
      ? ['目标文件被占用，已另存为 _V2~_V10 之一 —— 请关闭已打开的 docx 后重跑']
      : has(stdout, '已跳过单行超长')
        ? ['有单行超长文件被跳过（疑似压缩/内联产物）']
        : []
  };
}

// ---------------------------------------------------------------- 6. 源码打包
/** `build_src_package.py` —— 恒 0；**sdist 失败不改退出码**，必须扫关键字。 */
export function parseBuildPackage({ stdout, exitCode }) {
  const zip = /已生成 zip:\s*(.+?)\s*\|\s*文件数:\s*(\d+)/.exec(stdout);
  const sdistPath = str(stdout, /^已生成 sdist 到:\s*(.+)$/m);
  const sdistFailed = /sdist 构建失败/.test(stdout);
  const sdistSkipped = /跳过 sdist/.test(stdout);
  // 参数不足时脚本打 __doc__ 并 exit 1
  const ran = exitCode === 0 && (zip !== null || sdistPath !== undefined || sdistFailed || sdistSkipped);
  return {
    ran,
    // sdist 失败是"业务失败"：脚本不会因此改退出码，所以这里替它判
    ok: ran && !sdistFailed,
    fields: {
      zipPath: zip === null ? undefined : zip[1].trim(),
      zipFiles: zip === null ? undefined : Number(zip[2]),
      sdistPath,
      sdistStatus: sdistFailed ? 'failed' : sdistSkipped ? 'skipped' : sdistPath ? 'ok' : undefined
    },
    notes: [
      ...(sdistFailed ? ['sdist 构建失败（脚本不改退出码，此处已替它判定为失败）'] : []),
      ...(sdistSkipped ? ['项目无 pyproject.toml，已跳过 sdist'] : [])
    ]
  };
}

// ---------------------------------------------------------------- 7. 发布包冒烟
/** `package_smoke_template.py` —— 退出码即结论；2 = 目录不存在。 */
export function parsePackageSmoke({ stdout, exitCode }) {
  const totals = /用例总数:\s*(\d+)\s+通过:\s*(\d+)\s+失败:\s*(\d+)\s+通过率:\s*([\d.]+)%/.exec(stdout);
  const failedCases = findAll(stdout, '^\\[FAIL\\]\\s+(\\S+)').map((m) => m[1]);
  return {
    ran: exitCode === 0 || exitCode === 1,
    ok: exitCode === 0,
    fields: {
      total: totals === null ? undefined : Number(totals[1]),
      passed: totals === null ? undefined : Number(totals[2]),
      failed: totals === null ? undefined : Number(totals[3]),
      passRatePct: totals === null ? undefined : Number(totals[4]),
      failedCases: failedCases.slice(0, 15),
      dirMissing: exitCode === USAGE_EXIT
    },
    notes: [
      ...(exitCode === USAGE_EXIT ? ['包根目录不存在'] : []),
      '这是模板脚本：BMS 平台的必需文件清单与模块名是硬编码的，换项目须改 A1/C/D 三处断言'
    ]
  };
}

// ---------------------------------------------------------------- 8. 内联 JS 语法
/**
 * `check_inline_js.js` —— 退出码即结论，字段来自输出文本。
 *
 * ⚠️ **必须容忍行首缩进**：该脚本的明细行是**两空格缩进**的
 * （`  inline script #1: SYNTAX ERROR -> ...`），而汇总行不缩进
 * （`ALL OK (...)` / `FAILED: N block(s) ...`）。
 * 第一版明细正则写成 `^inline script #…`，锚定在行首 —— 于是**永远匹配不到**，
 * `syntaxErrors` 恒为 0：判定（FAILED）是对的，但字段是假的。
 * 这与会话早期修过的 Bug C（`^…$` 行模式全部静默失配）是同一类问题。
 */
export function parseCheckInlineJs({ stdout, exitCode }) {
  const okBlocks = num(stdout, /^ALL OK \((\d+) inline script blocks\)$/m);
  const badBlocks = num(stdout, /^FAILED: (\d+) block\(s\) with syntax errors$/m);
  const errors = findAll(stdout, '^\\s*inline script #(\\d+): SYNTAX ERROR -> (.+)$').map(
    (m) => `#${m[1]}: ${m[2].trim()}`
  );
  return {
    ran: exitCode === 0 || exitCode === 1,
    ok: exitCode === 0,
    fields: {
      blocks: okBlocks ?? badBlocks,
      syntaxErrors: errors.length
    },
    notes: errors.slice(0, 10)
  };
}

// ---------------------------------------------------------------- 9. 插图版说明书复验
/** `check_manual_with_figs.py` —— 图题数 == 图片数 是 Phase 5.2 的完成判据。 */
export function parseManualWithFigs({ stdout, exitCode }) {
  const line = /图题\/图片\s+图题=(\d+)\s+图片=(\d+)\s+一致=(True|False)；\s*图号连续=(True|False)；\s*残留占位段=(\d+)；\s*表格=(\d+)/.exec(
    stdout
  );
  const notes = [];
  if (has(stdout, '图题≠图片通常意味着有重复截图')) {
    notes.push('图题≠图片：常见原因是重复截图被 Word 去重 —— 对 docs/atlas/*.png 做 md5 查重后重拍');
  }
  return {
    ran: exitCode === 0 || exitCode === 1,
    ok: exitCode === 0,
    fields: {
      figureCaptions: line === null ? undefined : Number(line[1]),
      images: line === null ? undefined : Number(line[2]),
      figureMatch: line === null ? undefined : line[3] === 'True',
      numberingContinuous: line === null ? undefined : line[4] === 'True',
      placeholdersLeft: line === null ? undefined : Number(line[5]),
      tables: line === null ? undefined : Number(line[6]),
      arrows: num(stdout, /^箭头符号\s+(\d+)$/m)
    },
    notes
  };
}

// ---------------------------------------------------------------- 10. 提取 docx
/** `extract_docx.py` —— 成功无显式退出码；非 docx 时 exit 1 且错误在 stderr。 */
export function parseExtractDocx({ stdout, stderr, exitCode }) {
  const paragraphs = /已提取\s+(\d+)\s+个段落\s*->\s*(.+)$/m.exec(stdout);
  const referenced = num(stdout, /正文实际引用\s+(\d+)\s+张图片/);
  const extracted = num(stdout, /已解压\s+(\d+)\s+张图片/);
  const notes = [];
  if (has(stdout, '为占位框')) notes.push('说明书的「图N」是占位框，需按图题+上下文+源码重建界面');
  if (has(stdout, '正文未引用')) notes.push('word/media 里有正文未引用的资源（可能是残留图片）');
  return {
    ran: exitCode === 0 || paragraphs !== null,
    ok: exitCode === 0 && paragraphs !== null,
    fields: {
      paragraphs: paragraphs === null ? undefined : Number(paragraphs[1]),
      outPath: paragraphs === null ? undefined : paragraphs[2].trim(),
      referencedImages: referenced,
      extractedImages: extracted,
      stderr: exitCode !== 0 ? stderr.trim().slice(0, 200) : undefined
    },
    notes
  };
}

// ---------------------------------------------------------------- 11. 图集回填说明书
/** `insert_atlas_into_manual.py` —— 「已有 N 处图片」只是警告、**不改退出码**，必须视为需人工确认。 */
export function parseInsertAtlas({ stdout, exitCode }) {
  const inserted = num(stdout, /已插入图片\s+(\d+)\s+张并移除占位段/);
  const already = num(stdout, /文档内已有\s+(\d+)\s+处图片，疑似已插图过/);
  const captions = /发现图题\s+(\d+)\s+处，其中带占位段\s+(\d+)\s+处/.exec(stdout);
  const notes = [];
  if (already !== undefined) {
    notes.push(
      `文档内已有 ${already} 处图片，疑似已插图过 —— 二次插图会产生重复图。` +
        '请先从 _仅图位版.docx 备份恢复再重跑（或确认这就是你要的）'
    );
  }
  if (has(stdout, '警告：图号不连续')) notes.push('图号不连续，请核对图题编号');
  return {
    ran: inserted !== undefined || already !== undefined || captions !== null,
    // 已插图过属"业务需人工确认"，判为不通过以免静默二次插图
    ok: exitCode === 0 && inserted !== undefined && already === undefined,
    fields: {
      insertedImages: inserted,
      existingImages: already,
      captions: captions === null ? undefined : Number(captions[1]),
      captionsWithPlaceholder: captions === null ? undefined : Number(captions[2]),
      backupPath: str(stdout, /^已备份\s*->\s*(.+)$/m),
      nextStep: str(stdout, /^下一步：(.+)$/m)
    },
    notes
  };
}

// ---------------------------------------------------------------- 12. 图集静态校验
/** `validate_atlas.py` —— 退出码即结论。 */
export function parseValidateAtlas({ stdout, exitCode }) {
  const containers = /截图容器数:\s*(\d+)\s*\|\s*图注数:\s*(\d+)\s*\|\s*编号连续:\s*(True|False)/.exec(stdout);
  const expected = /预期图数:\s*(\d+)\s*\|\s*实际:\s*(\d+)\s*\|\s*一致:\s*(True|False)/.exec(stdout);
  const charts = /图表 div 数:\s*(\d+)\s*\|\s*init 引用数:\s*(\d+)/.exec(stdout);
  return {
    ran: exitCode === 0 || exitCode === 1,
    ok: exitCode === 0,
    fields: {
      containers: containers === null ? undefined : Number(containers[1]),
      captions: containers === null ? undefined : Number(containers[2]),
      numberingContinuous: containers === null ? undefined : containers[3] === 'True',
      expectedCaptions: expected === null ? undefined : Number(expected[1]),
      actualCaptions: expected === null ? undefined : Number(expected[2]),
      chartDivs: charts === null ? undefined : Number(charts[1]),
      chartInitRefs: charts === null ? undefined : Number(charts[2]),
      sizeOk: bool(stdout, /2559x1559 尺寸:\s*(True|False)/)
    },
    notes: has(stdout, '结论: 未通过') ? ['静态校验未通过，见上方逐项'] : []
  };
}

// ---------------------------------------------------------------- 13. 图集 HTML 校验
/** `validate_html.py` —— 退出码即结论。 */
export function parseValidateHtml({ stdout, exitCode }) {
  const line = /截图容器:\s*(\d+)\s*\|\s*图注:\s*(\d+)\s*\|\s*目录锚点:\s*(\d+)\s*\|\s*目标图数:\s*(\d+)/.exec(
    stdout
  );
  const problems = findAll(stdout, '^\\s+✗\\s+(.+)$').map((m) => m[1].trim());
  return {
    ran: exitCode === 0 || exitCode === 1,
    ok: exitCode === 0,
    fields: {
      containers: line === null ? undefined : Number(line[1]),
      captions: line === null ? undefined : Number(line[2]),
      anchors: line === null ? undefined : Number(line[3]),
      targetFigures: line === null ? undefined : Number(line[4]),
      problems: problems.slice(0, 10)
    },
    notes: problems.slice(0, 10)
  };
}

// ---------------------------------------------------------------- 14. 单位缩放
/** `scale_units.py` —— 唯一一行输出；**缺 output 会原地覆盖**。 */
export function parseScaleUnits({ stdout, exitCode }) {
  const line = /已将\s+(\d+)\s+个 cqw\/cqh 单位乘以\s+(.+?)\s*->\s*(.+)$/.exec(stdout);
  return {
    ran: exitCode === 0 && line !== null,
    ok: exitCode === 0 && line !== null,
    fields: {
      replaced: line === null ? undefined : Number(line[1]),
      factor: line === null ? undefined : line[2].trim(),
      outPath: line === null ? undefined : line[3].trim()
    },
    notes: []
  };
}

// ---------------------------------------------------------------- 15. 真实界面截图
/** `shoot_real_ui.py` —— 无 CLI 参数；Playwright/Chrome 异常直接冒泡（无降级）。 */
export function parseShootRealUi({ stdout, stderr, exitCode }) {
  const unique = /唯一图\s+(\d+)\s*\/\s*总图\s+(\d+)/.exec(stdout);
  const figures = findAll(stdout, '^\\s+图(\\d+)\\s*->\\s*(.+?)\\s*\\(([\\d.]+) KB\\)').map(
    (m) => `fig${m[1]}`
  );
  const noScroll = findAll(stdout, '页面未产生滚动').length;
  const notes = [];
  if (noScroll > 0) notes.push(`${noScroll} 屏页面未产生滚动，可能与上一屏重复 —— 请调大 zoom 或换内容区`);
  if (exitCode !== 0 && stdout.trim().length === 0) {
    notes.push(
      `脚本无输出即失败（退出码 ${exitCode}）：通常是 Playwright/Chrome 缺失或被测服务未启动。stderr: ${stderr.trim().slice(0, 200)}`
    );
  }
  return {
    ran: unique !== null || figures.length > 0 || stdout.trim().length > 0,
    ok: exitCode === 0 && unique !== null && Number(unique[1]) === Number(unique[2]),
    fields: {
      uniqueImages: unique === null ? undefined : Number(unique[1]),
      totalImages: unique === null ? undefined : Number(unique[2]),
      figures: figures.slice(0, 60),
      uniqueness: str(stdout, /^唯一性校验:\s*(.+)$/m)
    },
    notes
  };
}

// ---------------------------------------------------------------- 16. AIGC 扫描
/** `check_aigc.py` —— **退出码恒 0，不能判"降 AIGC 达标"**；必须解析数值并与阈值比较。 */
export function parseAigcScan({ stdout, exitCode }) {
  const rhythm = /句长均值:\s*([\d.]+)\s*\|\s*标准差\(突发性\):\s*([\d.]+)\s*\|\s*最长:\s*(\d+)\s*\|\s*超60字句:\s*(\d+)\s*\|\s*列举式长句\(分号≥3\):\s*(\d+)/.exec(
    stdout
  );
  const reduction = /AI 高频词合计:\s*(\d+)\s*→\s*(\d+)\s*\(↓([\d.]+)%\)/.exec(stdout);
  return {
    ran: stdout.trim().length > 0,
    // 脚本没有达标语义，这里不替它下结论；ok 仅表示"扫描跑成功了"
    ok: stdout.trim().length > 0,
    fields: {
      highFrequencyKinds: num(stdout, /AI 高频词（共\s*(\d+)\s*种）/),
      paragraphs: num(stdout, /正文段落:\s*(\d+)/),
      chars: num(stdout, /字数:\s*(\d+)/),
      avgSentenceLength: rhythm === null ? undefined : Number(rhythm[1]),
      sentenceStdDev: rhythm === null ? undefined : Number(rhythm[2]),
      longestSentence: rhythm === null ? undefined : Number(rhythm[3]),
      over60Chars: rhythm === null ? undefined : Number(rhythm[4]),
      enumeratedLong: rhythm === null ? undefined : Number(rhythm[5]),
      oldVocabTotal: reduction === null ? undefined : Number(reduction[1]),
      newVocabTotal: reduction === null ? undefined : Number(reduction[2]),
      reductionPct: reduction === null ? undefined : Number(reduction[3]),
      structuralTotal: num(stdout, /结构性问题合计:\s*(\d+)/)
    },
    notes: [
      '退出码恒 0，不代表任何达标结论；请用 vocabReductionTarget / structuralResidueTarget 与上面数值自行比对',
      ...(reduction === null ? [] : [`AI 高频词降幅 ${reduction[3]}%（阈值见配置 aigc.vocabReductionTarget）`])
    ]
  };
}

// ---------------------------------------------------------------- 17. 标红段残留探针
/** `probe_residue.py` —— 退出码即结论；2 = 无效颜色。 */
export function parseProbeResidue({ stdout, exitCode }) {
  const total = num(stdout, /标红段总数:\s*(\d+)/);
  const residue = num(stdout, /全文残留:\s*(\d+)/);
  const notes = [];
  if (total === 0) {
    notes.push('标红段总数为 0 —— 该报告本来就没有标红段，与"全部改掉"不是一回事，别误判成已达标');
  }
  const samples = findAll(stdout, '^\\s+残留\\[([^\\]]+)\\]:\\s*(.+)$').map((m) => `${m[1]}: ${m[2].trim()}`);
  return {
    ran: exitCode === 0 || exitCode === 1,
    ok: exitCode === 0,
    fields: {
      flaggedTotal: total,
      residue,
      colors: str(stdout, /标红段总数:\s*\d+（颜色:\s*(.+?)）/),
      samples: samples.slice(0, 10),
      invalidColor: exitCode === USAGE_EXIT
    },
    notes: [...notes, ...(exitCode === USAGE_EXIT ? ['--colors 传了无效颜色（可选：红/橙/紫）'] : [])]
  };
}

// ---------------------------------------------------------------- 18/19. 哈希清单
/**
 * 两个哈希脚本共用：stdout 是 TSV，**汇总在 stderr 且键名不同**。
 * @param variant - `'collect'`（`# TOTAL_FILES=…`）或 `'stats'`（`# FILES=…`）
 */
export function parseSourceHashes({ stdout, stderr, exitCode }, variant = 'collect') {
  const rows = findAll(stdout, '^(.+?)\\t(\\d+)\\t(\\d+)\\t([0-9a-f]{64})$').map((m) => ({
    path: m[1],
    bytes: Number(m[2]),
    lines: Number(m[3]),
    sha256: m[4]
  }));
  const totals =
    variant === 'collect'
      ? /#\s*TOTAL_FILES=(\d+)\s+TOTAL_LINES=(\d+)\s+TOTAL_BYTES=(\d+)/.exec(stderr)
      : /#\s*FILES=(\d+)\s+LINES=(\d+)\s+BYTES=(\d+)/.exec(stderr);
  const notes = [];
  if (totals === null) notes.push('未从 stderr 读到汇总行（脚本的 # TOTAL_FILES/# FILES 行）');
  if (exitCode !== 0) notes.push(`脚本退出码 ${exitCode}（目录不存在时错误打在 stderr）`);
  return {
    ran: exitCode === 0 || rows.length > 0,
    ok: exitCode === 0 && rows.length > 0,
    fields: {
      files: totals === null ? rows.length : Number(totals[1]),
      lines: totals === null ? rows.reduce((n, r) => n + r.lines, 0) : Number(totals[2]),
      bytes: totals === null ? rows.reduce((n, r) => n + r.bytes, 0) : Number(totals[3]),
      entries: rows.length,
      stderr: exitCode !== 0 ? stderr.trim().slice(0, 200) : undefined
    },
    notes
  };
}

// ---------------------------------------------------------------- 20. 申诉证明文档
/** `gen_proof_docx.py` —— **保存失败不改退出码（恒 0）**，必须检测"有生成 且 无保存失败"。 */
export function parseGenProofDocx({ stdout, exitCode }) {
  const generated = findAll(stdout, '^已生成:\\s*(.+)$').map((m) => m[1].trim());
  const savedFail = /保存失败（目标与 _V2~_V10 均被占用）/.test(stdout);
  const stats = /^文件数:\s*(\d+)\s*\|\s*总行数:\s*(\d+)$/m.exec(stdout);
  return {
    ran: exitCode === 0 && (generated.length > 0 || savedFail),
    ok: exitCode === 0 && generated.length > 0 && !savedFail,
    fields: {
      generated,
      files: stats === null ? undefined : Number(stats[1]),
      lines: stats === null ? undefined : Number(stats[2])
    },
    notes: savedFail
      ? ['docx 保存失败（被占用），已另存临时文件 —— 脚本不改退出码，此处已替它判定为失败']
      : []
  };
}
