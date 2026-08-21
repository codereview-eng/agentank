#!/usr/bin/env python3
"""在**已经开着的** chrome-cu 实例里复用现成 tab 做只读取证——不新建 tab、不关别人的 tab、不动窗口。

为什么需要它（2026-08-21 事故）：写自动化时的默认惯性是 `context.new_page()`，
但连上的是用户正在用的浏览器，屋里本来就开着要看的页面。实测代价：
  · headful 下 `new_page()` 会把**最小化的窗口复原并弹到前台**（minimized → normal），close 后也不还回去；
  · 复用已有 tab 做 goto / click / evaluate / inner_text 全程不吵醒窗口（实测保持 minimized）；
  · 但**截图**在最小化窗口上拿不到：Playwright `page.screenshot()` 超时 30s，
    CDP `Page.captureScreenshot` 同样挂死（实测 45s 超时，加不加 captureBeyondViewport 都一样）——
    最小化时合成器根本不产帧。这正是许多脚本"顺手 bring_to_front"的真实动机。
    正确取舍：**要 DOM 事实就复用现成 tab（最小化也能读）；要像素就用自己的 headless 实例**，
    而不是把用户的窗口弹出来。窗口是 normal（哪怕在后台、被别的窗口遮住）时，CDP 截图可用。

用法：
  python3 scripts/cu-page.py list                          # 列出现成 tab（带窗口状态）
  python3 scripts/cu-page.py eval  <url-substr> "<js>"     # 复用现成 tab 读事实
  python3 scripts/cu-page.py shot  <url-substr> <out.png>  # 复用现成 tab 截图（走 CDP）
  多个 tab 命中同一 URL 时（很常见：同一站开在两个窗口里）必须用 --index N 指名，
  否则本工具报错退出 —— 静默取第一个可能动到用户不期望的那个 tab。
"""
import base64
import sys

from playwright.sync_api import sync_playwright

import os

CDP = os.environ.get("CU_CDP", "http://127.0.0.1:19301")  # 默认 chrome-cu-1；CU_CDP 可覆盖（换实例/自验）


def win_state(b, url):
    """该 URL 所在窗口的状态（normal / minimized / ...）；查不到就返回 unknown。"""
    try:
        bs = b.new_browser_cdp_session()
        for t in bs.send("Target.getTargets")["targetInfos"]:
            if t["type"] == "page" and t["url"] == url:
                return bs.send("Browser.getWindowForTarget", {"targetId": t["targetId"]})["bounds"]["windowState"]
    except Exception:
        pass
    return "unknown"


def pick(b, ctx, needle, index=None):
    hits = [p for p in ctx.pages if needle in p.url]
    if not hits:
        raise SystemExit(f"没有匹配 {needle!r} 的现成 tab —— 请先在浏览器里打开它，本工具不会替你新建")
    if len(hits) > 1 and index is None:
        lines = [f"  --index {i}: [{win_state(b, p.url)}] {p.url}" for i, p in enumerate(hits)]
        raise SystemExit(f"{len(hits)} 个 tab 都匹配 {needle!r}，请用 --index 指名（静默取第一个可能动到你不想动的那个）：\n"
                         + "\n".join(lines))
    return hits[index or 0]


def main():
    argv = sys.argv[1:] or ["list"]
    index = None
    if "--index" in argv:
        i = argv.index("--index")
        index = int(argv[i + 1])
        del argv[i:i + 2]
    cmd = argv[0]
    with sync_playwright() as p:
        b = p.chromium.connect_over_cdp(CDP)  # 只连；connect 本身不抢前台
        ctx = b.contexts[0]
        if cmd == "list":
            for i, pg in enumerate(ctx.pages):
                print(f"{i}: [{win_state(b, pg.url)}] {pg.url}")
            return
        pg = pick(b, ctx, argv[1], index)
        if cmd == "eval":
            print(pg.evaluate(argv[2]))
        elif cmd == "shot":
            # fail-close：最小化窗口不产合成帧，截图必挂（Playwright 与 CDP 都一样）。
            # 宁可当场报错给出替代方案，也不要挂 30~45 秒，更不许把用户的窗口弹出来「解决」它。
            state = win_state(b, pg.url)
            if state == "minimized":
                raise SystemExit(
                    f"该 tab 所在窗口是 {state}：最小化时浏览器不产合成帧，截图必然超时。\n"
                    "  · 只要 DOM 事实 → 改用本工具的 eval（最小化下照常可用）\n"
                    "  · 确实要像素 → 用自己的 headless 实例截（别把用户的窗口弹出来）"
                )
            # 窗口 normal 时走 CDP：后台/被遮挡也能出图，且无需把窗口提到前台
            cdp = ctx.new_cdp_session(pg)
            data = cdp.send("Page.captureScreenshot", {"format": "png"})["data"]
            open(argv[2], "wb").write(base64.b64decode(data))
            print(f"saved {argv[2]} from {pg.url}")
        else:
            raise SystemExit(__doc__)
        # 注意：这里没有 page.close()／new_page()／setWindowBounds —— 借来的东西原样放回


if __name__ == "__main__":
    main()
