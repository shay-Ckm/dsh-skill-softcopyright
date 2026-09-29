# dsh-skill-softcopyright

软件著作权交付流水线的 DSH 插件：内置 4 个交付技能 + 10 步编排 + 确定性校验工具。

> **当前状态：M1 完成（技能层 + 运行时 + 体检工具）。**
> 工具层（`sc_manual` / `sc_aigc` / `sc_source` / `sc_atlas` / `sc_proof`）在 M2，
> 编排层（`sc_audit` / `sc_pipeline` / `/sc-*` 命令）在 M3。
> 设计文档：`docs/软著交付流水线插件-开发设计文档-v0.1.md`（v0.2）。

## 内置的 4 个技能

| 技能 | 角色 | 内容 |
|---|---|---|
| `python-software-delivery` | **编排方**（Phase 1–5.6） | 5 篇 references + 12 个脚本 |
| `manual-ui-screenshots` | 下游，Phase 5.2 界面图集 + 回填 docx | 1 篇 reference + 8 脚本 + 4 前端资产 |
| `aigc-review-reduction` | 下游，Phase 5.4 降 AIGC 率 | 3 篇 references + 2 脚本 |
| `software-copyright-aigc-appeal` | 下游，Phase 5.5 申诉证明 | 4 脚本 |

技能正文**原样收录**，磁盘上的 `SKILL.md` 与原始技能包 byte-identical（harness 用 SHA-256 锁住）。
插件只在其上追加一段"工具与流水线指引"，该注入可用 `skills.injectToolGuide: false` 关闭。

已做的去重：
- `check_aigc.py` 两个版本统一为 **17907 字节的超集版**（含 `--struct` 21 类结构扫描）。
- `references/aigc-reduction.md` 经核对本来两份就一致，保留双份但由 harness 锁一致性。

## 提供的工具

**混合粒度**（设计文档 §3.3）：高频/需强 schema 的单列，同领域的收进一个 `action` 分组工具，
以控制常驻每次请求的 schema token。

| 工具 | 粒度 | action | 关键点 |
|---|---|---|---|
| `sc_doctor` | 细粒度 | — | 体检：两条 Python 链、Word COM、受管 seam、资产完整性 |
| `sc_manual` | 分组 | `check` `stats` `check-figs` `insert-atlas` `extract` `render-pdf` | `stats` 默认走**渲染链**取 Word COM 真实页数；返回 `pagesSource` |
| `sc_source` | 分组 | `gen-doc` `check-doc` `build-package` `smoke` `collect-hashes` `stats-hashes` | 产出**四处口径的权威 N 文件/M 行**；`build-package` 会替脚本判 sdist 失败 |
| `sc_aigc` | 分组 | `scan` `struct` `probe` | **退出码恒 0 无语义**，需比对 `vocabReductionTarget` / `structuralResidueTarget` |
| `sc_proof` | 分组 | `gen-docx` `gen-html` `page-estimate` `check-inline-js` | 法律事实留占位符；检测"保存失败但退出码 0" |
| `sc_atlas` | 分组 | `validate` `check-html` `scale` `shoot` | `shoot` 走渲染链（Playwright + 真实 Chrome），耗时长 |
| `sc_audit` | 细粒度 | `four-way` `source-scope` `figures` | **四处口径一致性审计**（原技能包完全没有的能力） |
| `sc_pipeline` | 细粒度 | `status` `plan` `advance` `checkpoint` `skip` `recompute-facts` `reset` | 10 步状态机 + **Checkpoint 门禁** |

## 交付流水线（M3）

`assets/pipeline.yaml` 是一份**可定制的 10 步清单**：改阶段、改判据、改顺序、加不变量都只改 YAML，
不动 JS。启动时 `lib/pipeline/manifest.js` 严格校验（id 唯一、技能名、requires 环、判据 kind），写错立刻报错。

| 阶段 | 标题 | 完成判据 |
|---|---|---|
| `p1-requirements` | 需求确认 | 用户确认（4 项决策） |
| `p2-development` | 开发 | 用户确认 |
| `p3-regression` | 回归测试 | 用户确认 |
| `p4-package` | 源码打包 | `dist/*.zip` + `sc_source build-package` 证据 |
| `p5-1-manual` | 使用说明书 docx | 说明书 docx + `sc_manual check` + 图位≥30 + 页数须真实渲染 |
| `p5-2-atlas` | 界面图集 + 回填 | `sc_manual check-figs`：**图题数 == 图片数**、残留占位段 0 |
| `p5-3-srcdoc` | 源代码文档 docx | 源代码文档 docx + `sc_source check-doc` |
| `p5-4-aigc` | 降 AIGC（**按需**） | 降幅 ≥50% + 结构性残留 0 |
| `p5-5-proof` | 申诉证明（**按需**） | 两份 docx + `collect-hashes` + **四处口径一致** |
| `p5-6-delivery` | 统一交付 | 四处口径一致 + 用户确认 |

### 门禁怎么工作（「中约束」）

推进必须调用 `sc_pipeline action=advance`，它要求三类判据全过 **且** `confirmedByUser === true`：

| 判据 | 含义 |
|---|---|
| `artifacts` | 产物 glob 必须存在 |
| `evidence` | 某个 tool+action 必须**已通过**，且**晚于本阶段开始时间**（防"改了内容没重跑校验就推进"） |
| `measure` | 字段相等/上下界、页数来源必须是真实渲染、四处口径一致 |

**`mustStopAfter: true` 本身即要求用户确认** —— 这是 harness 抓出来的设计缺口：最初只有显式写了
`user-confirmed` 判据的阶段才拦确认，于是 p5-1 / p5-2 可以不带确认就推进，恰好违背技能正文的铁律。

> 为什么不做成 `agent/pre-step` 硬拦截：那属于深度干预 agent 循环，调试与误伤成本都高，
> 且会和 Aegis / browser-skill 抢同一个接缝。**"绕过去会被 `sc_audit` 抓出来"比"绕不过去"更稳。**

### 状态与证据

- 状态文件：**项目内** `<projectRoot>/.dsh/softcopyright/state.json`（项目自包含、多项目隔离）
- `sharedFacts` 是「四处口径」的**单一真源**：「N 个源文件 / M 行」只存这一份，四处消费点都读它
  → 任何一步收窄范围，`recompute-facts` 重算一次就自动对齐
- 每次工具执行自动记为证据（`pipeline.recordEvidence`，可关）

### 斜杠命令

`/sc-status` 查进度 · `/sc-audit` 立刻跑四处审计 · `/sc-milestone <phaseId>` 标记已汇报 · `/sc-reset confirm` 清空状态

### ⚠️ 行数口径必须与上游脚本一致（已交叉验证）

`sc_audit` 的价值全在于它报的「M 行代码」与源代码文档封面、哈希清单、研发日志一致。
**若我的行数口径与生成那些文档的脚本不同，审计就会误报不一致 —— 比没有审计更糟。**

上游口径是 Python 的 `f.read().splitlines()` / `fh.readlines()`：**结尾换行符不产生额外一行**
（`"a\nb\nc\n"` 是 3 行而非 4 行）。我第一版写成 `split(/\r?\n/).length`，会多算 1 行。

现已用真实脚本交叉验证（[linecount-parity.mjs](test/linecount-parity.mjs)）：

```
脚本报告 : files=12 lines=1865 bytes=79467
我的口径 : lines=1865      逐文件不一致数 : 0
结论：PASS —— 行数口径与上游脚本完全一致
```

> **文件筛选规则**（`source.includeExt` / `excludeDirs`）是可配置的，与行数口径无关；
> 上面 12 vs 11 的文件差异就来自 `includeExt` 默认只收 `.py`。

### 三个必须知道的语义（来自对 20 个脚本的逐字精读）

1. **退出码语义分三类**，不能一律当"成功/失败"：
   - `check_manual_docx` / `manual_stats` / `check_src_doc` / `check_manual_with_figs` /
     `validate_atlas` / `validate_html` / `probe_residue` / `check_inline_js` /
     `package_smoke_template` → **退出码就是校验结论**。
   - `check_aigc` / `build_src_package` / `gen_proof_docx` / `gen_src_docx` /
     `page_estimate` / 两个哈希脚本 / `insert_atlas_into_manual` / `scale_units`
     → **恒退出 0，退出 0 也可能业务失败**。插件已替它们判：
     `sdistStatus`、`generated[]`、`existingImages`（二次插图）等字段就是判据。
   - argparse 脚本 → 退出码 2 是"用法错误"，插件报 `ran=false` 而不是"不通过"。

2. **两个哈希脚本的汇总统计打在 stderr**，键名还不同
   （`# TOTAL_FILES=…` vs `# FILES=…`）。插件同时捕获两个流。

3. **`check_aigc` 没有任何达标语义**。降 AIGC 是否达标必须按配置阈值判断，
   插件只提供数字并附上阈值提示。

### 路径守卫（替代沙箱策略）

工具层通过 `ctx.subprocess` 直接 spawn「解释器 + 包内只读脚本」。该 seam **不带沙箱策略与审批**，
而带策略的 `ctx.shell` 只接受 shell 命令行字符串 —— 我们的路径含中文与空格，拼命令行会引入
一个随时会炸的转义层。因此边界改在**参数层**：用户提供的每个文件路径都必须落在
**会话工作区**、**配置的 allowlist**、或**插件自身只读资源目录**之内，越界即拒绝并给出可操作提示
（`lib/guard.js`）。可用 `security.pathGuard.enabled: false` 关闭（不建议）。

## 两条 Python 链（实测结论）

本插件区分两条解释器链，**按 action 选择**而不是统一用一个：

| 链 | 解释器 | 能力 | 用它做什么 |
|---|---|---|---|
| `generate` | 随包 Python（DSH 自带 3.12.14） | python-docx 1.2.0、lxml、Pillow；**无 pywin32、无 playwright** | 生成与校验 docx、打包、哈希统计 |
| `render` | `C:\Python314\python.exe` | pywin32 312 + Word 16.0、python-docx 1.2.0、**playwright 1.62.0 + chromium-1234** | Word COM 取真实页数、docx→PDF、真实界面截图 |

**页数与 PDF 以 Word COM 为权威口径**（决策 Q9）。`sc_manual action=stats` 会始终返回
`pagesSource` 字段，让"这次页数是估的"不可能被忽略。

**界面图集的真实运行截图走 `render` 链** —— 该链已装 playwright 1.62.0 与 chromium，
本机另有真 Chrome / Edge 可用 `channel` 启动（技能正文警告过：用 Playwright 自带
chromium 或无头 GPU 会整屏全黑）。因此**不需要 bsk，也不需要新装依赖**。

## 安装

本插件是一个 **DSH profile bundle**（`package.json` 声明 `dsh.bundle.patch`，
并通过 `exports["./cordis.patch.yml"]` 暴露 patch）。

### 1. 放置包体

```powershell
$src = "E:\Users\L\Desktop\个人ai项目\deepseel-harness\plugins\dsh-skill-softcopyright"
$dst = "C:\Users\L\.dsh\profiles\desktop\node_modules\dsh-skill-softcopyright"
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dst | Out-Null
foreach ($i in @("package.json","cordis.patch.yml","lib","assets","README.zh.md")) {
  Copy-Item -LiteralPath (Join-Path $src $i) -Destination $dst -Recurse -Force
}
```

> ⚠️ **不要复制开发用的 `node_modules/`。** 该目录下是为本地 harness 从 `app.asar`
> 抽出的官方包副本；一旦它随包进入 profile，Node 会优先从插件自己的 `node_modules`
> 解析 `@deepseek-ai/cordis`，**形成第二份 cordis 实例，破坏 Service 单例约束**。
> 同理，本插件**刻意不写进 profile 的 `dependencies`**：pnpm 对本地目录依赖会建**软链**，
> 软链会让 Node 以真实路径（工作区）解析，从而暴露上述副本。这是有意为之的取舍，
> 不是遗漏。

### 2. 声明为 bundle

在 `C:\Users\L\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles` 末尾追加：

```json
"dsh-skill-softcopyright"
```

（bundle 自己提供的 Loader 行 id 是 `skill-softcopyright`。你可以像 `browserskill`
那样，再在 `cordis.patch.yml` 里用同一个 id 覆盖它的 `config` —— 层次语义是**后写者胜**，
不会产生重复行。）

### 3. 重启

**配置改动（`cordis.patch.yml` / `package.json`）热生效，但插件 JS 模块代码不会**
（ESM 模块缓存）。改了 `lib/` 下任何文件都必须重启 DSH 桌面进程。

### 4. 在哪里能看到它

| 页面 | 数据来源 | 本插件 |
|---|---|---|
| 设置 → **内置插件**（只读清单） | `pluginInventory/list` = 每条非 group 的 Loader 行 | ✅ 显示为 `dsh-skill-softcopyright`，阶段 `active` |
| 侧边栏 → **Plugins**（可管理） | profile 的 **bundles** 及可寻址行 | ✅ 声明为 bundle 后出现 |

### 5. 验证

- 新会话的 `skill` 目录里出现上述 4 个技能。
- 调用一次 `sc_doctor`，应报告两条链 `状态: OK`、`seam: subprocess`、`结论：可用。`

## 配置

写在 **profile 的 `cordis.patch.yml` 里本插件条目的 `config` 字段**（由 loader 依据
`Config` schema 校验后传给 `apply()`）。

> ⚠️ **不是 `$DSH_HOME/settings.yaml`。** 实测 DSH 0.1.7-rc.2 中
> `@deepseek-ai/dsh-settings` 只导出 `SettingsConflictError / SettingsForms / redactSecrets`，
> `installSettingsSection` / `settingsNamespace` **不存在**；`settings.yaml` 机制也已废弃
> （本机的 `settings.yaml` 早已被改名 `settings.yaml.imported`）。
> 另外：**配置改动热生效，但 `lib/` 下的代码改动需要重启进程。**

```yaml
- id: skill-softcopyright
  name: dsh-skill-softcopyright
  config:
    skills:
      enabled: true
      assetRoot: ""            # 空 = 包内 assets/skills/
      injectToolGuide: true    # 是否在技能正文末尾追加工具/流水线指引
      enabledSkills: []        # 空 = 全部 4 个

    tools:
      doctor: true

    runtime:
      pythonPath: ""                                  # 空 = 自动解析随包 Python
      renderPythonPath: "C:\\Python314\\python.exe"   # 需 pywin32 + Word 的 Python
      defaultTimeoutMs: 60000
      longTaskTimeoutMs: 300000
```

## 自检与测试

两个 harness 都需要一些**开发用依赖**（`node_modules/` 已被 `.gitignore` 忽略，全新检出后须重建一次）：

| 依赖 | 谁需要 | 来源 |
|---|---|---|
| `yaml` | `lib/skills.js`（解析 frontmatter） | profile 的 `node_modules/yaml` |
| `@deepseek-ai/{schemastery,dsh-tools,dsh-util-values,dsh-brand,cosmokit,cordis,dsh-scope,dsh-llm,dsh-typert-protocol,dsh-util-crypto,dsh-timeout,dsh-sandbox}` | `lib/index.js` / `lib/tools/doctor.js` 的真实依赖链 | 从 `app.asar` 用 `tools/asar-extract.mjs` 抽出 |

```powershell
$p    = "E:\Users\L\Desktop\个人ai项目\deepseel-harness\plugins\dsh-skill-softcopyright"
$dst  = "$p\node_modules"
$ref  = "E:\Users\L\Desktop\个人ai项目\deepseel-harness\_ref_skills\_dsh\dsh\node_modules"
$node = "E:\Users\L\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
$asar = "E:\Users\L\AppData\Local\Programs\DeepSeek Harness\resources\app.asar"

New-Item -ItemType Directory -Force -Path "$dst\@deepseek-ai" | Out-Null
Copy-Item -Recurse "C:\Users\L\.dsh\profiles\desktop\node_modules\yaml" "$dst\yaml" -Force
# 其余官方包：按 harness 报出的缺失名逐个抽出（见 tools\asar-extract.mjs 用法）
```

然后：

```powershell
$p = "E:\Users\L\Desktop\个人ai项目\deepseel-harness\plugins\dsh-skill-softcopyright"

# 语法检查
node --check "$p\lib\index.js"

# M1 验收 harness（133 项断言，覆盖 A1–A4）
$env:DSH_HOME = "C:\Users\L\.dsh"
node "$p\test\harness.mjs"
```

harness 直接测 `lib/skills.js`、`lib/runtime.js`、`lib/tools/doctor-core.js` 这三个
**不 import `@deepseek-ai/*`** 的模块（那些包只存在于 `app.asar` 内，普通 node 进程
import 不到）。因此 `lib/index.js` 与 `lib/tools/doctor.js` 只能做语法检查，
其运行时验证依赖 profile 重载后的集成测试。

## 目录结构

```
lib/
  index.js            插件入口：name / inject / apply / Config
  skills.js           L2 技能提供方（ctx.skills.registerProvider）
  runtime.js          L1 两条 Python 链 + 受管子进程 seam + UTF-8 环境
  tools/
    doctor.js         sc_doctor 注册层（唯一 import defineTool 的地方）
    doctor-core.js    sc_doctor 体检逻辑（可在 DSH 外测试）
assets/skills/        4 个技能的 SKILL.md / references / scripts / assets
test/harness.mjs      M1 验收 harness
```

## 设计要点

- **子进程走受管 seam**：优先 `ctx.subprocess`（`resolveExecutable` / `spawn` /
  `handle.collected.stdout.readFrom(0)`），而不是裸 `node:child_process` —— 受管 seam
  有界收集输出、托管进程组、可终止，且不依赖受限模式下可能被拒的管道 stdio。
  服务缺席时退回 `node:child_process` 并把 `seam: 'node'` 显式标注出来，降级可见。
- **超时双保险**：超时回调除 `abort` 外**还主动调用 `handle.terminate()`**。
  只依赖 provider 响应 abort 信号会让长时间脚本挂死调用方（M1 实测踩到）。
- **UTF-8 强制注入**：Windows 上 Python 默认用 cp936 写 stdout，中文会乱码；
  插件固定注入 `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8` / `PYTHONUNBUFFERED=1`。
- **无客户端 half**：不声明 `dsh.client`，不需要前端构建链（决策 Q7）。
- **启动期严格校验**：`assetRoot` 缺失、SKILL.md 无 frontmatter、`scripts/` 不存在、
  `enabledSkills` 写了未知名 —— 一律在 `apply()` 时抛错，快速失败优于静默降级。

## 路线图

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 | 插件骨架 + 4 技能注册 + 运行时 + `sc_doctor` | ✅ |
| M2 | `sc_manual` / `sc_aigc` / `sc_source` / `sc_atlas` / `sc_proof` | 待做 |
| M3 | `pipeline.yaml` 清单 + 状态机 + 门禁 + `sc_audit` + `/sc-*` | 待做 |
| M4 | README、npm 打包、端到端验收 | 待做 |
