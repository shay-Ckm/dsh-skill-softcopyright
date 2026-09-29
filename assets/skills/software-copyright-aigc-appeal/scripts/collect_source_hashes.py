#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
collect_source_hashes.py — 遍历源程序目录，输出每个文件的相对路径、大小、代码行数、SHA-256。

用途：软著 AIGC 申诉"源程序文件目录结构及哈希值清单"证明文档的数据采集。
用法：
    python collect_source_hashes.py <源程序根目录> [--prefix <路径前缀>]

输出（tab 分隔，UTF-8）：
    <相对路径>\t<字节数>\t<行数>\t<sha256>

示例：
    python collect_source_hashes.py ./source --prefix source/
    # 只统计 .py/.html/.css/.js/.txt/.md 文本文件；其余按二进制处理（行数记 0）
"""
import argparse
import hashlib
import os
import sys

TEXT_EXTS = {'.py', '.html', '.htm', '.css', '.js', '.md', '.txt', '.json', '.yml', '.yaml', '.ini', '.cfg', '.toml'}


def file_stats(path):
    """返回 (size, lines, sha256)"""
    size = os.path.getsize(path)
    h = hashlib.sha256()
    lines = 0
    with open(path, 'rb') as fh:
        while True:
            chunk = fh.read(65536)
            if not chunk:
                break
            h.update(chunk)
    ext = os.path.splitext(path)[1].lower()
    if ext in TEXT_EXTS:
        try:
            with open(path, 'r', encoding='utf-8', errors='replace') as fh:
                lines = len(fh.readlines())
        except Exception:
            lines = 0
    return size, lines, h.hexdigest()


def main():
    ap = argparse.ArgumentParser(description='遍历目录输出文件哈希与统计')
    ap.add_argument('root', help='源程序根目录')
    ap.add_argument('--prefix', default='', help='输出相对路径前缀（如 source/）')
    args = ap.parse_args()

    if not os.path.isdir(args.root):
        print(f'错误：目录不存在 {args.root}', file=sys.stderr)
        sys.exit(1)

    files = []
    for dirpath, dirnames, filenames in os.walk(args.root):
        # 跳过常见非源码目录
        dirnames[:] = [d for d in dirnames if d not in ('.git', '__pycache__', '.venv', 'venv', 'node_modules', '.idea', '.vscode')]
        for fn in sorted(filenames):
            if fn.startswith('~$'):  # Office 临时锁文件
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, args.root).replace('\\', '/')
            size, lines, digest = file_stats(full)
            files.append((args.prefix + rel, size, lines, digest))

    files.sort(key=lambda x: x[0])
    total_lines = 0
    total_bytes = 0
    for rel, size, lines, digest in files:
        print(f'{rel}\t{size}\t{lines}\t{digest}')
        total_lines += lines
        total_bytes += size
    print(f'# TOTAL_FILES={len(files)} TOTAL_LINES={total_lines} TOTAL_BYTES={total_bytes}', file=sys.stderr)


if __name__ == '__main__':
    main()
