#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
说明书 docx 生成工具集（软著《使用说明书》）。
提供 DocxHelper：页面设置 / 页眉页脚(PAGE+NUMPAGES) / 封面 /
H1 H2 H3 / P(首行缩进) / LIST(①②③) / CODE / TABLE / FIG(截图位) / STEP。
格式规范见 references/docx-format-spec.md。

用法（内容脚本中）：
    import sys; sys.path.insert(0, "<本技能 scripts 目录>")
    from gen_manual_docx import DocxHelper
    dh = DocxHelper("输出.docx", software="软件名", version="V1.0.0", date="2026年8月17日")
    dh.H1("1 引言"); dh.H2("1.1 编写目的"); dh.P("正文…，**加粗**可用。")
    dh.FIG("系统主界面", "数据采集页整体布局")   # 自动编号"图 N 标题"+占位说明
    dh.TABLE(["列1","列2"], [["a","b"]], widths=[3.0,12.6])
    dh.STEP(1, "步骤标题", "步骤说明")           # 可随后 dh.FIG(...) 配截图位
    dh.save()
注意：全文不输出 emoji/箭头/**；Heading 显式黑色非斜体（覆盖默认蓝色）。
"""
import os
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

BLACK = RGBColor(0, 0, 0)


class DocxHelper:
    def __init__(self, out_path, software="软件名称", version="V1.0.0",
                 date="2026年1月1日", sub_title="用户使用说明书",
                 margin=(2.54, 2.54, 3.0, 2.6)):
        self.out = out_path
        self.doc = Document()
        self._fig_n = 0
        sec = self.doc.sections[0]
        sec.page_width, sec.page_height = Cm(21.0), Cm(29.7)
        sec.top_margin, sec.bottom_margin = Cm(margin[0]), Cm(margin[1])
        sec.left_margin, sec.right_margin = Cm(margin[2]), Cm(margin[3])
        normal = self.doc.styles["Normal"]
        normal.font.name = "Times New Roman"
        normal.font.size = Pt(12)
        normal.font.color.rgb = BLACK
        normal.font.italic = False
        normal.element.rPr.rFonts.set(qn("w:eastAsia"), "宋体")
        pf = normal.paragraph_format
        pf.line_spacing = 1.5
        pf.space_after = Pt(10)
        self._header_footer()
        self._cover(software, version, sub_title, date)

    # ---------- 内部 ----------
    def _run(self, p, text, size=12, bold=False, ea="宋体", mono=False, color=BLACK, italic=False):
        r = p.add_run(text)
        r.font.name = "Consolas" if mono else "Times New Roman"
        r.font.size = Pt(size)
        r.font.bold = bold
        r.font.italic = italic
        r.font.color.rgb = color
        rPr = r._element.get_or_add_rPr()
        rf = rPr.find(qn("w:rFonts"))
        if rf is None:
            rf = OxmlElement("w:rFonts"); rPr.append(rf)
        rf.set(qn("w:ascii"), "Consolas" if mono else "Times New Roman")
        rf.set(qn("w:hAnsi"), "Consolas" if mono else "Times New Roman")
        rf.set(qn("w:eastAsia"), ea)
        return r

    def _rich(self, p, text, size=12, bold=False, ea="宋体", mono=False):
        for i, seg in enumerate(text.split("**")):
            if seg:
                self._run(p, seg, size=size, bold=bold or (i % 2 == 1), ea=ea, mono=mono)

    def _header_footer(self):
        hp = self.doc.sections[0].header.paragraphs[0]
        hp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        self._run(hp, "用户使用说明书", size=10.5)
        fp = self.doc.sections[0].footer.paragraphs[0]
        fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        self._run(fp, "第 ", size=10.5)
        self._field(fp, " PAGE ")
        self._run(fp, " 页 / 共 ", size=10.5)
        self._field(fp, " NUMPAGES ")
        self._run(fp, " 页", size=10.5)

    def _field(self, p, instr):
        r1 = OxmlElement("w:r"); f1 = OxmlElement("w:fldChar"); f1.set(qn("w:fldCharType"), "begin"); r1.append(f1)
        r2 = OxmlElement("w:r"); it = OxmlElement("w:instrText"); it.set(qn("xml:space"), "preserve"); it.text = instr; r2.append(it)
        r3 = OxmlElement("w:r"); f3 = OxmlElement("w:fldChar"); f3.set(qn("w:fldCharType"), "end"); r3.append(f3)
        p._p.append(r1); p._p.append(r2); p._p.append(r3)

    def _cover(self, software, version, sub_title, date):
        for _ in range(5):
            self.doc.add_paragraph()
        p = self.doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        self._run(p, software, size=18, bold=True, ea="黑体")
        p = self.doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        self._run(p, version, size=15, bold=True, ea="黑体")
        p = self.doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        self._run(p, sub_title, size=14, bold=True, ea="黑体")
        for _ in range(6):
            self.doc.add_paragraph()
        p = self.doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        self._run(p, "编制日期：%s" % date, size=12, bold=True)
        self.doc.add_page_break()

    # ---------- 结构 ----------
    def H1(self, t):
        p = self.doc.add_paragraph(); p.paragraph_format.space_before = Pt(16); p.paragraph_format.space_after = Pt(12)
        p.paragraph_format.line_spacing = 1.5
        self._run(p, t, size=14, bold=True, ea="黑体")

    def H2(self, t):
        p = self.doc.add_paragraph(style="Heading 3")
        p.paragraph_format.space_before = Pt(13); p.paragraph_format.space_after = Pt(13)
        p.paragraph_format.line_spacing = 1.5
        self._run(p, t, size=12, bold=True)

    def H3(self, t):
        p = self.doc.add_paragraph(style="Heading 4")
        p.paragraph_format.space_before = Pt(10); p.paragraph_format.space_after = Pt(6)
        p.paragraph_format.line_spacing = 1.5
        self._run(p, t, size=12, bold=True)

    def P(self, t, indent=True, size=12):
        p = self.doc.add_paragraph()
        if indent:
            p.paragraph_format.first_line_indent = Cm(0.85)
        p.paragraph_format.line_spacing = 1.5; p.paragraph_format.space_after = Pt(6)
        self._rich(p, t, size=size)

    def LIST(self, items):
        for it in items:
            p = self.doc.add_paragraph()
            p.paragraph_format.line_spacing = 1.5; p.paragraph_format.space_after = Pt(2)
            p.paragraph_format.left_indent = Cm(0.85)
            self._rich(p, it)

    def CODE(self, t):
        p = self.doc.add_paragraph()
        p.paragraph_format.line_spacing = 1.5; p.paragraph_format.space_after = Pt(6)
        p.paragraph_format.left_indent = Cm(0.85)
        self._run(p, t, size=10.5, mono=True)

    def STEP(self, n, t, detail=None):
        p = self.doc.add_paragraph()
        p.paragraph_format.line_spacing = 1.5; p.paragraph_format.space_after = Pt(4)
        p.paragraph_format.first_line_indent = Cm(0.85)
        self._run(p, "步骤 %d：%s" % (n, t), bold=True)
        if detail:
            p2 = self.doc.add_paragraph()
            p2.paragraph_format.line_spacing = 1.5; p2.paragraph_format.space_after = Pt(6)
            p2.paragraph_format.first_line_indent = Cm(0.85)
            self._rich(p2, detail)

    def FIG(self, caption, desc):
        """截图位：'图 N 标题' 居中 + （界面截图，此处插入：desc）占位。返回图号。"""
        self._fig_n += 1
        n = self._fig_n
        p = self.doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_before = Pt(6)
        self._run(p, "图 %d %s" % (n, caption), size=10.5, bold=True)
        p2 = self.doc.add_paragraph(); p2.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p2.paragraph_format.space_after = Pt(10)
        self._run(p2, "（界面截图，此处插入：%s）" % desc, size=10.5)
        return n

    def TCAP(self, text):
        """表题：居中 10.5pt 加粗（表号需在 text 中手工写好，如 '表 6 运行参数说明'）。"""
        p = self.doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_before = Pt(6); p.paragraph_format.space_after = Pt(2)
        self._run(p, text, size=10.5, bold=True)

    def TABLE(self, headers, rows, widths=None, font=10.5):
        tb = self.doc.add_table(rows=1 + len(rows), cols=len(headers))
        tb.style = "Table Grid"; tb.alignment = WD_TABLE_ALIGNMENT.CENTER
        for j, h in enumerate(headers):
            c = tb.rows[0].cells[j]; c.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
            self._run(c.paragraphs[0], h, size=font, bold=True)
        for i, row in enumerate(rows):
            for j, v in enumerate(row):
                self._rich(tb.rows[i + 1].cells[j].paragraphs[0], str(v), size=font)
        if widths:
            for j, w in enumerate(widths):
                for row in tb.rows:
                    row.cells[j].width = Cm(w)
        self.doc.add_paragraph().paragraph_format.space_after = Pt(2)
        return tb

    def save(self):
        """保存 docx。若目标文件被预览面板占用（PermissionError），
        逐级尝试 _V2/_V3/... 另存（实测 _V2 也可能被占用）。"""
        import os
        tmp = self.out + ".tmp.docx"
        try:
            self.doc.save(tmp)
        except OSError:
            print("警告: 无法写临时文件（目录只读？）:", tmp)
            return
        for k in range(0, 10):
            target = self.out if k == 0 else self.out.replace(".docx", "_V%d.docx" % (k + 1))
            try:
                os.replace(tmp, target)
                print("已生成:", target, "| 截图位:", self._fig_n)
                return
            except OSError:
                continue
        print("保存失败（目标与 _V2~_V10 均被占用），临时文件位于:", tmp)
