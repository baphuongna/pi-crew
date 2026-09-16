#!/usr/bin/env python3
"""render_png.py — render docs/ui-samples/captures/*.txt thành PNG kiểu terminal.

Mọi .txt trong captures/ đều do capture.ts sinh ra (render function THẬT với
fixture). Script này KHÔNG viết file capture nào; nó chỉ:

  1. đọc từng .txt trong captures/,
  2. thay emoji/ký tự mà DejaVuSansMono không có bằng ký tự ASCII,
  3. strip ANSI escape (màu do rail/theme phát ra),
  4. vẽ lên nền tối kiểu terminal (title bar + khung) và ghi vào png/,
  5. xoá mọi PNG mồ côi (không còn .txt tương ứng).

Chạy (từ repo root):
  python3 docs/ui-samples/render_png.py
"""
import os
import re
import sys

from PIL import Image, ImageDraw, ImageFont

# Thư mục của script = docs/ui-samples (chạy được từ bất kỳ cwd nào).
HERE = os.path.dirname(os.path.abspath(__file__))
CAP = os.path.join(HERE, "captures")
PNG = os.path.join(HERE, "png")
os.makedirs(PNG, exist_ok=True)

# ── Title cho title bar của từng surface (thứ tự = thứ tự surface) ──────
TITLES = [
    ("01-dock-widget.txt", "1. Dock widget (1 dòng, dưới editor)"),
    ("02-task-list-widget.txt", "2. Task-list widget (trên editor)"),
    ("03-statusline.txt", "3. Status-line segment"),
    ("04-powerbar.txt", "4. Powerbar segments (4)"),
    ("05-dashboard-panes.txt", "5. Dashboard 8 pane (1–8)"),
    ("06-help-overlay.txt", "6. Help overlay (?)"),
    ("07-confirm-overlay.txt", "7. Confirm overlay"),
    ("08-mascot.txt", "8. Mascot (/team-mascot)"),
    ("09-tool-renderers.txt", "9. Tool renderers (team + agent)"),
    ("10-dwf-phase.txt", "10. DWF phase display"),
    ("11-crew-vibes.txt", "11. crew-vibes footer"),
    ("12-terminal-status.txt", "12. Terminal status (OSC 9;4)"),
    ("13-run-dashboard.txt", "13. Run dashboard"),
    ("14-agents-jobs-browser.txt", "14. Agents & Jobs browser"),
    ("15-inline-panel.txt", "15. Inline panel"),
    ("16-transcript-viewer.txt", "16. Transcript viewer"),
    ("17-live-conversation-overlay.txt", "17. Live conversation overlay"),
    ("18-settings.txt", "18. Settings overlay"),
]

# ── font coverage check (a catalog image must never show tofu) ──────────

_GLYPH_CACHE: dict[str, bool] = {}
_TOFU_REF: bytes | None = None


def _has_glyph(ch: str) -> bool:
    """True when the rendering font has a real glyph for `ch` (not .notdef)."""
    if " " == ch or "\n" == ch:
        return True
    if ch in _GLYPH_CACHE:
        return _GLYPH_CACHE[ch]
    global _TOFU_REF
    font = ImageFont.truetype(FONT, FS)
    if _TOFU_REF is None:
        ref = Image.new("L", (40, 40), 0)
        ImageDraw.Draw(ref).text((5, 5), "\ue000", font=font, fill=255)  # private use
        _TOFU_REF = ref.tobytes()
    img = Image.new("L", (40, 40), 0)
    ImageDraw.Draw(img).text((5, 5), ch, font=font, fill=255)
    _GLYPH_CACHE[ch] = img.tobytes() != _TOFU_REF
    return _GLYPH_CACHE[ch]


FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
# Line height must equal the glyph box, otherwise the RAIL column (`┃`) paints as
# a dashed line: box-drawing glyphs are designed to meet at the cell boundary, so
# any extra leading opens a visible gap between rows.
FS, LH, PAD = 15, 15, 16
# emoji DejaVu không có → thay bằng ký hiệu ASCII chỉ trong PNG
EMOJI = {
    "⚙": "*", "📐": "L", "🤖": "A", "🖥": "U", "🎨": "T", "🚀": "R", "🔧": "X",
    "▶": ">", "◀": "<", "⏰": "o", "⏳": "w", "⏸": "||", "❯": ">",
    # DejaVu Sans Mono has every rail/box/block glyph (┏ ┃ ┗ ┣ ▸ ▕ █ ░) but NOT
    # these four — without a mapping they paint as tofu (□) in the catalog PNG,
    # e.g. the "running" status icon. Map them to the closest glyph the font has.
    "⟳": "↻", "⟲": "↺", "⎿": "└", "⌛": "h", "⏱": "o",
}

# Braille patterns (U+2800–U+28FF) ARE the running spinner frames; DejaVu Sans
# Mono has no braille block at all, so every in-flight row would paint tofu.
# A single half-filled circle reads as "in progress" and is frame-independent
# (the catalog is a still image, so animating the frames would be noise).
BRAILLE_TO = "◐"


def _substitute(ln: str) -> str:
    for k, v in EMOJI.items():
        ln = ln.replace(k, v)
    return "".join(BRAILLE_TO if 0x2800 <= ord(c) <= 0x28FF else c for c in ln)


def to_png(txt_path: str, title: str) -> str:
    with open(txt_path, encoding="utf-8") as f:
        raw_lines = f.read().rstrip("\n").split("\n")
    lines = []
    for ln in raw_lines:
        lines.append(_substitute(ln))
    # strip ANSI cho PNG (màu đồng nhất theo dòng)
    lines = [re.sub(r"\x1b\[[0-9;]*m", "", ln) for ln in lines]
    missing = sorted({c for ln in lines for c in ln if not _has_glyph(c)})
    if missing:
        raise SystemExit(
            f"[render_png] {txt_path}: font {os.path.basename(FONT)} cannot paint "
            f"{' '.join(repr(c) for c in missing)} — add a mapping to EMOJI instead of "
            "shipping a catalog image with tofu boxes."
        )
    maxw = max(len(ln) for ln in lines)
    width = maxw * 9 + PAD * 2 + 2
    height = (len(lines) + 2) * LH + PAD * 2 + 4
    img = Image.new("RGB", (width, height), "#0d1117")
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT, FS)
    bold = ImageFont.truetype(FONT.replace(".ttf", "-Bold.ttf"), FS)
    # title bar
    d.rectangle([0, 0, width, LH + PAD], fill="#161b22")
    d.text((PAD, PAD), f"pi-crew — {title}", font=bold, fill="#f0883e")
    d.line([(0, LH + PAD + 1), (width, LH + PAD + 1)], fill="#30363d")
    y = PAD * 2 + LH
    for ln in lines:
        is_hdr = ln.startswith("###") or ln.startswith("───") or ln.startswith("═══")
        color = "#7ee787" if is_hdr else ("#79c0ff" if ln.startswith(" ") else "#e6edf3")
        d.text((PAD, y), ln, font=font, fill=color)
        y += LH
    d.rectangle([0, 0, width - 1, height - 1], outline="#30363d", width=1)
    out = os.path.join(PNG, os.path.basename(txt_path).replace(".txt", ".png"))
    img.save(out)
    return out


def main() -> int:
    on_disk = sorted(f for f in os.listdir(CAP) if f.endswith(".txt"))

    # Mọi .txt phải được khai báo title — surface mới mà quên title là lỗi rõ ràng.
    declared = [fn for fn, _ in TITLES]
    undeclared = [fn for fn in on_disk if fn not in declared]
    if undeclared:
        print(f"ERROR: captures/ có .txt chưa khai báo title: {', '.join(undeclared)}", file=sys.stderr)
        return 1

    missing = [fn for fn in declared if fn not in on_disk]
    if missing:
        print(f"ERROR: thiếu capture (chạy capture.ts trước): {', '.join(missing)}", file=sys.stderr)
        return 1

    expected_png = set()
    for fn, title in TITLES:
        out = to_png(os.path.join(CAP, fn), title)
        expected_png.add(os.path.basename(out))
        print("✓", os.path.relpath(out, HERE))

    # PNG mồ côi (không còn .txt nguồn) — xoá để png/ khớp captures/.
    for fn in sorted(os.listdir(PNG)):
        if fn.endswith(".png") and fn not in expected_png:
            os.remove(os.path.join(PNG, fn))
            print("✗ removed orphan", os.path.join("png", fn))

    print("DONE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
