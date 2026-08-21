#!/usr/bin/env python3
"""在**已经开着的** chrome-cu 实例里复用现成 tab 做只读取证——不新建 tab、不关别人的 tab、不动窗口。

为什么需要它（2026-08-21 事故）：写自动化时的默认惯性是 `context.new_page()`，
但连上的是用户正在用的浏览器，屋里本来就开着要看的页面。实测代价：
  · headful 下 `new_page()` 会把**最小化的窗口复原并弹到前台**（minimized → normal），close 后也不还回去；
  · 复用已有 tab 做 goto / click / evaluate / inner_text 全程不吵醒窗口（实测保持 minimized）；
  · 但 Playwright 的 `page.screenshot()` 在最小化窗口上会**超时 30s**（等不到合成帧）——
    这正是许多脚本"顺手 bring_to_front"的真实动机；正确解法是 CDP `Page.captureScreenshot`，不需要窗口可见。

用法：
  python3 scripts/cu-page.py list
  python3 scripts/cu-page.py eval  <url-substr> "<js 表达式>"
  python3 scripts/cu-page.py shot  <url-substr> <输出 png 路径>
"""
import base64
import sys

from playwright.sync_api import sync_playwright

CDP = "http://127.0.0.1:19301"  # chrome-cu-1；换实例改这里


def pick(ctx, needle):
    hits = [p for p in ctx.pages if needle in p.url]
    if not hits:
        raise SystemExit(f"没有匹配 {needle!r} 的现成 tab —— 请先在浏览器里打开它，本工具不会替你新建")
    return hits[0]


def main():
    argv = sys.argv[1:] or ["list"]
    cmd = argv[0]
    with sync_playwright() as p:
        b = p.chromium.connect_over_cdp(CDP)  # 只连；connect 本身不抢前台
        ctx = b.contexts[0]
        if cmd == "list":
            for i, pg in enumerate(ctx.pages):
                print(f"{i}: {pg.url}")
            return
        pg = pick(ctx, argv[1])
        if cmd == "eval":
            print(pg.evaluate(argv[2]))
        elif cmd == "shot":
            # 走 CDP：窗口最小化/被遮挡也能出图，且不需要把窗口弹到前台
            cdp = ctx.new_cdp_session(pg)
            data = cdp.send("Page.captureScreenshot", {"format": "png"})["data"]
            open(argv[2], "wb").write(base64.b64decode(data))
            print(f"saved {argv[2]} from {pg.url}")
        else:
            raise SystemExit(__doc__)
        # 注意：这里没有 page.close()／new_page()／setWindowBounds —— 借来的东西原样放回


if __name__ == "__main__":
    main()
