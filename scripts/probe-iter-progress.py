#!/usr/bin/env python3
"""多轮复盘「不像卡死」的确定性取证：进度行必须随时间变化，日志必须逐轮增长。

为什么需要它：视觉上「有没有卡死」是靠一行字会不会动来判断的，静态截图证明不了这一点。
这里在同一次真实运行里连采多帧，断言 ① 进度行文本随秒变化；② 日志条数单调增长；
③ 收尾出现「完成」行。截图只是这些事实的旁证，不是判据本身。

只借用已在跑的 chrome-cu 实例（本机纪律：不 kill、不 Browser.close、只关自己开的 tab、绝不抢前台）。
"""
import json
import re
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

CDP = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:19301"
OUT = "/tmp/agentank-iter"
DIST = "/Users/zkf/work/tankgame/dist"

# 产物用 http 提供（贴近线上；file:// 下 blob Worker 会被拦）。服务器跑在本进程的守护线程里：
# 探针退出即消失，不会留下孤儿端口（本机纪律：探针生命周期必须绑定被观测对象）。
httpd = ThreadingHTTPServer(("127.0.0.1", 0), partial(SimpleHTTPRequestHandler, directory=DIST))
PORT = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
# fakedelay 拉到 3s（假 AI 上限）：否则一轮 1.2s 跑完，采样点全落在步骤切换瞬间，
# 秒表「已用 N s」永远显示 0 —— 那样测不出心跳到底会不会走（首轮探针就栽在这）。
URL = f"http://127.0.0.1:{PORT}/agentank.html?fakellm=1&fakedelay=3000&lang=zh"
print("serving", URL)

samples = []


def snap(page, tag):
    state = page.evaluate(
        """() => ({
      prog: (document.getElementById('itProgress') || {}).textContent || '',
      bar: (document.getElementById('itBar') || {}).style ? document.getElementById('itBar').style.width : '',
      rows: [...document.querySelectorAll('#itLog .r')].map((e) => e.textContent.trim()),
      btn: (document.getElementById('itRunBtn') || {}).textContent || '',
    })"""
    )
    state["tag"] = tag
    samples.append(state)
    return state


with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp(CDP)
    ctx = browser.contexts[0]
    page = ctx.new_page()  # 自己开的 tab，收尾只关它
    try:
        page.set_viewport_size({"width": 1440, "height": 900})
        page.goto(URL, wait_until="load")
        page.wait_for_timeout(1200)

        # 批量动作 1：跑基线（训练组 + 留出组），等胜率出数
        page.click("#wrRunBtn")
        page.wait_for_function(
            "() => !/—%/.test((document.getElementById('wrNum')||{}).textContent||'—%')",
            timeout=60000,
        )
        # 批量动作 2：开复盘弹层 → 轮数选 3 → 开始迭代
        page.click("#wrReviewBtn")
        page.wait_for_selector("#itRunBtn", timeout=15000)
        page.select_option("#itRounds", "3")
        page.click("#itRunBtn")

        # 采样：每 700ms 采一帧，直到跑完（最多 120s）。密集采样才能抓到「同一步骤内秒表在走」，
        # 也不会像上一版那样把已经收尾的那帧误当成运行中。
        t_end = time.time() + 120
        shot = False
        while time.time() < t_end:
            s = snap(page, "running")
            if not s["prog"]:
                samples.pop()  # 已收尾：这帧不算运行中样本
                break
            if not shot and len(s["rows"]) >= 3:
                page.screenshot(path=f"{OUT}-running.png")
                shot = True
            page.wait_for_timeout(700)
        print(f"采到运行中样本 {len(samples)} 帧")

        # 等收尾（按钮回到「开始迭代」）
        page.wait_for_function(
            "() => /开始迭代/.test((document.getElementById('itRunBtn')||{}).textContent||'')",
            timeout=180000,
        )
        page.wait_for_timeout(600)
        s = snap(page, "done")
        page.screenshot(path=f"{OUT}-done.png")
        print(f"[done] rows={len(s['rows'])}")
        for r in s["rows"]:
            print("   ", r)
    finally:
        page.close()  # 只关自己这个 tab；共享实例保持存活

# ---------- 确定性判据 ----------
run = [s for s in samples if s["tag"] == "running"]
done = samples[-1]
fails = []
progs = [s["prog"] for s in run]
if len(run) < 4:
    fails.append(f"运行中样本太少（{len(run)}），采不到心跳变化")
if not all(re.search(r"已用 \d+s", p) for p in progs):
    fails.append(f"进度行缺秒表（已用 Ns）：{progs}")
if not all(re.search(r"第 \d+/3 轮", p) for p in progs):
    fails.append(f"进度行缺轮次：{progs}")


def clock(p):
    m = re.search(r"已用 (\d+)s", p)
    return int(m.group(1)) if m else -1


def step(p):
    m = re.match(r"(第 \d+/3 轮 · [^·]+)", p)
    return m.group(1) if m else p


# 关键判据：存在「同一轮同一步骤」的相邻两帧，秒表读数严格变大 ——
# 这正是「界面不是静止的」的确定性证据，而不是靠肉眼看截图。
ticked = any(
    step(a) == step(b) and clock(b) > clock(a)
    for a, b in zip(progs, progs[1:])
)
if not ticked:
    fails.append(f"同一步骤内秒表没有前进（等于看起来卡死）：{progs}")
bars = [s["bar"] for s in run]
if len({b for b in bars if b}) < 2:
    fails.append(f"进度条宽度没变化：{bars}")
counts = [len(s["rows"]) for s in run] + [len(done["rows"])]
if counts != sorted(counts) or counts[-1] <= counts[0]:
    fails.append(f"日志条数没有单调增长：{counts}")
if not any("复盘" in r for r in done["rows"]):
    fails.append("日志里没有每轮复盘汇总行")
if not any("评分" in r and "训练组" in r for r in done["rows"]):
    fails.append("日志里没有带胜率的评分汇总行")
if not any("完成" in r for r in done["rows"]):
    fails.append("收尾没有「完成」汇总行")

print(json.dumps({"samples": samples, "fails": fails}, ensure_ascii=False, indent=2)[:4000])
print("PROBE:", "PASS" if not fails else "FAIL")
sys.exit(0 if not fails else 1)
