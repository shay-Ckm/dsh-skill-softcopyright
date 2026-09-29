# 真实界面还原路径（Real-UI Rendering）

当目标软件本身是可运行的 Web 应用（Flask/Node + ECharts/React 等）时，用户通常期望
图集中的每一屏就是"真实运行界面的完整全图"，而非手绘示意界面。本路径优先于通用
cqw 手绘方式。已在"面向STM32的FOC算法模型在环测试与自动部署软件"项目实测验证
（多轮用户反馈迭代：波形空白 / 界面不居中 / 字体小 / 内容被裁 / 图表空白）。

## 何时采用本路径
- 目标软件有真实前端页面（index.html + style.css + 数据接口）可复现；
- 用户反馈过"要真实运行界面，不要示意/占位拼贴"，或要求"每个页面呈现该界面的所有内容"；
- 图表为 ECharts / canvas 等动态库渲染。

## 实施步骤
1. **内联真实 CSS**：读取应用真实 `static/css/style.css` 内容内联进 `<style>`，
   放在图集外壳样式之前；外壳样式用 `.shot xxx` 前缀后写覆盖（如侧栏 position:absolute）。
2. **复用真实页面结构**：侧栏 / 页头 / 卡片 / 表单 / 表格 / 按钮取真实 index.html 的
   class 与文案（含真实字段名、单位、默认值）；输入框用真实 `<input value=...>` 控件。
3. **服务端渲染真实数据**：调用项目 core 模块以固定种子生成仿真波形、性能指标、
   C 代码、历史记录，内嵌为 JSON；不得手写近似数据。
4. **图表用 ECharts**：内联 echarts.min.js（单文件自包含）；每屏图表 init 脚本复用
   应用真实图表配置（坐标轴、dataZoom、颜色、图例）。
5. **容器与放大**：`.shot` 固定 2559×1559；用户偏好放大（如 150%）时采用
   "设计层 1706×1039 + `transform:scale(1.5)` + `transform-origin:0 0`"，
   ECharts init 传 `{devicePixelRatio:2}` 保证放大后清晰。
6. **内容完整**：生成前估算并压缩各界面高度（紧凑化 CSS：卡片 padding 12/16、
   field 行高约 55px、图表高 200-240px），确保每个 section 完整放入设计层高度
   （1559/SCALE），避免 `overflow:hidden` 裁剪底部内容。

## 关键坑（均已实测）
- **多屏复用同一 section 时图表容器 id 必须唯一（实测根因）**：图集多屏若复用同一段 HTML（如监控页
  在图7~10 多次出现），图表 div 的 id（f9_vib/f10_temp 等）会在文档中重复，浏览器 getElementById
  只命中文档第一个 div，其余屏图表永远空白；且 stub 校验（mock echarts 吞掉所有调用）无法发现此问题。
  修复：section 函数带 fig 参数，按图号生成唯一 id（f{n}_vib/f{n}_temp/f{n}_tool），每屏独立 init。
- **stub 校验通过不等于浏览器渲染正常**：交付前除图表 init 零异常外，必须额外检查：
  ① 图表 div id 全文档唯一（正则收集 id 查重，重复即报）；
  ② 内联 echarts 库不含 `</script` 字面量（否则浏览器提前截断 script，库加载失败整页图表空白）。
- **资源必须内联**：echarts / html2canvas 等库用相对路径（`../static/...`）会在预览服务
  （`/static-html/<hash>/`）或其他打开方式下加载失败 → 图表空白。全部内联为单文件
  （HTML 2-3MB 可接受）。
- **内联大 JS 前先确认不含 `</script` 字面量**，否则浏览器提前截断 script。
- **动态生成脚本不得引用仅存在于 JSON 字面量中的变量名**：如目标线写成
  `series[0].markLine={...}` 而脚本中并无 `series` 变量 → ReferenceError → 整图空白，
  且只有带目标线的图（如转速图）异常，易误导排查。目标线等配置直接内嵌进
  series JSON（`ser_list[0]["markLine"]={...}`）。
- **交付前执行级验证**：正则提取全部图表 init IIFE → `node --check` 语法检查 →
  用 stub（假 echarts/document/window/setTimeout）实际执行全部 init，确认零异常。
- **Python % 格式化**：模板字符串含百分号需转义（`150%` → `150%%`），否则
  `unsupported format character` 报错（`%便` 之类）。
- **validate_html.py 的"占位"关键字**：把"占位"视为示意图残留；真实内容（如生成的
  C 代码注释"此处占位"）会被误报 → 生成内容前确认无该字样（改写为"由观测器提供"等）。
- **布局溢出**：2559×1559 固定高度下内容超高会被裁（底部表单/图表缺失）——压缩后
  必须重新核对各 section 高度（估算 < 设计层高）。
- **transform:scale 与一键导出**：html2canvas 对 transform 支持有限，导出结果需人工
  复核；用户手动浏览器截图为主路径（页面 2559px 宽可直接整屏截）。
- **界面居中**：`.shot` 2559px 超出外层容器时 `margin:0 auto` 无效（靠左被裁）；
  外层容器全宽 + 页面横向滚动即可居中查看。
- **终端/命令行屏 = 独立终端窗口（禁止套软件布局）**：安装/启动等步骤截图是真实的
  cmd 窗口，若复用 `sidebar + page_head` 软件外壳渲染终端框，用户会质疑"为什么软件界面里
  有终端命令行"。生成器为终端屏走独立分支（`term=True`）：桌面渐变背景 + 独立 cmd 窗口
  （标题栏"命令提示符"+ 最小化/最大化/关闭按钮 + 菜单栏 文件(F)/编辑(E)/查看(V)/帮助(H)
  + 黑底命令行区，字号放大 1.5 倍后 ≥22px），**不套 sidebar/page_head**。
  提示符用真实 Windows 路径（`C:\Users\...`），禁止 `C://...` 假路径（heredoc 转义叠加
  会产生 2~4 个斜杠，跨层改路径文本优先用 Edit 工具直接写目标字面量，勿用 replace/regex 链）。

## 交付检查清单
- [ ] 单文件无任何外部 src/http 引用
- [ ] 全部图表 init 脚本 node --check + stub 执行零异常
- [ ] validate_html.py 通过（截图数/图注/锚点/无占位残留）
- [ ] 各 section 内容完整（无底部被裁）
- [ ] 放大系数下文字清晰（ECharts devicePixelRatio ≥2）
