#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""说明书页数解析式估算（不依赖 Word/WPS 渲染）。

原理：按 A4 页面与字体设置，逐段落累计"排版高度"（文字行高 + 段间距 + 表格行高 +
内嵌图高度），再除以单页可用高度得到页数。内嵌图高度直接读 word/document.xml 中
<wp:extent cy="...">（EMU），比按字数估算准确得多。

用法：
    python page_estimate.py <docx> [--calib <已知页数的docx>]
--calib 用于校验模型：会同时打印参考件的估算页数与已知页数。
"""
import math
import re
import sys
import zipfile

import docx
from docx.shared import Emu

# A4 + 本套规范
PAGE_H_CM = 29.7
MARGIN_TB_CM = 2.54
USABLE_H_CM = PAGE_H_CM - 2 * MARGIN_TB_CM          # 24.62 cm
USABLE_W_CM = 21.0 - 3.0 - 2.6                      # 15.4 cm
PT2CM = 2.54 / 72.0

# 每行可容纳字符数（中文按 1 字宽，西文按半宽近似）
BODY_CHARS_PER_LINE = int(USABLE_W_CM / (12 * PT2CM))     # 12pt 正文
TBL_CHARS_PER_LINE = int(USABLE_W_CM / (10.5 * PT2CM))    # 10.5pt 表格


def para_lines(text, cpl):
    if not text.strip():
        return 0
    n = 0
    for seg in text.split("\n"):
        # 西文按半宽折算
        w = sum(1.0 if ord(c) > 0x2E80 else 0.5 for c in seg)
        n += max(1, math.ceil(w / cpl))
    return n


def image_heights(path):
    """返回 document.xml 中所有内嵌图的高度(EMU)列表"""
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8", "replace")
    return [int(m) for m in re.findall(r'<wp:extent cx="(\d+)" cy="(\d+)"', xml)
            for m in [m[1]]] if False else [
        int(m) for m in re.findall(r'<wp:extent cx="\d+" cy="(\d+)"', xml)]


def estimate(path):
    d = docx.Document(path)
    h_cm = 0.0
    detail = {"body": 0.0, "table": 0.0, "image": 0.0, "other": 0.0}

    # 正文段落（按 flow 顺序遍历 body 元素，保证表格与段落顺序正确）
    from docx.oxml.ns import qn
    body = d.element.body
    tbls = {id(t._element): t for t in d.tables}
    for child in body.iterchildren():
        tag = child.tag
        if tag == qn("w:p"):
            # 该段落是否含图
            ext = child.findall(".//" + qn("wp:extent"))
            if ext:
                for e in ext:
                    cy = int(e.get("cy"))
                    h_cm += Emu(cy).cm
                detail["image"] += sum(Emu(int(e.get("cy"))).cm for e in ext)
                continue
            txt = "".join(n.text or "" for n in child.findall(".//" + qn("w:t")))
            sz = 12
            # 取该段首个 run 的字号
            rpr = child.find(".//" + qn("w:rPr") + "/" + qn("w:sz"))
            if rpr is not None:
                sz = int(rpr.get(qn("w:val"))) / 2.0
            ls = 1.5
            sa = 6.0
            ppr = child.find(qn("w:pPr"))
            if ppr is not None:
                sp = ppr.find(qn("w:spacing"))
                if sp is not None:
                    if sp.get(qn("w:line")):
                        ls = int(sp.get(qn("w:line"))) / 240.0
                    if sp.get(qn("w:after")):
                        sa = int(sp.get(qn("w:after"))) / 20.0
            lines = para_lines(txt, BODY_CHARS_PER_LINE)
            h_cm += lines * sz * ls * PT2CM + sa * PT2CM
            detail["body"] += lines * sz * ls * PT2CM + sa * PT2CM
        elif tag == qn("w:tbl"):
            t = tbls.get(id(child))
            if t is None:
                continue
            nrow = len(t.rows)
            tot = 0.0
            for row in t.rows:
                maxl = 1
                for c in row.cells:
                    for p in c.paragraphs:
                        maxl = max(maxl, para_lines(p.text, TBL_CHARS_PER_LINE))
                tot += maxl * 10.5 * 1.15 * PT2CM + 0.12
            tot += 0.2
            h_cm += tot
            detail["table"] += tot

    pages = h_cm / USABLE_H_CM
    return pages, h_cm, detail


def main():
    path = sys.argv[1]
    pages, h, det = estimate(path)
    print("文件:", path)
    print("累计排版高度: %.1f cm   单页可用高度: %.2f cm" % (h, USABLE_H_CM))
    print("  正文 %.1f cm | 表格 %.1f cm | 内嵌图 %.1f cm" % (
        det["body"], det["table"], det["image"]))
    print("估算页数: %.1f 页" % pages)

    if "--calib" in sys.argv:
        cp = sys.argv[sys.argv.index("--calib") + 1]
        cpages, ch, cdet = estimate(cp)
        print()
        print("模型校验: %s" % cp)
        print("  估算 %.1f 页（正文 %.1f / 表 %.1f / 图 %.1f cm）" % (
            cpages, cdet["body"], cdet["table"], cdet["image"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
