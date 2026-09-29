# docx 文档格式规范（说明书 / 源代码文档通用）

以下规范从《三维激光点云逆向建模与路径规划系统说明书.docx》与《v1_0.docx（源代码文档）》解析得出，python-docx 生成时逐项落实。

## 页面
- A4（21.0 × 29.7 cm）
- 说明书边距：上/下 2.54 cm、左 3.00 cm、右 2.60 cm
- 源代码文档边距：上/下 2.00 cm、左/右 2.50 cm
- 页眉/页脚（说明书用）：页眉"用户使用说明书"居中；页脚"第 X 页 / 共 Y 页"（PAGE + NUMPAGES 域，手写 w:fldChar/instrText XML）

## 封面（说明书）
- 软件名：18 pt 黑体加粗居中；版本号 15 pt；"用户使用说明书" 14 pt 黑体；编制日期 12 pt 加粗居中

## 标题层级
| 级别 | 样式 | 字号/字体 |
|------|------|----------|
| 一级（"1 引言"） | 手动编号"N " | 14 pt 黑体加粗，段前 16 pt 段后 12 pt |
| 二级（"1.1 xxx"） | Heading 3 | 12 pt 加粗（Times New Roman + 宋体），段前/段后 13 pt |
| 三级（"1.1.1 xxx"） | Heading 4 | 12 pt 加粗，段前 10 pt 段后 6 pt |

⚠️ **Word Heading 样式默认蓝色**：python-docx 生成时必须对每个 run 显式设 `RGBColor(0,0,0)`，否则标题是蓝色（用户普遍反感）。

## 正文
- 字体：`ascii/hAnsi = Times New Roman` + `eastAsia = 宋体`（中文宋体、英文/数字/符号新罗马）
- 12 pt，1.5 倍行距，**首行缩进 0.85 cm**，段后 6~10 pt
- 列表：Compact 风格，编号用"① ② ③"，左缩进 0.85 cm
- 表格：Table Grid 边框，表头加粗居中，正文 10.5 pt；三列表格宽度可设（如 3.2/4.2/8.2 cm）
- 图题："图 N xxx" 居中 10.5 pt 加粗，下方灰色（或黑色）占位说明

## 源代码文档
- 全部 Normal 样式，无页眉页脚，无缩进无灰底无行号
- 封面：软件名 22 pt 黑体 + "源代码文档" 22 pt 宋体 + **"共 N 个源文件，M 行代码" 14 pt 宋体居中**（N/M 由生成脚本自动统计，必标，供审查核对规模）
- 文件章节标题：文件名（`core\analysis.py` 反斜杠格式）**小四 12 pt 黑体加粗**，段前 12 pt 段后 6 pt
- 代码正文：10.5 pt（五号），行距 1.05，段前段后 0；空行保留为空段落（不要写空格，否则校验比对不一致）
- **收录范围（强约束）**：只收手写源码，必须排除 `docs/`、`img/`、`tmp_*`、`dist/` 等目录——界面图集 HTML 内联 echarts 单行可达 98 万字符，误收录会把 docx 撑到 500+ 页（实测）；单行超长(>5000字符)文件自动跳过并告警；生成后超长段落数应为 0

## python-docx 字体设置要点
```python
def _run(p, text, ea="宋体", ascii_f="Times New Roman", size=12, bold=False, color=RGBColor(0,0,0)):
    r = p.add_run(text)
    r.font.name = ascii_f
    r.font.size = Pt(size)
    r.font.bold = bold
    r.font.color.rgb = color
    rPr = r._element.get_or_add_rPr()
    rf = rPr.find(qn("w:rFonts"))
    if rf is None:
        rf = OxmlElement("w:rFonts"); rPr.append(rf)
    rf.set(qn("w:ascii"), ascii_f)
    rf.set(qn("w:hAnsi"), ascii_f)
    rf.set(qn("w:eastAsia"), ea)
```
- 页脚域：构造 `w:fldChar(begin) + w:instrText(" PAGE ") + w:fldChar(end)` 三段 XML。
- Heading 3/4 加 run 时同时显式设黑 + 非斜体，覆盖样式默认。
