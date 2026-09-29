---
name: manual-ui-screenshots
description: 为软件《使用说明书》生成界面图集（软著申请用）并把图集直接插入说明书 docx 对应图位。当用户要求"把说明书里的图/界面截图用HTML生成""给说明书配界面图""生成图1~图N界面""软件界面图集""截图插入说明书"等，或提供使用说明书 docx（+可选源代码 docx）要求生成全部界面截图时使用。工作流：提取说明书图位清单 → **首选 Playwright 驱动真实运行中的软件逐屏截取 2559×1559 真实界面**（目标软件不可运行时才按描述重建 HTML 界面）→ md5 唯一性校验 → **insert_atlas_into_manual.py 回填进说明书 docx 图位** → 插图版复验。This skill should be used when generating UI screenshot albums (figure sets) for software user manuals or software copyright (软著) applications, and inserting them back into the manual docx.
agent_created: true
---

# 说明书界面图集生成（manual-ui-screenshots）

## Overview

产出并交付**说明书界面图集**：为说明书中的"图 1~图 N"各生成一张 **2559×1559** 全屏界面图，然后把它们**直接插入说明书 docx 的对应图位**，使说明书成为图文自洽的完整交付材料。

**三条出图路径（按优先级）**：

| 优先级 | 路径 | 适用 | 产出方式 |
|---|---|---|---|
| **A（首选）** | **真实运行截图** | 目标软件是可运行应用（Flask/Web/桌面） | Playwright 驱动运行中的软件逐屏截图，数据是真实计算结果 |
| B | 真实界面还原 | 软件跑不起来，但有完整前端源码与数据接口 | 内联真实 CSS + 复用真实页面结构 + 调用 core 模块真实数据（见 `references/real-ui-rendering.md`） |
| C | 按描述重建 | 只有说明书 + 源代码 docx，无运行环境 | 按「图标题 + 上下文描述 + 源码字段」用 cqw/cqh 容器单位重建 |

**关键前提**：说明书中的"图 N"通常只是占位框（「（界面截图，此处插入：xxx）」），**没有真实截图**。三条路径都是在补这个缺。

**交付形态（缺一不可）**：① `docs/atlas/figNN.png` 截图（2559×1559）；② 图集 HTML（可选，供预览/复用）；③ **图集已回填进说明书 docx**（MUST，见 Step 7）——只交 HTML 不插图，审查方看到的仍是 37 个空图位。

## 用户强约束（MUST，历次反馈沉淀）

1. **每屏 = 该界面的所有内容**：一张图必须呈现对应页面**完整真实内容**（全部表单字段、全部图表、全部表格行、完整代码区），禁止"只画相关内容"的局部拼贴。
2. **必须是真实运行界面**：优先"真实界面还原路径"（内联真实 CSS/复用真实页面结构/core 模块真实数据），禁止示意拼贴、占位文字、近似布局（用户原话"现在生成的界面显示的不是真实运行时的界面"）。
3. **终端/命令行截图 = 独立终端窗口**：渲染为黑底 cmd 窗口（标题栏 + 菜单栏 + 命令行区），**禁止套进软件侧栏+主区域布局**（用户原话"为什么是在软件界面里会有终端命令行？"）。
4. **图位一一对应**：图集屏数 = 说明书图位数，逐屏同号同题。
5. **界面居中 + 整体放大 150%**（用户偏好）：`.shot` 固定 2559×1559，内部按 1706×1039 设计后用 `transform:scale(1.5)` 放大；外层 `.wrap` 全宽、截图区 `margin:0 auto` 居中；ECharts `devicePixelRatio:2` 保证放大后清晰。
6. **内容不被裁剪**：放大后每屏内容高度必须 ≤ 设计高 1039px（紧凑化：压缩卡片间距/行高/图表高度，保留全部元素与真实值）。
7. **波形/图表必须真实渲染**：交付前用 stub（假 echarts/document/window/setTimeout）**实际执行全部图表 init 脚本零异常**（防 `series[0]` 类未定义变量导致整图空白）。
8. **Checkpoint（铁律）**：图集生成并校验通过后**立即停下，向用户汇报（屏数/校验结果/预览地址），等待用户审阅确认后再继续**；用户提出修改意见时按图号逐屏调整，每轮调整后再次停下等审阅。禁止一口气改完多轮。
9. **图集必须回填进说明书 docx（MUST，2026-09-27 用户明确要求）**：图集 HTML 只是中间产物，"生成图集"这件事的完成标准是**插图版 docx**。截图完成后必须用 Step 7 把 `figNN.png` 按图号插进说明书的「图 N」图位、删掉「（界面截图，此处插入…）」占位段，并对插图版跑 `check_manual_with_figs.py`（图题数 == 图片数）。**禁止把"图集 HTML 已生成"当作任务完成来汇报。**
10. **先回填、后统一复验**：插图会使页数显著增加（实测 45 页 → 60 页，+33%）；若用户对页数有约束，须在插图**前**确认，插图后再压页数代价更高。

## Workflow

### Step 0：判定路径（先做这一步，别急着出图）

**先问自己一句话：目标软件现在能不能跑起来（有服务地址 / 能启动）？**

| 现象 | 走哪条路 | 章节 |
|---|---|---|
| 能启动服务（如 `python app.py` 后浏览器可访问） | **路径 A：真实运行截图（首选）** | 见下方「路径 A」 |
| 跑不起来，但有完整前端源码 + 数据接口 | **路径 B：真实界面还原** | 见下方「路径 B」 |
| 只有说明书 + 源代码 docx，无运行环境 | **路径 C：按描述重建** | 见下方「路径 C」 |

**同时**先用 `scripts/extract_docx.py` 拿到图位清单（图号 + 图题），这是三条路径共同的输入与校验基准：

```bash
python scripts/extract_docx.py "使用说明书.docx" manual.txt
```

提取结果要回答三件事：① 共多少张图（= 要截多少屏）；② 每张图的标题；③ 正文是否已引用图片（`<w:drawing>` 数）。**图号必须连续、屏数必须 = 图位数**，多一张少一张都会在回填时错位。

---

### 路径 A：真实运行截图（首选，2026-09-27 实测跑通 37 屏）

**适用**：软件能启动（Flask/Web 应用、Desktop 应用带 Web 预览皆可）。优势是数据与界面都是真的，审查方无从质疑"示意拼贴"。

用 `scripts/shoot_real_ui.py`（配置驱动骨架，复制到项目 `scripts/` 后填 `BASE` 与 `SCREENS`）：

```bash
pip install playwright        # 不需要 playwright install：直接复用本机 Chrome
python scripts/shoot_real_ui.py
```

**硬性规范与实测坑（逐条都是踩出来的）**：

1. **先启动软件再截图**：脚本只驱动、不启动。截图前确认服务在线（先 `curl`/urllib 探测一次 `/` 返回 200，避免截出一堆错误页）。
2. **必须用本机真实 Chrome + 禁 GPU**：`executable_path` 指向 `C:/Program Files/Google/Chrome/Application/chrome.exe`，args 加 `--disable-gpu --disable-software-rasterizer --hide-scrollbars --force-device-scale-factor=1`。用 Playwright 自带 chromium 或无头 GPU 会**整屏全黑且文件非空**（只能靠肉眼看出来，md5 查重查不出）。
3. **清代理**：系统代理会截走 `127.0.0.1` 请求返回 502（页面白屏、boot 失败）。脚本内 pop 掉 `*_proxy` 并设 `NO_PROXY=127.0.0.1,localhost`。
4. **单进程一次跑完全部屏**：CLI 型浏览器工具（agent-browser）相邻命令之间会重置页面（回到 `about:blank`），**不能逐条命令截图**——必须像骨架脚本那样在一个进程里循环。
5. **成对图必须内容互补（最容易翻车）**：视口 2559×1559 已经很高，页面往往**根本不滚动**——"滚顶/滚底各一张"会得到两张一模一样的图（**同 md5，Word 插图时还会去重，最终暴露为"图题 37 但图片 36"**）。对策：
   - 首页/总览图用 **100%（zoom=1）** 拍"整体布局"（侧栏+顶栏+内容区一屏可见）；
   - 其余面板统一 `document.body.style.zoom='1.5'`（符合用户 150% 阅读偏好），内容变高后滚顶/滚底才有区别；
   - 每次滚底后回读 `scrollY/pageHeight/innerHeight` 自检，`scrollY == 0` 立即告警。
6. **独立窗口图位独立渲染**：安装/解压/命令行类图（典型是图 1~3）**不套软件侧栏布局**，用 `kind="wintml"` 走独立 HTML 渲染（资源管理器 / 黑底 cmd 窗口：标题栏 + 菜单栏 + 命令区）。命令行内容**取自真实命令输出**（先真跑一遍 `pip install -r requirements.txt`、`start.bat`，把 stdout 贴进 HTML），路径用真实 `C:\Users\...`。
7. **md5 唯一性校验（交付前必过）**：脚本末尾自动查重。任何两屏同 md5 都必须重拍——这既防重复图，也防"某屏其实是上一屏的截图"。

---

### Step 1：提取文档文本

用 `scripts/extract_docx.py` 分别提取说明书与源代码 docx 的段落文本（无需 python-docx，zipfile 直解）：

```bash
python scripts/extract_docx.py "使用说明书.docx" manual.txt
python scripts/extract_docx.py "源代码.docx" src.txt
```

脚本会报告：
- **段落数** + 提取文本文件路径
- **正文是否实际引用了图片**（`<w:drawing>` 数量）：
  - 若为 **0**：说明书中"图N"是占位框（"请将实际截图粘贴至此"），**按路径 C 重建**。
  - 若 **>0**：说明书已含真实截图（按 docx 出现顺序对应"图1~图N"）。此时可加 `--images <dir>` 一键解压为 `image1.png .. imageN.png`：
    ```bash
    python scripts/extract_docx.py "使用说明书.docx" manual.txt --images ./manual_images
    ```
    然后 **直接将这些图嵌入 HTML**（`<img src="manual_images/imageN.png" style="width:100%;height:100%;object-fit:contain">`，外层套 `.shot + .size-tag`），无需按路径 C 重建。
- **"图N"标题定位**（行号 + 内容），方便快速定位每张图上下文。

### Step 2：分析图与源码对应关系

- 在 manual.txt 中定位每个"图N"标题行，读取其**上方/下方各 1~3 段**的功能描述、参数说明、运行效果文字（这些决定了界面元素与文案）。
- 在 src.txt 中定位对应前端页面/组件代码，提取真实界面元素：菜单项、按钮文案、表格列名、状态枚举、字段名、接口路径。**界面上的元素命名必须取源代码字段**（如设备编号 PIPE-ROBOT-XXX、角色 super_admin/tenant_admin/operator/viewer、状态 pending/assigned/in_progress/completed/failed、缺陷类型、告警阈值等）。
- 说明书章节 → 源码映射示例：
  - 安装/卸载章节 → 终端界面（命令输出）+ docker-compose.yml / 数据库脚本
  - 主界面/整体布局章节 → Layout 外壳（顶栏+侧栏+内容区+底栏）
  - 各功能模块章节 → 对应页面组件（如 Dashboard/DigitalTwin/FleetManagement/SaaSManagement/Login）

### Step 3：准备界面素材

- **说明书无图**：直接进入路径 C 重建。
- **说明书有图**：已用 `--images` 解压到目录。继续 Step 2 的源码分析以便在图注中标注章节与对应源码文件。出图步骤改为"逐图嵌入真实截图"：
  - 每张图结构：`<div class="fig" id="figN"><div class="shot"><div class="size-tag">2559 × 1559</div><img src="manual_images/imageN.png" style="width:100%;height:100%;object-fit:contain"></div><div class="cap">...</div></div>`
  - 顶部 `<nav class="toc">` 与页头/页脚按真实图片数同步更新。

### 路径 B：真实界面还原路径（软件跑不起来但有前端源码时）

当目标软件有真实前端页面（index.html + style.css + 数据接口）且用户要求"真实运行界面、
每页呈现该界面的所有内容"时，**优先采用本路径**而非手绘 cqw 界面：内联真实 CSS、
复用真实页面结构、调用项目 core 模块服务端渲染真实数据（ECharts 图表），
单文件自包含（内联 echarts/html2canvas）。.shot 固定 2559×1559，内部可用
`transform:scale(1.5)` 放大 150%（ECharts devicePixelRatio:2 保证清晰）。
详细步骤、实测坑与交付检查清单见 `references/real-ui-rendering.md`。

**本路径硬性规范（MUST）**：
- **每屏完整呈现**：整页滚动预览，内容超高时**紧凑化**（压缩 padding/行高/图表高度）而非裁剪，必须保留全部元素与真实值。
- **终端屏独立渲染**：`term=True` 参数走独立分支（桌面背景 + 独立 cmd 窗口：标题栏/菜单栏/黑底命令行），**不套 sidebar/page_head**；提示符用真实 Windows 路径（`C:\Users\...`），禁止 `C://...` 假路径。
- **波形必须渲染**：动态图表脚本禁止引用 JSON 字面量之外的变量（防 ReferenceError 整图空白）；目标线 markLine 直接内嵌进 series JSON。
- **交付前校验**：validate_html.py + 图表 init 脚本 stub 实际执行零异常（见 Step 4 校验节）。

### 路径 C：按模板重建每张图（仅适用于无运行环境）

复制 `assets/template.html` 为 `<软件名>_界面图集.html`，参考其中三类范例逐图构建：

1. **应用外壳界面**（绝大多数图）：`.shot > .app > .app-top + .app-main(.sider + .content) + .app-bottom`。侧栏高亮当前模块（`.mi.on`），子菜单用 `.sub/.smi`。
2. **终端界面**（安装/卸载/命令行）：`.shot > .term`，用 `.prompt/.cmd/.out/.ok/.warn/.err/.dim` 上色。
3. **登录页**：全屏渐变背景 + 居中登录卡 + 顶部浏览器地址栏。

**硬性规范（必须遵守）**：

- 每张图必须是 **2559×1559 完整全屏界面**：`.shot` 容器 `aspect-ratio:2559/1559` + `container-type:inline-size`，内部全部尺寸用 **cqw/cqh 容器查询单位**（正文字号 ≈ 0.93cqw）。任何宽度下界面等比缩放、内容完整，**禁止局部组件拼贴/特写**。
- 下拉框、弹窗、详情卡片等场景：绘制在**完整界面之上**（弹出层覆盖），模拟真实截图。
- 内容区必须是**真实页面内容**（表格、图表、卡片、真实文案）。**禁止出现**"中央内容操作区——展示……""菜单栏默认宽度 220px（本图展开示意）""请将实际截图粘贴至此""可集成XXX"等示意图占位说明文字。
- 每图 HTML 结构：`<div class="fig" id="figN">` 内含 `.shot`（右上角 `.size-tag` 标注 2559 × 1559）与 `.cap`（`<b>图N</b>　标题（说明：X.X 章节；对应源码文件）`）。
- 顶部 `.toc` 目录为每图追加 `<a href="#figN">图N</a>`；页头标题、页脚图数范围同步更新。
- 图表用内联 SVG（`viewBox` 固定坐标 + `width:100%`）；三维场景用 `.pipe3d/.pipe/.def`；地图用 `.map/.road/.blk/.m-ico/.area-poly`。

### Step 4：校验（三条路径通用）

用 `scripts/validate_html.py` 校验图集完整性（截图数/图注数/目录锚点/标签配对/占位文字残留）：
```bash
python scripts/validate_html.py "<软件名>_界面图集.html" 42   # 42 为总图数，可按需改
```
- 只生成部分图（如"图6~图28"共23张）时，校验需传起始图号，否则会误报"缺失图1~5"：
  ```bash
  python scripts/validate_html.py "<软件名>_界面图集.html" 23 6   # 23 张，从图6开始
  ```
- 注意：部分范围图集（非图1起始）若引用 ui-style.css 中 `.modal` 等弹出层覆盖内容区，需给 `.content` 加 `position:relative`，否则弹窗定位到错误锚点。

**图表初始化执行级校验（必做，防整图空白）**：用正则提取全部图表 init IIFE（`\(function\(\)\{var el=document.getElementById\('f\d+_[a-z]+'\)...\}\)\(\);`），
拼接后加 stub（假 echarts/document/window/setTimeout）用 node **实际执行**，必须零异常；
再 `node --check` 做语法检查。此步能抓到 curl/静态检查发现不了的运行时错误（如 `series[0].markLine` 引用未定义变量 → 转速图空白）。

必须全部通过后再交付。

### Step 5（可选）：整体缩放

若用户反馈"字太小/太大"，用 `scripts/scale_units.py` 将全部 cqw/cqh 数值统一乘以系数（如 1.5 放大、0.8 缩小），整图等比缩放、布局不变形：

```bash
python scripts/scale_units.py "<软件名>_界面图集.html" 1.5
```

### Step 6：一键导出 PNG（交付前必含）

用户工作流通常是「HTML 图集 → 逐张截图 2559×1559 → 贴进说明书」。在 HTML 中内置**一键导出**功能可免去手动截图：

- 把 `assets/export-png.js` 头部注释中的 **CSS 片段**复制进 `<style>` 末尾。
- 把 **JS 片段**复制进页面末尾 `<script>`（保留原目录平滑滚动脚本）。
- 在页头 `<div class="badges">` 后加导出按钮：
  ```html
  <button class="export-btn" id="exportAllBtn" style="margin-top:14px;height:34px;padding:0 20px;font-size:13.5px;background:rgba(255,255,255,.14);color:#fff;border-color:rgba(255,255,255,.45)">⬇ 一键导出全部 PNG（2559 × 1559）</button>
  ```

功能效果：每张图注右侧出现"导出PNG"按钮；右下角悬浮"全部导出 PNG"按钮可批量导出所有图，文件命名为"图N_标题.png"，尺寸精确 2559×1559。
- **主路径 html2canvas**（纯 JS 重绘，不触发浏览器 Tainted canvas 限制；克隆 .shot 为 2559px 宽挂载到隐藏 DOM，cqw/cqh 由浏览器原生解析，html2canvas 读取已计算像素值，无需单位换算）。库优先用 `assets/html2canvas.min.js`（已随技能提供，**内联进 `<script>` 可离线使用**），否则动态加载 CDN。
- **回退路径 SVG foreignObject**：个别浏览器仍可能 Tainted → 自动降级下载同名 .svg 并提示。
- 导出前对克隆节点消毒（sanitizeCloneForSvg）：嵌套 `<svg>`→dataURI `<img>`、表单控件→`<span>`，规避兼容问题。
- 依赖现代 Chromium 内核浏览器（Chrome/Edge）。

### Step 7：把图集回填进说明书 docx（MUST，软著场景的完成标准）

**为什么必须做**：说明书里的图位只有占位段「（界面截图，此处插入：xxx）」。图集单独交 HTML 时，审查方拿到的说明书仍是 37 个空图位——**只有把 `figNN.png` 插回 docx，说明书才是图文自洽的交付材料。**

**执行（`scripts/insert_atlas_into_manual.py`）**：

```bash
# 建议先留备份（便于反复重跑）
cp "使用说明书.docx" "使用说明书_仅图位版.docx"
python scripts/insert_atlas_into_manual.py "使用说明书.docx" docs/atlas --expect 37 --backup
```

脚本逻辑：① 定位形如「图 N 标题」的图题段（跳过含"截图"字样的说明段）；② 在**图题段上方**插入居中的图片段（页宽 **14.6 cm** = A4 21 cm − 左右页边距，等比缩放）；③ 删除紧随其后的占位段；④ **自后向前**处理，避免段落索引位移。

**硬性约束**：

1. **文件名与图号严格对应**：`fig01.png … figNN.png`，图号必须与说明书「图 N」同号同题，屏数 = 图位数。截图缺任一即拒绝执行。
2. **重跑前先从 `_仅图位版.docx` 恢复**：直接对已插图版重跑会二次插入（图片翻倍）。脚本会检测 `<w:drawing>` 已有图片数并告警。
3. **插图后必须复验**（`scripts/check_manual_with_figs.py`）：

   ```bash
   python scripts/check_manual_with_figs.py "使用说明书.docx" --expect 37
   ```
   判定口径与图位版不同：**图题数 == 图片数**（原图位版是"图题数 == 图位数"），并保留箭头/Markdown**/非黑/斜体 全 0、图号连续、残留占位段 0 的检查。
4. **"图题 37 / 图片 36" = 有重复截图**：Word 对**内容完全相同**的图片会去重（同一份 PNG 只存一份 media），所以 `word/media/` 数量少 1 就说明有两屏内容重复——回到出图步骤做 md5 查重并重拍。**这是一个很好用的信号，别忽略。**

**实测数据（37 图，2026-09-27）**：插图前 45 页 → 插图后 **60 页**（+15 页，约每图 0.4 页）；内嵌 media 37 张 = 图题数，无去重。

**图集 HTML 的定位（可选产物）**：`gen_atlas_html.py` 生成的单文件 HTML 图集（37 屏 / 37 图注 / 37 锚点，相对引用 `atlas/`）用于**预览与复用**，不是交付主体。若用户只要 docx，可跳过 HTML 但仍须完成本步骤。

---

## Resources

### scripts/（出图与回填）
- `shoot_real_ui.py` — **路径 A 真实运行截图骨架（首选）**：Playwright + 本机 Chrome 驱动运行中的软件，2559×1559 视口、独立窗口图位（`kind="wintml"`）、150% 缩放 + 滚顶/滚底成对、滚底自检、末尾 md5 唯一性校验；配置区填 `BASE` 与 `SCREENS` 即可用。
- `insert_atlas_into_manual.py` — **图集回填说明书 docx（Step 7 MUST）**：按「图 N」图题定位，上方插入居中图片（默认 14.6 cm），删除「（界面截图，此处插入…）」占位段；支持 `--expect/--backup/--pad`，已插图会告警。
- `check_manual_with_figs.py` — **插图版说明书复验**：判定口径为「图题数 == 图片数」+ 箭头/Markdown**/非黑/斜体 0 + 图号连续 + 残留占位段 0；图题≠图片时提示做 md5 查重。
- `extract_docx.py` — docx 段落文本提取 + "图N"标题定位 + 正文图片检测/一键解压。
- `validate_html.py` — 图集完整性校验（截图数/图注数/目录锚点/标签配对/占位文字残留）。
- `validate_atlas.py` — 图集静态一致性校验（容器↔图注、图表 div↔init 匹配、2559×1559 尺寸；兼容 .shot 与 .screen 两种路径）。
- `scale_units.py` — cqw/cqh 整体缩放（放大/缩小）。
- `gen_ui_atlas_skeleton.py` — **路径 B 真实界面还原生成器骨架**（通用：screen/commit term=True 独立终端、chart_init markLine 内嵌、紧凑化 CSS、内联 echarts；按 TODO 替换项目数据与屏清单）。

### assets/（路径 B/C 用）
- `assets/ui-style.css` — 通用 UI 组件库（.shot/.app/.sider/.card/.tbl/.btn/.tag/.stat/.term/.pipe3d/.map/.modal 等），生成图集时**内联进 `<style>`** 保证单文件可移植（复制模板时注意模板用 `<link>` 引用，交付前改为内联）。
- `assets/template.html` — 完整骨架模板，含应用外壳/终端/登录页三类范例 + 一键导出 PNG 功能。
- `assets/export-png.js` — 一键导出 PNG 功能片段（CSS + JS），按 Step 6 复制进图集 HTML。
- `assets/html2canvas.min.js` — html2canvas 1.4.1 库（MIT），内联进 `<script>` 可离线导出（可选，CDN 动态加载亦可）。

## 注意事项

- 说明书图总数可能超过用户要求（如说明书 51 张图、用户只要 图1~42）：按用户指定范围生成，未要求部分不做。
- 提取文本时保持 UTF-8；Windows Git Bash 下调用脚本用完整 python 路径。
- **完成标准 = 插图版 docx**：只出 HTML 图集不算完成，必须走 Step 7 回填并用 `check_manual_with_figs.py` 复验通过。汇报时给出"图题数 = 图片数 = 图位数、残留占位段 0、插图后页数"。
- **Word 图片去重是免费的自检信号**：docx 里 `word/media/` 文件数少于图题数 → 有两屏截图完全相同 → md5 查重后重拍。比肉眼看 37 张图快得多。
- **插图会显著增加页数**（实测 45 → 60 页）：用户对页数有约束时要**先确认再插图**。
- **Checkpoint（铁律）**：图集生成并校验通过后**停下等用户审阅**（汇报屏数/校验结果/预览地址/插图后页数），用户反馈逐屏调整、每轮再停；不得一口气改完多轮或直接交付。
- 交付后可用 present_files 打开 HTML 供用户预览；用户常反馈"图太多/字太小/内容不全/波形不显示"，对应处理：按图号精简、scale_units.py 缩放、紧凑化防裁剪、stub 执行验证图表脚本。
- **与相邻技能的衔接**（软著交付链路，见 `python-software-delivery` 的「技能串联」节）：
  - **上游**：`python-software-delivery` 的 Phase 5.1 先出《使用说明书》docx（含「图 N」图位），本技能读它的图位清单；
  - **下游**：回填后的插图版说明书交给 `aigc-review-reduction` 降 AIGC（注意：降 AIGC 只改文字不动图，图题与图片数必须保持不变）；
  - 说明书的图位清单变化时（用户增删章节图位），图集与插图都要跟着重做，**别只改一边**。
