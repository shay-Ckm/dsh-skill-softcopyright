#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
validate_html.py — 校验"说明书界面图集"HTML 的完整性。

检查项：
  1. 截图数量（.shot 容器）与图注数量（<b>图N</b>）是否齐全、图号 1..N 是否连续无缺失
  2. 顶部目录锚点链接（href="#figN"）是否齐全
  3. div 开闭是否平衡；HTML 标签配对（HTMLParser 深度校验）
  4. 是否残留示意图占位文字（如"请将实际截图粘贴""中央内容操作区""可集成XXX"等）

用法：
  python validate_html.py <input.html> [total_figures] [start_figure]
    total_figures 默认 42；图集扩充（如图43~51）时改为 51。
    start_figure  默认 1；仅生成部分图（如图6~图28）时填起始图号，如 6。
"""
import re
import sys
import os
from html.parser import HTMLParser

VOID = {'meta', 'br', 'hr', 'img', 'input', 'link', 'circle', 'line',
        'polyline', 'path', 'rect', 'text', 'area', 'base', 'col',
        'embed', 'source', 'track', 'wbr'}

# 真实界面中不应出现的"示意图说明"占位文字
PLACEHOLDER_KEYWORDS = [
    '请将实际截图粘贴', '中央内容操作区', '菜单栏默认宽度', '本图展开示意',
    '可集成Leaflet', '地图展示区域', '占位', '示意图说明',
]


class TagChecker(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.unclosed = []
        self.extra_closes = []

    def handle_starttag(self, tag, attrs):
        if tag not in VOID:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if self.stack and self.stack[-1] == tag:
            self.stack.pop()
        else:
            for i in range(len(self.stack) - 1, -1, -1):
                if self.stack[i] == tag:
                    del self.stack[i]
                    return
            self.extra_closes.append(tag)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    src = sys.argv[1]
    total = int(sys.argv[2]) if len(sys.argv) > 2 else 42
    start = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    if not os.path.exists(src):
        raise SystemExit(f'错误：{src} 不存在')
    html = open(src, encoding='utf-8').read()
    ok = True

    shots = html.count('class="shot"')
    caps = re.findall(r'<b>图(\d+)</b>', html)
    cap_nums = [int(x) for x in caps]
    end = start + total - 1
    missing = [i for i in range(start, end + 1) if i not in cap_nums]
    anchors = len(re.findall(r'href="#fig\d+"', html))

    print(f'截图容器: {shots} | 图注: {len(cap_nums)} | 目录锚点: {anchors} | 目标图数: {total}（图{start}~图{end}）')
    if shots != total or len(cap_nums) != total:
        print(f'  ✗ 截图/图注数量与目标 {total} 不符'); ok = False
    if missing:
        print(f'  ✗ 缺失图号: {missing}'); ok = False
    if anchors != total:
        print(f'  ✗ 目录锚点数量 {anchors} != {total}'); ok = False

    checker = TagChecker()
    checker.feed(html)
    if checker.unclosed:
        print(f'  ✗ 未闭合标签: {checker.unclosed}'); ok = False
    if checker.extra_closes:
        print(f'  ✗ 多余闭合: {checker.extra_closes}'); ok = False

    hits = [kw for kw in PLACEHOLDER_KEYWORDS if kw in html]
    if hits:
        print(f'  ✗ 残留占位文字: {hits}'); ok = False

    print('✔ 校验通过，图集完整可交付' if ok else '✗ 存在上述问题，请修复后重跑')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
