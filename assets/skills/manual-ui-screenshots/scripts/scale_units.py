#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scale_units.py — 将界面图集 HTML 中全部容器查询单位（cqw/cqh）数值统一乘以系数。

用途：整体放大 / 缩小界面截图。例如系数 1.5 可将截图内所有字号、按钮、
表格、间距、图表高度等比放大 150%（布局不变形，容器仍保持 2559:1559 比例）。

用法：
  python scale_units.py <input.html> [factor] [output.html]
    factor  默认 1.5；不传 output 时直接覆盖原文件。

原理：本技能所有截图内部尺寸均使用容器查询单位（cqw/cqh，基于 .shot 容器
宽度/高度），因此只需对数值整体缩放即可实现"整图等比缩放"。
"""
import re
import sys
import os


def scale_file(src, factor, dst=None):
    html = open(src, encoding='utf-8').read()

    def repl(m):
        num = float(m.group(1))
        return f'{num * factor:g}{m.group(2)}'

    new = re.sub(r'([0-9]*\.?[0-9]+)(cqw|cqh)', repl, html)
    target = dst or src
    open(target, 'w', encoding='utf-8').write(new)
    n = len(re.findall(r'[0-9]*\.?[0-9]+(?:cqw|cqh)', new))
    print(f'✔ 已将 {n} 个 cqw/cqh 单位乘以 {factor} -> {target}')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    src = sys.argv[1]
    factor = float(sys.argv[2]) if len(sys.argv) > 2 else 1.5
    dst = sys.argv[3] if len(sys.argv) > 3 else None
    if not os.path.exists(src):
        raise SystemExit(f'错误：{src} 不存在')
    scale_file(src, factor, dst)
