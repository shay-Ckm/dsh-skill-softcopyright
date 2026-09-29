# -*- coding: utf-8 -*-
"""
《使用说明书》插图版复验（图集已回填进 docx 之后用）

与 python-software-delivery 的 check_manual_docx.py 的区别：
  插图后占位说明段已被真实图片替换，故判定口径改为 **图题数 == 图片数**
  （原判定是"图题数 == 图位数"），其余符号/颜色/斜体约束保持一致。

用法：
  python check_manual_with_figs.py <说明书.docx> [--expect 37]

输出：箭头/Markdown**/非黑/斜体 计数 + 图题数、图片数、图号连续性、残留占位段、表格数。
"""
import argparse
import re
import sys

import docx

ARROW_RE = re.compile(r"(?:->|<-|←|→|↑|↓|↖|↗|↘|↙|⇄|↔|↕)")
CAP_RE = re.compile(r"^图\s*(\d+)\s*(.+)$")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("docx_path")
    ap.add_argument("--expect", type=int, default=0, help="期望图数，0 = 用文档内图题数自我一致判定")
    args = ap.parse_args()

    d = docx.Document(args.docx_path)
    bad_sym, bad_star, bad_color, bad_italic = [], [], [], []
    caps, placeholders = [], 0

    for p in d.paragraphs:
        t = p.text
        m = CAP_RE.match(t.strip())
        if m and "截图" not in t:
            caps.append((int(m.group(1)), t.strip()))
        if "（界面截图，此处插入" in t:
            placeholders += 1
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

    for tb in d.tables:
        for row in tb.rows:
            for cell in row.cells:
                for p in cell.paragraphs:
                    if ARROW_RE.search(p.text):
                        bad_sym.append("TBL:" + p.text[:40])
                    if "**" in p.text:
                        bad_star.append("TBL:" + p.text[:40])

    images = d.element.xml.count("<w:drawing>")
    nums = [n for n, _ in caps]
    seq_ok = nums == list(range(1, len(caps) + 1))

    def report(name, lst):
        print("%-14s %d" % (name, len(lst)))
        for x in lst[:5]:
            print("     ", x)

    print("== 说明书（插图版）复验 ==")
    report("箭头符号", bad_sym)
    report("Markdown**", bad_star)
    report("非黑颜色", bad_color)
    report("斜体", bad_italic)
    print("%-14s 图题=%d 图片=%d 一致=%s；图号连续=%s；残留占位段=%d；表格=%d" % (
        "图题/图片", len(caps), images, len(caps) == images, seq_ok, placeholders, len(d.tables)))

    expect = args.expect or len(caps)
    ok = (not bad_sym and not bad_star and not bad_color and not bad_italic
          and len(caps) == images and images == expect and seq_ok and placeholders == 0)

    if len(caps) != images:
        print("提示：图题≠图片通常意味着有重复截图（Word 对完全相同图片去重）——")
        print("      对 docs/atlas/*.png 做 md5 查重，重拍重复项后再插图。")

    print("结论:", "通过" if ok else "未通过")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
