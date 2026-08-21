#!/usr/bin/env python3
"""在**已经开着的** chrome-cu 实例里复用现成 tab 做只读取证——不新建 tab、不关别人的 tab、不动窗口。

选 tab 的规则（2026-08-21 用户定案）：
  1. **优先在没有最小化的窗口里找**。同一个站常常在多个窗口里各开一个，
     只要有一个在 normal 窗口，就用它 —— 不要因为「碰巧先扫到最小化窗口里那个」而卡住。
  2. **绝不为了干活去恢复用户最小化的窗口**，也绝不新建 tab。
  3. 可见窗口里找不到目标页面（或整个浏览器只有一个最小化窗口）→ **停下来交回给用户**，
     说清楚要他做什么，而不是自作主张。

为什么有这些规则（实测代价）：
  · headful 下 `new_page()` 会把**最小化的窗口复原并弹到前台**（minimized → normal），close 后也不还原；
  · 复用已有 tab 做 goto / click / evaluate / inner_text 全程不吵醒窗口（实测保持 minimized）；
  · 但**截图**在最小化窗口上拿不到：Playwright `page.screenshot()` 超时 30s，
    CDP `Page.captureScreenshot` 同样挂死（实测 45s，带不带 captureBeyondViewport 都一样）——
    最小化时合成器根本不产帧。窗口是 normal 时（哪怕在后台、被别的窗口遮住）CDP 截图可用。

用法：
  python3 scripts/cu-page.py list                          # 列出现成 tab（带窗口状态）
  python3 scripts/cu-page.py eval  <url-substr> "<js>"     # 复用现成 tab 读事实
  python3 scripts/cu-page.py shot  <url-substr> <out.png>  # 复用现成 tab 截图（走 CDP）
  可见窗口里有多个 tab 命中同一 URL 时，用 --index N 指名（静默取第一个可能动错 tab）。
  CU_CDP 环境变量可覆盖实例地址（默认 chrome-cu-1）。
"""
import base64
import os
import sys

from playwright.sync_api import sync_playwright

CDP = os.environ.get("CU_CDP", "http://127.0.0.1:19301")
VISIBLE = ("normal", "maximized", "fullscreen")


def scan(b, ctx, needle=None):
    """[(page, windowState, windowId)]。窗口状态按 **targetId** 精确取——
    按 URL 匹配在「同一站开在两个窗口」时会张冠李戴（本工具此前就是这个 bug）。"""
    bs = b.new_browser_cdp_session()
    out = []
    for pg in ctx.pages:
        if needle is not None and needle not in pg.url:
            continue
        try:
            tid = ctx.new_cdp_session(pg).send("Target.getTargetInfo")["targetInfo"]["targetId"]
            w = bs.send("Browser.getWindowForTarget", {"targetId": tid})
            out.append((pg, w["bounds"]["windowState"], w["windowId"]))
        except Exception:
            out.append((pg, "unknown", None))
    return out


def pick(b, ctx, needle, index=None):
    cands = scan(b, ctx, needle)
    if not cands:
        raise SystemExit(f"没有匹配 {needle!r} 的现成 tab —— 请先在浏览器里打开它，本工具不会替你新建")

    visible = [c for c in cands if c[1] in VISIBLE]
    if not visible:
        # 目标只在最小化窗口里：停下交回用户，不恢复窗口、不新建 tab
        all_wins = {c[2] for c in scan(b, ctx) if c[2] is not None}
        if len(all_wins) <= 1:
            raise SystemExit(
                f"匹配 {needle!r} 的 tab 只在最小化窗口里，而且整个浏览器只有这一个窗口。\n"
                "  已停下：请你把窗口恢复出来（或换个窗口打开该页面）后再跑一次 —— 我不会替你恢复窗口。"
            )
        raise SystemExit(
            f"匹配 {needle!r} 的 tab 都在最小化窗口里；可见窗口里没有这个页面。\n"
            "  已停下：请在某个可见窗口里打开它后再跑一次 —— 我不会替你恢复窗口，也不会新建 tab。"
        )

    if len(visible) > 1 and index is None:
        lines = [f"  --index {i}: [{st}] {pg.url}" for i, (pg, st, _) in enumerate(visible)]
        raise SystemExit(f"可见窗口里有 {len(visible)} 个 tab 匹配 {needle!r}，请用 --index 指名：\n" + "\n".join(lines))
    return visible[index or 0]


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
            for i, (pg, st, wid) in enumerate(scan(b, ctx)):
                print(f"{i}: [{st}] win={wid} {pg.url}")
            return
        pg, state, _ = pick(b, ctx, argv[1], index)
        if cmd == "eval":
            print(pg.evaluate(argv[2]))
        elif cmd == "shot":
            if state not in VISIBLE:  # 兜底：pick 已保证可见，这里 fail-close 不留侥幸
                raise SystemExit(f"该 tab 所在窗口是 {state}：最小化时浏览器不产合成帧，截图必然超时。已停下。")
            cdp = ctx.new_cdp_session(pg)
            data = cdp.send("Page.captureScreenshot", {"format": "png"})["data"]
            open(argv[2], "wb").write(base64.b64decode(data))
            print(f"saved {argv[2]} from [{state}] {pg.url}")
        else:
            raise SystemExit(__doc__)
        # 借来的东西原样放回：全程没有 new_page / close / setWindowBounds


if __name__ == "__main__":
    main()
