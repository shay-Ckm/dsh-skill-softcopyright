#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""软著 AIGC 申诉证明文档 HTML 生成器（通用版）。

输入：
  1. 哈希 tsv（collect_source_hashes.py 输出）：<路径>\t<字节>\t<行数>\t<sha256>
  2. 配置文件 JSON（--config）：软件名/版本/编制日期/著作权人占位/文件数/总行数覆盖/逐文件功能说明

输出：
  <out_prefix>_doc1_hashes.html   —— 源程序文件目录结构及哈希值清单
  <out_prefix>_doc2_log.html      —— 项目研发日志（骨架：阶段总览表 + 分阶段记录表占位，
                                     研发记录内容按 SKILL.md 第 1/7 步规则手工填充）

用法：
  python gen_proof_html.py <hashes.tsv> <out_prefix> --config config.json

配置 JSON 示例：
{
  "software": "XX系统", "version": "V1.0.0", "date": "2026 年 8 月 17 日",
  "owner_field": true,                       # 是否生成著作权人书签占位
  "total_files": 14, "total_lines_override": null,   # 手动覆盖总行数（不推荐，默认按 tsv 求和）
  "lines_override": {"source/start.bat": 41},        # 脚本对非文本扩展名记 0 行，此处补真实行数
  "file_desc": {"source/app.py": "Flask 主程序：..."} # 逐文件功能说明
}

注意（踩坑）：
- HTML 模板内 CSS 的 % 写单个 %（勿写 %%）；动态数据用 @@占位符@@ + .replace() 填充。
- 生成后检查 HTML 无 %% 残留再转 docx，否则 html-to-docx 静默丢内容。
"""
import argparse
import json
import os
import sys

# ---------------- 读取哈希 tsv ----------------
def load_hashes(tsv, lines_override):
    rows = []
    with open(tsv, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            rel, size, lines, sha = line.split("\t")
            lines = int(lines_override.get(rel, int(lines)))
            rows.append((rel, int(size), lines, sha))
    return rows


# ---------------- 文档一：哈希清单 ----------------
def build_doc1(cfg, rows):
    total_files = cfg.get("total_files") or len(rows)
    total_lines = cfg.get("total_lines_override") or sum(r[2] for r in rows)
    total_bytes = sum(r[1] for r in rows)
    owner_cell = ('<span data-docx-field="copyright_owner" '
                  'data-placeholder="（请填写著作权人名称）"></span>' if cfg.get("owner_field")
                  else "（请填写著作权人名称）")

    hash_rows = "".join(
        "<tr><td>%d</td><td class='mono'>%s</td><td class='num'>%d</td>"
        "<td class='num'>%d</td><td class='mono sha'>%s</td></tr>"
        % (i, rel, size, lines, sha)
        for i, (rel, size, lines, sha) in enumerate(rows, 1))
    desc_rows = "".join(
        "<tr><td class='num'>%d</td><td class='mono'>%s</td><td>%s</td></tr>"
        % (i, rel, cfg.get("file_desc", {}).get(rel, "—"))
        for i, (rel, size, lines, sha) in enumerate(rows, 1))

    tree = _tree_html([r[0] for r in rows])

    html = """<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>源程序文件目录结构及哈希值清单</title></head>
<body>
<section>
<style>
body { font-family: '宋体', SimSun, serif; font-size: 12pt; line-height: 1.6; color: #000; margin: 2.2cm 2.4cm; }
h1 { text-align: center; font-size: 18pt; font-weight: bold; margin: 18pt 0 6pt; }
h2 { font-size: 14pt; font-weight: bold; margin: 16pt 0 8pt; }
p  { margin: 6pt 0; text-indent: 0; }
table { border-collapse: collapse; width: 100%; margin: 8pt 0 14pt; font-size: 10.5pt; }
th, td { border: 1px solid #000; padding: 4pt 6pt; text-align: left; vertical-align: top; }
th { background: #f2f2f2; font-weight: bold; }
.mono { font-family: 'Courier New', monospace; font-size: 10pt; }
.num { text-align: right; }
.sha { word-break: break-all; }
.sub { text-align: center; font-size: 14pt; margin-bottom: 14pt; }
pre { font-family: 'Courier New', monospace; font-size: 10pt; background: #f7f7f7; border: 1px solid #ccc; padding: 8pt; line-height: 1.45; }
.note { font-size: 10.5pt; margin: 6pt 0; }
</style>
<h1>源程序文件目录结构及哈希值清单</h1>
<p class="sub">《@@SOFTWARE@@》</p>

<h2>一、基本信息</h2>
<table>
<tr><th style="width:24%">项目</th><th>内容</th></tr>
<tr><td>软件名称</td><td>@@SOFTWARE@@</td></tr>
<tr><td>软件版本</td><td>@@VERSION@@</td></tr>
<tr><td>著作权人</td><td>@@OWNER@@</td></tr>
<tr><td>编制日期</td><td>@@DATE@@</td></tr>
<tr><td>源程序文件总数</td><td class="num">@@FILES@@ 个</td></tr>
<tr><td>源程序代码总行数</td><td class="num">@@LINES@@ 行</td></tr>
<tr><td>源程序总字节数</td><td class="num">@@BYTES@@ 字节</td></tr>
<tr><td>哈希算法</td><td>SHA-256（对文件原始字节逐块计算）</td></tr>
</table>

<h2>二、源程序文件目录结构</h2>
<pre>@@TREE@@</pre>

<h2>三、源程序文件哈希值明细</h2>
<p class="note">下表列出全部 @@FILES@@ 个源程序文件的相对路径、文件大小（字节）、代码行数与 SHA-256 哈希值。哈希值由文件原始内容计算，任何一行代码的修改都会导致对应文件的哈希值改变，可据此核验提交审查的源程序与本次登记的源程序一致。</p>
<table>
<thead><tr><th style="width:5%">序号</th><th style="width:32%">文件路径</th><th style="width:10%">大小(字节)</th><th style="width:10%">代码行数</th><th style="width:43%">SHA-256 哈希值</th></tr></thead>
<tbody>@@HASHROWS@@</tbody>
</table>

<h2>四、源程序文件功能说明</h2>
<p class="note">各文件功能与《@@SOFTWARE@@ 源代码文档》及《使用说明书》所描述功能一一对应，可相互印证。</p>
<table>
<thead><tr><th style="width:5%">序号</th><th style="width:30%">文件路径</th><th>功能说明</th></tr></thead>
<tbody>@@DESCROWS@@</tbody>
</table>

<h2>五、完整性校验说明</h2>
<p>1. 上述 @@FILES@@ 个文件是该软件全部手写源代码，不包含第三方压缩库（如 *.min.js）、运行时生成文件（records.db）与打包产物（dist/）；</p>
<p>2. 每个文件的 SHA-256 哈希值由文件原始字节流计算得出，可用于交付源程序与登记源程序的一致性校验；</p>
<p>3. 源程序与《使用说明书》《源代码文档》中的功能描述一一对应，每个核心功能模块都能在上述文件中找到对应代码。</p>
</section>
</body>
</html>"""
    return (html.replace("@@SOFTWARE@@", cfg["software"])
                .replace("@@VERSION@@", cfg.get("version", "V1.0.0"))
                .replace("@@OWNER@@", owner_cell)
                .replace("@@DATE@@", cfg.get("date", ""))
                .replace("@@FILES@@", str(total_files))
                .replace("@@LINES@@", str(total_lines))
                .replace("@@BYTES@@", str(total_bytes))
                .replace("@@TREE@@", tree)
                .replace("@@HASHROWS@@", hash_rows)
                .replace("@@DESCROWS@@", desc_rows))


# ---------------- 文档二：研发日志骨架 ----------------
def build_doc2(cfg):
    owner_cell = ('<span data-docx-field="copyright_owner" '
                  'data-placeholder="（请填写著作权人名称）"></span>' if cfg.get("owner_field")
                  else "（请填写著作权人名称）")
    html = """<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>项目研发日志</title></head>
<body>
<section>
<style>
body { font-family: '宋体', SimSun, serif; font-size: 12pt; line-height: 1.6; color: #000; margin: 2.2cm 2.4cm; }
h1 { text-align: center; font-size: 18pt; font-weight: bold; margin: 18pt 0 6pt; }
h2 { font-size: 14pt; font-weight: bold; margin: 16pt 0 8pt; }
p  { margin: 6pt 0; }
table { border-collapse: collapse; width: 100%; margin: 8pt 0 14pt; font-size: 10.5pt; }
th, td { border: 1px solid #000; padding: 4pt 6pt; text-align: left; vertical-align: top; }
th { background: #f2f2f2; font-weight: bold; }
.mono { font-family: 'Courier New', monospace; font-size: 10pt; }
.num { text-align: right; }
.sub { text-align: center; font-size: 14pt; margin-bottom: 14pt; }
</style>
<h1>项目研发日志</h1>
<p class="sub">《@@SOFTWARE@@》@@VERSION@@</p>

<h2>一、研发基本信息</h2>
<table>
<tr><th style="width:24%">项目</th><th>内容</th></tr>
<tr><td>软件名称</td><td>@@SOFTWARE@@</td></tr>
<tr><td>软件版本</td><td>@@VERSION@@</td></tr>
<tr><td>著作权人</td><td>@@OWNER@@</td></tr>
<tr><td>研发周期</td><td>@@DEV_PERIOD@@</td></tr>
<tr><td>研发阶段数</td><td class="num">@@PHASES@@ 个阶段</td></tr>
<tr><td>代码规模</td><td class="num">@@FILES@@ 个源文件，@@LINES@@ 行代码</td></tr>
<tr><td>技术栈</td><td>@@TECHSTACK@@</td></tr>
</table>

<h2>二、研发阶段总览</h2>
<table>
<thead><tr><th style="width:8%">阶段</th><th style="width:22%">时间</th><th style="width:35%">阶段目标</th><th>主要产出</th></tr></thead>
<tbody>
<!-- TODO: 按实际阶段填写，示例行如下，可复制扩展 -->
<tr><td class="num">1</td><td>2026.XX.XX - 2026.XX.XX</td><td>阶段目标</td><td>主要产出</td></tr>
</tbody>
</table>

<h2>三、分阶段详细研发记录</h2>
<!-- TODO: 每阶段一个 <h3> + 日期/工作内容表。要点：
     1) 内容基于真实源码设计决策（函数名/接口路径/配置项/数据表），可交叉核验；
     2) 每条记录写成"做决策/工程师口吻"，禁止"实现 xxx"开头模板句式（见 SKILL.md 第 7 步）；
     3) 写入开发过程痕迹与取舍。 -->
<p>（按 SKILL.md 第 1、7 步规则逐阶段填写）</p>

<h2>四、研发过程中解决的关键问题</h2>
<table>
<thead><tr><th style="width:6%">序号</th><th style="width:22%">问题现象</th><th style="width:26%">根因分析</th><th>解决方案</th></tr></thead>
<tbody>
<!-- TODO: 填写 5~8 条真实问题/根因/方案（写具体函数名） -->
</tbody>
</table>

<h2>五、测试验证记录</h2>
<table>
<thead><tr><th style="width:8%">序号</th><th style="width:26%">测试项</th><th style="width:14%">规模</th><th>结果</th></tr></thead>
<tbody>
<!-- TODO: 填写真实测试项与结果 -->
</tbody>
</table>

<h2>六、研发总结</h2>
<p>（总结研发过程与成果，工程师口吻，避免模板套话）</p>
</section>
</body>
</html>"""
    return (html.replace("@@SOFTWARE@@", cfg["software"])
                .replace("@@VERSION@@", cfg.get("version", "V1.0.0"))
                .replace("@@OWNER@@", owner_cell)
                .replace("@@DEV_PERIOD@@", cfg.get("dev_period", "（请填写研发周期）"))
                .replace("@@PHASES@@", str(cfg.get("phases", 6)))
                .replace("@@FILES@@", str(cfg.get("total_files", "")))
                .replace("@@LINES@@", str(cfg.get("total_lines_override") or "（请填写）"))
                .replace("@@TECHSTACK@@", cfg.get("techstack", "（请填写技术栈）")))


# ---------------- 目录树 ----------------
def _tree_html(paths):
    """由文件路径列表生成 ASCII 目录树（按路径层级）"""
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
            last = (i == len(entries) - 1)
            conn = "└── " if last else "├── "
            lines.append(prefix + conn + name)
            if isinstance(child, dict):
                walk(child, prefix + ("    " if last else "│   "))
    walk(root, "")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tsv", help="collect_source_hashes.py 输出的 tsv")
    ap.add_argument("out_prefix", help="输出 HTML 前缀（如 .workbuddy/proof）")
    ap.add_argument("--config", required=True, help="配置文件 JSON")
    args = ap.parse_args()

    cfg = json.load(open(args.config, encoding="utf-8"))
    rows = load_hashes(args.tsv, cfg.get("lines_override", {}))
    if not rows:
        print("错误：tsv 为空", file=sys.stderr)
        sys.exit(1)

    # 总行数：优先配置覆盖（不推荐），否则按 tsv 实测求和
    if cfg.get("total_lines_override") is None:
        cfg["total_lines_override"] = sum(r[2] for r in rows)
    if cfg.get("total_files") is None:
        cfg["total_files"] = len(rows)

    doc1 = build_doc1(cfg, rows)
    doc2 = build_doc2(cfg)
    # 防踩坑：%% 残留检查
    for name, html in (("doc1", doc1), ("doc2", doc2)):
        if "%%" in html:
            print("警告：%s 含 %% 残留，html-to-docx 会静默丢内容，请修复" % name)

    with open(args.out_prefix + "_doc1_hashes.html", "w", encoding="utf-8") as f:
        f.write(doc1)
    with open(args.out_prefix + "_doc2_log.html", "w", encoding="utf-8") as f:
        f.write(doc2)
    print("已生成: %s_doc1_hashes.html / %s_doc2_log.html" % (args.out_prefix, args.out_prefix))
    print("文件数:", len(rows), "| 总行数:", cfg["total_lines_override"], "| 总字节:", sum(r[1] for r in rows))


if __name__ == "__main__":
    main()
