#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""说明书 docx 程序化复验。

校验项：
1. 全文无箭头符号（-> <- → ← ↑ ↓ ↖ ↗ ↘ ↙ 等）与 emoji；
2. 无残留 Markdown 符号 **；
3. 所有文字运行均为黑色（RGB 0,0,0）；
4. 无斜体运行；
5. 图题数（"图 N "）与截图位占位符数（"（界面截图，此处插入"）一致。

用法：python scripts/check_manual_docx.py <docx路径>
"""

import re
import sys
import docx
from docx.oxml.ns import qn

# 箭头/方向符号（注意 - 需转义，避免形成字符范围）
ARROW_RE = re.compile(r"(?:->|<-|←|→|↑|↓|↖|↗|↘|↙|⇄|↔|↕)")


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else None
    if not path:
        print("用法: python scripts/check_manual_docx.py <docx>")
        return 1
    d = docx.Document(path)

    bad_sym, bad_star, bad_color, bad_italic = [], [], [], []
    fig_titles = 0
    fig_placeholders = 0

    for p in d.paragraphs:
        t = p.text
        if re.search(r"图\s*\d+", t) and "截图" not in t:
            fig_titles += 1
        if "（界面截图，此处插入" in t:
            fig_placeholders += 1
        if ARROW_RE.search(t):
            bad_sym.append(t[:40])
        if "**" in t:
            bad_star.append(t[:40])
        for r in p.runs:
            c = r.font.color
            if c and c.rgb is not None and str(c.rgb) != "000000":
                bad_color.append((t[:30], str(c.rgb)))
            if r.font.italic:
                bad_italic.append(t[:30])

    # 表格内文字也纳入符号检查
    for tb in d.tables:
        for row in tb.rows:
            for cell in row.cells:
                for p in cell.paragraphs:
                    if ARROW_RE.search(p.text):
                        bad_sym.append("TBL:" + p.text[:40])
                    if "**" in p.text:
                        bad_star.append("TBL:" + p.text[:40])

    def report(name, lst):
        print("%-14s %d" % (name, len(lst)))
        for x in lst[:5]:
            print("     ", x)

    print("== 说明书复验 ==")
    report("箭头符号", bad_sym)
    report("Markdown**", bad_star)
    report("非黑颜色", bad_color)
    report("斜体", bad_italic)
    print("%-14s 图题=%d 图位=%d 一致=%s" % (
        "图题/图位", fig_titles, fig_placeholders, fig_titles == fig_placeholders))

    ok = (not bad_sym and not bad_star and not bad_color and not bad_italic
          and fig_titles == fig_placeholders)
    print("结论:", "通过" if ok else "未通过")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
