#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
源码包打包工具：为 Python 项目生成可分发的源码包。
- 生成 Windows 友好整包 zip（自动排除运行时/缓存/第三方压缩库，含《安装与启动说明.md》）
- 若项目已有 pyproject.toml + MANIFEST.in，同时构建 sdist tar.gz

用法：
  python build_src_package.py <项目目录> [--out <输出目录>] [--name <包名>] [--version 1.0.0]
  python build_src_package.py <项目目录> --sdist-only

排除规则（默认）：__pycache__/.venv/.workbuddy/node_modules/dist/build/uploads/.git
  records.db *.log *.min.js 及项目内 .workbuddy 等。
生成《安装与启动说明.md》骨架：环境要求/安装（清华镜像）/启动/FAQ/目录结构。
"""
import os
import sys
import zipfile
import datetime

EXCLUDE_DIRS = {"__pycache__", ".venv", ".workbuddy", "node_modules", "dist", "build",
                "uploads", ".git", ".idea", "venv", "env", "__pycache__"}
EXCLUDE_PATTERNS = ("records.db", ".log", ".min.js", ".pyc", ".DS_Store", "~$")


def _is_tmp_dir(name):
    """临时校验目录（tmp_xxx / _tmp 等）一律排除，避免混入交付包。"""
    return name.startswith("tmp_") or name.startswith("_tmp")


def collect(root):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames
                       if d not in EXCLUDE_DIRS and not _is_tmp_dir(d)]
        for fn in sorted(filenames):
            if any(fn.endswith(p) or fn == p for p in EXCLUDE_PATTERNS):
                continue
            out.append(os.path.join(dirpath, fn))
    return out


def make_readme(root, name, ver):
    return """# %s V%s 安装与启动说明

## 环境要求
- 操作系统：Windows 10/11、Linux、macOS
- Python 3.10 及以上

## 安装
1. 解压本包至任意目录；
2. 打开命令行进入目录，安装依赖（推荐清华镜像）：
   python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

## 启动
python app.py        # Windows 亦可双击 start.bat
浏览器访问 http://127.0.0.1:5000

## 常见问题
- 提示 No module named 'xxx'：依赖未装，执行上面的 pip 命令。
- start.bat 报乱码错误：说明脚本被非 ASCII 编辑器改动，请从本包重新解压一份（原版为纯 ASCII）。
- 端口被占用：netstat -ano | findstr :5000 查 PID 后 taskkill /PID <PID> /F。

## 目录结构
见包内源码目录（核心算法位于 core/ 子包）。
""" % (name, ver)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    root = os.path.abspath(sys.argv[1])
    out_dir = None
    name = os.path.basename(root)
    ver = "1.0.0"
    sdist_only = False
    for i, a in enumerate(sys.argv):
        if a == "--out":
            out_dir = sys.argv[i + 1]
        if a == "--name":
            name = sys.argv[i + 1]
        if a == "--version":
            ver = sys.argv[i + 1]
        if a == "--sdist-only":
            sdist_only = True
    out_dir = out_dir or os.path.join(root, "dist")
    os.makedirs(out_dir, exist_ok=True)

    files = collect(root)
    top = "%s-v%s-src" % (name, ver)
    readme_txt = make_readme(root, name, ver)
    readme_path = os.path.join(root, "安装与启动说明.md")
    if not os.path.exists(readme_path):
        with open(readme_path, "w", encoding="utf-8") as f:
            f.write(readme_txt)

    if not sdist_only:
        zpath = os.path.join(out_dir, "%s-v%s-src.zip" % (name, ver))
        readme_abs = os.path.abspath(readme_path)
        # collect() 在写入说明文件之前执行。若上一次打包已经把说明留在项目里，
        # 它会被收进 files，而下面又显式写一次 —— 同一路径产生**重复条目**
        # （zip 条目数比实际文件多 1）。所以这里先把它剔除，只写一次。
        included = [fp for fp in files if os.path.abspath(fp) != readme_abs]
        with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
            for fp in included:
                rel = os.path.relpath(fp, root).replace(os.sep, "/")
                z.write(fp, "%s/%s" % (top, rel))
            z.write(readme_path, "%s/安装与启动说明.md" % top)
        print("已生成 zip:", zpath, "| 文件数:", len(included) + 1)

    # sdist（若存在打包配置）
    if os.path.exists(os.path.join(root, "pyproject.toml")):
        import subprocess
        r = subprocess.run([sys.executable, "-m", "build", "--sdist", "--outdir", out_dir],
                           cwd=root, capture_output=True, text=True)
        if r.returncode == 0:
            print("已生成 sdist 到:", out_dir)
        else:
            print("sdist 构建失败（可先 pip install build）：", r.stderr[-300:])
    elif not sdist_only:
        print("提示：项目无 pyproject.toml，跳过 sdist；如需标准源码包请先创建打包配置。")


if __name__ == "__main__":
    main()
