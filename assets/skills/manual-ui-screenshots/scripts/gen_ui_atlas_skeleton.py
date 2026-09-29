#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""界面图集 HTML 生成器（真实界面还原路径 · 通用骨架模板）。

用法（按项目替换 TODO 标记处）：
1. 内联真实 CSS：把 STYLE_CSS 指向应用真实 static/css/style.css；
2. 复用真实页面结构：sidebar()/page_head() 换成应用真实侧栏/页头（class 与文案取源码）；
3. 服务端渲染真实数据：在 main() 里调用项目 core 模块生成数据，传给各 section_*()；
4. 配置屏清单：按说明书图位逐屏调用 commit()，终端屏传 term=True；
5. 交付前校验：validate_html.py + 图表 init stub 执行（见文件尾注释）。

内置通用机制（勿删）：
- screen()/commit()：term=True 走独立终端窗口渲染（不套软件侧栏/页面头）
- chart_init()：markLine 内嵌进 series JSON（防 ReferenceError 整图空白），devicePixelRatio:2
- term_screen()：独立 cmd 窗口（标题栏/菜单栏/黑底命令行），提示符用真实 Windows 路径
- 紧凑化 CSS：内容超高时压缩 padding/行高/图表高度，防 overflow 裁剪底部
- 单文件自包含：echarts.min.js / html2canvas 内联，无外部 src

输出：docs/界面图集.html（2559×1559，放大 SCALE 倍）
"""

import os
import sys
import json
import math

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

# ---- TODO 项目特定：路径配置 ----
OUT = os.path.join(ROOT, "docs", "界面图集.html")
STYLE_CSS = os.path.join(ROOT, "static", "css", "style.css")
ECHARTS_JS = os.path.join(ROOT, "static", "lib", "echarts.min.js")
SKILL_ASSETS = r"C:\Users\L\.workbuddy\skills\manual-ui-screenshots\assets"
HTML2CANVAS = os.path.join(SKILL_ASSETS, "html2canvas.min.js")
EXPORT_JS = os.path.join(SKILL_ASSETS, "export-png.js")

SCALE = 1.5
SHOT_W = 2559
SHOT_H = 1559
DESIGN_W = int(SHOT_W / SCALE)
DESIGN_H = SHOT_H / SCALE

# ---- TODO 项目特定：导航/页面元数据（取真实 index.html） ----
NAV = ["页面一", "页面二", "页面三", "页面四", "页面五", "页面六"]
SOFT_NAME = "软件名称 V1.0"
SOFT_SUB = "软件副标题"

TOTAL_FIGS = 37          # 必须 = 说明书图位数
FIG_RANGE = (1, TOTAL_FIGS)  # 若只生成部分图，改为实际范围


# ---------------------------------------------------------------------------
# 通用工具
# ---------------------------------------------------------------------------

def _fmt(x, nd=6):
    return "%.*g" % (nd, x)


def _down(arr, n=900):
    """降采样（时域绘图数据控制点数，对应后端降采样策略）。"""
    a = [float(x) for x in arr]
    if len(a) <= n:
        return a
    step = math.ceil(len(a) / n)
    return a[::step]


def _escape(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ---------------------------------------------------------------------------
# 真实界面片段（TODO 项目特定：取应用真实结构/class/文案）
# ---------------------------------------------------------------------------

def sidebar(active):
    items = "".join(
        '<a%s>%s</a>' % (' class="active"' if i == active else "", n)
        for i, n in enumerate(NAV))
    return ('<aside class="sidebar">'
            '<div class="brand"><div class="title">%s</div>'
            '<div class="sub">%s</div></div>'
            '<nav class="nav">%s</nav>'
            '<div class="run-box"><button class="btn-run">运行</button>'
            '<div class="hint">%s</div></div>'
            '</aside>' % (SOFT_NAME.split(" V")[0], SOFT_SUB, items, SOFT_SUB))


def page_head():
    return ('<div class="page-head"><h1>%s</h1>'
            '<p>%s</p></div>' % (SOFT_NAME, SOFT_SUB))


def field_html(label, value, unit=""):
    return ('<div class="field"><label>%s</label>'
            '<input type="number" step="any" value="%s">'
            '<div class="unit">%s</div></div>' % (label, _fmt(value), unit))


def status_bar(text, kind="ok"):
    return '<div class="status-bar-inner"><span class="%s">%s</span></div>' % (kind, text)


# TODO 项目特定：按应用页面写 section_*()（参数配置/图表/报告/代码/导入/历史），
# 每屏必须呈现该页面"所有内容"（全部字段/图表/表格行/代码区），数据来自 core 真实计算。


# ---------------------------------------------------------------------------
# ECharts 初始化（通用；markLine 必须内嵌进 series JSON，禁止引用外部变量）
# ---------------------------------------------------------------------------

def chart_init(div, series, yname, target=None):
    ser_list = [{
        "name": s["name"], "type": "line", "data": s["y"], "showSymbol": False,
        "lineStyle": {"width": 2 if i == 0 else 1.6, "color": s["color"]},
        "itemStyle": {"color": s["color"]},
    } for i, s in enumerate(series)]
    if target is not None:
        ser_list[0]["markLine"] = {
            "silent": True, "symbol": "none",
            "lineStyle": {"color": "#cf1322", "type": "dashed"},
            "data": [{"yAxis": target, "label": {"formatter": "目标 %s rpm" % target}}],
        }
    ser = json.dumps(ser_list, ensure_ascii=False)
    xs = json.dumps(series[0]["x"], ensure_ascii=False)
    names = json.dumps([s["name"] for s in series], ensure_ascii=False)
    return (
        "<script>"
        "(function(){var el=document.getElementById('%s');if(!el)return;"
        "var ch=echarts.init(el,null,{devicePixelRatio:2});var opt={backgroundColor:'transparent',"
        "grid:{left:60,right:20,top:34,bottom:40},tooltip:{trigger:'axis'},"
        "legend:{%s},"
        "xAxis:{type:'category',data:%s,name:'时间 (s)',axisLabel:{color:'#6b7280'},"
        "axisLine:{lineStyle:{color:'#bfbfbf'}}},"
        "yAxis:{type:'value',name:%s,scale:true,axisLabel:{color:'#6b7280'},"
        "splitLine:{lineStyle:{color:'#f0f0f0'}}},"
        "dataZoom:[{type:'inside'}],series:%s};"
        "ch.setOption(opt,true);"
        "setTimeout(function(){ch.resize();},150);"
        "window.addEventListener('resize',function(){ch.resize();});"
        "})();"
        "</script>" % (div, ("top:2,data:" + names) if len(series) > 1 else "show:false",
                       xs, json.dumps(yname, ensure_ascii=False), ser))


# ---------------------------------------------------------------------------
# 独立终端窗口（通用：安装/启动等步骤截图，禁止套软件侧栏布局）
# ---------------------------------------------------------------------------

def term_screen(lines, win_title="命令提示符", app_title="C:\\Windows\\System32\\cmd.exe"):
    """独立 Windows 命令提示符窗口：桌面背景 + 标题栏 + 菜单栏 + 黑底命令行区。

    lines: [(class, text), ...]，class ∈ prompt/cmd/out/ok/err/dim。
    提示符用真实 Windows 路径（C:\\Users\\...），勿用 C:// 假路径。
    """
    inner = "".join(
        '<div class="l"><span class="%s">%s</span></div>' % (tp, _escape(tx))
        for tp, tx in lines)
    return ('<div class="term-stage">'
            '<div class="term">'
            '<div class="term-bar">'
            '<span class="t">%s</span>'
            '<span class="ctrl"><b>&ndash;</b><b>&#9633;</b><b>&times;</b></span>'
            '</div>'
            '<div class="term-menu"><span>文件(F)</span><span>编辑(E)</span>'
            '<span>查看(V)</span><span>帮助(H)</span></div>'
            '<div class="term-body">%s</div>'
            '</div>'
            '<div class="term-note">命令提示符 - %s</div>'
            '</div>' % (win_title, inner, app_title))


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def main():
    # TODO 项目特定：生成真实数据（同种子调用 core 模块），并传给各 section_*()
    # 示例：res = run_simulation(...); metrics = compute_metrics(res); code = generate_code(...)
    style_css = open(STYLE_CSS, encoding="utf-8").read()
    echarts_js = open(ECHARTS_JS, encoding="utf-8").read()
    html2canvas = open(HTML2CANVAS, encoding="utf-8").read()
    export_js = open(EXPORT_JS, encoding="utf-8").read()
    export_js = export_js[export_js.index("(function(){"):]

    def screen(n, title, note, body, active, js="", extra_css_scope="", term=False):
        if term:
            inner = '<div class="app-scaled term-scope">%s</div>' % body
        else:
            inner = ('<div class="app-scaled">%s<main class="main">%s%s</main></div>'
                     % (sidebar(active), page_head(), body))
        return ('<div class="fig" id="fig%d"><div class="shot"><div class="size-tag">2559 × 1559</div>%s</div>'
                '<div class="cap"><b>图%d</b>　%s（说明：%s；对应源码 %s）</div></div>%s'
                % (n, inner, n, title, note, note_src(title), js))

    def note_src(title):
        # TODO 项目特定：按标题关键字映射对应源码文件
        if any(k in title for k in ["安装", "依赖", "启动", "端口"]):
            return "start.bat, requirements.txt, app.py"
        return "templates/index.html, static/js/app.js"

    js_all = []
    html = []

    def commit(n, title, note, body, active, js="", scope="", term=False):
        html.append(screen(n, title, note, body, active, js, scope, term))
        js_all.append(js)

    # ---- TODO 项目特定：按说明书图位逐屏配置（终端屏 term=True）----
    # commit(1, "软件安装——解压源码包", "3.3 安装步骤",
    #        term_screen([("prompt", "C:\\Users\\User> "), ("cmd", "tar -xf xx.zip")]), 0, term=True)
    # commit(2, "系统主界面", "4.1 主界面", section_main(...), 0)
    # ... 共 TOTAL_FIGS 屏

    # 外壳（目录/页头/样式）
    toc_links = "".join(
        '<a href="#fig%d">图%d</a>' % (i, i) for i in range(FIG_RANGE[0], FIG_RANGE[1] + 1))
    shell_css = compact_css()

    html_doc = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>界面图集（图%d~图%d） - %s</title>
<script>%s</script>
<style>
%s
%s
</style>
</head>
<body>
<div class="page-head">
  <h1>%s — 界面图集（图%d ~ 图%d）</h1>
  <p>本图集依据《使用说明书》各章节描述，结合真实运行界面与《源代码文档》按 <b>2559 × 1559</b> 全屏界面逐图重建，界面内容整体放大 150%% 便于阅读。每张图即一帧真实运行界面的完整全图。</p>
  <button class="export-btn" id="exportAllBtn" style="margin-top:14px;height:34px;padding:0 20px;font-size:13.5px;background:rgba(255,255,255,.14);color:#fff;border-color:rgba(255,255,255,.45)">⬇ 一键导出全部 PNG（2559 × 1559）</button>
</div>
<nav class="toc">%s</nav>
<div class="wrap">
%s
</div>
<script>%s</script>
<script>%s</script>
</body>
</html>""" % (FIG_RANGE[0], FIG_RANGE[1], SOFT_NAME, echarts_js, style_css, shell_css,
             SOFT_NAME, FIG_RANGE[0], FIG_RANGE[1], toc_links,
             "\n".join(html), html2canvas, export_js)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(html_doc)
    print("界面图集（%d 屏）已生成:" % TOTAL_FIGS, OUT)
    print("交付前校验：\n"
          "  1) python scripts/validate_html.py \"%s\" %d %d\n"
          "  2) 图表 init 脚本 stub 执行零异常（见技能 SKILL.md 校验节）" % (OUT, TOTAL_FIGS, FIG_RANGE[0]))


def compact_css():
    """紧凑化外壳 CSS（防放大后内容超高被 overflow 裁剪；保留全部元素）。"""
    return """
    body{margin:0;background:#e8ecf3;font-family:"Microsoft YaHei","PingFang SC",sans-serif;color:#1f1f1f}
    .page-head{max-width:1400px;margin:0 auto;padding:26px 28px 8px;color:#0b1f3a}
    .page-head h1{font-size:24px;margin:0 0 6px}
    .page-head p{color:#6b7280;font-size:14px;margin:0}
    .badges{display:flex;gap:10px;margin-top:10px}
    .badges .badge{background:#e6f4ff;color:#1677ff;border:1px solid #91caff;border-radius:12px;
      padding:4px 12px;font-size:12.5px}
    .toc{max-width:1400px;margin:14px auto 0;padding:10px 28px;background:#fff;border-radius:8px;
      display:flex;flex-wrap:wrap;gap:6px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
    .toc a{color:#1677ff;text-decoration:none;font-size:13px;padding:3px 8px;border-radius:6px}
    .toc a:hover{background:#e6f4ff}
    .wrap{width:100%;margin:18px 0 60px;padding:0;overflow-x:auto}
    .fig{margin:0 0 30px}
    .shot{position:relative;width:2559px;height:1559px;margin:0 auto;overflow:hidden;
      background:#f0f2f5;border:1px solid #d9d9d9;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.12)}
    .shot .size-tag{position:absolute;top:14px;right:18px;z-index:60;background:rgba(11,31,58,.82);
      color:#fff;font-size:13px;padding:4px 12px;border-radius:10px;letter-spacing:.5px}
    .app-scaled{position:relative;width:1706px;height:1039.33px;margin:0;
      transform:scale(1.5);transform-origin:0 0;background:#f0f2f5;overflow:hidden}
    .shot .sidebar{position:absolute;top:0;left:0;bottom:0;z-index:5}
    .shot .main{margin-left:248px;padding:18px 24px 10px}
    .shot .main .page-head{margin-bottom:8px}
    .shot .main .page-head h1{font-size:17px}
    .shot .main .page-head p{font-size:12px;margin-top:2px}
    .shot .card{margin-bottom:12px;padding:12px 16px}
    .shot .card h2{font-size:14px;margin-bottom:8px}
    .shot .card h3{font-size:12.5px;margin:8px 0 4px}
    .shot .grid2{gap:10px 14px}
    .shot .grid3{gap:8px 14px}
    .shot .field label{font-size:11px;margin-bottom:2px}
    .shot .field input,.shot .field select{padding:4px 8px;font-size:12px}
    .shot .field .unit{font-size:9.5px;margin-top:1px}
    .shot .chart{height:240px}
    .shot .chart-sm{height:200px}
    .shot .tbl th,.shot .tbl td{padding:5px 8px;font-size:12px}
    .shot .btn{padding:5px 10px;font-size:12px}
    .shot pre.code{max-height:470px;font-size:11px;line-height:1.45;padding:12px}
    .shot .status-bar{display:none}
    .status-bar-inner{position:absolute;left:0;right:0;bottom:0;height:30px;background:#fff;
      border-top:1px solid #eef0f3;display:flex;align-items:center;padding:0 16px;font-size:12px}
    .status-bar-inner .ok{color:#389e0d}
    .status-bar-inner .err{color:#cf1322}
    .term-stage{position:relative;width:1706px;height:1039.33px;display:flex;align-items:center;
      justify-content:center;padding:30px 40px;box-sizing:border-box;
      background:linear-gradient(135deg,#3a6ea5 0%,#2b5585 45%,#1e3a5f 100%)}
    .term{width:100%;max-width:1580px;border-radius:8px;overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,.45);
      background:#0b1021;color:#d6e2ff;font-family:Consolas,Menlo,monospace;font-size:15px;line-height:1.62}
    .term-bar{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;
      background:linear-gradient(#f0f2f5,#dfe3ea);color:#333;font-size:13px;
      font-family:"Microsoft YaHei",sans-serif;border-bottom:1px solid #c9cdd4}
    .term-bar .t{color:#1f2937;font-weight:600;display:flex;align-items:center;gap:8px}
    .term-bar .ctrl{display:flex;gap:6px}
    .term-bar .ctrl b{display:inline-flex;align-items:center;justify-content:center;width:24px;height:22px;
      background:#fff;border:1px solid #c9cdd4;border-radius:4px;color:#444;font-size:12px;font-weight:400}
    .term-menu{display:flex;gap:20px;padding:5px 16px;background:#182338;color:#c3d2ef;font-size:13px;
      border-bottom:1px solid #0a0f1e;font-family:"Microsoft YaHei",sans-serif}
    .term-body{padding:22px 24px;min-height:800px}
    .term-body .l{white-space:pre-wrap;margin-bottom:4px}
    .term-body .prompt{color:#7cb3ff}
    .term-body .cmd{color:#e6f0ff}
    .term-body .out{color:#b8c7e6}
    .term-body .ok{color:#5ad478}
    .term-body .err{color:#ff6b6b}
    .term-body .dim{color:#5c6f96}
    .term-note{position:absolute;bottom:12px;left:0;right:0;text-align:center;color:#dbe7ff;
      font-size:12px;font-family:"Microsoft YaHei",sans-serif;opacity:.85}
    .cap{max-width:2559px;margin:10px auto 0;font-size:14px;color:#374151;line-height:1.7}
    .cap b{color:#0b1f3a}
    .export-btn{display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 13px;border:1px solid #91caff;border-radius:6px;background:#fff;color:#1677ff;font-size:12.5px;cursor:pointer;white-space:nowrap;transition:all .15s}
    .export-btn:hover{background:#e6f4ff;border-color:#1677ff}
    .cap .export-btn{height:24px;font-size:12px;padding:0 10px;margin-left:10px;vertical-align:middle}
    .fab-export{position:fixed;right:22px;bottom:26px;z-index:300;height:38px;padding:0 18px;font-size:13.5px;border-color:#1677ff;background:#1677ff;color:#fff;box-shadow:0 4px 16px rgba(22,119,255,.35)}
    .fab-export:hover{background:#0e5fd8;border-color:#0e5fd8}
    .fab-export.working{opacity:.75;cursor:wait}
    #exportHint{position:fixed;left:50%;bottom:78px;transform:translateX(-50%);z-index:400;background:rgba(11,31,58,.92);color:#fff;font-size:13px;padding:8px 18px;border-radius:8px;display:none}
    """


if __name__ == "__main__":
    main()
