# -*- coding: utf-8 -*-
"""
把界面图集截图直接插入《使用说明书》docx 的对应图位（MUST 步骤，软著场景）

为什么必须做：
  说明书里的"图 N"通常只留了占位段「（界面截图，此处插入：xxx）」。图集单独交付
  HTML 时不构成"文档鉴别材料"，审查方看到的是 37 个空图位。把图集 PNG 按图号
  回填进 docx，说明书才是自洽的完整材料。

逻辑：
  1. 定位形如「图 N 标题」的图题段落（跳过含"截图"字样的说明段）；
  2. 在该图题段落**上方**插入居中图片段落（默认页宽 14.6 cm，等比缩放）；
  3. 删除紧随图题之后的占位段落「（界面截图，此处插入…）」；
  4. 自后向前处理，避免段落索引位移。

用法：
  python insert_atlas_into_manual.py <说明书.docx> <图集目录> [--prefix fig] [--width 14.6]
                                    [--expect 37] [--pad 2] [--backup]

  --expect N   期望图数（用于一致性守卫，0 = 不校验）
  --pad N      文件名数字补零位数（fig01.png → 2）
  --backup     插图前先备份为 <name>_仅图位版.docx（强烈建议，便于重跑）

插图后必须复验（用 check_manual_with_figs.py）：
  图题数 == 图片数；图号连续；残留占位段 0；箭头/**/非黑/斜体均为 0。
"""
import argparse
import os
import re
import shutil
import sys

import docx
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Cm, Pt

CAP_RE = re.compile(r"^图\s*(\d+)\s*(.+)$")
PLACEHOLDER = "（界面截图，此处插入"


def find_jobs(paras):
    """收集 (图号, 图题段索引, 占位段索引)，占位段在图题后 1~3 段内查找。"""
    jobs = []
    for i, p in enumerate(paras):
        t = p.text.strip()
        m = CAP_RE.match(t)
        if not m or "截图" in t:
            continue
        ph_idx = None
        for j in range(i + 1, min(i + 4, len(paras))):
            if PLACEHOLDER in paras[j].text:
                ph_idx = j
                break
        jobs.append({"n": int(m.group(1)), "cap_idx": i, "cap": t, "ph_idx": ph_idx})
    return jobs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("docx_path")
    ap.add_argument("atlas_dir")
    ap.add_argument("--prefix", default="fig")
    ap.add_argument("--width", type=float, default=14.6, help="图片宽度 cm（A4 页宽 21 - 左右边距）")
    ap.add_argument("--expect", type=int, default=0, help="期望图数，0 = 不校验")
    ap.add_argument("--pad", type=int, default=2, help="文件名数字补零位数")
    ap.add_argument("--backup", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(args.docx_path):
        print("说明书不存在:", args.docx_path)
        return 1

    def img_of(n):
        return os.path.join(args.atlas_dir, "%s%0*d.png" % (args.prefix, args.pad, n))

    d = docx.Document(args.docx_path)
    paras = d.paragraphs
    jobs = find_jobs(paras)
    print("发现图题 %d 处，其中带占位段 %d 处" % (len(jobs), sum(1 for j in jobs if j["ph_idx"] is not None)))

    if not jobs:
        print("未找到图题：说明书图位格式可能不同（应为「图 N 标题」）")
        return 1

    nums = sorted(j["n"] for j in jobs)
    if nums != list(range(1, len(nums) + 1)):
        print("警告：图号不连续 ->", nums[:40])
    if args.expect and len(jobs) != args.expect:
        print("警告：图题数 %d 与期望 %d 不一致" % (len(jobs), args.expect))

    missing = [j["n"] for j in jobs if not os.path.exists(img_of(j["n"]))]
    if missing:
        print("缺少截图文件，图号：", missing)
        return 1

    # 已插图守卫：避免重复插入（重跑前应从备份恢复）
    already = d.element.xml.count("<w:drawing>")
    if already:
        print("警告：文档内已有 %d 处图片，疑似已插图过；请从 _仅图位版 备份恢复后重跑" % already)

    if args.backup:
        base = args.docx_path[:-5] + "_仅图位版.docx"
        shutil.copy(args.docx_path, base)
        print("已备份 ->", os.path.basename(base))

    inserted = 0
    for j in sorted(jobs, key=lambda x: -x["cap_idx"]):
        cap_p = paras[j["cap_idx"]]
        new_p = cap_p.insert_paragraph_before()
        new_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        new_p.paragraph_format.space_before = Pt(6)
        new_p.paragraph_format.space_after = Pt(2)
        new_p.add_run().add_picture(img_of(j["n"]), width=Cm(args.width))
        inserted += 1
        if j["ph_idx"] is not None:
            ph = paras[j["ph_idx"]]
            ph._element.getparent().remove(ph._element)

    d.save(args.docx_path)
    print("已插入图片 %d 张并移除占位段，文档已保存" % inserted)
    print("下一步：check_manual_with_figs.py \"%s\" --expect %d" % (args.docx_path, len(jobs)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
