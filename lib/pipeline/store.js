/**
 * dsh-skill-softcopyright —— 流水线状态与证据持久化
 *
 * 存放位置：**项目工作区内** `<projectRoot>/.dsh/softcopyright/state.json`
 * （设计文档 §6.2）。理由：项目自包含、跟着代码走、多项目天然隔离；
 * 放 `$DSH_HOME` 会跨项目串味，放 session 里换会话就丢。
 *
 * 两个关键设计：
 * 1. **`sharedFacts` 是「四处口径」的单一真源。** 「N 个源文件 / M 行」只存这一份，
 *    源代码文档封面、哈希清单、研发日志、交付清单自检都读它。任何一步收窄范围，
 *    重算一次即可自动对齐 —— 把 SKILL.md 里的人工纪律变成数据结构。
 * 2. **证据带时间戳。** 门禁要求证据**晚于本阶段开始时间**，否则拿上一轮的旧结果
 *    当本轮通过（典型翻车：改了内容但没重跑校验就推进）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 状态文件相对项目根的路径。 */
export const STATE_DIR = join('.dsh', 'softcopyright');
export const STATE_FILE = 'state.json';

/** 阶段状态取值。 */
export const PHASE_STATUS = Object.freeze({
  pending: 'pending',
  waitingUser: 'waiting-user',
  done: 'done',
  skipped: 'skipped'
});

/** 空状态工厂。 */
export function emptyState(projectRoot) {
  return {
    version: 1,
    projectRoot,
    softwareName: undefined,
    currentPhase: undefined,
    phases: {},
    evidence: {},
    sharedFacts: {
      sourceFiles: undefined,
      sourceLines: undefined,
      sourceBytes: undefined,
      scope: undefined,
      recomputedAt: undefined
    },
    updatedAt: new Date().toISOString()
  };
}

/** 状态文件的绝对路径。 */
export function statePath(projectRoot) {
  return join(projectRoot, STATE_DIR, STATE_FILE);
}

/**
 * 读取状态。文件不存在或损坏时返回空状态，并带回 `_load` 说明
 * （不抛错：首次运行本来就没有文件）。
 */
export function readState(projectRoot) {
  const path = statePath(projectRoot);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { ...emptyState(projectRoot), _load: error?.code === 'ENOENT' ? 'fresh' : `unreadable: ${error?.message}` };
  }
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    return {
      ...emptyState(projectRoot),
      ...parsed,
      phases: parsed.phases ?? {},
      evidence: parsed.evidence ?? {},
      sharedFacts: { ...emptyState(projectRoot).sharedFacts, ...(parsed.sharedFacts ?? {}) },
      _load: 'ok'
    };
  } catch (error) {
    return { ...emptyState(projectRoot), _load: `corrupt (${error.message}); treated as fresh` };
  }
}

/** 写回状态。自动建目录并刷新 `updatedAt`。 */
export function writeState(projectRoot, state) {
  const dir = join(projectRoot, STATE_DIR);
  mkdirSync(dir, { recursive: true });
  const next = { ...state, projectRoot, updatedAt: new Date().toISOString() };
  delete next._load;
  writeFileSync(statePath(projectRoot), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/** 清空状态（`sc_pipeline reset`）。 */
export function resetState(projectRoot) {
  return writeState(projectRoot, emptyState(projectRoot));
}

/** 证据键：`<tool>.<action>`。 */
export function evidenceKey(tool, action) {
  return `${tool}.${action}`;
}

/**
 * 记录一次工具执行证据。
 *
 * 由 `lib/tools/scripts.js` 在每次 action 跑完后调用 —— 这样"工具跑过什么"
 * 由工具层自己写，门禁只负责读，职责清晰。
 *
 * @returns 写入后的证据对象。
 */
export function recordEvidence(projectRoot, { tool, action, ok, fields, notes, chain, summary }) {
  const state = readState(projectRoot);
  const key = evidenceKey(tool, action);
  const entry = {
    tool,
    action,
    at: new Date().toISOString(),
    ok: ok === true,
    fields: fields ?? {},
    notes: notes ?? [],
    chain,
    summary
  };
  state.evidence[key] = entry;
  writeState(projectRoot, state);
  return entry;
}

/** 读某个证据（含 `at` 时间戳，供门禁判断新鲜度）。 */
export function readEvidence(state, tool, action) {
  return state.evidence[evidenceKey(tool, action)];
}

/** 取某个阶段的状态记录（不存在则视为 pending）。 */
export function phaseState(state, phaseId) {
  return state.phases[phaseId] ?? { status: PHASE_STATUS.pending };
}

/** 写入某个阶段的状态字段（浅合并）。 */
export function updatePhase(state, phaseId, patch) {
  state.phases[phaseId] = { ...phaseState(state, phaseId), ...patch };
  return state.phases[phaseId];
}

/** 把 `sharedFacts` 更新为权威口径数字。 */
export function setSharedFacts(state, facts) {
  state.sharedFacts = { ...state.sharedFacts, ...facts, recomputedAt: new Date().toISOString() };
  return state.sharedFacts;
}

/**
 * 从证据/共享口径里按 `sc_manual.check.figureCaptions` 这样的路径取值。
 * 解析顺序：`evidence.<...>`（默认）或 `sharedFacts.<...>`。
 */
export function resolveValue(state, source, path) {
  const segments = String(path ?? '').split('.').filter(Boolean);
  if (segments.length === 0) return undefined;

  if (source === 'sharedFacts') {
    return segments.reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), state.sharedFacts);
  }
  // 默认走 evidence：第一段是 tool，第二段是 action，其余是 fields 路径
  if (segments.length < 3) return undefined;
  const [tool, action, ...rest] = segments;
  const entry = readEvidence(state, tool, action);
  if (entry === undefined) return undefined;
  return rest.reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), entry.fields);
}
