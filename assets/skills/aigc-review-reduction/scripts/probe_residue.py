#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AIGC 检测报告标红段残留探针（改写闭环自检）。

作用：从检测平台返回的标红报告 docx 中提取红/橙/紫段原文，检查
改写后的新 docx 是否还残留这些原文（整段全文匹配，非首尾双端——避免误报）。

颜色映射（检测平台通用）：
  红 F12828   AIGC 生成疑似度 ≥70%（高度疑似）
  橙 F39800   AIGC 生成疑似度 60%~70%（中度疑似）
  紫 9D91E9   AIGC 生成疑似度 50%~60%（轻度疑似）
  黑 000000   <50% 正常
  灰 B0B0B0   过短片段/标题/英文等不予检测

用法：
  python probe_residue.py <标红报告.docx> <改写后docx.docx> [--colors 红,橙,紫]
示例：
  python probe_residue.py "检测报告.docx" "说明书_降AIGC版_V5.docx"
  python probe_residue.py "检测报告.docx" "说明书_V5.docx" --colors 红
"""

import sys
import argparse
from collections import Counter

import docx

COLOR_MAP = {
    "红": "F12828",
    "橙": "F39800",
    "紫": "9D91E9",
}


def collect_targets(report_path, colors):
    """从标红报告提取指定颜色段的完整原文。"""
    d = docx.Document(report_path)
    wanted = {COLOR_MAP[c] for c in colors}
    targets = []
    for p in d.paragraphs:
        t = p.text.strip()
        if not t or len(t) < 20:
            continue  # 过短片段视为灰色不检测
        cnt = Counter()
        for r in p.runs:
            c = r.font.color
            if c and c.rgb is not None:
                cnt[str(c.rgb)] += len(r.text)
        total = sum(cnt.values())
        if total == 0:
            continue
        top_color, top_cnt = cnt.most_common(1)[0]
        if top_cnt / total < 0.5:
            continue  # 混合颜色段落忽略，避免误判
        if top_color in wanted:
            targets.append((top_color, t))
    return targets


def main():
    ap = argparse.ArgumentParser(description="AIGC 标红段残留探针")
    ap.add_argument("report", help="检测平台标红报告 docx 路径")
    ap.add_argument("new_doc", help="改写后的 docx 路径")
    ap.add_argument("--colors", default="红,橙,紫", help="要检查的颜色，逗号分隔（默认 红,橙,紫）")
    args = ap.parse_args()

    colors = [c.strip() for c in args.colors.split(",") if c.strip() in COLOR_MAP]
    if not colors:
        print("无效颜色，可选：红/橙/紫")
        return 2

    targets = collect_targets(args.report, colors)
    print("标红段总数: %d（颜色: %s）" % (len(targets), "/".join(colors)))

    d2 = docx.Document(args.new_doc)
    new_text = "\n".join(p.text for p in d2.paragraphs)

    resid = []
    for color, t in targets:
        if t in new_text:  # 整段全文匹配，最严格
            resid.append((color, t))

    print("全文残留: %d" % len(resid))
    if not resid:
        print("✓ 全部标红段已清除（0 残留）")
        return 0
    for color, t in resid:
        print("  残留[%s]: %s ..." % (color, t[:60]))
    return 1


if __name__ == "__main__":
    sys.exit(main())
