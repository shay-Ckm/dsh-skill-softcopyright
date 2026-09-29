#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
源代码文档完整性校验：docx 中每个源码文件的内容与磁盘源码逐行比对。
用法：
  python check_src_doc.py <docx路径> <源码目录>
输出每个文件"OK 一致(N行)"或差异明细；全部一致返回 0。
注意：空行必须保留比对（不能跳过），文件间分隔空行自动剔除；
      封面标题若含 "."（如 V1.0.0）会误判为文件标题，脚本自动排除。
"""
import os
import sys
import docx
from docx.oxml.ns import qn


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    doc_path, src_root = sys.argv[1], sys.argv[2]
    d = docx.Document(doc_path)

    # 收集文件标题（黑体段且含 . 或 \）
    titles = []
    for p in d.paragraphs:
        if p.runs and p.runs[0]._element.rPr is not None:
            rf = p.runs[0]._element.rPr.find(qn("w:rFonts"))
            if rf is not None and rf.get(qn("w:eastAsia")) == "黑体" and ("." in p.text or "\\" in p.text):
                if p.text in ("V1.0.0", "V1.0", "V2.0"):
                    continue
                titles.append(p.text)
    if not titles:
        print("未找到文件标题（黑体段）"); sys.exit(1)

    paras = [p.text for p in d.paragraphs]
    all_ok = True
    for t in titles:
        rel = t.replace("\\", os.sep)
        spath = os.path.join(src_root, rel)
        if not os.path.exists(spath):
            print("  [警告] 源码缺失:", rel); all_ok = False; continue
        src_lines = open(spath, encoding="utf-8").read().splitlines()
        while src_lines and src_lines[-1].strip() == "":
            src_lines.pop()
        idx = paras.index(t) + 1
        doc_lines = []
        for x in paras[idx:]:
            if x in titles:
                break
            doc_lines.append(x)
        while doc_lines and doc_lines[-1] == "":
            doc_lines.pop()
        n = min(len(src_lines), len(doc_lines))
        diff = [i for i in range(n) if src_lines[i] != doc_lines[i]]
        if not diff and len(src_lines) == len(doc_lines):
            print("  %-28s OK 一致(%d行)" % (t, len(src_lines)))
        else:
            print("  %-28s X 差异 %d 处 (源码%d/文档%d)" % (t, len(diff), len(src_lines), len(doc_lines)))
            for i in diff[:5]:
                print("      第%d行  源码:%r" % (i + 1, src_lines[i][:60]))
                print("           文档:%r" % (doc_lines[i][:60]))
            all_ok = False
    print("完整性:", "OK 全部一致" if all_ok else "X 存在差异")
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
