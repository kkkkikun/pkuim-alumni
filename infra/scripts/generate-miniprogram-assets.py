#!/usr/bin/env python3
# =============================================================================
# NMG-PKU-Alumni —— 小程序图标 / 插画资产生成器
#
#   python3 infra/scripts/generate-miniprogram-assets.py
#   python3 infra/scripts/generate-miniprogram-assets.py --check   # 只校验不写文件
#
# 为什么需要它：
#   小程序端**不支持 SVG data URI**（WXSS 里写 url("data:image/svg+xml,...")
#   在真机上不渲染），所以原型 prototype/html-v1/index.html 里的
#   Feather 风格描边图标与塔楼线描插画必须先**栅格化成 PNG** 才能用。
#   而手写 CSS 伪元素去描这些图形（项目此前对 tabBar 就是这么干的）
#   既还原不了（原型是描边 SVG，CSS 只能画实心块），
#   也无法随原型改动自动同步 —— 这正是 #154「细节不精致」的根因之一。
#
# 唯一事实来源：
#   图标路径与插画路径**全部从 prototype/html-v1/index.html 里现读现提取**，
#   不在本脚本里另抄一份 —— 抄一份就会漂移，而漂移是静默的。
#
# 依赖：cairosvg（pip install cairosvg）、Pillow（用于 PNG 压缩）
#   本脚本是**本地资源生成工具**，不是回归链的硬依赖：
#   生成的 PNG 已提交进仓库，服务器上不需要装 cairosvg。
#
# 退出码：0 成功；1 失败。
# =============================================================================

import argparse
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(HERE))
PROTOTYPE = os.path.join(PROJECT_ROOT, "prototype", "html-v1", "index.html")
ASSET_ROOT = os.path.join(PROJECT_ROOT, "apps", "miniprogram", "src", "assets")
ICON_DIR = os.path.join(ASSET_ROOT, "icons")
ART_DIR = os.path.join(ASSET_ROOT, "art")

# 两种状态色：与 prototype 的 --red / 底栏未选中色保持一致
COLOR_NORMAL = "#a29c99"
COLOR_ACTIVE = "#a51e28"

# 只有底部导航需要「选中态」配色版本；
# 其余图标导一份中性色即可 —— 多导一套纯粹是白占主包体积。
ACTIVE_ICONS = ("home", "users", "connect", "person")

# 图标渲染倍率：24×24 的 viewBox 渲染成 72×72，覆盖 3 倍屏
ICON_SCALE = 3
ICON_SIZE = 24 * ICON_SCALE

# 插画：原型 viewBox 尺寸 × 倍率
ART_SPECS = {
    # name: (viewBox 宽, viewBox 高, 倍率)
    "banner-art": (414, 171, 3),
    "mini-art": (150, 125, 3),
    "net-art": (175, 165, 3),
    "me-art": (190, 145, 3),
}

# 额外配色变体：(输出文件名, 原型图标名, 颜色)
#
# 为什么需要「变体」：原型里这些图标是用 `currentColor` 画的，
# **每个位置的色调都不一样**（首页快捷入口四色、我的页菜单统一 #c38f73、
# 活动卡红/橄榄两色）。如果只导出一份灰色 PNG，就还原不了这个层次。
# 颜色一律取自 prototype/html-v1/index.html 的 CSS。
VARIANTS = [
    # 首页 · 快捷入口（prototype 的 .shortcut:nth-child(n) 配色）
    ("shortcut-users", "users", "#b3403c"),
    ("shortcut-connect", "connect", "#b57c4f"),
    ("shortcut-calendar", "calendar", "#b24348"),
    ("shortcut-building", "building", "#96765a"),
    # 我的页 / 账号页 · 菜单图标（prototype 的 .menu-icon 配色）
    ("menu-card", "card", "#c38f73"),
    ("menu-calendar", "calendar", "#c38f73"),
    ("menu-connect", "connect", "#c38f73"),
    ("menu-bell", "bell", "#c38f73"),
    ("menu-file", "file", "#c38f73"),
    ("menu-lock", "lock", "#c38f73"),
    ("menu-building", "building", "#c38f73"),
    ("menu-settings", "settings", "#c38f73"),
    # 活动卡 · 标记图标（prototype 的 .event-mark / .event-mark.olive 配色）
    ("event-users", "users", "#a53b36"),
    ("event-users-olive", "users", "#77836b"),
    ("event-building", "building", "#a53b36"),
    ("event-building-olive", "building", "#77836b"),
    ("event-calendar", "calendar", "#a53b36"),
    # 通知类型图标（var(--red)，画在粉色圆底上）
    ("notify-shield", "shield", "#a51e28"),
    ("notify-check", "check", "#a51e28"),
    ("notify-connect", "connect", "#a51e28"),
    ("notify-handshake", "handshake", "#a51e28"),
    ("notify-file", "file", "#a51e28"),
    ("notify-calendar", "calendar", "#a51e28"),
    ("notify-bell", "bell", "#a51e28"),
    ("notify-info", "info", "#a51e28"),
    # 零散小图标（沿用小程序既有占位元素的配色）
    ("plain-shield", "shield", "#b98a80"),
    ("plain-search", "search", "#b9aeb0"),
    # 连接页 · 行动按钮（原型 .link-action.primary / .link-action.ghost）
    ("action-plus", "plus", "#9c2630"),
    ("action-heart", "heart", "#ffffff"),
    # 连接页 · 筛选按钮（原型 .filter-button）
    ("filter-pin", "pin", "#69615f"),
    ("filter-down", "down", "#69615f"),
    # 连接页 · 流程步骤（原型 .step-bubble）
    ("flow-search", "search", "#bd625b"),
    ("flow-message", "message", "#bd625b"),
    ("flow-shield", "shield", "#bd625b"),
    ("flow-handshake", "handshake", "#bd625b"),
    # 机会卡片 · 「了解详情」箭头（原型 .op-foot span:last-child）
    ("op-right", "right", "#ab5152"),
]


def die(msg):
    print("❌ " + msg, file=sys.stderr)
    sys.exit(1)


def read_prototype():
    if not os.path.isfile(PROTOTYPE):
        die("找不到原型文件：" + PROTOTYPE)
    with open(PROTOTYPE, "r", encoding="utf-8") as fh:
        return fh.read()


def extract_icon_paths(html):
    """从原型 JS 里提取 iconPaths 对象：{'home':'<path .../>', ...}"""
    match = re.search(r"const\s+iconPaths\s*=\s*\{(.*?)\n\};", html, re.S)
    if not match:
        die("原型里找不到 iconPaths 定义")
    body = match.group(1)
    paths = {}
    # 形如  'name':'<svg 片段>',
    for entry in re.finditer(r"'([a-zA-Z0-9_-]+)'\s*:\s*'((?:[^'\\]|\\.)*)'", body):
        paths[entry.group(1)] = entry.group(2).replace("\\'", "'")
    if not paths:
        die("iconPaths 解析结果为空")
    return paths


def extract_art_svg(html, const_name):
    """提取形如 const bannerArt=()=>`<svg ...>...</svg>`; 的 SVG 字符串"""
    match = re.search(
        r"const\s+" + re.escape(const_name) + r"\s*=\s*\(\)\s*=>\s*`(.*?)`\s*;",
        html,
        re.S,
    )
    if not match:
        die("原型里找不到插画定义：" + const_name)
    svg = match.group(1).strip()
    if not svg.startswith("<svg"):
        die("插画 " + const_name + " 不是以 <svg 开头")
    return svg


def build_icon_svg(body, color):
    """按原型的 I() 口径拼一个独立 SVG：fill=none stroke=color stroke-width=1.7"""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" '
        'viewBox="0 0 24 24" fill="none" stroke="{color}" stroke-width="1.7" '
        'stroke-linecap="round" stroke-linejoin="round">{body}</svg>'
    ).format(color=color, body=body)


def render(svg, out_path, width, height, scale):
    try:
        import cairosvg
    except ImportError:
        die("缺少 cairosvg：pip install cairosvg")
    try:
        cairosvg.svg2png(
            bytestring=svg.encode("utf-8"),
            write_to=out_path,
            output_width=width,
            output_height=height,
            scale=scale,
            background_color=None,
        )
    except Exception as exc:  # noqa: BLE001 - 需要把渲染错误原样带出来
        die("渲染失败 %s：%s" % (out_path, exc))


def optimize_png(path):
    """用 Pillow 做一次无损压缩，尽量压小包体积（小程序主包上限 2MB）"""
    try:
        from PIL import Image
    except ImportError:
        return 0
    before = os.path.getsize(path)
    with Image.open(path) as img:
        img.load()
        # 量化到 256 色：对线描图视觉无损，体积能降一个数量级
        quantized = img.convert("RGBA").quantize(colors=256, method=Image.FASTOCTREE)
        quantized.save(path, optimize=True)
    return before - os.path.getsize(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="只校验不写文件")
    args = parser.parse_args()

    html = read_prototype()
    icon_paths = extract_icon_paths(html)
    print("✅ 从原型提取到 %d 个图标路径" % len(icon_paths))

    arts = {}
    for name, const_name in (
        ("banner-art", "bannerArt"),
        ("mini-art", "miniArt"),
        ("net-art", "netArt"),
        ("me-art", "meArt"),
    ):
        arts[name] = extract_art_svg(html, const_name)
    print("✅ 从原型提取到 %d 幅插画" % len(arts))

    if args.check:
        # 校验模式：确认目标文件都已存在
        missing = []
        for name in icon_paths:
            p = os.path.join(ICON_DIR, "%s.png" % name)
            if not os.path.isfile(p):
                missing.append(os.path.relpath(p, PROJECT_ROOT))
            if name in ACTIVE_ICONS:
                p = os.path.join(ICON_DIR, "%s-active.png" % name)
                if not os.path.isfile(p):
                    missing.append(os.path.relpath(p, PROJECT_ROOT))
        for name, _icon, _color in VARIANTS:
            p = os.path.join(ICON_DIR, "%s.png" % name)
            if not os.path.isfile(p):
                missing.append(os.path.relpath(p, PROJECT_ROOT))
        for name in arts:
            p = os.path.join(ART_DIR, "%s.png" % name)
            if not os.path.isfile(p):
                missing.append(os.path.relpath(p, PROJECT_ROOT))
        if missing:
            die("缺少资产文件（%d 个）：\n  %s" % (len(missing), "\n  ".join(missing)))
        print("✅ 资产齐全（%d 图标 × 2 状态 + %d 变体 + %d 插画）"
              % (len(icon_paths), len(VARIANTS), len(arts)))
        return 0

    os.makedirs(ICON_DIR, exist_ok=True)
    os.makedirs(ART_DIR, exist_ok=True)

    total = 0
    for name, body in sorted(icon_paths.items()):
        out = os.path.join(ICON_DIR, "%s.png" % name)
        render(build_icon_svg(body, COLOR_NORMAL), out, ICON_SIZE, ICON_SIZE, 1)
        optimize_png(out)
        total += os.path.getsize(out)
        if name in ACTIVE_ICONS:
            out = os.path.join(ICON_DIR, "%s-active.png" % name)
            render(build_icon_svg(body, COLOR_ACTIVE), out, ICON_SIZE, ICON_SIZE, 1)
            optimize_png(out)
            total += os.path.getsize(out)

    for out_name, icon_name, color in VARIANTS:
        if icon_name not in icon_paths:
            die("变体 %s 引用了原型里不存在的图标：%s" % (out_name, icon_name))
        out = os.path.join(ICON_DIR, "%s.png" % out_name)
        render(build_icon_svg(icon_paths[icon_name], color), out, ICON_SIZE, ICON_SIZE, 1)
        optimize_png(out)
        total += os.path.getsize(out)

    for name, svg in sorted(arts.items()):
        vb_w, vb_h, scale = ART_SPECS[name]
        out = os.path.join(ART_DIR, "%s.png" % name)
        render(svg, out, vb_w * scale, vb_h * scale, 1)
        optimize_png(out)
        total += os.path.getsize(out)

    print("✅ 已生成 %d 个图标文件（基础 %d×2 + 变体 %d）+ %d 幅插画，合计 %.1f KB"
          % (len(icon_paths) * 2 + len(VARIANTS), len(icon_paths), len(VARIANTS),
             len(arts), total / 1024.0))
    print("   输出目录：%s" % os.path.relpath(ASSET_ROOT, PROJECT_ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
