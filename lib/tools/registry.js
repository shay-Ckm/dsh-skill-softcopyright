/**
 * dsh-skill-softcopyright —— 分组工具工厂
 *
 * 设计动机（设计文档 §3.3 「混合粒度」）：DSH 每个工具的 schema 都常驻每次请求，
 * 20 个脚本各做一个工具会让 token 开销失控。因此把同一领域的多个脚本收进**一个**
 * `action` 分组工具；只有 `sc_audit` / `sc_pipeline` 这类高频、需强 schema 的才单列。
 *
 * 输出信封刻意只用"已在真机验证受支持"的 schema 形状：
 * 对象根 + `additionalProperties: false` + boolean/string/array-of-string。
 * （`sc_doctor` 用的就是这一形状，已在真机跑通。）结构化数字以 `key=value` 字符串
 * 放进 `fields`，既避免依赖未验证的嵌套对象支持，又不丢信息。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

/**
 * 构建一个 action 分组工具。纯函数：不碰 ctx、不留模块状态。
 *
 * @param options.name - 工具名。
 * @param options.description - 面向模型的描述（要说清"什么时候用我"）。
 * @param options.prompt - `{ name, order, text }`，由调用方注册成 systemPrompt 段。
 * @param options.params - 参数名 → DSH 参数 schema 片段（各 action 共享同一份定义）。
 * @param options.actions - action 名 → `{ summary, uses: [参数名], optional?: [参数名], run, concurrencySafe? }`。
 *   `uses` 里的参数进 schema；不在 `optional` 里的一律视为**必填**，缺了报可操作错误。
 *   `run` 返回 `{ ok, fields?, output?, summary? }`；`fields` 为 `key=value` 字符串数组。
 * @param options.timeoutMs - 工具级超时（`defineTool` 只接受静态值，故取各 action 的最大者）。
 * @param options.kind - `presentCall` 卡片里的 kind。
 * @param options.onResult - 可选钩子 `({ tool, action, envelope, exec })`，在每次 action
 *   返回信封后调用。用于把"哪个工具跑过、结果如何"记为流水线证据（门禁据此判定）。
 *   钩子抛错**不影响**工具结果（证据是旁路，不该让业务失败）。
 * @param options.sharedParams - 所有 action 共有的**可选**参数名：进 schema、不强制。
 *   用于 `projectRoot` 这类横切参数，免得 7 个 action 各写一遍 uses/optional。
 * @returns `{ tool, prompt }`
 */
export function buildActionTool(options) {
  const {
    name,
    description,
    prompt,
    params = {},
    actions,
    timeoutMs = 300000,
    kind = 'softcopyright',
    sharedParams = [],
    onResult
  } = options;

  const actionNames = Object.keys(actions);
  if (actionNames.length === 0) throw new Error(`softcopyright: tool "${name}" declares no actions`);

  // 参数取所有 action 的并集；"哪些必填"由各 action 的 uses 决定，在 execute 里校验。
  const usedParams = new Set(sharedParams);
  for (const actionName of actionNames) {
    for (const key of actions[actionName].uses ?? []) usedParams.add(key);
  }
  const unknown = [...usedParams].filter((key) => params[key] === undefined);
  if (unknown.length > 0) {
    throw new Error(`softcopyright: tool "${name}" references undeclared params: ${unknown.join(', ')}`);
  }

  const parameters = {
    action: {
      type: 'string',
      required: true,
      enum: actionNames,
      description: actionNames.map((a) => `${a} — ${actions[a].summary}`).join(' | ')
    }
  };
  for (const key of usedParams) parameters[key] = params[key];

  const tool = defineTool({
    name,
    description,
    parameters,
    timeoutMs,
    isConcurrencySafe: (args) => actions[args?.action]?.concurrencySafe !== false,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          fields: { type: 'array', required: true, items: { type: 'string' } },
          output: { type: 'string' }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }]
    },
    async execute(args, exec) {
      const actionName = args?.action;
      const action = actions[actionName];
      if (action === undefined) {
        throw new Error(
          `softcopyright: ${name} requires "action"; expected one of: ${actionNames.join(', ')}`
        );
      }
      // `optional` 里的参数进 schema 但不强制；`sharedParams` 一律可选；其余 `uses` 必填
      const optional = new Set([...(action.optional ?? []), ...sharedParams]);
      const missing = (action.uses ?? []).filter(
        (key) =>
          !optional.has(key) &&
          (args[key] === undefined || args[key] === null || args[key] === '')
      );
      if (missing.length > 0) {
        throw new Error(
          `softcopyright: ${name} action "${actionName}" requires: ${missing.join(', ')}`
        );
      }
      const result = await action.run({ args, exec, action: actionName });
      // ⚠️ 信封里**不能出现 undefined**：DSH 要求工具输出是 **lossless JSON**，带 undefined
      // 属性会被拒。实测报错：`tool "sc_pipeline" returned invalid output: value is not
      // lossless JSON`（因为 sc_pipeline 的 action 只回 summary/fields，没有 output）。
      // 可选项一律条件展开。
      const envelope = {
        ok: result.ok === true,
        action: actionName,
        summary: result.summary ?? defaultSummary(name, actionName, result),
        fields: result.fields ?? [],
        ...(result.output === undefined ? {} : { output: result.output })
      };
      if (onResult !== undefined) {
        // 证据是旁路：记录失败不该让业务结果失败
        try {
          onResult({ tool: name, action: actionName, envelope, exec, args });
        } catch {
          /* ignore */
        }
      }
      return envelope;
    },
    presentCall(args) {
      const actionName = args?.action ?? '?';
      return {
        card: 'generic',
        title: `${name} ${actionName}`,
        kind,
        rawInput: actionName
      };
    }
  });

  return { tool, prompt };
}

/** 没给 summary 时兜底渲染：标题 + 字段行。 */
function defaultSummary(name, actionName, result) {
  const lines = [`${name} ${actionName}: ${result.ok === true ? 'OK' : 'FAILED'}`];
  for (const field of result.fields ?? []) lines.push(`  ${field}`);
  if (result.output) lines.push('', result.output);
  return lines.join('\n');
}

/** 把适配器采集到的字段拼成 `key=value` 行；空值跳过，便于模型与渲染直接消费。 */
export function toFields(pairs) {
  const out = [];
  for (const [key, value] of Object.entries(pairs)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      out.push(`${key}=${value.join(',')}`);
    } else {
      out.push(`${key}=${value}`);
    }
  }
  return out;
}
