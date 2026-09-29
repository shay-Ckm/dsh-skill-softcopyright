#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
源代码文档生成器：把项目全部手写源码排入一个 docx（软著源代码文档）。
格式规范见 references/docx-format-spec.md：
  A4 / 封面（软件名 22pt 黑体 + "源代码文档" 22pt 宋体）/
  文件标题黑体小四 12pt 加粗（core\\xxx.py 格式）/
  代码正文 10.5pt，中文宋体 + 英文/符号 Times New Roman，行距 1.05，无缩进无灰底。

用法：
  python gen_src_docx.py <项目目录> <输出.docx> [--title "软件名"] [--version V1.0]
自动发现源码文件（*.py *.html *.css *.bat *.toml *.txt *.in），
排除 __pycache__ / *.min.js / records.db / uploads / dist / .venv / .workbuddy / node_modules。
"""
import os
import sys
from docx import Document
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

EXCLUDE_DIRS = {"__pycache__", ".venv", ".workbuddy", "node_modules", "dist", "build",
                "uploads", ".git", ".idea", "venv", "env",
                "docs", "img"}   # docs/img 为交付物目录（docx/html/截图），非源码，必须排除
EXCLUDE_FILES = {"records.db", "*.min.js", ".DS_Store"}
EXCLUDE_SUFFIX_DIRS = (".egg-info",)

KEEP_EXTS = (".py", ".ts", ".vue", ".css", ".html", ".bat", ".toml", ".txt", ".in", ".js", ".json", ".yaml", ".yml", ".sh", ".sql")


def _is_tmp_dir(name):
    """临时校验/解压副本目录（tmp_xxx / _tmp 等）一律排除，避免把 sdist 副本当源码收录。"""
    return name.startswith("tmp_") or name.startswith("_tmp")


def discover_files(root):
    """按目录序遍历源码文件，返回 (分组, 相对路径用反斜杠) 列表"""
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames
                       if d not in EXCLUDE_DIRS
                       and not d.endswith(EXCLUDE_SUFFIX_DIRS)
                       and not _is_tmp_dir(d)]
        for fn in sorted(filenames):
            if fn in EXCLUDE_FILES or fn.endswith(".min.js"):
                continue
            if not fn.endswith(KEEP_EXTS):
                continue
            rel = os.path.relpath(os.path.join(dirpath, fn), root)
            group = os.path.dirname(rel).replace(os.sep, "/") or "根目录"
            out.append((group, rel.replace(os.sep, "\\")))
    # 根目录文件优先，再按目录
    out.sort(key=lambda x: (x[0] != "根目录", x[0], x[1]))
    return out


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    root, out = sys.argv[1], sys.argv[2]
    title = None
    ver = "V1.0.0"
    for i, a in enumerate(sys.argv):
        if a == "--title":
            title = sys.argv[i + 1]
        if a == "--version":
            ver = sys.argv[i + 1]
    if title is None:
        title = os.path.basename(os.path.abspath(root))

    files = discover_files(root)
    if not files:
        print("未发现源码文件:", root)
        sys.exit(1)

    # 预读所有文件：统计有效代码行数（封面标注用），缓存正文内容（避免读两次）
    contents = {}
    skipped = []
    total = 0
    for group, rel in files:
        path = os.path.join(root, rel.replace("\\", os.sep))
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
        # 防御：压缩/内联产物（单行超长）误收录会把 docx 撑到几百页，跳过并告警
        if lines and max((len(l) for l in lines), default=0) > 5000:
            skipped.append((rel, max(len(l) for l in lines)))
            continue
        while lines and lines[-1].strip() == "":
            lines.pop()
        contents[(group, rel)] = lines
        total += len(lines)
    if skipped:
        print("警告: 已跳过单行超长(>5000字符)的疑似压缩/内联产物文件:")
        for rel, m in skipped:
            print("   ", rel, "(最大行 %d 字符)" % m)
    files = [(g, r) for (g, r) in files if (g, r) in contents]

    doc = Document()
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Cm(21.0), Cm(29.7)
    sec.top_margin = sec.bottom_margin = Cm(2.0)
    sec.left_margin = sec.right_margin = Cm(2.5)
    normal = doc.styles["Normal"]
    normal.font.name = "Times New Roman"
    normal.font.size = Pt(10.5)
    normal.element.rPr.rFonts.set(qn("w:eastAsia"), "宋体")
    npf = normal.paragraph_format
    npf.space_before = Pt(0); npf.space_after = Pt(0)

    def _run(p, text, ea="宋体", ascii_f="Times New Roman", size=10.5, bold=False):
        r = p.add_run(text)
        r.font.name = ascii_f
        r.font.size = Pt(size)
        r.font.bold = bold
        rPr = r._element.get_or_add_rPr()
        rf = rPr.find(qn("w:rFonts"))
        if rf is None:
            rf = OxmlElement("w:rFonts"); rPr.append(rf)
        rf.set(qn("w:ascii"), ascii_f)
        rf.set(qn("w:hAnsi"), ascii_f)
        rf.set(qn("w:eastAsia"), ea)
        return r

    # 封面（含文件数与代码量统计，供审查快速核对规模）
    for _ in range(6):
        doc.add_paragraph()
    p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    _run(p, title, ea="黑体", size=22, bold=True)
    p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    _run(p, ver, ea="黑体", size=15, bold=True)
    for _ in range(2):
        doc.add_paragraph()
    p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    _run(p, "源代码文档", ea="宋体", size=22)
    p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    _run(p, "共 %d 个源文件，%d 行代码" % (len(files), total), ea="宋体", size=14)
    doc.add_page_break()

    # 正文
    for group, rel in files:
        lines = contents[(group, rel)]
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(12)
        p.paragraph_format.space_after = Pt(6)
        _run(p, rel, ea="黑体", size=12, bold=True)
        for ln in lines:
            p2 = doc.add_paragraph()
            p2.paragraph_format.line_spacing = 1.05
            p2.paragraph_format.space_before = Pt(0)
            p2.paragraph_format.space_after = Pt(0)
            if ln:
                _run(p2, ln, size=10.5)
        doc.add_paragraph()

    # 保存（逐级 _V2~_V10 兜底，防目标被 Word 预览占用）
    tmp = out + ".tmp.docx"
    doc.save(tmp)
    saved = None
    for k in range(0, 10):
        target = out if k == 0 else out.replace(".docx", "_V%d.docx" % (k + 1))
        try:
            os.replace(tmp, target)
            saved = target
            break
        except OSError:
            continue
    if saved is None:
        print("保存失败（目标与 _V2~_V10 均被占用），临时文件位于:", tmp)
        return 1
    print("已生成:", saved)
    print("文件数:", len(files), "| 代码行数:", total)
    return 0


if __name__ == "__main__":
    sys.exit(main())
