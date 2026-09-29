#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""界面图集 HTML 静态一致性校验（与 validate_html.py 互补）。

校验项：
1. 截图容器数（.shot 真实还原路径 / .screen 手绘路径）与图注数一致、编号连续；
2. 图表容器 div（id=f\d+_[a-z]+ 或 g\d+[ab]?）与 echarts 初始化引用一一匹配
   （防"容器存在但无初始化脚本"导致图表空白）；
3. 2559×1559 尺寸声明存在。

用法：python scripts/validate_atlas.py <html路径> [预期图数]
"""

import re
import sys


def main():
    args = sys.argv[1:]
    if not args:
        print("用法: python scripts/validate_atlas.py <html> [预期图数]")
        return 1
    path = args[0]
    expect = int(args[1]) if len(args) > 1 else 0
    html = open(path, encoding="utf-8").read()

    # 容器：兼容两种路径
    screens = len(re.findall(r'class="shot"', html)) + len(re.findall(r'class="screen"', html))
    # 图注：<b>图N</b> 或 class="tag">图 N
    caps = re.findall(r"<b>图\s*(\d+)</b>", html)
    tags = re.findall(r'class="tag">图\s*(\d+)', html)
    nums = sorted({int(x) for x in caps + tags})
    cont = nums == list(range(1, max(nums) + 1)) if nums else False

    # 图表容器与初始化引用
    divs = set(re.findall(r'id="(f\d+_[a-z]+|g\d+[ab]?)"', html))
    refs = set(re.findall(r"getElementById\('(f\d+_[a-z]+|g\d+[ab]?)'\)", html))
    missing = sorted(divs - refs)
    orphan = sorted(refs - divs)

    size_ok = "width:2559px" in html and "height:1559px" in html

    print("== 界面图集静态校验 ==")
    print("  截图容器数:", screens, "| 图注数:", len(nums), "| 编号连续:", cont)
    if expect:
        print("  预期图数:", expect, "| 实际:", screens, "| 一致:", screens == expect)
    print("  图表 div 数:", len(divs), "| init 引用数:", len(refs))
    print("  图表未初始化:", missing, "| 无容器初始化:", orphan)
    print("  2559x1559 尺寸:", size_ok)

    ok = (screens == len(nums) and cont and not missing and not orphan and size_ok
          and (not expect or screens == expect))
    print("结论:", "通过" if ok else "未通过")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
