/**
 * dsh-skill-softcopyright —— 路径守卫
 *
 * 为什么需要它：工具层通过 `ctx.subprocess` 直接 spawn「解释器 + 包内只读脚本」，
 * 这条 seam **不带沙箱策略与审批**（`SubprocessSpawnSpec` 里没有 policy 字段），
 * 而带策略的 `ctx.shell` 只接受 shell 命令行字符串 —— 我们的路径含中文与空格，
 * 拼命令行等于引入一个随时会炸的转义层（详见设计文档 §0.5-N4 / M1 验收报告 §5）。
 *
 * 所以改成在**参数层面**做边界：用户提供的文件路径必须落在
 *   1) 调用会话的工作区，或
 *   2) 显式配置的 allowlist 目录，或
 *   3) 插件自己的只读资源目录（技能脚本与资产）
 * 之内。越界即拒绝，并给出可操作的提示。这给出的是真正的安全边界
 * （限制能碰哪些文件），而不是"拼成字符串再解析回来"。
 */
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';

/** Windows 下路径比较不区分大小写；统一用此函数判断包含关系。 */
export function isInside(parent, child) {
  if (typeof parent !== 'string' || typeof child !== 'string') return false;
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

/**
 * 尽力解析**真实**路径（跟随符号链接与 Windows 目录联接）。
 *
 * 为什么必须有这一步：`path.resolve` 只做词法归一化，**不解析链接**。
 * 于是工作区里一个指向外部的目录联接（Windows 上 `mklink /J` 不需要管理员权限）
 * 会让 `workspace\link\secret.txt` 在词法上仍位于工作区内 —— 边界被绕过。
 * 实测确认过这一点（见 test/probe-guard.mjs）。
 *
 * 写入场景下目标文件可能还不存在，此时向上找到**最近存在的祖先**解析真实路径，
 * 再把剩下的路径段拼回去。
 */
export function resolveRealPath(target) {
  const absolute = resolve(target);
  let current = absolute;
  const tail = [];
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = realpathSync.native(current);
      return tail.length === 0 ? real : resolve(real, ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute; // 已经到根仍解不开：回退到词法路径
      tail.unshift(basename(current));
      current = parent;
    }
  }
  return absolute;
}

/** 把一个候选路径归一化；失败返回 undefined。 */
export function normalizePath(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  try {
    return resolve(value);
  } catch {
    return undefined;
  }
}

/**
 * 建立路径守卫。
 *
 * @param options.enabled - false 时只记录不拦截（用于排查与自救）。
 * @param options.workspaceRoot - 会话工作区；未知时不启用工作区这一条。
 * @param options.allowlist - 额外允许的目录（绝对或相对）。
 * @param options.alwaysAllow - 无条件允许的目录（插件自身资源）。
 * @param options.cwd - 解析相对路径的基准，默认 workspaceRoot 或 process.cwd()。
 * @returns { check(value, label), assert(value, label), describe() }
 */
export function createPathGuard(options = {}) {
  const {
    enabled = true,
    workspaceRoot,
    allowlist = [],
    alwaysAllow = [],
    cwd
  } = options;

  const base = cwd ?? workspaceRoot ?? process.cwd();
  const roots = [];
  // 记录根时就把符号链接解析掉，保证与 target 的比较是在**同一套真实路径**上做的
  if (workspaceRoot !== undefined) {
    roots.push({ path: resolveRealPath(resolve(workspaceRoot)), kind: 'workspace' });
  }
  for (const item of alwaysAllow) {
    if (typeof item === 'string' && item.length > 0) {
      roots.push({ path: resolveRealPath(resolve(item)), kind: 'plugin-resource' });
    }
  }
  for (const item of allowlist) {
    if (typeof item === 'string' && item.length > 0) {
      const abs = isAbsolute(item) ? resolve(item) : resolve(base, item);
      roots.push({ path: resolveRealPath(abs), kind: 'allowlist' });
    }
  }

  /** 在一个已归一化的真实路径上判定是否被允许（不含 enabled 开关的处理）。 */
  function judge(target, label, value) {
    if (roots.length === 0) {
      // 无任何边界信息（例如拿不到会话工作区）：不拦截，但把状态显式暴露给调用方。
      return { ok: true, label, value, target, guarded: false, reason: 'no boundary known; guard skipped' };
    }
    for (const root of roots) {
      if (isInside(root.path, target)) {
        return { ok: true, label, value, target, guarded: true, root: root.path, kind: root.kind };
      }
    }
    return {
      ok: false,
      label,
      value,
      target,
      guarded: true,
      reason:
        `${label} "${target}" is outside the allowed roots. Allowed: ` +
        roots.map((r) => `${r.path} (${r.kind})`).join(', ') +
        '. Move the file into the session workspace, or add its directory to security.pathGuard.allowlist.'
    };
  }

  /** 判定一个路径是否被允许。 */
  function check(value, label = 'path') {
    const raw = isAbsolute(value ?? '') ? value ?? '' : resolve(base, value ?? '');
    const lexical = normalizePath(raw);
    if (lexical === undefined) {
      // 路径本身不可用（空、非字符串）属于调用方错误，**不受 enabled 影响**
      return { ok: false, label, value, reason: `${label} is not a usable path` };
    }
    const target = resolveRealPath(lexical);
    const verdict = judge(target, label, value);

    if (!enabled) {
      // `enabled:false` 的语义是"**只记录不拦截**"（排查与自救用）。
      // 所以这里放行，但把"本来会被拒"如实算出来交给调用方展示 ——
      // 否则这个开关就是死代码，用户文件全在工作区外时改它也救不回来。
      return {
        ok: true,
        label,
        value,
        target,
        guarded: false,
        enforced: false,
        wouldDeny: verdict.ok === false,
        reason: verdict.reason
      };
    }
    return verdict;
  }

  /** 同 check，但不允许时抛错。 */
  function assert(value, label = 'path') {
    const result = check(value, label);
    if (!result.ok) {
      const error = new Error(`softcopyright: ${result.reason}`);
      error.pathGuard = result;
      throw error;
    }
    if (!enabled) {
      return { ...result, enforced: false };
    }
    return { ...result, enforced: true };
  }

  return {
    check,
    assert,
    describe() {
      return {
        enabled,
        base,
        roots: roots.map((r) => ({ ...r }))
      };
    }
  };
}
