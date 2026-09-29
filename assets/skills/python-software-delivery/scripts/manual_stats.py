#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""说明书规模统计与页数估算。

统计：段落数、表格数、图题数、正文字符数（含表格）、各章字数分布。

页数来源优先级（越靠前越准）：
  1. --render        ：调 Word COM 后台渲染，取真实页数（最准，需装 Word + pywin32）
  2. docProps/app.xml：Word/WPS 保存过的文件内含真实 <Pages>
  3. 校准法 --calib  ：用参考 docx 的 (真实页数 / 字符数) 反推每页容量
  4. 双密度区间兜底  ：同时给出「纯文字密度」「图文混排密度」两个估计，暴露不确定性

**重要实测结论（2026-09-24，06 电池BMS平台说明书）**：
  单页容量因「表格 + 图位」而大幅下降。实测 34560 字（含 20 表 + 37 图位）
  由 Word 渲染为 **46 页**，即 **约 751 字/页**；而旧版经验值 1400 字/页
  高估近 1.9 倍，会给出「24.7 页」的严重偏低结论。
  因此：**估算页数一律以 --render 为准，经验法仅作无 Word 环境的粗略参考。**
  另注：规范里「≥1.5 万字」与「30~35 页」在真实密度下并不同时成立——
  要落到 30~35 页，含表格的图文混排稿约需 2.3~2.6 万字；1.5 万字只约 20 页。
  正文规模以字数为硬约束，页数以「不少于 30 页」为实质意图。

用法：
    python manual_stats.py <docx> [--calib <参考docx>] [--render]
"""
import io
import os
import re
import sys
import zipfile

import docx

# 实测校准的两个密度（字/页，含空白排版）
DENSITY_TEXT = 1300.0   # 纯正文段落为主
DENSITY_MIXED = 750.0   # 表格/图位密集的图文混排（06 实测 751）


def rendered_pages(path):
    """读 docProps/app.xml 的 Pages。python-docx 生成的文件恒为 1（未渲染），
    故仅 >1 才视为可信真实页数。"""
    try:
        with zipfile.ZipFile(path) as z:
            if "docProps/app.xml" not in z.namelist():
                return None
            xml = z.read("docProps/app.xml").decode("utf-8", "replace")
        m = re.search(r"<Pages>(\d+)</Pages>", xml)
        if not m:
            return None
        n = int(m.group(1))
        return n if n > 1 else None
    except Exception:
        return None


def render_pages(path):
    """Word COM 后台渲染取真实页数（不弹窗）。失败返回 None。"""
    try:
        import win32com.client as win32
    except Exception:
        return None
    word = None
    try:
        word = win32.DispatchEx("Word.Application")
        word.Visible = False
        word.DisplayAlerts = 0
        doc = word.Documents.Open(os.path.abspath(path),
                                  ReadOnly=True, AddToRecentFiles=False)
        doc.Repaginate()
        pages = doc.ComputeStatistics(2)  # wdStatisticPages
        doc.Close(False)
        return pages
    except Exception:
        return None
    finally:
        try:
            if word is not None:
                word.Quit()
        except Exception:
            pass


def stats(path):
    d = docx.Document(path)
    paras = [p.text for p in d.paragraphs]
    n_para = sum(1 for t in paras if t.strip())
    txt_all = "\n".join(paras)
    for tb in d.tables:
        for row in tb.rows:
            for cell in row.cells:
                txt_all += "\n" + cell.text
    n_char = len(re.sub(r"\s", "", txt_all))
    fig_titles = len([t for t in paras if re.search(r"^\s*图\s*\d+\s", t)])
    # 图位（占位说明行）；排除「界面截图位」这类导语误命中
    n_figslot = 0
    for t in paras:
        if "此处插入" in t:
            n_figslot += 1
    chapters, cur = [], None
    for t in paras:
        t = t.strip()
        if re.match(r"^[1-8]\s+\S", t) and len(t) < 30:
            cur = [t, 0]
            chapters.append(cur)
        elif cur is not None:
            cur[1] += len(re.sub(r"\s", "", t))
    return {
        "n_para": n_para, "n_table": len(d.tables), "n_char": n_char,
        "fig_titles": fig_titles, "n_figslot": n_figslot, "chapters": chapters,
    }


def main():
    path = sys.argv[1]
    calib = None
    if "--calib" in sys.argv:
        calib = sys.argv[sys.argv.index("--calib") + 1]
    do_render = "--render" in sys.argv

    s = stats(path)
    print("== 说明书规模统计 ==")
    print("段落数(非空)      : %d" % s["n_para"])
    print("表格数            : %d" % s["n_table"])
    print("图题数            : %d" % s["fig_titles"])
    print("图位数(占位说明)  : %d" % s["n_figslot"])
    print("正文字符数(含表格) : %d" % s["n_char"])
    print()
    print("各章字数：")
    for name, n in s["chapters"]:
        print("  %-28s %6d" % (name, n))
    print()

    # ---- 页数：按优先级取 ----
    est = None
    src = ""
    if do_render:
        p = render_pages(path)
        if p:
            est, src = float(p), "Word 真实渲染"
        else:
            print("[提示] --render 失败（未装 Word / 无 pywin32），回退到其他方式")

    if est is None:
        p = rendered_pages(path)
        if p:
            est, src = float(p), "app.xml 真实页数"

    if est is None and calib:
        cp, cs = rendered_pages(calib), stats(calib)
        if cp and cs["n_char"]:
            per_page = cs["n_char"] / cp
            print("校准参考：%s（%d 字 / %d 页 = %.0f 字/页）"
                  % (calib, cs["n_char"], cp, per_page))
            est, src = s["n_char"] / per_page, "校准法"

    if est is not None:
        print("页数（%s）: %.1f 页" % (src, est))
    else:
        lo = s["n_char"] / DENSITY_TEXT
        hi = s["n_char"] / DENSITY_MIXED
        print("页数估计区间      : %.1f ~ %.1f 页" % (lo, hi))
        print("  （纯文字 %.0f 字/页 ~ 图文混排 %.0f 字/页；"
              "本稿含 %d 表 / %d 图位，实际更靠近上界）"
              % (DENSITY_TEXT, DENSITY_MIXED, s["n_table"], s["n_figslot"]))
        print("  → 建议加 --render 取真实页数")
        est = hi

    print()
    checks = [
        ("图题 ≥ 30", s["fig_titles"] >= 30, s["fig_titles"]),
        ("表格 ≥ 10", s["n_table"] >= 10, s["n_table"]),
        ("字数 ≥ 1.5 万", s["n_char"] >= 15000, s["n_char"]),
        ("页数 ≥ 30", est >= 30, round(est, 1)),
    ]
    all_ok = True
    for label, ok, val in checks:
        print("  [%s] %-14s = %s" % ("✔" if ok else "✘", label, val))
        all_ok = all_ok and ok
    if est > 35:
        print("  [i] 页数 > 35（规范上限为软建议，软著说明书无硬上限；"
              "内容详尽优先级更高）")
    print("达标判定: %s" % ("达标" if all_ok else "不达标（见上方 ✘ 项）"))
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
