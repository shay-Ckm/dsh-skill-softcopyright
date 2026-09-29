/**
 * dsh-skill-softcopyright —— 流水线清单的加载与校验
 *
 * 纯模块（不依赖 `@deepseek-ai/*`），因此可在 DSH 之外单测。
 *
 * 设计立场：**清单写错必须在加载时炸**，不能拖到某次 `advance` 才暴露。
 * 这里对 id 唯一性、技能名、`requires` 环、判据 kind 都做严格检查并给出可操作报错。
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

/** 已知的判据类型。写错 kind 会立刻报错，而不是被静默忽略。 */
export const MEASURE_KINDS = new Set([
  'user-confirmed',
  'field-equals',
  'field-at-least',
  'field-at-most',
  'pages-measured',
  'four-way-consistency'
]);

/** 已知的不变量类型。 */
export const INVARIANT_KINDS = new Set(['four-way-consistency', 'figure-counts']);

/** 清单里允许引用的技能名（与 assets/skills/ 一致）。 */
export const KNOWN_SKILLS = new Set([
  'python-software-delivery',
  'manual-ui-screenshots',
  'aigc-review-reduction',
  'software-copyright-aigc-appeal'
]);

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

class ManifestError extends Error {
  constructor(message) {
    super(`softcopyright: pipeline manifest invalid — ${message}`);
    this.name = 'ManifestError';
  }
}

/**
 * 校验并规范化清单对象。
 * @param raw - 已解析的 YAML 对象。
 * @returns 规范化后的清单（含解析好的 `requires` 与 `index`）。
 */
export function validateManifest(raw) {
  if (typeof raw !== 'object' || raw === null) throw new ManifestError('root must be a mapping');
  if (raw.version !== 1) throw new ManifestError(`unsupported version ${JSON.stringify(raw.version)}; expected 1`);
  if (!Array.isArray(raw.phases) || raw.phases.length === 0) {
    throw new ManifestError('phases must be a non-empty array');
  }

  const seen = new Set();
  const phases = raw.phases.map((phase, i) => {
    const at = `phases[${i}]`;
    if (typeof phase !== 'object' || phase === null) throw new ManifestError(`${at} must be a mapping`);

    const { id, title, skill, ref, optional, requires, artifacts, evidence, measure, mustStopAfter } = phase;
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw new ManifestError(`${at}.id must be kebab-case, got ${JSON.stringify(id)}`);
    }
    if (seen.has(id)) throw new ManifestError(`duplicate phase id "${id}"`);
    seen.add(id);

    if (typeof title !== 'string' || title.length === 0) throw new ManifestError(`phase "${id}" needs a title`);
    if (typeof skill !== 'string' || !KNOWN_SKILLS.has(skill)) {
      throw new ManifestError(
        `phase "${id}".skill must be one of ${[...KNOWN_SKILLS].join(' / ')}, got ${JSON.stringify(skill)}`
      );
    }

    const artifactList = artifacts ?? [];
    if (!Array.isArray(artifactList) || artifactList.some((a) => typeof a !== 'string' || a.length === 0)) {
      throw new ManifestError(`phase "${id}".artifacts must be an array of non-empty strings`);
    }

    const evidenceList = evidence ?? [];
    if (!Array.isArray(evidenceList)) throw new ManifestError(`phase "${id}".evidence must be an array`);
    for (const [j, item] of evidenceList.entries()) {
      if (typeof item?.tool !== 'string' || typeof item?.action !== 'string') {
        throw new ManifestError(`phase "${id}".evidence[${j}] needs { tool, action }`);
      }
    }

    const measureList = measure ?? [];
    if (!Array.isArray(measureList)) throw new ManifestError(`phase "${id}".measure must be an array`);
    for (const [j, item] of measureList.entries()) {
      const kind = item?.kind;
      if (typeof kind !== 'string' || !MEASURE_KINDS.has(kind)) {
        throw new ManifestError(
          `phase "${id}".measure[${j}].kind must be one of ${[...MEASURE_KINDS].join(' / ')}, got ${JSON.stringify(kind)}`
        );
      }
      if ((kind === 'field-equals' || kind === 'field-at-least' || kind === 'field-at-most') && typeof item.path !== 'string') {
        throw new ManifestError(`phase "${id}".measure[${j}] (${kind}) needs a "path"`);
      }
    }

    if (requires !== undefined && !Array.isArray(requires)) {
      throw new ManifestError(`phase "${id}".requires must be an array when present`);
    }

    return {
      id,
      title,
      skill,
      ref: typeof ref === 'string' ? ref : undefined,
      optional: optional === true,
      mustStopAfter: mustStopAfter !== false,
      requires: requires === undefined ? undefined : [...requires],
      artifacts: [...artifactList],
      evidence: evidenceList.map((e) => ({ tool: e.tool, action: e.action })),
      measure: measureList
    };
  });

  // requires 校验 + 默认链式依赖（不写 requires 就依赖上一个阶段）
  for (const [i, phase] of phases.entries()) {
    const deps = phase.requires ?? (i === 0 ? [] : [phases[i - 1].id]);
    for (const dep of deps) {
      if (!seen.has(dep)) throw new ManifestError(`phase "${phase.id}".requires references unknown phase "${dep}"`);
      if (dep === phase.id) throw new ManifestError(`phase "${phase.id}" cannot require itself`);
    }
    phase.requires = deps;
  }

  // 环检测（Kahn）：按拓扑序推进才安全
  const indegree = new Map(phases.map((p) => [p.id, p.requires.length]));
  const dependents = new Map(phases.map((p) => [p.id, []]));
  for (const phase of phases) {
    for (const dep of phase.requires) dependents.get(dep).push(phase.id);
  }
  const queue = phases.filter((p) => indegree.get(p.id) === 0).map((p) => p.id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    visited += 1;
    for (const next of dependents.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (visited !== phases.length) {
    throw new ManifestError('phase requires form a cycle');
  }

  const invariants = raw.invariants ?? [];
  if (!Array.isArray(invariants)) throw new ManifestError('invariants must be an array');
  for (const [i, inv] of invariants.entries()) {
    if (typeof inv?.id !== 'string' || !ID_PATTERN.test(inv.id)) {
      throw new ManifestError(`invariants[${i}].id must be kebab-case`);
    }
    if (!INVARIANT_KINDS.has(inv.kind)) {
      throw new ManifestError(
        `invariants[${i}].kind must be one of ${[...INVARIANT_KINDS].join(' / ')}, got ${JSON.stringify(inv.kind)}`
      );
    }
  }

  return {
    version: 1,
    project: typeof raw.project === 'string' ? raw.project : 'softcopyright',
    phases,
    invariants,
    index: Object.fromEntries(phases.map((p, i) => [p.id, i]))
  };
}

/**
 * 从磁盘读取并校验清单。
 * @param path - pipeline.yaml 绝对路径。
 */
export function loadManifest(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ManifestError(`cannot read ${path} (${error?.code ?? error?.message})`);
  }
  let parsed;
  try {
    parsed = parse(text);
  } catch (error) {
    throw new ManifestError(`YAML parse failed for ${path}: ${error.message}`);
  }
  return validateManifest(parsed);
}

/** 取某个阶段的定义。 */
export function phaseById(manifest, id) {
  const index = manifest.index[id];
  return index === undefined ? undefined : manifest.phases[index];
}

/**
 * 拓扑序（requires 全部满足在前），用于汇报"完整推进顺序"。
 */
export function topologicalOrder(manifest) {
  const done = new Set();
  const out = [];
  let remaining = [...manifest.phases];
  while (remaining.length > 0) {
    const ready = remaining.filter((p) => p.requires.every((d) => done.has(d)));
    if (ready.length === 0) break; // 环已在校验阶段排除
    for (const phase of ready) {
      out.push(phase.id);
      done.add(phase.id);
    }
    remaining = remaining.filter((p) => !done.has(p.id));
  }
  return out;
}
