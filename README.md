# dsh-skill-softcopyright

**软件著作权（软著）交付流水线插件** — 面向 DeepSeek Harness 的 DSH 插件。

把「软件开发 → 回归测试 → 源码打包 → 说明书 → 界面图集 → 源代码文档 → 降 AIGC → 申诉证明 → 统一交付」
做成了**一条带门禁的流水线**，并且把软著送审最硬的那条要求
——「**四处口径一致**」—— 做成了可机械校验的能力。

> 详细中文文档见 [README.zh.md](README.zh.md)。

---

## 它解决什么问题

软著送审要求 **四处必须报出同一组「N 个源文件 / M 行代码」**：
源程序目录、源代码文档封面、哈希值清单、研发日志。

这四个数字分别由**不同的脚本**生成，而**没有任何工具负责交叉校验** ——
任何一步收窄了范围，其余三处就会无声地对不上。

本插件新增的能力就是：**在交付前把四处读出来交叉核对，不一致就报出来并指出修法**
（并且规则是「以源程序目录为准，重新生成其余三处」，**禁止手改单个文档**）。

## 功能一览

| 类型 | 内容 |
|---|---|
| **技能** | 4 个：Python 全流程交付、界面图集、降 AIGC、AIGC 申诉证明 |
| **工具** | 8 个 / 33 个 action：`sc_doctor` `sc_manual` `sc_source` `sc_aigc` `sc_proof` `sc_atlas` `sc_audit` `sc_pipeline` |
| **编排** | 10 阶段清单（可定制 YAML）+ 三类门禁 + 证据记录 + Checkpoint 强制汇报 |
| **命令** | `/sc-status` `/sc-audit` `/sc-milestone` `/sc-reset` |
| **审计** | 四处口径一致、图集屏数 vs 说明书图题/图片数、源码范围 |

## 安装

### 方式一：DSH 插件管理页（推荐）

打开 **设置 → 插件管理**，在安装框中输入包名：

```
dsh-skill-softcopyright
```

安装源可选「npm 官方源」或「中国大陆镜像源」。

### 方式二：命令行

```bash
npm install dsh-skill-softcopyright
```

### 方式三：手动放入 profile

把本包复制到 `<DSH_HOME>/profiles/<profile>/node_modules/dsh-skill-softcopyright/`，
并在该 profile 的 `cordis.patch.yml` 中追加：

```yaml
- insert:
    - id: skill-softcopyright
      name: dsh-skill-softcopyright
      config: {}
```

重启 DSH 后，应看到 **8 个工具**与 `/sc-*` 命令。
首次使用请先调用 `sc_doctor` 体检，确认两条 Python 链与资产完整。

## 快速开始

```
sc_doctor                                    # 体检：运行链 / 受管 seam / 资产
sc_pipeline action=status                    # 看 10 阶段与共享口径
sc_pipeline action=recompute-facts sourceDir=<项目的 src 目录>
sc_source  action=gen-doc     sourceDir=... outPath=...
sc_manual  action=check       docx=...       # 图位版格式复验
sc_atlas   action=shoot                      # 真实浏览器逐屏截图
sc_manual  action=insert-atlas docx=... atlasDir=...
sc_manual  action=check-figs  docx=...       # 图题数 == 图片数
sc_audit   action=four-way    projectRoot=... sourceDir=...
```

**流水线铁律**：每个阶段完成并校验通过后**立即停下汇报**，等明确确认才继续。

## 可定制项

改 `cordis.patch.yml` 里本插件的 `config` 段即可（**热生效，无需重启**）：

| 配置 | 作用 |
|---|---|
| `source.includeExt` / `excludeDirs` | 送审源程序的收录范围（多语言项目就靠它） |
| `skills.enabledSkills` / `injectToolGuide` | 只启用部分技能 / 是否注入工具指引 |
| `tools.*` | 逐个开关 8 个工具 |
| `pipeline.manifestPath` | 换成你自己的阶段清单 YAML |
| `pipeline.commands` / `recordEvidence` | 命令与证据记录的开关 |
| `security.pathGuard.allowlist` | 允许工具访问工作区外的目录 |
| `runtime.*` | 两条 Python 链的路径与超时 |
| `diagnostics.bootLog` | 启动自诊断日志开关 |

## 设计取舍（值得先说清）

- **页数一律以 Word COM 真实渲染为准**，估算只作兜底；`pagesSource` 字段会如实标注来源。
- **`check_aigc` 的退出码恒 0、没有成败语义**，判读必须比对数值目标，不能看退出码。
- **插件自带启动自诊断**：`apply()` 逐段隔离，某段失败只丢那段；
  日志写在 `$DSH_HOME/softcopyright-boot.log`（测试进程不写）。
- **每个工具的输出信封不含 `undefined`**（DSH 要求 lossless JSON）。

## 测试

```bash
node test/run-all.mjs
```

13 个 harness / 639 项断言，含：
路径守卫安全性（链接绕过）、超时与终止安全性、**12 个解析器 ↔ 真实脚本端到端**、
全部 33 个 action 可调用性、`ctx` 属性访问静态守卫（含自测）。

## 关于随包技能资产（**发布前必读**）

`assets/skills/` 下的四个技能包，其 `SKILL.md` 均标记 `agent_created: true`，
且**无作者署名与许可证**。若你不是这些内容的著作权人，公开分发即构成再分发他人作品。
详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

**只带框架发布**（不确定归属时的稳妥做法）：从 npm 包中移除 `assets/skills/`，
使用者把自己的技能包放到 `assets/skills/` 下即可 —— 插件的全部工具与编排不依赖具体技能内容。

## 许可证

[MIT](LICENSE)。随包分发的第三方组件声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
