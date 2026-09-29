# -*- coding: utf-8 -*-
"""
发布包冒烟测试【模板】（材料生成工具，不属源程序）

用法：把交付 zip 解压到**干净临时目录**，本脚本也复制进去，以该目录为 cwd 运行：
    python package_smoke_template.py <解压后的包根目录>

为什么必须做这一步（实测 2026-09-22，电池BMS平台）：
    开发树内一切正常，交付包却启动即崩——打包脚本的 `_*` 前缀排除规则
    把 `__init__.py` 一并吞掉，导致「目录内仅有 __init__.py」的包
    （如 utils/）连目录一起从 zip 消失，报 ModuleNotFoundError。
    开发树测不出这类问题（命名空间包兜底），只有干净目录运行才暴露。

新项目适配：改 A1 必需文件清单、C 核心链路模块名、D 接口字段名三处即可。

校验项：
  A. 结构与包完备性（必需文件 / 每个 Python 包目录都有 __init__.py）
  B. 全部 .py 可编译（py_compile）
  C. 核心链路端到端
  D. Web 层：导入入口（起后台线程）→ test_client 遍历 页面路由 + API 路由；
     关键接口字段完整性（可兼作界面修复项的回归守卫）
  E. 前端库经 Flask 可服务 / 模板经 url_for 引用本地库
  F. 源码无开发机绝对路径泄漏
"""
import io
import os
import py_compile
import re
import sys
import tempfile
import time
import traceback

PASS = []
FAIL = []


def check(name):
    """装饰器：执行校验并记录结果"""

    def deco(fn):
        t0 = time.time()
        try:
            detail = fn()
            PASS.append((name, detail, (time.time() - t0) * 1000))
        except Exception as e:
            FAIL.append((name, "%s: %s" % (type(e).__name__, e), traceback.format_exc()))
        return fn

    return deco


def main(root):
    root = os.path.abspath(root)
    print("=" * 96)
    print("BMS 平台发布包冒烟测试（干净目录运行）")
    print("包根目录:", root)
    print("=" * 96)

    if not os.path.isdir(root):
        print("!! 包根目录不存在")
        return 2

    sys.path.insert(0, root)

    # ---------- A. 结构完整性 ----------
    @check("A1 必需文件存在")
    def _():
        must = [
            "pyproject.toml", "requirements.txt", "start.bat",
            "安装与启动说明.md", "README.md",
            "bms_platform/web/app.py",
            "bms_platform/web/templates/index.html",
            "bms_platform/web/templates/eis.html",
            "bms_platform/web/templates/scheduling.html",
            "bms_platform/web/templates/digital_twin.html",
            "bms_platform/web/templates/passport.html",
            "bms_platform/web/static/lib/echarts.min.js",
            "bms_platform/web/static/lib/tailwind.min.js",
        ]
        miss = [m for m in must if not os.path.exists(os.path.join(root, m))]
        assert not miss, "缺失: %s" % miss
        return "%d/%d 项必需文件齐全" % (len(must), len(must))

    @check("A2 包结构 __init__.py 完备")
    def _():
        pkg = os.path.join(root, "bms_platform")
        n_dir, missing = 0, []
        for dp, dn, fns in os.walk(pkg):
            dn[:] = [d for d in dn if d != "__pycache__"]
            has_py = any(f.endswith(".py") for f in fns)
            if not has_py:
                continue  # 纯资源目录（templates / static）无需 __init__.py
            n_dir += 1
            if "__init__.py" not in fns:
                missing.append(os.path.relpath(dp, root).replace(os.sep, "/"))
        assert not missing, "以下包目录缺 __init__.py（目录内容会被整体丢失）: %s" % missing
        return "%d 个 Python 包目录全部含 __init__.py" % n_dir

    # ---------- B. 全部 .py 可编译 ----------
    @check("B1 源程序编译检查")
    def _():
        tmp = tempfile.mkdtemp(prefix="pkgchk_")
        cf = os.path.join(tmp, "x.pyc")
        pys, bad = [], []
        for dp, dn, fns in os.walk(os.path.join(root, "bms_platform")):
            dn[:] = [d for d in dn if d != "__pycache__"]
            for fn in fns:
                if fn.endswith(".py"):
                    pys.append(os.path.join(dp, fn))
        for p in pys:
            try:
                py_compile.compile(p, cfile=cf, doraise=True)
            except Exception as e:
                bad.append("%s -> %s" % (os.path.basename(p), e))
        assert not bad, "编译失败: %s" % bad[:3]
        return "%d 个 .py 全部编译通过" % len(pys)

    # ---------- C. 核心链路端到端 ----------
    @check("C1 端侧模拟器 -> 边缘推理 -> 包级联合估计")
    def _():
        from bms_platform.device.bms_simulator import BMSSimulator
        from bms_platform.edge.inference_engine import EdgeInferenceEngine
        from bms_platform.core.estimation.joint_estimator import JointStateEstimator

        sim = BMSSimulator(num_packs=2, cells_per_pack=24)
        sim.set_mode("discharge", load_current=2.0, ambient_temp=28.0)
        edge = EdgeInferenceEngine(num_cells=48)
        joi = JointStateEstimator(num_cells=24)
        packs = sim.step()
        for _ in range(5):
            packs = sim.step()
        r = edge.inference(packs)
        assert len(r.pack_states) == 2, "pack_states=%d" % len(r.pack_states)
        ps = joi.estimate_pack_state(
            currents=sim.get_cell_currents()[:24], voltages=sim.get_cell_voltages()[:24],
            temperatures=sim.get_cell_temperatures()[:24],
            eis_features_list=[[0.03] * 12 for _ in range(24)],
            dt=1.0,
        )
        for k in ("pack_soc", "pack_soh", "pack_sop_w", "pack_soe_wh"):
            assert k in ps, "缺少 %s" % k
        return "packs=2, edge_latency=%.0fms, pack_soc=%.3f, pack_soh=%.3f" % (
            r.inference_latency_ms, ps["pack_soc"], ps["pack_soh"],
        )

    @check("C2 安全保护链路（电芯级 + 包级）")
    def _():
        import numpy as np
        from bms_platform.core.safety.protection import SafetyProtectionSystem
        sp = SafetyProtectionSystem(num_cells=24)
        # 造越压/越温电芯，应触发保护动作
        ev1 = sp.check(cell_id=0, voltage=3.95, current=6.0, temperature=62.0)
        n = 24
        ev2 = sp.check_pack(
            voltages=np.full(n, 3.30),
            currents=np.full(n, 2.0),
            temperatures=np.full(n, 28.0),
            eis_R_ohm_list=np.full(n, 0.015),
        )
        assert isinstance(ev1, list) and isinstance(ev2, list)
        assert len(ev1) >= 1, "越压/越温电芯未触发任何保护"
        return "电芯级保护 %d 条、包级检查 %d 条，action=%s" % (
            len(ev1), len(ev2), ev1[0].action.name if ev1 else "-",
        )

    # ---------- D. Web 层 ----------
    @check("D1 导入 web.app 并启动仿真线程")
    def _():
        mod = __import__("bms_platform.web.app", fromlist=["app"])
        for _ in range(40):
            if getattr(mod, "last_sim_data", None) is not None:
                break
            time.sleep(0.25)
        assert mod.last_sim_data is not None, "仿真线程未产出数据"
        return "sim_data 已就绪，顶层键=%d" % len(mod.last_sim_data)

    @check("D2 5 个页面路由可渲染")
    def _():
        from bms_platform.web.app import app
        c = app.test_client()
        pages = {
            "/": "text/html", "/eis": "text/html", "/scheduling": "text/html",
            "/digital-twin": "text/html", "/passport": "text/html",
        }
        bad = []
        for url in pages:
            rv = c.get(url)
            if rv.status_code != 200:
                bad.append("%s->%d" % (url, rv.status_code))
        assert not bad, "页面异常: %s" % bad
        return "%d 个页面全部 200" % len(pages)

    @check("D3 全部 API 路由返回 200 且为 JSON")
    def _():
        from bms_platform.web.app import app
        c = app.test_client()
        apis = [
            "/api/realtime", "/api/dashboard", "/api/eis",
            "/api/scheduling", "/api/passports", "/api/models",
            "/api/safety",
        ]
        bad = []
        for url in apis:
            rv = c.get(url)
            if rv.status_code != 200:
                bad.append("%s->%d" % (url, rv.status_code))
            elif not rv.is_json:
                bad.append("%s非JSON" % url)
        assert not bad, "接口异常: %s" % bad
        return "%d 个 API 全部 200/JSON" % len(apis)

    @check("D4 /api/realtime 字段完整性（含 D13/D16/服务端事件缓冲）")
    def _():
        from bms_platform.web.app import app
        c = app.test_client()
        j = c.get("/api/realtime").get_json()
        miss = []
        for k in ("packs", "edge", "step", "timestamp"):
            if k not in j:
                miss.append(k)
        edge = j["edge"]
        for k in ("pack_states", "thermal_warnings", "abnormal_cells",
                  "recent_safety_events", "safety_events", "inference_latency_ms"):
            if k not in edge:
                miss.append("edge." + k)
        # D13：电芯电阻字段名须为 internal_resistance（旧版误写 internal_r）
        cell0 = j["packs"][0]["cells"][0]
        for k in ("id", "voltage", "temperature", "soc", "soh",
                  "current", "internal_resistance"):
            if k not in cell0:
                miss.append("cells[0]." + k)
        # 任务2：pack_states 提供 SOC/SOH/SOP/SOE 四状态
        for pk, pv in (edge.get("pack_states") or {}).items():
            for k in ("soc", "soh", "sop", "soe"):
                if k not in pv:
                    miss.append("pack_states.%s.%s" % (pk, k))
        # D16：热预警须逐电芯且带 cell_id（供热力图按全局编号着色）
        tw = edge.get("thermal_warnings") or []
        if not tw or "cell_id" not in tw[0]:
            miss.append("thermal_warnings[].cell_id")
        assert not miss, "字段缺失: %s" % miss
        return ("packs/edge/cells 字段齐全；abnormal=%s；pack_states=%s；"
                "热预警=%d 芯；近期安全事件=%d 条") % (
            edge.get("abnormal_cells"), sorted((edge.get("pack_states") or {}).keys()),
            len(tw), len(edge.get("recent_safety_events") or []),
        )

    @check("D5 /api/eis 热管理四档计数（D14 修复项）")
    def _():
        from bms_platform.web.app import app
        c = app.test_client()
        r = c.get("/api/eis").get_json()
        ts = r.get("thermal_summary")
        assert isinstance(ts, dict), "thermal_summary 类型=%s" % type(ts).__name__
        need = ("low_risk", "medium_risk", "high_risk", "critical_risk",
                "max_temperature", "avg_temperature", "total_cells")
        miss = [k for k in need if k not in ts]
        assert not miss, "thermal_summary 缺字段: %s" % miss
        tot = sum(ts[k] for k in ("low_risk", "medium_risk", "high_risk", "critical_risk"))
        assert tot == ts["total_cells"], "四档之和 %s != total_cells %s" % (tot, ts["total_cells"])
        assert ts["max_temperature"] >= ts["avg_temperature"], "最高温不应低于均温"
        return "四档 %d/%d/%d/%d 合计=%d；max=%.1fC avg=%.1fC；异常芯=%s" % (
            ts["low_risk"], ts["medium_risk"], ts["high_risk"], ts["critical_risk"],
            ts["total_cells"], ts["max_temperature"], ts["avg_temperature"],
            r.get("abnormal_cells"),
        )

    # ---------- E. 静态资源 ----------
    @check("E1 前端库可被 Flask 服务")
    def _():
        from bms_platform.web.app import app
        c = app.test_client()
        bad = []
        for lib in ("echarts.min.js", "tailwind.min.js"):
            rv = c.get("/static/lib/" + lib)
            n = len(rv.data or b"")
            if rv.status_code != 200 or n < 1000:
                bad.append("%s->%d/%dB" % (lib, rv.status_code, n))
        assert not bad, "静态库异常: %s" % bad
        return "echarts + tailwind 均 200 且非空"

    @check("E2 页面已引用本地前端库（无 CDN 硬依赖）")
    def _():
        hits = []
        tdir = os.path.join(root, "bms_platform", "web", "templates")
        for fn in sorted(os.listdir(tdir)):
            if not fn.endswith(".html"):
                continue
            with io.open(os.path.join(tdir, fn), "r", encoding="utf-8") as f:
                txt = f.read()
            # 模板通过 url_for('static', filename='lib/xxx') 引用本地库
            ok = ("lib/echarts.min.js" in txt and "lib/tailwind.min.js" in txt
                  and "url_for" in txt)
            hits.append((fn, ok))
        bad = [h[0] for h in hits if not h[1]]
        assert not bad, "以下模板未引用本地前端库: %s" % bad
        return "%d 个模板均经 url_for 引用本地 echarts/tailwind" % len(hits)

    # ---------- F. 路径泄漏 ----------
    @check("F1 源码无开发机绝对路径泄漏")
    def _():
        pat = re.compile(r"[A-Za-z]:\\\\(?:Users|douyaun)|E:\\\\Users|C:\\\\Users")
        bad = []
        for dp, dn, fns in os.walk(os.path.join(root, "bms_platform")):
            dn[:] = [d for d in dn if d != "__pycache__"]
            for fn in fns:
                if not fn.endswith(".py"):
                    continue
                p = os.path.join(dp, fn)
                with io.open(p, "r", encoding="utf-8", errors="replace") as f:
                    for i, line in enumerate(f, 1):
                        if pat.search(line):
                            bad.append("%s:%d" % (os.path.relpath(p, root), i))
        assert not bad, "发现硬编码路径: %s" % bad[:5]
        return "源程序目录下无硬编码绝对路径"

    # ---------- 汇总 ----------
    print()
    total = len(PASS) + len(FAIL)
    for name, detail, dt in PASS:
        print("[PASS] %-42s %7.1f ms" % (name, dt))
        if detail:
            print("        %s" % detail)
    for name, detail, _tb in FAIL:
        print("[FAIL] %-42s" % name)
        print("        %s" % detail)
    print()
    print("-" * 96)
    print("用例总数: %d   通过: %d   失败: %d   通过率: %.1f%%" % (
        total, len(PASS), len(FAIL), 100.0 * len(PASS) / max(total, 1),
    ))
    if FAIL:
        print()
        print("=" * 96)
        print("失败明细")
        print("=" * 96)
        for name, detail, tb in FAIL:
            print("\n--- %s ---" % name)
            print(tb)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "."))
