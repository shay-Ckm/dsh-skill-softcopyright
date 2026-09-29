# -*- coding: utf-8 -*-
"""
真实运行界面截图骨架（首选路径，软著图集 / 说明书图位用）

与"按说明书重建 HTML 界面"的区别：本路径**驱动真实运行中的软件**逐屏截图，
数据是真实计算结果，界面是真实 DOM —— 审查方无法质疑"示意拼贴"。

产出：docs/atlas/figNN.png，每张精确 2559 × 1559。

快速开始
--------
1. 先启动被截图软件（如 `python app.py`，记下端口）
2. 复制本文件到项目 scripts/，按「配置区」填 BASE / SCREENS
3. `.venv/Scripts/python.exe scripts/shoot_real_ui.py`
4. 末尾自动做 md5 唯一性校验；有重复项按提示重拍（见下"重复截图"）

环境对策（实测坑，逐条都有代价）
--------------------------------
- **黑屏**：headless 下必须 `--disable-gpu --disable-software-rasterizer`，
  并用 `executable_path` 指向**本机真实 Chrome**（`C:/Program Files/Google/Chrome/Application/chrome.exe`）；
  用 Playwright 自带 chromium 或无头 GPU 会整屏全黑、且截图文件非空（肉眼才看得出）。
- **代理拦截**：系统代理会把 `127.0.0.1` 请求截走返回 502（页面白屏、boot 失败）。
  脚本里已 pop 掉 *_proxy 并设 NO_PROXY；若仍白屏，检查 `os.environ` 是否残留代理变量。
- **会话不持久**：CLI 型浏览器工具（agent-browser）命令之间会重置页面，
  必须像本脚本这样**单进程一次跑完所有屏**，不要逐条命令截图。
- **重复截图**：视口够高时页面根本不滚动，拍两次得到同一张图（同 md5）。
  对策：正文面板统一注入 `body{zoom:1.5}` 让内容变高，再滚顶/滚底各拍一张；
  首页/总览图用 100% 缩放拍"整体布局"，与后续细节图视角区分。
- **成对图必须内容互补**：每屏截图后打印页面高/视口高/实际滚动位置自检。

文件名与图号必须与说明书「图 N」一一对应（同号同题），屏数 = 图位数。
"""
import hashlib
import os
import sys
import time

from playwright.sync_api import sync_playwright

# ============================== 配置区（按项目替换） ==============================
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "atlas")
TMP = os.path.join(ROOT, "scripts", "_atlas_tmp")
CHROME = os.environ.get("CHROME_PATH", r"C:\Program Files\Google\Chrome\Application\chrome.exe")
BASE = "http://127.0.0.1:5090"          # 被截图软件的地址（真实运行中）
W, H = 2559, 1559                        # 固定截图尺寸，勿改
DEVICE_SCALE = 1

# 每屏：图号 / 面板 nav 选择器 / 触发按钮 / 缩放 / 滚动位置
# clk(sel) 与 js(code) 二选一或多选，按顺序在页面内执行
SCREENS = [
    # 图 1~3 独立窗口（资源管理器 / 命令行），走独立渲染，不套软件布局
    {"n": 1, "kind": "wintml", "fn": "explorer_html"},
    {"n": 2, "kind": "wintml", "fn": "terminal_install_html"},
    {"n": 3, "kind": "wintml", "fn": "terminal_start_html"},
    # 图 4 主界面总体布局（100% 缩放，整屏可见侧栏/顶栏/内容区）
    {"n": 4, "kind": "app", "js": "", "zoom": 1.0, "scroll": "top", "wait": 2200},
    # 图 5~ 各功能面板：默认 150% 缩放 + 滚顶/滚底成对
    {"n": 5, "kind": "app", "js": "document.querySelector('.nav-item[data-panel=perception]').click();"
                                  "document.getElementById('pcRun').click();",
     "zoom": 1.5, "scroll": "top", "wait": 5000, "title": "感知诊断面板"},
    {"n": 6, "kind": "app", "js": "", "zoom": 1.5, "scroll": "bottom", "wait": 800, "title": "指标细节"},
    # TODO: 按说明书图位清单继续补全（每屏一项），图号必须连续且=图位数
]

# 独立窗口 HTML（终端/资源管理器类图位）：每个函数返回完整 HTML 字符串
# 硬约束：① 独立窗口观感（标题栏+菜单栏），禁止套软件侧栏布局
#         ② 命令行内容取自**真实命令输出**（先跑一遍 pip/启动命令，把 stdout 贴进 HTML）
#         ③ 路径用真实 Windows 路径（C:\Users\...），勿写 C://... 假路径
WIN_CSS = """
*{margin:0;padding:0;box-sizing:border-box}
body{width:2559px;height:1559px;font-family:"Microsoft YaHei",sans-serif;
     background:linear-gradient(140deg,#1b5aa8 0%,#123a6b 45%,#0a1f3d 100%);
     display:flex;align-items:center;justify-content:center;overflow:hidden}
.win{width:1980px;background:#f3f3f3;border:1px solid #9aa5b1;border-radius:10px;
     box-shadow:0 30px 80px rgba(0,0,0,.45);overflow:hidden}
.term{width:1980px;background:#0c0c0c;border:1px solid #3a3a3a;border-radius:10px;
     box-shadow:0 30px 80px rgba(0,0,0,.5);overflow:hidden}
.bar{height:54px;background:linear-gradient(180deg,#fdfdfd,#eaeaea);border-bottom:1px solid #d9d9d9;
     display:flex;align-items:center;gap:16px;padding:0 20px}
.term .bar{background:linear-gradient(180deg,#2b2b2b,#1f1f1f);border-bottom:1px solid #111}
.bar .ttl{font-size:19px;color:#333}
.term .bar .ttl{color:#e8e8e8}
.screen{height:1018px;background:#0c0c0c;padding:18px 24px;font-family:Consolas,"Courier New",monospace;
     font-size:17.5px;line-height:1.62;color:#d6d6d6;overflow:hidden}
.prompt{color:#7fd6a0}.cmd{color:#ffffff}.ok{color:#5ee08a}.warn{color:#ffd166}.err{color:#ff7b7b}
.dim{color:#8b8b8b}
"""


def explorer_html():
    """解压目录截图：类容列表用真实文件名/大小（取自发行包目录树）。"""
    return "<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'><style>%s</style></head><body>" \
           "<div class='win'><div class='bar'><div class='ttl'>软件安装目录</div></div>" \
           "<div class='screen' style='background:#fff;color:#2b3a4a'>TODO: 资源管理器列表（真实文件名/大小/日期）</div>" \
           "</div></body></html>" % WIN_CSS


def terminal_install_html():
    """依赖安装截图：把真实 `pip install -r requirements.txt` 输出贴进来。"""
    return "<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'><style>%s</style></head><body>" \
           "<div class='term'><div class='bar'><div class='ttl'>命令提示符</div></div>" \
           "<div class='screen'><div class='prompt'>C:\\Users\\L\\Desktop\\软件名-V1.0&gt;</div>" \
           "<div class='cmd'>pip install -r requirements.txt</div>" \
           "<div class='dim'>TODO: 真实 pip 输出（Looking in / Downloading / Successfully installed）</div>" \
           "</div></div></body></html>" % WIN_CSS


def terminal_start_html():
    """启动截图：把真实启动横幅（含访问地址）贴进来。"""
    return "<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'><style>%s</style></head><body>" \
           "<div class='term'><div class='bar'><div class='ttl'>命令提示符</div></div>" \
           "<div class='screen'><div class='cmd'>start.bat</div>" \
           "<div class='ok'>TODO: 真实启动输出（依赖自检 / 服务地址 / 就绪提示）</div>" \
           "</div></div></body></html>" % WIN_CSS


HTML_FNS = {"explorer_html": explorer_html,
            "terminal_install_html": terminal_install_html,
            "terminal_start_html": terminal_start_html}
# ================================================================================


def shot(page, n):
    path = os.path.join(OUT, "fig%02d.png" % n)
    page.screenshot(path=path)
    print("  图%02d -> %s (%.0f KB)" % (n, os.path.basename(path), os.path.getsize(path) / 1024.0))
    return path


def scroll_top(page):
    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(450)


def scroll_bottom(page):
    """滚到底部并回读滚动位置/页面高/视口高——用于确认"下半屏"确实有独立内容。"""
    info = page.evaluate(
        """() => { window.scrollTo(0, document.body.scrollHeight);
                   return {y: window.scrollY, h: document.body.scrollHeight, vh: window.innerHeight}; }""")
    page.wait_for_timeout(450)
    print("      [自检] 页面高 %d，视口高 %d，滚动到 y=%d" % (info["h"], info["vh"], info["y"]))
    if info["y"] == 0:
        print("      [警告] 页面未产生滚动，本屏将与上一屏重复——请调大 zoom 或换内容区")
    return info


def shot_win(page, n, html_fn):
    p = os.path.join(TMP, "win%02d.html" % n)
    with open(p, "w", encoding="utf-8") as fh:
        fh.write(html_fn())
    page.goto("file:///" + p.replace("\\", "/"), wait_until="load")
    page.wait_for_timeout(700)
    return shot(page, n)


def check_unique():
    """md5 唯一性校验：任何两屏完全相同即失败（Word 插图时也会去重，暴露空图位）。"""
    h = {}
    dup = []
    for fn in sorted(os.listdir(OUT)):
        if not fn.endswith(".png"):
            continue
        d = hashlib.md5(open(os.path.join(OUT, fn), "rb").read()).hexdigest()
        if d in h:
            dup.append((h[d], fn))
        h[d] = fn
    total = len([f for f in os.listdir(OUT) if f.endswith(".png")])
    print("唯一图 %d / 总图 %d" % (len(h), total))
    if dup:
        print("重复截图:", dup)
    return not dup


def main():
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(TMP, exist_ok=True)

    # 代理会截走 127.0.0.1 请求（返回 502 / 页面白屏），截图前清掉
    for k in ("http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
        os.environ.pop(k, None)
    os.environ.setdefault("NO_PROXY", "127.0.0.1,localhost")

    t0 = time.time()
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=CHROME, headless=True,
            args=["--disable-gpu", "--disable-software-rasterizer", "--hide-scrollbars",
                  "--force-device-scale-factor=1"])
        page = browser.new_page(viewport={"width": W, "height": H}, device_scale_factor=DEVICE_SCALE)

        app_opened = False
        for sc in SCREENS:
            n = sc["n"]
            if sc.get("kind") == "wintml":
                shot_win(page, n, HTML_FNS[sc["fn"]])
                continue

            if not app_opened:
                page.goto(BASE, wait_until="load")
                page.wait_for_timeout(2200)
                app_opened = True

            zoom = sc.get("zoom", 1.5)
            page.evaluate("document.body.style.zoom='%s'" % zoom)
            page.wait_for_timeout(900)
            if sc.get("js"):
                page.evaluate(sc["js"])
            page.wait_for_timeout(sc.get("wait", 1200))
            (scroll_bottom if sc.get("scroll") == "bottom" else scroll_top)(page)
            shot(page, n)

        browser.close()

    print("完成，耗时 %.1f s" % (time.time() - t0))
    ok = check_unique()
    print("唯一性校验:", "通过" if ok else "未通过（按上面重复清单重拍）")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
