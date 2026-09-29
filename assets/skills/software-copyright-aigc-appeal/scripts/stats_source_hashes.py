#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""软著 AIGC 申诉：源程序哈希统计（与 gen_src_docx 收录范围/行数口径完全一致）。

- 收录范围 = 《源代码文档》封面 29 个文件（排除 dist/egg-info/tmp_*/docs/ 等）；
- 行数口径 = splitlines 后去掉末尾空行的行数（与 gen_src_docx total 一致）；
- 输出 tsv：<相对路径>\t<字节>\t<行数>\t<sha256>，末尾打印 TOTAL 校验。

用法：python stats_source_hashes.py <根目录>
"""
import hashlib
import os
import sys

# 与 gen_src_docx EXCLUDE 一致 + 项目特有
EXCLUDE_DIRS = {"__pycache__", ".venv", ".workbuddy", "node_modules", "dist", "build",
                "uploads", ".git", ".idea", "venv", "env", "docs", "img",
                "foc_mil_stm32.egg-info", "tmp_smoke", "tmp_skillcheck",
                "fault_decision_agent.egg-info"}
SKIP_FILES = {"records.db", ".DS_Store", "安装与启动说明.md", "需求规格说明书_V1.0草案.md"}
KEEP_EXTS = (".py", ".html", ".css", ".bat", ".toml", ".txt", ".in", ".js",
             ".json", ".yaml", ".yml", ".sh", ".ts", ".vue", ".sql")


def stats(path):
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        lines = f.read().splitlines()
    while lines and lines[-1].strip() == "":
        lines.pop()
    return size, len(lines), digest


def main():
    root = sys.argv[1]
    rows = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for fn in sorted(filenames):
            if fn in SKIP_FILES or fn.endswith(".min.js"):
                continue
            if not fn.endswith(KEEP_EXTS):
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root).replace("\\", "/")
            size, lines, sha = stats(full)
            rows.append((rel, size, lines, sha))
    rows.sort(key=lambda x: x[0])
    total_lines = sum(r[2] for r in rows)
    total_bytes = sum(r[1] for r in rows)
    for rel, size, lines, sha in rows:
        print("%s\t%d\t%d\t%s" % (rel, size, lines, sha))
    print("# FILES=%d LINES=%d BYTES=%d" % (len(rows), total_lines, total_bytes),
          file=sys.stderr)


if __name__ == "__main__":
    main()
