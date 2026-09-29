/**
 * `sc_doctor` 的**纯逻辑**部分 —— 不 import 任何 `@deepseek-ai/*` 包。
 *
 * 拆出来的理由与 `lib/skills.js` / `lib/runtime.js` 相同：`@deepseek-ai/*` 只存在于
 * app.asar 内，普通 node 进程 import 不到。把体检逻辑与工具注册分开，就能在 DSH
 * 之外用真机环境跑测试（`test/harness.mjs` 就是这么做的）。
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROBE_PROGRAM,
  resolveBundledPython,
  resolveRenderPython,
  runPythonInline
} from '../runtime.js';
import { SKILLS } from '../skills.js';

/** 数出技能目录下的文件数与字节数，用于确认资产完整。 */
export function countFiles(directory) {
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__pycache__') continue;
        walk(path);
      } else if (entry.isFile()) {
        files += 1;
        bytes += statSync(path).size;
      }
    }
  };
  walk(directory);
  return { files, bytes };
}

/**
 * 执行体检。
 *
 * 存在的理由：工具层依赖两条 Python 链与一批技能资产，任何一样悄悄坏掉，工具都会
 * 以"脚本报错"的形式表现出来，归因成本极高。把体检做成一次调用，agent 与用户都能
 * 一次看清。
 *
 * @param ctx - cordis 上下文（只需 `get('subprocess')`，可为 undefined）。
 * @param options.assetRoot - 技能资产根目录。
 * @param options.config - runtime 配置段。
 * @param options.signal - 取消信号。
 */
export async function runDoctor(ctx, options) {
  const { assetRoot, config = {}, signal, cwd } = options;

  const report = {
    ok: false,
    bundledPython: { ok: false },
    renderPython: { ok: false },
    assets: { ok: false, skills: [] },
    subprocessSeam: false,
    warnings: []
  };

  // ---- 受管子进程 seam ----
  const subprocess = typeof ctx?.get === 'function' ? ctx.get('subprocess') : ctx?.subprocess;
  report.subprocessSeam = subprocess !== undefined && typeof subprocess.spawn === 'function';
  if (!report.subprocessSeam) {
    report.warnings.push(
      'ctx.subprocess 未挂载：将回退 node:child_process；受限沙箱模式下管道 stdio 可能被拒绝（EPERM）。'
    );
  }

  // ---- 生成/校验链 ----
  try {
    const found = resolveBundledPython(config);
    const probe = await runPythonInline(ctx, PROBE_PROGRAM, {
      pythonPath: found.path,
      cwd,
      signal,
      timeoutMs: 30000
    });
    report.bundledPython = {
      ok: probe.json !== undefined && probe.json?.hasDocx === true,
      source: found.source,
      path: found.path,
      seam: probe.seam,
      seamFailed: probe.seamFailed === true,
      seamError: probe.error,
      exitCode: probe.exitCode,
      version: probe.json?.version,
      docxVersion: probe.json?.docxVersion,
      stdoutEncoding: probe.json?.stdoutEncoding,
      hasDocx: probe.json?.hasDocx,
      hasLxml: probe.json?.hasLxml,
      hasPIL: probe.json?.hasPIL,
      hasPywin32: probe.json?.hasPywin32,
      stderr: probe.stderr?.trim() || undefined
    };
    if (probe.seamFailed === true) {
      // 最有用的一条诊断：受管 seam 在，但调用失败。真实原因必须在报告里可见。
      report.warnings.push(
        `受管子进程 seam 调用失败（未降级，避免掩盖原因）：${probe.error ?? 'unknown error'}`
      );
    } else if (probe.seam === 'node') {
      report.warnings.push('生成/校验链走了 node:child_process 回退路径，非受管 seam。');
    }
    if (probe.json?.hasDocx !== true) {
      report.warnings.push('生成/校验链缺少 python-docx：docx 相关脚本无法运行。');
    }
    if (probe.json?.stdoutEncoding && !/utf-?8/i.test(probe.json.stdoutEncoding)) {
      report.warnings.push(
        `生成/校验链的 stdout 编码是 ${probe.json.stdoutEncoding}，非 UTF-8；中文输出可能乱码。`
      );
    }
  } catch (error) {
    report.bundledPython = { ok: false, error: error?.message ?? String(error) };
    report.warnings.push('无法定位或运行生成/校验链 Python —— 所有工具都会失败。');
  }

  // ---- 渲染链（Word COM）----
  try {
    const found = resolveRenderPython(config);
    const probe = await runPythonInline(ctx, PROBE_PROGRAM, {
      pythonPath: found.path,
      cwd,
      signal,
      timeoutMs: 30000
    });
    report.renderPython = {
      ok: probe.json !== undefined && probe.json?.hasPywin32 === true,
      source: found.source,
      path: found.path,
      version: probe.json?.version,
      docxVersion: probe.json?.docxVersion,
      pywin32Version: probe.json?.pywin32Version,
      hasPywin32: probe.json?.hasPywin32,
      hasPlaywright: probe.json?.hasPlaywright
    };
    if (probe.json?.hasPywin32 !== true) {
      report.warnings.push('渲染链缺少 pywin32：真实页数与 docx→PDF 不可用（Word COM 需要它）。');
    }
    if (probe.json?.hasPlaywright !== true) {
      report.warnings.push(
        '渲染链缺少 playwright：技能自带的 shoot_real_ui.py 不可用（图集走 bsk 或路径 B/C）。'
      );
    }
    const genDocx = report.bundledPython?.docxVersion;
    const renDocx = probe.json?.docxVersion;
    if (genDocx && renDocx && genDocx !== renDocx) {
      report.warnings.push(
        `两条链的 python-docx 版本不一致（生成链 ${genDocx} vs 渲染链 ${renDocx}）；` +
          '渲染链是系统 Python，版本漂移可能造成页数口径差异。'
      );
    }
  } catch (error) {
    report.renderPython = { ok: false, error: error?.message ?? String(error) };
    report.warnings.push(
      '找不到渲染链 Python —— 真实页数不可用（技能明确不推荐经验法），docx→PDF 也不可用。'
    );
  }

  // ---- 技能资产完整性 ----
  try {
    const skills = SKILLS.map(({ name }) => {
      const directory = join(assetRoot, name);
      return { name, path: directory, ...countFiles(directory) };
    });
    report.assets = {
      ok: skills.every((s) => s.files > 0),
      assetRoot,
      skills,
      totalFiles: skills.reduce((n, s) => n + s.files, 0)
    };
  } catch (error) {
    report.assets = { ok: false, assetRoot, error: error?.message ?? String(error) };
    report.warnings.push(`技能资产目录不可读：${assetRoot}`);
  }

  // 渲染链缺失只降级（页数走经验法需显式开启），不判定整体失败；
  // 生成链或资产缺失则整体失败。
  report.ok =
    report.bundledPython.ok === true &&
    report.assets.ok === true &&
    report.subprocessSeam === true;
  return report;
}

/** 把体检结果渲染成人类可读文本。 */
export function formatDoctor(report) {
  const mark = (v) => (v === true ? 'OK' : v === false ? 'FAIL' : '?');
  const lines = ['软著交付插件体检', ''];

  lines.push('[生成/校验链 Python]');
  lines.push(`  状态    : ${mark(report.bundledPython.ok)}`);
  lines.push(`  路径    : ${report.bundledPython.path ?? '-'}`);
  lines.push(`  来源    : ${report.bundledPython.source ?? '-'}`);
  lines.push(`  版本    : ${report.bundledPython.version ?? '-'}`);
  lines.push(`  seam    : ${report.bundledPython.seam ?? '-'}`);
  if (report.bundledPython.seamFailed === true) {
    lines.push(`  seam 错误: ${report.bundledPython.seamError ?? 'unknown'}`);
  }
  lines.push(
    `  python-docx: ${mark(report.bundledPython.hasDocx)} ${report.bundledPython.docxVersion ?? ''}`
  );
  lines.push(`  stdout 编码: ${report.bundledPython.stdoutEncoding ?? '-'}`);
  if (report.bundledPython.error) lines.push(`  错误    : ${report.bundledPython.error}`);
  lines.push('');

  lines.push('[渲染链 Python · Word COM]');
  lines.push(`  状态    : ${mark(report.renderPython.ok)}`);
  lines.push(`  路径    : ${report.renderPython.path ?? '-'}`);
  lines.push(`  来源    : ${report.renderPython.source ?? '-'}`);
  lines.push(
    `  pywin32 : ${mark(report.renderPython.hasPywin32)} ${report.renderPython.pywin32Version ?? ''}`
  );
  lines.push(`  python-docx: ${report.renderPython.docxVersion ?? '-'}`);
  lines.push(`  playwright : ${mark(report.renderPython.hasPlaywright)}`);
  if (report.renderPython.error) lines.push(`  错误    : ${report.renderPython.error}`);
  lines.push('');

  lines.push('[技能资产]');
  lines.push(`  状态    : ${mark(report.assets.ok)}`);
  lines.push(`  根目录  : ${report.assets.assetRoot ?? '-'}`);
  for (const skill of report.assets.skills ?? []) {
    lines.push(
      `  - ${skill.name.padEnd(32)} ${String(skill.files).padStart(3)} 文件  ${String(skill.bytes).padStart(8)} 字节`
    );
  }
  if (report.assets.error) lines.push(`  错误    : ${report.assets.error}`);
  lines.push('');

  lines.push(`[受管子进程 seam] ${report.subprocessSeam ? 'ctx.subprocess 可用' : '未挂载（回退 node:child_process）'}`);
  lines.push('');

  if (report.warnings.length > 0) {
    lines.push('[警告]');
    for (const w of report.warnings) lines.push(`  ! ${w}`);
    lines.push('');
  }

  lines.push(report.ok ? '结论：可用。' : '结论：存在阻塞问题（见上）。');
  return lines.join('\n');
}
