#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""docx 文档 AI 痕迹检测（降 AIGC 率前置分析，内置检测、不依赖外部平台）。

统计六组指标，供改写定位目标段落：
1. AI 高频词出现次数（降 AIGC 后应显著下降）；
2. 模板句式命中数（"该功能由…实现"等整句框架）；
3. 句长分布：均值 / 标准差（突发性，AI <0.3，人类 0.4~0.7）/ 最长句；
4. 结构性问题（--struct）："不是A而是B"/"不仅X更是Y"/否定列举/宣告式/被动语态
   等 AI 句式结构（来源：stop-slop/structures + Humanizer-zh）；
5. 书面化表达（--struct 内置）："采用…技术栈"/"经…避免"/"依据…推荐"等
   书面化套话——实测证明书面化=AI 特征，比口语化更易被标红；
6. 参数罗列密集段（--struct 内置）：同一段 ≥3 处"取 0.001/等于 50/默认 100 次"
   式参数罗列，建议正文去参数化（参数下沉附录参数表）；
7. 排比句检测（--struct 内置，对应"加解释破排比"改写手法）：推进链
   "先…接着…再…最后"、编号三段式"①②③"、段内同类动词重复
   （"A 包含…；B 包含…；C 包含…"式排比枚举）；
8. 书面化语句检测（--struct 内置，对应"打散书面化句式"改写手法）：
   "对…进行""从而/进而/以便""该方案能够""在…过程中"等书面化套话。

用法：
  python scripts/check_aigc.py <docx路径>            # 统计报告（词汇级）
  python scripts/check_aigc.py <docx路径> --struct   # 追加结构+书面化+参数罗列扫描
  python scripts/check_aigc.py <docx路径> --list     # 额外列出含 AI 痕迹词的正文段落
  python scripts/check_aigc.py <docx路径> --old <旧版docx>  # 与旧版对比降幅
"""

import re
import sys
import statistics
from collections import Counter

import docx

# AI 高频词（出现即优先改写）
AI_WORDS = [
    "本系统", "本软件", "同时", "此外", "因此", "其中", "从而", "通过",
    "实现", "采用", "进行", "提供", "支持", "用于", "以便", "旨在",
    "值得注意的是", "综上所述", "首先", "其次", "最后", "一方面", "另一方面",
    "随着", "不仅", "而且", "具备", "具有", "充分", "有效", "显著",
    "重要", "相关", "相应", "合理", "便捷", "直观", "一站式",
]

# 模板句式（整句命中即报告）
TEMPLATE_PATTERNS = [
    "该功能由", "通过...实现", "为用户提供", "能够有效", "具有以下",
    "主要功能包括", "集成...于一体", "一站式", "点击「", "支持导入",
    "自动执行", "旨在", "值得注意的是", "综上所述",
]

# 结构性问题模式（来源：中文 AI 味结构性问题清单 v4.0，含"不是A而是B"三毒/二元对比/
# 否定列举/碎片化/修辞性设置/公式化/虚假能动性/距离化叙述/被动/极端词/副词）
# 注意：技术文档中部分模式是合理表达（如软件职责描述），命中后需人工判断
STRUCT_PATTERNS = {
    "不是A而是B": re.compile(r"不是[^。；，]{1,20}(?:而是)"),
    "不仅是X更是Y": re.compile(r"不仅是[^。；]{1,25}(?:更是|而且是|而是)"),
    "X不是问题Y才是": re.compile(r"不是问题"),
    "答案不是X是Y": re.compile(r"答案不是"),
    "问题不是X而是Y": re.compile(r"问题不是"),
    "感觉像X其实是Y": re.compile(r"感觉像"),
    "不再X开始成为Y": re.compile(r"不再是"),
    "没有X没有Y只有Z": re.compile(r"没有[^。；]{1,15}没有"),
    "否定列举-不是X不是Y": re.compile(r"不是[^。；]{1,15}不是"),
    "戏剧性碎片化": re.compile(r"。就这样|这一刻|。而且"),
    "修辞性设置": re.compile(r"我的意思是|想想看|如果[^。？]{1,25}呢|这也没关系"),
    "公式化三段式": re.compile(r"首先.{0,60}其次.{0,60}最后"),
    "随着...的发展": re.compile(r"随着[^。，]{1,20}(?:的发展|的进步|的到来)"),
    "在...的背景下": re.compile(r"在[^。，]{1,25}的背景下"),
    "从某种意义上说": re.compile(r"从某种意义上"),
    "宣告式": re.compile(r"值得注意的是|需要指出的是|这正是|也就是说|总而言之|不难发现|由此可见|综上所述"),
    "虚假能动性": re.compile(r"(?:数据|结果|实验|指标|系统|软件|平台)[^。；，]{0,12}(?:告诉我们|表明|揭示|印证|证明了|显示了)"),
    "距离化叙述者": re.compile(r"这是因为|人们往往会|没有人设计"),
    "被动语态叙述": re.compile(r"被压下去|被滤掉|被创造|被实现|被设计|被做出|被抛弃|被忽略"),
    "极端词": re.compile(r"每一个|总是|从不|所有人|没有人|任何情况"),
    "副词过度": re.compile(r"突然|好像|瞬间|其实|实际上"),
    # ---- 书面化表达（实测：书面化=AI 特征，比口语化更易被标红）----
    "书面化套话": re.compile(r"采用[^。；，]{1,14}技术栈|经\S{0,6}(?:过渡|此|该|由)|依据\S{0,8}类型|即停止并返回|负责[^。；，]{0,10}负责|对[^。；，]{1,18}进行(?:了|调整|处理|分析|优化|设置|计算)|进行了|予以"),
    "书面化连接": re.compile(r"即可|均需|均应|将\S{1,4}设为|设置为\S{1,6}(?:即可|便可)|从而|进而|以便|以便于|由此|以达到"),
    "书面化收尾": re.compile(r"整体上|综上所述|这一设计|该方案|由此可见|整体来看|总体而言"),
    "书面化过程": re.compile(r"在[^。；，]{1,20}过程中"),
    "书面化指代": re.compile(r"该(?:设计|方案|系统|功能|软件)[^。；，]{0,22}(?:能够|可以|具备|实现|提供|支持)"),
    # ---- 排比句式（对应"加解释破排比"改写手法）----
    "排比推进链": re.compile(r"(?:先|首先)[^。；]{1,35}(?:接着|然后|随后|其次)[^。；]{1,35}(?:再|最后)"),
    "编号三段式枚举": re.compile(r"(?:①|1[.、])\s*\S{1,30}(?:②|2[.、])\s*\S{1,30}(?:③|3[.、])"),
    "排比指代重复": re.compile(r"该(?:方案|功能|模块|页面|系统|接口)[^。；]{1,25}该(?:方案|功能|模块|页面|系统|接口)"),
    # ---- 基于第三方标红报告实测补充（2026-08-21，33 段标红反馈）----
    "编号标签段": re.compile(r"^[①②③④⑤⑥]\s*[\u4e00-\u9fa5A-Za-z（）()\-]{2,14}[：:]"),
    "引言呼应模板": re.compile(r"本文档(?:为|与)[^。]{1,40}|供[^。]{1,22}(?:参考|查阅|核对)|方便[^。]{1,22}(?:追溯|审计|查阅)"),
    "括号注释排比": re.compile(r"(?:[\u4e00-\u9fa5A-Za-z]{1,8}（[^（）]{1,14}）、){2,}[\u4e00-\u9fa5A-Za-z]{1,8}（[^（）]{1,14}）"),
    "顿号长列举": re.compile(r"[^。；，：]{1,9}(?:、[^。；，：]{1,9}){4,}"),
    "数量词引出枚举": re.compile(r"(?:两种|三种|三类|两类|四条|五个|六个|多条|多种|多类|若干种|两种通道|两条通道|两个环节)"),
    "顺滑衔接句": re.compile(r"这样[^。；]{1,22}(?:到|直至|就)|随时能查|想查[^。]{1,12}随时|随手[^。；]{1,16}"),
    "技术归因链": re.compile(r"由[^。；，]{2,24}(?:管理|实现|负责|完成|处理|统计|落库|维护)|供[^。；，]{2,18}(?:定位|使用|展示|查看|参考)"),
    "推进词链": re.compile(r"(?:先|首先)[^。；]{1,28}(?:再|接着|随后|然后)[^。；]{1,28}(?:随后|接着|再|最后|收尾)"),
}

# 参数罗列密集段：同一段 ≥ PARAM_HIT 处"取 X/等于 X/默认 X/设为 X"式参数，建议去参数化
PARAM_PAT = re.compile(r"(?:取|等于|设为?|设置成|默认(?:为)?|配置为|调整(?:为)?)\s*[0-9][0-9a-zA-Z.±·\s]*(?:ms|Hz|N|rad|s|mm|m|°|%|次|条|个)?")
PARAM_HIT = 3

# 跳过行（标题/图题/步骤/页眉页脚/占位说明）
SKIP_RE = re.compile(r"^(图 \d|步骤 \d|第 .*页|目|（界面截图)")


def collect_texts(path):
    """收集正文段落文本（排除标题/图题/步骤等非叙述内容）。"""
    d = docx.Document(path)
    texts = []
    for p in d.paragraphs:
        t = p.text.strip()
        if not t or SKIP_RE.match(t) or len(t) < 20:
            continue
        r = p.runs[0] if p.runs else None
        sz = r.font.size.pt if r and r.font.size else None
        if sz == 14 or (p.style and p.style.name in ("Heading 3", "Heading 4")):
            continue  # 标题不参与
        texts.append(t)
    return texts


def analyze(path, list_paras=False):
    texts = collect_texts(path)
    text = "\n".join(texts)

    cnt = Counter()
    for w in AI_WORDS:
        c = text.count(w)
        if c:
            cnt[w] = c

    tmpl = Counter()
    for pat in TEMPLATE_PATTERNS:
        c = text.count(pat)
        if c:
            tmpl[pat] = c

    sents = [s for s in re.split(r"[。；!?]", text) if len(s) > 5]
    lens = [len(s) for s in sents]
    mean = statistics.mean(lens) if lens else 0
    stdev = statistics.stdev(lens) if len(lens) > 1 else 0
    longest = max(lens) if lens else 0
    long_cnt = sum(1 for n in lens if n > 60)
    # 列举式长句（第三轮实测标红特征：排比枚举"A 包含…；B 包含…"），分号≥3 且句长>60
    enum_cnt = sum(1 for t in texts if t.count("；") >= 3 and len(t) > 60)

    result = dict(cnt=cnt, tmpl=tmpl, n_paras=len(texts), n_chars=len(text),
                  mean=mean, stdev=stdev, longest=longest, long_cnt=long_cnt,
                  enum_cnt=enum_cnt)
    if list_paras:
        result["hit_paras"] = [t for t in texts
                               if any(w in t for w in AI_WORDS)
                               or any(p.replace("...", "") in t for p in TEMPLATE_PATTERNS)]
    return result


def scan_struct(path):
    """结构性问题扫描（中文 AI 味结构性问题清单 + 书面化表达 + 参数罗列）。

    返回 {模式名: [(段落序号, 段落文本, 命中片段), ...]}。注意：
    技术文档中"系统/页面提供、支持"等职责描述是规范表达，命中后
    需人工判断是否真 AI 味，勿机械全改。
    """
    d = docx.Document(path)
    hits = {}
    for name, pat in STRUCT_PATTERNS.items():
        loc = []
        for i, p in enumerate(d.paragraphs):
            t = p.text
            m = pat.search(t)
            if m:
                loc.append((i, t.strip()[:80], m.group(0)))
        if loc:
            hits[name] = loc
    # 参数罗列密集段（正文去参数化候选）
    param_loc = []
    for i, p in enumerate(d.paragraphs):
        t = p.text.strip()
        if not t or len(t) < 30:
            continue
        n = len(PARAM_PAT.findall(t))
        if n >= PARAM_HIT:
            param_loc.append((i, t[:80], "%d 处参数罗列" % n))
    if param_loc:
        hits["参数罗列密集(建议去参数化)"] = param_loc
    # 段内同类结构词重复（A 包含…；B 包含…；C 包含… 式排比枚举，对应破排比改写）
    REPEAT_VERBS = ["包含", "包括", "负责", "支持", "提供", "实现", "采用", "展示", "管理", "用于", "基于", "覆盖"]
    enum_loc = []
    for i, p in enumerate(d.paragraphs):
        t = p.text.strip()
        if not t or len(t) < 40:
            continue
        for v in REPEAT_VERBS:
            c = t.count(v)
            if c >= 2:
                enum_loc.append((i, t[:80], "'%s' 重复 %d 次（排比枚举候选）" % (v, c)))
                break
    if enum_loc:
        hits["排比枚举-同类动词重复(建议破排比)"] = enum_loc
    # 分号并列句（信息密度+顺滑度，对应长句拆分）
    semi_loc = []
    for i, p in enumerate(d.paragraphs):
        t = p.text.strip()
        if len(t) >= 50 and t.count("；") >= 2:
            semi_loc.append((i, t[:80], "分号 %d 处（并列完整句候选）" % t.count("；")))
    if semi_loc:
        hits["分号并列句(建议拆句)"] = semi_loc
    # 多列动作排比（X 做…，Y 做…，Z 做…，对应破排比改写）
    act_loc = []
    for i, p in enumerate(d.paragraphs):
        t = p.text.strip()
        if len(t) < 60:
            continue
        n = len(re.findall(r"[\u4e00-\u9fa5]{1,6}(?:做|调|靠|走|负责|把|用|存|按|给|拿|拼|串)", t))
        if n >= 4:
            act_loc.append((i, t[:80], "动作链 %d 处（多列排比候选）" % n))
    if act_loc:
        hits["多列动作排比(建议破排比)"] = act_loc
    # 高完整度顺滑段（语言完整顺滑特征，对应语义重构/个性化改写）
    smooth_loc = []
    SMOOTH_WORDS = ["保证", "实现", "完成", "可溯源", "即可", "通吃", "自动", "随时能查",
                    "落库", "预留", "封装", "承载", "收敛"]
    for i, p in enumerate(d.paragraphs):
        t = p.text.strip()
        if len(t) < 60:
            continue
        score = 0
        score += t.count("；") + min(t.count("、") // 3, 2)
        score += len(re.findall(r"[由经把将按]", t))
        score += sum(1 for w in SMOOTH_WORDS if w in t)
        # 技术引用：文件名/表名（core/x.py、x_record、x_config、XxxProvider 等）
        score += len(re.findall(r"[A-Za-z_]+\.[A-Za-z_]+", t))
        score += len(re.findall(r"[a-z_]{3,}_(?:record|config|log|case|info|data|threshold|sensor|action)", t))
        score += len(re.findall(r"[A-Za-z]+Provider|Simulator|RuleEngine|AgentDiagnoser|Collector|Database|Threshold", t))
        if score >= 6:
            smooth_loc.append((i, t[:80], "完整度得分 %d" % score))
    if smooth_loc:
        hits["高完整度顺滑段(建议语义重构)"] = smooth_loc
    # 连续编号列举组（跨段 ≥3 条连续 ①/②/③ 或 1. 2. 3.，对应编号列举改自然段）
    num_pat = re.compile(r"^([①②③④⑤⑥]|\d+[.、])\s*\S")
    seq, seq_start, groups = [], None, []
    for i, p in enumerate(d.paragraphs):
        t = p.text.strip()
        m = num_pat.match(t) if t else None
        if m:
            if seq_start is None:
                seq_start = i
            seq.append(i)
        else:
            if len(seq) >= 3:
                groups.append((seq_start, seq[-1], len(seq)))
            seq, seq_start = [], None
    if len(seq) >= 3:
        groups.append((seq_start, seq[-1], len(seq)))
    if groups:
        hits["连续编号列举组(建议改自然段)"] = [
            (g0, "段 %d~%d 共 %d 条连续编号" % (g0, g1, n), "编号枚举组") for g0, g1, n in groups]
    # 功能短句列表段（20~45 字单句、无分号/冒号，主谓宾完整 -> 建议并入表格或合并长段）
    short_loc = []
    for ip, p in enumerate(d.paragraphs):
        t = p.text.strip()
        if not (20 <= len(t) <= 45):
            continue
        if "；" in t or "：" in t or ":" in t:
            continue
        if re.search(r"[\u4e00-\u9fa5]{1,4}(?:采集|告警|报告|反馈|内置|输出|给出|记录|呈现|生成|判定|识别|接入)", t):
            short_loc.append((ip, t[:80], "功能短句(建议并入表格/合并长段)"))
    if short_loc:
        hits["功能短句列表(建议结构化)"] = short_loc
    return hits


def fmt(r):
    out = []
    out.append("== AI 高频词（共 %d 种） ==" % len(r["cnt"]))
    for w, c in r["cnt"].most_common(25):
        out.append("  %-10s %d" % (w, c))
    out.append("== 模板句式命中 ==")
    for p, c in r["tmpl"].most_common(10):
        out.append("  %-24s %d" % (p, c))
    out.append("== 文本与节奏 ==")
    out.append("  正文段落: %d | 字数: %d" % (r["n_paras"], r["n_chars"]))
    out.append("  句长均值: %.1f | 标准差(突发性): %.2f | 最长: %d | 超60字句: %d | 列举式长句(分号≥3): %d"
               % (r["mean"], r["stdev"], r["longest"], r["long_cnt"], r["enum_cnt"]))
    return "\n".join(out)


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 1
    path = args[0]
    list_paras = "--list" in args
    r = analyze(path, list_paras)
    print(fmt(r))

    if list_paras and r.get("hit_paras"):
        print("\n== 含 AI 痕迹词的正文段落（改写目标） ==")
        for t in r["hit_paras"][:40]:
            print("  -", t[:70])

    if "--old" in args:
        old_path = args[args.index("--old") + 1]
        old = analyze(old_path)
        tot_old = sum(old["cnt"].values())
        tot_new = sum(r["cnt"].values())
        print("\n== 降幅对比（旧版 → 新版） ==")
        print("  AI 高频词合计: %d → %d (↓%.0f%%)" % (
            tot_old, tot_new, (tot_old - tot_new) / max(tot_old, 1) * 100))
        print("  句长标准差: %.2f → %.2f" % (old["stdev"], r["stdev"]))

    if "--struct" in args:
        print("\n== 结构性问题扫描（中文 AI 味结构性问题清单） ==")
        s = scan_struct(path)
        if list_paras and s:
            print("\n== 结构性问题命中段落（改写目标，与手法对应） ==")
            shown = set()
            for name, loc in sorted(s.items()):
                for i, t, m in loc:
                    key = t[:40]
                    if key in shown:
                        continue
                    shown.add(key)
                    print("  [%s] %s  |  命中: %s" % (name, t[:56], m))
        total = 0
        for name, loc in sorted(s.items()):
            total += len(loc)
            print("  %-18s %d 处" % (name, len(loc)))
            for i, t, m in loc[:3]:
                print("     [%d] %s" % (i, t))
        print("  结构性问题合计: %d（技术文档中的合理表达需人工判断）" % total)
    return 0


if __name__ == "__main__":
    sys.exit(main())