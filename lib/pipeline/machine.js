/**
 * dsh-skill-softcopyright —— 流水线状态机
 *
 * 「每阶段必须停下等用户确认」这条铁律的**可执行实现**（设计文档 §3.4 的"中约束"）：
 * 推进必须调用 `advance`，而它要求门禁全过 **且** `confirmedByUser === true`。
 * 模型仍可能绕过（不调用工具），但绕过后状态与产物不一致，`sc_audit` 会暴露出来 ——
 * "绕过去会被审计抓出来"比"绕不过去"更稳，也不需要深度干预 agent 循环。
 */
import { matchArtifacts, blockedPhases, evaluateGate, nextPhase } from './gates.js';
import { phaseById, topologicalOrder } from './manifest.js';
import { collectSourceStats } from '../audit/consistency.js';
import {
  PHASE_STATUS,
  phaseState,
  readState,
  resetState,
  setSharedFacts,
  updatePhase,
  writeState
} from './store.js';

/** 阶段状态 → 人类可读标记。 */
const STATUS_MARK = {
  done: '[x]',
  skipped: '[-]',
  'waiting-user': '[?]',
  pending: '[ ]'
};

/** 当前应该做的阶段（= nextPhase）。 */
export function currentPhase(manifest, state) {
  return nextPhase(manifest, state);
}

/** 汇总状态：给 `sc_pipeline action=status` 用。 */
export function statusReport(manifest, state) {
  const active = currentPhase(manifest, state);
  const rows = manifest.phases.map((phase) => {
    const scope = phaseState(state, phase.id);
    return {
      id: phase.id,
      title: phase.title,
      status: scope.status ?? PHASE_STATUS.pending,
      mark: STATUS_MARK[scope.status ?? PHASE_STATUS.pending] ?? '[ ]',
      optional: phase.optional,
      skill: phase.skill,
      confirmedAt: scope.confirmedAt,
      evidenceCount: (scope.evidence ?? []).length
    };
  });
  const doneCount = rows.filter((r) => r.status === PHASE_STATUS.done).length;
  return {
    current: active === undefined ? undefined : { id: active.id, title: active.title, ref: active.ref, skill: active.skill },
    rows,
    doneCount,
    total: rows.length,
    blocked: blockedPhases(manifest, state),
    sharedFacts: state.sharedFacts,
    stateLoad: state._load
  };
}

/** 完整推进计划：拓扑序 + 每阶段就绪度。 */
export function planReport(manifest, state, options = {}) {
  const order = topologicalOrder(manifest);
  return {
    order,
    phases: order.map((id) => {
      const phase = phaseById(manifest, id);
      const scope = phaseState(state, id);
      const gate = phase.requires.every((d) => {
        const s = phaseState(state, d);
        return s.status === PHASE_STATUS.done || s.status === PHASE_STATUS.skipped;
      })
        ? evaluateGate(phase, state, { ...options, projectRoot: options.projectRoot })
        : undefined;
      return {
        id,
        title: phase.title,
        status: scope.status ?? PHASE_STATUS.pending,
        optional: phase.optional,
        requires: phase.requires,
        mustStopAfter: phase.mustStopAfter,
        gateOk: gate?.ok,
        blockers: gate?.blockers?.map((b) => b.message)
      };
    })
  };
}

/**
 * 推进到目标阶段（默认 = 下一个就绪阶段）。
 *
 * 语义：
 *  - 门禁不过 → **不改状态**，把该阶段置为 `waiting-user`（记录"已汇报、在等确认"），
 *    并返回差什么 + 怎么补。
 *  - 门禁通过但 `confirmedByUser !== true` → 同上（`user-confirmed` 判据会拦住）。
 *  - 门禁通过且有确认 → 标记 done，写 `confirmedAt`，并把 currentPhase 指向下一个。
 */
export function advance(manifest, state, options = {}) {
  const { to, projectRoot, confirmedByUser = false, fourWay, now = new Date().toISOString() } = options;

  const target = to === undefined ? currentPhase(manifest, state) : phaseById(manifest, to);
  if (target === undefined) {
    return {
      ok: false,
      reason: to === undefined ? 'no phase is ready to advance' : `unknown phase "${to}"`,
      available: manifest.phases.map((p) => p.id)
    };
  }

  const scope = phaseState(state, target.id);
  if (scope.status === PHASE_STATUS.done) {
    return { ok: false, reason: `phase "${target.id}" is already done`, phase: target.id };
  }

  // requires 必须已完成
  const missing = target.requires.filter((dep) => {
    const s = phaseState(state, dep);
    return s.status !== PHASE_STATUS.done && s.status !== PHASE_STATUS.skipped;
  });
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `phase "${target.id}" is blocked by unfinished prerequisites`,
      missing,
      fixHint: `先完成 ${missing.join(', ')}`
    };
  }

  const gate = evaluateGate(target, state, { projectRoot, confirmedByUser, fourWay, now });

  if (!gate.ok) {
    // 记录"已汇报、在等用户确认"，但不推进
    updatePhase(state, target.id, {
      status: PHASE_STATUS.waitingUser,
      lastGateAt: now,
      lastBlockers: gate.blockers.map((b) => b.message)
    });
    writeState(projectRoot, state);
    return {
      ok: false,
      phase: target.id,
      title: target.title,
      gateFailed: true,
      blockers: gate.blockers,
      checks: gate.checks,
      mustStopAfter: target.mustStopAfter,
      fixHint: '按上面每条的 fix 处理后重跑；全部通过且拿到用户确认后再 advance'
    };
  }

  // 通过：落盘产物 + 证据
  const artifacts = matchArtifacts(projectRoot, target.artifacts);
  updatePhase(state, target.id, {
    status: PHASE_STATUS.done,
    confirmedAt: now,
    confirmedBy: confirmedByUser ? 'user' : 'gate-only',
    startedAt: scope.startedAt ?? now,
    artifacts: artifacts.map((a) => ({ path: a })),
    evidence: target.evidence.map((e) => ({ ...e, at: state.evidence[`${e.tool}.${e.action}`]?.at })),
    checks: gate.checks,
    lastBlockers: undefined
  });
  const next = currentPhase(manifest, state);
  state.currentPhase = next?.id;
  writeState(projectRoot, state);

  return {
    ok: true,
    phase: target.id,
    title: target.title,
    artifacts,
    checks: gate.checks,
    next: next === undefined ? undefined : { id: next.id, title: next.title, ref: next.ref, skill: next.skill },
    mustStopAfter: target.mustStopAfter,
    instruction:
      next === undefined
        ? '全部阶段已完成，可以统一交付'
        : `下一步：${next.title}${next.ref === undefined ? '' : `（${next.ref}）`} —— ` +
          '完成后立即停下汇报，等用户确认再 continue'
  };
}

/** 把某阶段显式标记为"已汇报、等用户确认"（`/sc-milestone` 用）。 */
export function checkpoint(manifest, state, options = {}) {
  const { phaseId, projectRoot, note, now = new Date().toISOString() } = options;
  const target = phaseId === undefined ? currentPhase(manifest, state) : phaseById(manifest, phaseId);
  if (target === undefined) return { ok: false, reason: `unknown phase "${phaseId}"` };
  updatePhase(state, target.id, {
    status: PHASE_STATUS.waitingUser,
    startedAt: phaseState(state, target.id).startedAt ?? now,
    note
  });
  writeState(projectRoot, state);
  return { ok: true, phase: target.id, title: target.title, status: PHASE_STATUS.waitingUser };
}

/** 跳过按需阶段（`optional: true`）。 */
export function skip(manifest, state, options = {}) {
  const { phaseId, projectRoot, now = new Date().toISOString() } = options;
  const target = phaseById(manifest, phaseId);
  if (target === undefined) return { ok: false, reason: `unknown phase "${phaseId}"` };
  if (!target.optional) {
    return { ok: false, reason: `phase "${phaseId}" is not optional; cannot skip`, optional: false };
  }
  updatePhase(state, target.id, { status: PHASE_STATUS.skipped, skippedAt: now });
  const nx = currentPhase(manifest, state);
  state.currentPhase = nx?.id;
  writeState(projectRoot, state);
  return { ok: true, phase: target.id, next: nx?.id };
}

/** 从源程序目录重算权威口径并写入 `sharedFacts`（四处口径的单一真源）。 */
export function recomputeFacts(state, options = {}) {
  const { projectRoot, sourceDir, sourceRules = {} } = options;
  const tree = collectSourceStats(sourceDir, sourceRules);
  setSharedFacts(state, {
    sourceFiles: tree.files,
    sourceLines: tree.lines,
    sourceBytes: tree.bytes,
    scope: sourceDir
  });
  writeState(projectRoot, state);
  return { files: tree.files, lines: tree.lines, bytes: tree.bytes, scope: sourceDir };
}

/** 清空状态。 */
export function reset(projectRoot) {
  return resetState(projectRoot);
}

/** 便捷：读状态（供工具层）。 */
export { readState };
