#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
extract_docx.py — 提取 Word(.docx) 文档的段落文本与（可选）嵌入图片。

用途：
  1. 说明书 docx：定位每个"图N"标题及上下文描述文字，识别正文是否嵌入真实截图。
     - 若 <w:drawing>=0：说明书中"图N"为占位框，需按描述 + 源码重建界面（默认工作流）
     - 若 <w:drawing>>0：说明书已含真实截图，可用 --images <dir> 一键解压为 image1.ext..
       imageN.ext，对应"图1~图N"；此时可直接用这些图嵌入 HTML，无需重建。
  2. 源代码 docx：输出全部代码行，便于对照前端页面（结构、字段名、按钮文案）。

用法：
  python extract_docx.py <input.docx> [output.txt] [--images <dir>]
"""
import argparse
import zipfile
import os
import re
from xml.etree import ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'


def extract(docx_path):
    """返回段落文本列表、media 文件列表、正文 drawing 数、正文按顺序引用的 media 文件名列表。"""
    with zipfile.ZipFile(docx_path) as z:
        names = z.namelist()
        if 'word/document.xml' not in names:
            raise SystemExit(f'错误：{docx_path} 不是有效的 docx（缺少 word/document.xml）')
        xml = z.read('word/document.xml').decode('utf-8', 'ignore')
        rels_xml = (z.read('word/_rels/document.xml.rels').decode('utf-8', 'ignore')
                    if 'word/_rels/document.xml.rels' in names else '')
        media = [n for n in names if n.startswith('word/media/') and not n.endswith('/')]
    embedded = xml.count('<w:drawing')

    rid_to_target = {}
    for m in re.finditer(r'<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"', rels_xml):
        rid, target = m.group(1), m.group(2)
        if target.startswith('media/'):
            rid_to_target[rid] = 'word/' + target
        elif target.startswith('image') or '/' not in target:
            rid_to_target[rid] = 'word/media/' + target.lstrip('/')

    rids_in_order = re.findall(r'r:embed="([^"]+)"', xml)
    referenced = []
    for rid in rids_in_order:
        if rid in rid_to_target:
            referenced.append(rid_to_target[rid])

    root = ET.fromstring(xml)
    body = root.find(W + 'body')
    out = []
    for p in body.iter(W + 'p'):
        texts = [t.text or '' for t in p.iter(W + 't')]
        line = ''.join(texts).strip()
        if line:
            out.append(line)
    return out, media, embedded, referenced


def extract_images(docx_path, referenced, out_dir):
    """将正文按顺序引用的图片解压到 out_dir，命名为 image1.ext..imageN.ext"""
    os.makedirs(out_dir, exist_ok=True)
    with zipfile.ZipFile(docx_path) as z:
        saved = []
        for i, mname in enumerate(referenced, start=1):
            try:
                data = z.read(mname)
                ext = os.path.splitext(mname)[1] or '.png'
                out_path = os.path.join(out_dir, f'image{i}{ext}')
                with open(out_path, 'wb') as f:
                    f.write(data)
                saved.append(out_path)
            except KeyError:
                pass
    return saved


def main():
    parser = argparse.ArgumentParser(description='提取 docx 段落文本与嵌入图片')
    parser.add_argument('docx', help='输入 docx 路径')
    parser.add_argument('output', nargs='?', default=None,
                        help='输出文本路径（默认：<docx 文件名>.txt）')
    parser.add_argument('--images', dest='images_dir', default=None,
                        help='若正文含图片，解压到该目录（命名 image1..N.ext，对应图1~图N）')
    args = parser.parse_args()

    src = args.docx
    dst = args.output or os.path.splitext(os.path.basename(src))[0] + '.txt'
    paras, media, embedded, referenced = extract(src)
    with open(dst, 'w', encoding='utf-8') as f:
        f.write('\n'.join(paras))
    print(f'✔ 已提取 {len(paras)} 个段落 -> {dst}')

    if referenced:
        print(f'  正文实际引用 {embedded} 张图片（按出现顺序对应"图1~图{embedded}"）')
        if args.images_dir:
            saved = extract_images(src, referenced, args.images_dir)
            print(f'  已解压 {len(saved)} 张图片 -> {args.images_dir}（image1.ext ... image{len(saved)}.ext）')
        else:
            print(f'  💡 提示：用 --images <dir> 一键解压所有图片（命名对应"图1~图{len(referenced)}"），'
                  '可直接嵌入 HTML，无需重建。')
    elif media:
        print(f'  word/media 含 {len(media)} 个资源但正文未引用（<w:drawing>=0）')
        print(f'  ⚠ 说明书中"图N"为占位框（"请将实际截图粘贴至此"），需按图标题+上下文+源码重建界面。')
    else:
        print('  无嵌入图片——"图N"为占位框，需按描述重建界面。')

    fig_lines = [(i, p) for i, p in enumerate(paras) if p.startswith('图') and ' ' in p[:6]]
    if fig_lines:
        print('\n-- 图标题定位（行号 | 内容）--')
        for i, p in fig_lines:
            print(f'  {i:4d} | {p[:60]}')


if __name__ == '__main__':
    main()