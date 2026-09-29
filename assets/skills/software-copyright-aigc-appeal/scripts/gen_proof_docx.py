#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""软著 AIGC 申诉证明文档生成器（python-docx 直生，无 HTML 中转）。

生成两份 Word：
  doc1 源程序文件目录结构及哈希值清单（基本信息表 + 目录树 + 哈希明细表 + 功能说明表）
  doc2 项目研发日志（基本信息 + 阶段总览 + 分阶段记录 + 关键问题 + 测试记录 + 总结）

用法：
  python gen_proof_docx.py <hashes.tsv> <out_dir> <软件名> [--version V1.0] [--date "2026 年 8 月 18 日"]
    [--period "2026 年 3 月 2 日 - 2026 年 8 月 18 日"] [--files N] [--lines N] [--owner "（请填写著作权人名称）"]

数据来源：hashes.tsv 为 stats_source_hashes.py 输出（路径/字节/行数/sha256），行数口径与《源代码文档》一致。
字体规范：正文宋体+Times New Roman 12pt、表格 10.5pt、标题黑体加粗、全黑非斜体（软著格式约束）。
保存：逐级 _V2~_V10 兜底（目标被 Word 预览占用时自动另存）。
"""

import os
import re
import sys
import json

import docx
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

BLACK = RGBColor(0, 0, 0)


def _run(p, text, ea="宋体", ascii_f="Times New Roman", size=12, bold=False, underline=False):
    r = p.add_run(text)
    r.font.name = ascii_f
    r.font.size = Pt(size)
    r.font.bold = bold
    r.font.underline = underline
    r.font.color.rgb = BLACK
    rPr = r._element.get_or_add_rPr()
    rf = rPr.find(qn("w:rFonts"))
    if rf is None:
        rf = OxmlElement("w:rFonts")
        rPr.append(rf)
    rf.set(qn("w:ascii"), ascii_f)
    rf.set(qn("w:hAnsi"), ascii_f)
    rf.set(qn("w:eastAsia"), ea)
    return r


def _table(doc, headers, rows, widths=None, font_size=10.5):
    tb = doc.add_table(rows=1 + len(rows), cols=len(headers))
    tb.style = "Table Grid"
    for j, h in enumerate(headers):
        cell = tb.rows[0].cells[j]
        cell.text = ""
        p = cell.paragraphs[0]
        _run(p, h, ea="黑体", size=font_size, bold=True)
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    for i, row in enumerate(rows, 1):
        for j, v in enumerate(row):
            cell = tb.rows[i].cells[j]
            cell.text = ""
            p = cell.paragraphs[0]
            mono = isinstance(v, str) and (len(v) == 64 or "/" in v or "\\" in v)
            _run(p, str(v), size=font_size, ascii_f="Courier New" if mono else "Times New Roman")
    if widths:
        for j, w in enumerate(widths):
            for row in tb.rows:
                row.cells[j].width = Cm(w)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return tb


def _tree_text(paths):
    root = {}
    for p in paths:
        parts = p.split("/")
        node = root
        for part in parts[:-1]:
            node = node.setdefault(part + "/", {})
        node[parts[-1]] = None
    lines = []

    def walk(node, prefix):
        entries = sorted(node.items(), key=lambda kv: (kv[1] is None, kv[0]))
        for i, (name, child) in enumerate(entries):
            last = i == len(entries) - 1
            lines.append(prefix + ("└── " if last else "├── ") + name)
            if isinstance(child, dict):
                walk(child, prefix + ("    " if last else "│   "))
    walk(root, "")
    return "\n".join(lines)


def load_hashes(tsv):
    rows = []
    with open(tsv, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            rel, size, lines, sha = line.split("\t")
            rows.append((rel, int(size), int(lines), sha))
    return rows


# ---------------- 文档一：哈希清单 ----------------
def build_doc1(out, cfg, rows):
    d = docx.Document()
    sec = d.sections[0]
    sec.page_width, sec.page_height = Cm(21.0), Cm(29.7)
    sec.top_margin = sec.bottom_margin = Cm(2.54)
    sec.left_margin, sec.right_margin = Cm(3.0), Cm(2.6)

    p = d.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    _run(p, "源程序文件目录结构及哈希值清单", ea="黑体", size=18, bold=True)
    p = d.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    _run(p, "《%s》" % cfg["software"], size=14)

    total_files = cfg.get("files") or len(rows)
    total_lines = cfg.get("lines") or sum(r[2] for r in rows)
    total_bytes = sum(r[1] for r in rows)

    d.add_heading("", level=0)
    p = d.add_paragraph(); _run(p, "一、基本信息", ea="黑体", size=14, bold=True)
    _table(d, ["项目", "内容"], [
        ["软件名称", cfg["software"]],
        ["软件版本", cfg.get("version", "V1.0")],
        ["著作权人", cfg.get("owner", "（请填写著作权人名称）")],
        ["编制日期", cfg.get("date", "")],
        ["源程序文件总数", "%d 个" % total_files],
        ["源程序代码总行数", "%d 行" % total_lines],
        ["源程序总字节数", "%d 字节" % total_bytes],
        ["哈希算法", "SHA-256（对文件原始字节逐块计算）"],
    ], widths=[4.2, 11.6], font_size=10.5)

    p = d.add_paragraph(); _run(p, "二、源程序文件目录结构", ea="黑体", size=14, bold=True)
    for ln in _tree_text([r[0] for r in rows]).splitlines():
        p = d.add_paragraph()
        _run(p, ln, ascii_f="Courier New", size=10)
        p.paragraph_format.space_after = Pt(0)

    p = d.add_paragraph(); _run(p, "三、源程序文件哈希值明细", ea="黑体", size=14, bold=True)
    p = d.add_paragraph()
    _run(p, "下表列出全部 %d 个源程序文件的相对路径、文件大小（字节）、代码行数与 SHA-256 哈希值。哈希值由文件原始内容计算，任何一行代码的修改都会导致对应文件的哈希值改变，可据此核验提交审查的源程序与本次登记的源程序一致。" % total_files, size=10.5)
    _table(d, ["序号", "文件路径", "大小(字节)", "代码行数", "SHA-256 哈希值"],
           [(i, rel, size, lines, sha) for i, (rel, size, lines, sha) in enumerate(rows, 1)],
           widths=[1.2, 5.6, 2.2, 2.0, 5.6], font_size=9)

    p = d.add_paragraph(); _run(p, "四、源程序文件功能说明", ea="黑体", size=14, bold=True)
    p = d.add_paragraph()
    _run(p, "各文件功能与《%s 源代码文档》及《使用说明书》所描述功能一一对应，可相互印证。" % cfg["software"], size=10.5)
    desc = cfg.get("file_desc", {})
    _table(d, ["序号", "文件路径", "功能说明"],
           [(i, rel, desc.get(rel, "—")) for i, (rel, _, _, _) in enumerate(rows, 1)],
           widths=[1.2, 5.2, 9.4], font_size=9.5)

    p = d.add_paragraph(); _run(p, "五、完整性校验说明", ea="黑体", size=14, bold=True)
    _run(d.add_paragraph(), "1. 上述 %d 个文件是该软件全部手写源代码，不包含第三方压缩库（如 *.min.js）、运行时生成文件（records.db）与打包产物（dist/）；" % total_files, size=10.5)
    _run(d.add_paragraph(), "2. 每个文件的 SHA-256 哈希值由文件原始字节流计算得出，用来交付源程序与登记源程序的一致性校验；", size=10.5)
    _run(d.add_paragraph(), "3. 源程序与《使用说明书》《源代码文档》中的功能描述一一对应，每个核心功能模块都能在上述文件中找到对应代码。", size=10.5)

    _save(d, out)


# ---------------- 文档二：研发日志 ----------------
def build_doc2(out, cfg, phases, issues, tests, summary):
    d = docx.Document()
    sec = d.sections[0]
    sec.page_width, sec.page_height = Cm(21.0), Cm(29.7)
    sec.top_margin = sec.bottom_margin = Cm(2.54)
    sec.left_margin, sec.right_margin = Cm(3.0), Cm(2.6)

    p = d.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    _run(p, "项目研发日志", ea="黑体", size=18, bold=True)
    p = d.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    _run(p, "《%s》%s" % (cfg["software"], cfg.get("version", "V1.0")), size=14)

    p = d.add_paragraph(); _run(p, "一、研发基本信息", ea="黑体", size=14, bold=True)
    _table(d, ["项目", "内容"], [
        ["软件名称", cfg["software"]],
        ["软件版本", cfg.get("version", "V1.0")],
        ["著作权人", cfg.get("owner", "（请填写著作权人名称）")],
        ["研发周期", cfg.get("period", "（请填写研发周期）")],
        ["研发阶段数", "%d 个阶段" % len(phases)],
        ["代码规模", "%d 个源文件，%d 行代码" % (cfg.get("files", 0), cfg.get("lines", 0))],
        ["技术栈", cfg.get("techstack", "")],
    ], widths=[4.2, 11.6])

    p = d.add_paragraph(); _run(p, "二、研发阶段总览", ea="黑体", size=14, bold=True)
    _table(d, ["阶段", "时间", "阶段目标", "主要产出"],
           [(i, ph["time"], ph["goal"], ph["output"]) for i, ph in enumerate(phases, 1)],
           widths=[1.0, 3.6, 5.4, 5.6])

    p = d.add_paragraph(); _run(p, "三、分阶段详细研发记录", ea="黑体", size=14, bold=True)
    for i, ph in enumerate(phases, 1):
        p = d.add_paragraph(); _run(p, "阶段%d：%s（%s）" % (i, ph["name"], ph["time"]), ea="黑体", size=12, bold=True)
        _table(d, ["日期", "工作内容与决策"], [(rec[0], rec[1]) for rec in ph["records"]],
               widths=[2.4, 13.4], font_size=10)

    p = d.add_paragraph(); _run(p, "四、研发过程中解决的关键问题", ea="黑体", size=14, bold=True)
    _table(d, ["序号", "问题现象", "根因分析", "解决方案"],
           [(i, *t) for i, t in enumerate(issues, 1)],
           widths=[1.0, 4.6, 4.6, 5.4], font_size=9.5)

    p = d.add_paragraph(); _run(p, "五、测试验证记录", ea="黑体", size=14, bold=True)
    _table(d, ["序号", "测试项", "规模", "结果"],
           [(i, *t) for i, t in enumerate(tests, 1)],
           widths=[1.0, 6.0, 3.2, 5.4], font_size=9.5)

    p = d.add_paragraph(); _run(p, "六、研发总结", ea="黑体", size=14, bold=True)
    for para in summary:
        p = d.add_paragraph()
        _run(p, para, size=12)
        p.paragraph_format.first_line_indent = Cm(0.85)

    _save(d, out)


def _save(d, out):
    tmp = out + ".tmp.docx"
    d.save(tmp)
    for k in range(0, 10):
        target = out if k == 0 else out.replace(".docx", "_V%d.docx" % (k + 1))
        try:
            os.replace(tmp, target)
            print("已生成:", target)
            return
        except OSError:
            continue
    print("保存失败（目标与 _V2~_V10 均被占用），临时文件位于:", tmp)


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    tsv, out_dir, software = sys.argv[1], sys.argv[2], sys.argv[3]
    cfg = {"software": software, "version": "V1.0", "date": "2026 年 8 月 18 日",
           "owner": "（请填写著作权人名称）", "file_desc": {}, "techstack": ""}
    log_cfg = None
    i = 3
    while i < len(sys.argv):
        if sys.argv[i] == "--version":
            cfg["version"] = sys.argv[i + 1]; i += 2
        elif sys.argv[i] == "--date":
            cfg["date"] = sys.argv[i + 1]; i += 2
        elif sys.argv[i] == "--period":
            cfg["period"] = sys.argv[i + 1]; i += 2
        elif sys.argv[i] == "--files":
            cfg["files"] = int(sys.argv[i + 1]); i += 2
        elif sys.argv[i] == "--lines":
            cfg["lines"] = int(sys.argv[i + 1]); i += 2
        elif sys.argv[i] == "--owner":
            cfg["owner"] = sys.argv[i + 1]; i += 2
        elif sys.argv[i] == "--config":
            c = json.load(open(sys.argv[i + 1], encoding="utf-8"))
            cfg.update({k: v for k, v in c.items() if k in (
                "file_desc", "techstack", "version", "date", "owner", "period")})
            i += 2
        elif sys.argv[i] == "--log":
            log_cfg = json.load(open(sys.argv[i + 1], encoding="utf-8"))
            i += 2
        else:
            i += 1

    rows = load_hashes(tsv)
    os.makedirs(out_dir, exist_ok=True)
    safe = re.sub(r'[\\/:*?"<>|]', "_", software)
    build_doc1(os.path.join(out_dir, "%s_源程序文件目录结构及哈希值清单.docx" % safe), cfg, rows)
    if log_cfg:
        build_doc2(os.path.join(out_dir, "%s_项目研发日志.docx" % safe), cfg,
                   log_cfg["phases"], log_cfg["issues"], log_cfg["tests"], log_cfg["summary"])
    print("文件数:", len(rows), "| 总行数:", cfg.get("lines") or sum(r[2] for r in rows))


if __name__ == "__main__":
    main()
