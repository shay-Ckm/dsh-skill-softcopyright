/**
 * dsh-skill-softcopyright —— 门禁判定
 *
 * 「每阶段必须停下等用户确认」是这套流程的灵魂（技能正文的铁律）。这里把它变成
 * **可执行的判据**：`advance` 只有在三类判据全过时才允许推进，否则返回差什么 + 怎么补。
 *
 * 三类判据（与 assets/pipeline.yaml 对应）：
 *   artifacts —— 产物文件/glob 必须存在
 *   evidence  —— 某个 tool+action 必须**已通过**，且**晚于本阶段开始时间**
 *                （防陈旧证据：改了内容没重跑校验就推进，是典型翻车）
 *   measure   —— 量化判据：字段相等/上下界、页数来源、四处口径一致
 *
 * 判定逻辑本身是纯的（文件系统与审计结果由参数注入），因此可脱离 DSH 单测。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { PHASE_STATUS, phaseState, readEvidence, resolveValue } from './store.js';

/** 经验法/估算的 pagesSource 取值 —— 技能明确不推荐，门禁因此拒绝。 */
const ESTIMATE_SOURCES = new Set(['estimate', '校准法', 'app.xml 真实页数']);

/** 把 glob 的**文件名部分**编译成正则（仅支持 `*` 与 `?`）。 */
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '[^/\\\\]*').replace(/\?/g, '.')}$`, 'i');
}

/**
 * 在一棵目录树里找匹配的产物。支持 `dir/*.ext`、`dir/*含中文*.ext` 与 `**` 递归。
 * @returns 命中的绝对路径数组。
 */
export function matchArtifacts(projectRoot, globs) {
  const found = [];
  for (const glob of globs ?? []) {
    const normalized = String(glob).replace(/\\/g, '/');
    const recursive = normalized.includes('**');
    const lastSlash = normalized.lastIndexOf('/');
    const dirPart = lastSlash < 0 ? '.' : normalized.slice(0, lastSlash).replace(/\*\*/g, '');
    const filePart = lastSlash < 0 ? normalized : normalized.slice(lastSlash + 1);
    const baseDir = join(projectRoot, dirPart);
    if (!existsSync(baseDir)) continue;

    const matcher = globToRegExp(filePart);
    const walk = (dir, depth) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (recursive && depth < 8) walk(path, depth + 1);
        } else if (matcher.test(entry.name)) {
          found.push(path);
        }
      }
    };
    walk(baseDir, 0);
  }
  return [...new Set(found)];
}

/** 证据是否新鲜：必须晚于本阶段的 `startedAt`。 */
function evidenceIsFresh(entry, startedAt) {
  if (entry === undefined) return false;
  if (startedAt === undefined || startedAt === null) return true; // 阶段还没开始记录时间：不苛求
  return String(entry.at) >= String(startedAt);
}

/**
 * 判定一个阶段的门禁。
 *
 * @param phase - manifest 里的阶段定义。
 * @param state - 当前状态。
 * @param options.projectRoot - 项目根（glob 基准）。
 * @param options.confirmedByUser - 本次 advance 是否带用户确认。
 * @param options.fourWay - 可选：四处口径审计结果 `{ ok, blockers }`。
 * @returns `{ ok, checks, blockers }`
 */
export function evaluateGate(phase, state, options = {}) {
  const { projectRoot, confirmedByUser = false, fourWay, now = new Date().toISOString() } = options;
  const scope = phaseState(state, phase.id);
  const checks = [];
  const blockers = [];

  const fail = (kind, message, fix) => {
    checks.push({ kind, ok: false, detail: message });
    blockers.push({ kind, message, fix });
  };
  const pass = (kind, detail) => checks.push({ kind, ok: true, detail });

  // ---- artifacts ----
  if (phase.artifacts.length > 0) {
    const hits = matchArtifacts(projectRoot, phase.artifacts);
    const missed = phase.artifacts.filter((glob) => !hits.some((h) => globToRegExp(glob.split('/').pop()).test(h.split(sep).pop())));
    if (missed.length === 0) {
      pass('artifacts', `${hits.length} 个产物匹配 ${phase.artifacts.join(', ')}`);
    } else {
      fail(
        'artifacts',
        `缺少产物：${missed.join(', ')}`,
        `先把这些文件生成到项目里；当前匹配到 ${hits.length} 个文件`
      );
    }
  }

  // ---- evidence（必须已通过且新鲜）----
  for (const { tool, action } of phase.evidence) {
    const entry = readEvidence(state, tool, action);
    if (entry === undefined) {
      fail(
        'evidence',
        `缺少证据：${tool} action=${action} 尚未运行过`,
        `先调用 ${tool}（action=${action}）并确保通过`
      );
      continue;
    }
    if (!entry.ok) {
      fail(
        'evidence',
        `证据不通过：${tool} action=${action} 上次结果是 FAILED`,
        `修复问题后重跑 ${tool} action=${action}（上次运行于 ${entry.at}）`
      );
      continue;
    }
    if (!evidenceIsFresh(entry, scope.startedAt)) {
      fail(
        'evidence',
        `证据过期：${tool} action=${action} 通过于 ${entry.at}，早于本阶段开始时间 ${scope.startedAt}`,
        `本阶段内容已变动，请重跑 ${tool} action=${action}`
      );
      continue;
    }
    pass('evidence', `${tool} action=${action} 通过于 ${entry.at}`);
  }

  // ---- measure ----
  for (const [i, rule] of phase.measure.entries()) {
    const label = rule.label ?? `${rule.kind}#${i}`;
    switch (rule.kind) {
      case 'user-confirmed': {
        if (confirmedByUser) pass('measure', `${label}：已获用户确认`);
        else fail('measure', `${label}：尚未获得用户确认`, '汇报本阶段结果，等用户明确回复"继续"后再推进');
        break;
      }
      case 'pages-measured': {
        const source = resolveValue(state, 'evidence', 'sc_manual.stats.pagesSource') ?? resolveValue(state, 'evidence', 'sc_manual.render-pdf.pagesSource');
        if (source === undefined) {
          fail('measure', `${label}：没有页数证据`, '运行 sc_manual action=stats（render=true）取真实页数');
        } else if (ESTIMATE_SOURCES.has(String(source))) {
          fail(
            'measure',
            `${label}：页数来源是「${source}」，不是真实渲染`,
            '技能明确不推荐经验法；请确认渲染链可用后重跑 sc_manual action=stats'
          );
        } else {
          pass('measure', `${label}：pagesSource=${source}`);
        }
        break;
      }
      case 'field-equals': {
        const left = resolveValue(state, rule.source, rule.path);
        const right = rule.other === undefined ? rule.value : resolveValue(state, rule.source, rule.other);
        if (left === undefined || right === undefined) {
          fail('measure', `${label}：字段缺失（left=${left}, right=${right}）`, `先运行产出这些字段的工具`);
        } else if (left === right) {
          pass('measure', `${label}：${rule.path} == ${rule.other ?? rule.value} (${left})`);
        } else {
          fail('measure', `${label}：${rule.path}=${left} != ${rule.other ?? rule.value}=${right}`, '修正到相等后重跑对应校验');
        }
        break;
      }
      case 'field-at-least':
      case 'field-at-most': {
        const value = resolveValue(state, rule.source, rule.path);
        const bound = rule.value;
        const atLeast = rule.kind === 'field-at-least';
        if (typeof value !== 'number' || typeof bound !== 'number') {
          fail('measure', `${label}：拿不到可比较的数值（value=${value}, bound=${bound}）`, '先运行产出该字段的工具');
        } else if (atLeast ? value >= bound : value <= bound) {
          pass('measure', `${label}：${value} ${atLeast ? '>=' : '<='} ${bound}`);
        } else {
          fail('measure', `${label}：${value} 不满足 ${atLeast ? '≥' : '≤'} ${bound}`, '按技能正文调整后重跑校验');
        }
        break;
      }
      case 'four-way-consistency': {
        if (fourWay === undefined) {
          fail('measure', `${label}：未做四处口径审计`, '运行 sc_audit action=four-way');
        } else if (fourWay.ok) {
          pass('measure', `${label}：四处一致（${fourWay.summary ?? 'OK'}）`);
        } else {
          fail('measure', `${label}：${fourWay.summary ?? '四处口径不一致'}`, fourWay.fixHint ?? '运行 sc_audit action=four-way 看明细');
        }
        break;
      }
      default:
        fail('measure', `未知判据 kind=${rule.kind}`, '检查 assets/pipeline.yaml');
    }
  }

  // ---- Checkpoint 铁律：mustStopAfter 本身即要求用户确认 ----
  //
  // 这条是 harness 抓出来的设计缺口：最初只有显式写了 `user-confirmed` 判据的阶段才拦
  // 确认，于是 p5-1 / p5-2 这类必须停下的阶段**可以不带确认就推进** —— 恰好违背了
  // 技能正文"每阶段结束必须停下等用户确认"的铁律。现在 mustStopAfter 自带该约束。
  // 若某阶段已显式声明了 `user-confirmed` 判据，则不重复报（避免同一件事两个 blocker）。
  const hasExplicitConfirmRule = phase.measure.some((m) => m.kind === 'user-confirmed');
  if (phase.mustStopAfter === true && !hasExplicitConfirmRule) {
    if (confirmedByUser) {
      pass('checkpoint', '必须停下的阶段：已获用户确认');
    } else {
      fail(
        'checkpoint',
        'Checkpoint 铁律：本阶段必须停下等用户确认',
        '汇报本阶段结果（含校验数据），等用户明确回复"继续"后再带 confirmedByUser=true 调用 advance'
      );
    }
  }

  return { ok: blockers.length === 0, checks, blockers, at: now, projectRoot };
}

/**
 * 计算「下一个可推进的阶段」。
 *
 * 规则：候选 = requires 已全部 done 且自身非 done/skipped 的阶段；按 manifest 顺序取第一个。
 * 可选阶段（optional）不阻塞链，但也不自动跳过 —— 由用户/`allowSkipPhases` 决定。
 */
export function nextPhase(manifest, state) {
  for (const phase of manifest.phases) {
    const scope = phaseState(state, phase.id);
    if (scope.status === PHASE_STATUS.done || scope.status === PHASE_STATUS.skipped) continue;
    const ready = phase.requires.every((dep) => {
      const depScope = phaseState(state, dep);
      return depScope.status === PHASE_STATUS.done || depScope.status === PHASE_STATUS.skipped;
    });
    if (ready) return phase;
  }
  return undefined;
}

/** 报告所有被阻塞的阶段（requires 未满足），便于诊断"为什么不能推进"。 */
export function blockedPhases(manifest, state) {
  const out = [];
  for (const phase of manifest.phases) {
    const scope = phaseState(state, phase.id);
    if (scope.status === PHASE_STATUS.done || scope.status === PHASE_STATUS.skipped) continue;
    const missing = phase.requires.filter((dep) => {
      const depScope = phaseState(state, dep);
      return depScope.status !== PHASE_STATUS.done && depScope.status !== PHASE_STATUS.skipped;
    });
    if (missing.length > 0) out.push({ id: phase.id, missing });
  }
  return out;
}

export { globToRegExp };
