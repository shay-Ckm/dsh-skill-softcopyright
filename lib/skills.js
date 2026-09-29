/**
 * dsh-skill-softcopyright — L2 技能层
 *
 * 把 `assets/skills/` 下的四个软著交付技能注册进 `ctx.skills`，机制照抄官方
 * `@deepseek-ai/dsh-skill-office`：
 *
 *   ctx.skills.registerProvider(() => ({ name, list, get }))
 *
 * 每个技能的 `resourceBase` 指向它自己的磁盘目录，`skill` 工具会据此渲染
 * "Base directory for this skill: <path>" —— 技能正文里写的 `scripts/xxx.py`、
 * `references/xxx.md` 就是靠这个被 agent 找到的。
 *
 * 设计约束：
 *  - **正文原样透传**：只剥 frontmatter，不改一个字，避免与上游技能分叉。
 *  - 唯一的增强是**可选**地在正文末尾追加一段工具/流水线指引（`injectToolGuide`），
 *    磁盘上的 SKILL.md 文件本身始终 byte-identical。
 */
import { readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parse } from 'yaml';

/**
 * 随包技能的优先级 rank。
 *
 * 与 `@deepseek-ai/dsh-skill` 的 `BUNDLED_SKILL_RANK` 一致（值 600，
 * 释义为 "Standard precedence rank for packaged skill providers and local bundled roots"）。
 * 这里刻意不 import 该常量：为一个整数引入一个 peer 依赖不值得，且会让本模块
 * 无法脱离 DSH 运行时被单元测试导入。rank 越小优先级越高，600 意味着项目内
 * 或用户目录下的同名技能可以覆盖本插件的技能 —— 这是期望行为。
 */
export const BUNDLED_SKILL_RANK = 600;

/** 提供方名称，注册进 `ctx.skills` 时作为唯一标识。 */
export const PROVIDER_NAME = 'softcopyright';

/**
 * 四个技能的元数据。
 *
 * `invocation` 决定谁能加载它：
 *  - `modelInvocable` → 出现在会话目录里，模型可自行 `skill` 加载
 *  - `userInvocable`  → 用户可用 `/<name>` 显式拉起
 * 编排方技能两个都开；下游技能同样两个都开，因为用户也可能想直接点名某一个。
 */
export const SKILLS = [
  {
    name: 'python-software-delivery',
    invocation: { modelInvocable: true, userInvocable: true }
  },
  {
    name: 'manual-ui-screenshots',
    invocation: { modelInvocable: true, userInvocable: true }
  },
  {
    name: 'aigc-review-reduction',
    invocation: { modelInvocable: true, userInvocable: true }
  },
  {
    name: 'software-copyright-aigc-appeal',
    invocation: { modelInvocable: true, userInvocable: true }
  }
];

/**
 * 默认追加到每个技能正文末尾的指引。
 *
 * 只写**已经为真**的东西：流水线铁律是这套技能的既有知识，工具清单随里程碑更新。
 * M2 起把 sc_manual / sc_aigc / sc_source / sc_atlas / sc_proof / sc_audit / sc_pipeline
 * 逐项加进「可用工具」一节。
 */
export const DEFAULT_TOOL_GUIDE = `
## 本插件提供的编排与工具（dsh-skill-softcopyright）

本插件把这四个技能串成一条 10 步交付流水线，并提供确定性校验工具。
**技能正文（上文）仍然是唯一权威的作业说明**；本节只补充工具与纪律。

### 流水线铁律（不可违反）

1. **Checkpoint**：每阶段、每份产物完成并校验通过后，**立即停下汇报结果，等用户明确确认**
   才进入下一阶段。禁止一口气跑完全部流程；用户只说"继续吧"时也只推进一个 Checkpoint。
2. **四处口径一致**：源程序目录 = 源代码文档封面 = 哈希清单 = 研发日志 →
   同一组「N 个源文件 / M 行代码」。任何一步收窄范围，其余三处同步改。
3. **界面图集的完成判据是「插图版说明书 docx」**，不是"图集 HTML 已生成"。
4. **降 AIGC 只改文字、不动结构**：图题数、图片数、表格数、章节标题树必须保持不变。
5. **法律事实不代填**：著作权人、研发周期等留占位符，请用户确认后再替换。
6. **页数一律取真实渲染值**，不要用"每页 N 字"经验法。

### 可用工具

- \`sc_doctor\` — 体检：两条 Python 链、Word COM 可用性、技能资产完整性。

（M2 起陆续上线：\`sc_manual\` / \`sc_aigc\` / \`sc_source\` / \`sc_atlas\` / \`sc_proof\`，
M3 上线：\`sc_audit\` / \`sc_pipeline\`。）
`.trim();

/**
 * 解析 SKILL.md 的 YAML frontmatter。
 * @param raw - SKILL.md 全文。
 * @param path - 仅用于错误消息。
 * @returns 描述与正文（已 trim）。
 */
export function parseSkill(raw, path) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (frontmatter?.[1] === undefined) {
    throw new Error(`dsh-skill-softcopyright: ${path} has no YAML frontmatter`);
  }
  const metadata = parse(frontmatter[1]);
  const description =
    typeof metadata === 'object' && metadata !== null && 'description' in metadata
      ? metadata.description
      : undefined;
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error(`dsh-skill-softcopyright: ${path} has no description`);
  }
  return {
    description,
    content: raw.slice(frontmatter[0].length).trim()
  };
}

/**
 * 启动期严格校验资产目录，快速失败优于静默降级。
 *
 * 检查每个技能的 SKILL.md 存在且 frontmatter 合法、`scripts/` 目录存在。
 * @param assetRoot - 绝对路径，其下应有 `<skill>/SKILL.md`。
 * @returns 每个技能解析出的摘要。
 */
export function validateAssets(assetRoot) {
  if (!isAbsolute(assetRoot)) {
    throw new Error(`dsh-skill-softcopyright: assetRoot must be an absolute directory, got "${assetRoot}"`);
  }
  return SKILLS.map(({ name }) => {
    const directory = join(assetRoot, name);
    const skillPath = join(directory, 'SKILL.md');
    let raw;
    try {
      raw = readFileSync(skillPath, 'utf8');
    } catch (error) {
      throw new Error(
        `dsh-skill-softcopyright: cannot read ${skillPath} (${error?.code ?? error?.message}); ` +
          `the package assets are incomplete — reinstall the plugin`
      );
    }
    const { description } = parseSkill(raw, skillPath);
    try {
      if (!statSync(join(directory, 'scripts')).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new Error(
        `dsh-skill-softcopyright: ${directory} has no scripts/ directory; ` +
          `the skill cannot execute its helper scripts`
      );
    }
    return { name, directory, skillPath, description };
  });
}

/**
 * 构建技能提供方。
 *
 * `list()` 只返回摘要（不读正文），`get()` 按需读取并组装正文 —— 这是注册表的
 * 约定，也是目录渲染不付出正文 token 代价的前提。
 *
 * @param options.assetRoot - 技能资产根目录（绝对路径）。
 * @param options.injectToolGuide - 是否在正文末尾追加工具/流水线指引。
 * @param options.toolGuide - 指引正文，默认 {@link DEFAULT_TOOL_GUIDE}。
 * @param options.enabledSkills - 只启用其中若干技能；空数组 = 全部。
 * @param options.logger - 可选的 cordis logger。
 */
export function createSkillProvider(options) {
  const {
    assetRoot,
    injectToolGuide = true,
    toolGuide = DEFAULT_TOOL_GUIDE,
    enabledSkills = [],
    logger
  } = options;

  const resolved = validateAssets(assetRoot);
  const wanted = new Set(enabledSkills);
  const selected = wanted.size === 0 ? resolved : resolved.filter((s) => wanted.has(s.name));

  const unknown = [...wanted].filter((n) => !resolved.some((s) => s.name === n));
  if (unknown.length > 0) {
    throw new Error(
      `dsh-skill-softcopyright: skills.enabledSkills names unknown skills: ${unknown.join(', ')}; ` +
        `known: ${resolved.map((s) => s.name).join(', ')}`
    );
  }

  // 摘要（list 用）与 locator（get 用）分开持有，和官方实现同形。
  const candidates = selected.map(({ name, directory, skillPath, description }) => {
    const meta = SKILLS.find((s) => s.name === name);
    return {
      name,
      description,
      invocation: { ...meta.invocation },
      provider: PROVIDER_NAME,
      source: 'bundled',
      rank: BUNDLED_SKILL_RANK,
      resourceBase: { kind: 'directory', path: directory },
      locator: skillPath
    };
  });

  const provider = {
    name: PROVIDER_NAME,
    list: () => Promise.resolve(candidates),
    async get(candidate, getOptions) {
      // 候选摘要里不带 rank / locator，避免把它们泄漏进定义正文。
      const { rank: _rank, locator, ...summary } = candidate;
      const raw = await readFile(locator, { encoding: 'utf8', signal: getOptions?.signal });
      const base = parseSkill(raw, locator).content;
      const content = injectToolGuide ? `${base}\n\n${toolGuide}` : base;
      return { ...summary, content };
    }
  };

  logger?.info?.(
    `softcopyright: registered ${candidates.length} skill(s) from ${assetRoot}: ` +
      candidates.map((c) => c.name).join(', ')
  );

  return provider;
}
