#!/usr/bin/env python3
"""Build assets/crew-vibes.ttf.

Speed indicator (16 runner frames, U+E700..U+E70F):
  traced from assets/runner-spritesheet.png (a 4x4 silhouette sprite sheet)
  via threshold -> morphological close -> Moore-neighbor boundary trace ->
  Douglas-Peucker simplify -> Chaikin smooth.

Capacity meter (6 boat-with-crew stages, U+E710..U+E715):
  drawn as vector silhouettes (half-ellipse hull + circle crew heads).

Regenerate after editing the sprite sheet or the capacity builder:

    python scripts/build-crew-vibes-font.py
"""
import math
import os
from PIL import Image, ImageFilter
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
SPRITE = os.path.join(ROOT, "assets", "runner-spritesheet.png")
TTF_OUT = os.path.join(ROOT, "assets", "crew-vibes.ttf")
UPM = 1000
ASCENT = 780
TH = 200  # threshold: pixel < TH is figure


# ---------- image -> contours ----------

def load_binary(path):
    im = Image.open(path).convert("L")
    W, H = im.size
    px = im.load()
    return [[px[x, y] < TH for x in range(W)] for y in range(H)], W, H


def detect_rows(b, W, H, min_height=80, gap=12):
    row_sum = [sum(1 for x in range(W) if b[y][x]) for y in range(H)]
    runs = []
    i = 0
    while i < H:
        if row_sum[i] > 0:
            j = i
            while j < H and row_sum[j] > 0:
                j += 1
            if j - i >= min_height:
                runs.append((i, j - 1))
            i = j
        else:
            i += 1
    merged = []
    for r in runs:
        if merged and r[0] - merged[-1][1] <= gap:
            merged[-1] = (merged[-1][0], r[1])
        else:
            merged.append(r)
    return merged


def connected_components_in_band(b, W, y0, y1, min_area=400):
    visited = [[False] * W for _ in range(y1 - y0)]
    comps = []
    for sy in range(y1 - y0):
        for sx in range(W):
            if b[y0 + sy][sx] and not visited[sy][sx]:
                stack = [(sx, sy)]
                visited[sy][sx] = True
                xs, ys, area = [], [], 0
                while stack:
                    x, y = stack.pop()
                    xs.append(x); ys.append(y); area += 1
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < W and 0 <= ny < (y1 - y0) and b[y0 + ny][nx] and not visited[ny][nx]:
                            visited[ny][nx] = True
                            stack.append((nx, ny))
                if area >= min_area:
                    comps.append((min(xs), y0 + min(ys), max(xs) + 1, y0 + max(ys) + 1))
    comps.sort(key=lambda c: c[0])
    return comps


def clean_binary(sub):
    h = len(sub); w = len(sub[0]) if h else 0
    if not h or not w:
        return sub
    im = Image.new("1", (w, h))
    px = im.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = 1 if sub[y][x] else 0
    im = im.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))
    px = im.load()
    return [[bool(px[x, y]) for x in range(w)] for y in range(h)]


def trim_bbox(cell):
    h = len(cell); w = len(cell[0]) if h else 0
    xs = [x for y in range(h) for x in range(w) if cell[y][x]]
    ys = [y for y in range(h) for x in range(w) if cell[y][x]]
    if not xs:
        return None
    return (min(xs), min(ys), max(xs) + 1, max(ys) + 1)


def moore_trace(b):
    h = len(b); w = len(b[0]) if h else 0
    start = None
    for y in range(h):
        for x in range(w):
            if b[y][x]:
                start = (x, y); break
        if start:
            break
    if not start:
        return []
    dirs = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)]
    contour = [start]
    cur = start
    bdir = 4
    while True:
        found = False
        for k in range(1, 9):
            d = (bdir + k) % 8
            nx, ny = cur[0] + dirs[d][0], cur[1] + dirs[d][1]
            if 0 <= nx < w and 0 <= ny < h and b[ny][nx]:
                bdir = (d + 4) % 8
                cur = (nx, ny)
                found = True
                break
        if not found:
            break
        if cur == start:
            break
        contour.append(cur)
    return contour


def point_line_dist(p, a, b):
    if a == b:
        return math.hypot(p[0] - a[0], p[1] - a[1])
    t = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2)
    t = max(0, min(1, t))
    return math.hypot(p[0] - (a[0] + t * (b[0] - a[0])), p[1] - (a[1] + t * (b[1] - a[1])))


def douglas_peucker(points, eps):
    if len(points) < 3:
        return points
    dmax = 0; idx = 0
    for i in range(1, len(points) - 1):
        d = point_line_dist(points[i], points[0], points[-1])
        if d > dmax:
            dmax = d; idx = i
    if dmax > eps:
        left = douglas_peucker(points[: idx + 1], eps)
        right = douglas_peucker(points[idx:], eps)
        return left[:-1] + right
    return [points[0], points[-1]]


def chaikin(points, iters=2):
    pts = points[:]
    for _ in range(iters):
        out = [pts[0]]
        for i in range(len(pts) - 1):
            a, b = pts[i], pts[i + 1]
            out.append((0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]))
            out.append((0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]))
        out.append(pts[-1])
        pts = out
    return pts


def trace_frame(b, cx0, cy0, cx1, cy1, pad=4, target_h=720):
    cell = [[b[y][x] for x in range(cx0, cx1)] for y in range(cy0, cy1)]
    bbox = trim_bbox(cell)
    if not bbox:
        return None
    x0, y0, x1, y1 = bbox
    px0 = max(0, x0 - pad); py0 = max(0, y0 - pad)
    px1 = min(cx1 - cx0, x1 + pad); py1 = min(cy1 - cy0, y1 + pad)
    sub = [[cell[y][x] for x in range(px0, px1)] for y in range(py0, py1)]
    sub = clean_binary(sub)
    chain = moore_trace(sub)
    if len(chain) < 6:
        return None
    chain = chain + [chain[0]]
    simp = douglas_peucker(chain, 1.5)
    sm = chaikin(simp, 2)
    if len(sm) < 6:
        return None
    pts = [(p[0] + cx0 + px0, p[1] + cy0 + py0) for p in sm]
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    fh = maxy - miny or 1
    scale = target_h / fh
    contour = [((p[0] - minx) * scale, (maxy - p[1]) * scale) for p in pts]
    advance = int(round((maxx - minx) * scale)) + 60
    return contour, advance


# ---------- vector capacity (boat + crew) ----------

def polygon(pen, pts):
    pen.moveTo(pts[0])
    for p in pts[1:]:
        pen.lineTo(p)
    pen.closePath()


def circle(pen, cx, cy, r, n=40):
    pts = [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)) for i in range(n)]
    polygon(pen, pts)


def capsule(pen, ax, ay, bx, by, r):
    dx, dy = bx - ax, by - ay
    length = math.hypot(dx, dy) or 1.0
    nx, ny = -dy / length, dx / length
    polygon(pen, [(ax + nx * r, ay + ny * r), (bx + nx * r, by + ny * r), (bx - nx * r, by - ny * r), (ax - nx * r, ay - ny * r)])
    circle(pen, ax, ay, r)
    circle(pen, bx, by, r)


def half_ellipse(pen, cx, cy, rx, ry, n=48):
    pts = [(cx + rx * math.cos(math.pi * i / n), cy - ry * math.sin(math.pi * i / n)) for i in range(n + 1)]
    polygon(pen, pts)


def draw_boat(pen, n, target_h=720):
    """Draw boat + n crew heads, fitting in target_h font units (baseline 0)."""
    s = target_h / 480.0  # design is 480 tall
    half_ellipse(pen, 380 * s, 140 * s, 320 * s, 130 * s)
    capsule(pen, 60 * s, 140 * s, 700 * s, 140 * s, 12 * s)
    capsule(pen, 20 * s, 10 * s, 740 * s, 10 * s, 9 * s)
    if n == 1:
        xs = [380]
    else:
        xs = [round(80 + i * (600 / (n - 1))) for i in range(n)]
    r = 52 if n <= 3 else (44 if n <= 4 else 36)
    for x in xs:
        head_y = 250 + (52 - r)
        circle(pen, x * s, head_y * s, r * s)
        capsule(pen, x * s, (head_y - r + 6) * s, x * s, 150 * s, r * 0.55 * s)


def capacity_glyph(n):
    pen = TTGlyphPen(None)
    draw_boat(pen, n)
    g = pen.glyph()
    xs = [pt[0] for pt in g.coordinates]
    advance = int(round(max(xs))) + 40 if xs else 700
    return g, advance


# ---------- assemble font ----------

def main():
    b, W, H = load_binary(SPRITE)
    rows = detect_rows(b, W, H)
    print(f"sprite {W}x{H}, rows: {rows}")
    glyphs = []  # (cp, name, glyph_obj_or_pen_draw, advance, lsb)

    fb = FontBuilder(UPM, isTTF=True)
    runner_names = [f"runner{i}" for i in range(16)]
    capacity_names = [f"crew{i}" for i in range(6)]
    order = [".notdef"] + runner_names + capacity_names
    cmap = {}
    for i, nm in enumerate(runner_names):
        cmap[0xE700 + i] = nm
    for i, nm in enumerate(capacity_names):
        cmap[0xE710 + i] = nm
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)
    fb.setupHorizontalHeader(ascent=ASCENT, descent=0)

    h_metrics = {".notdef": (UPM, 0)}
    glyf = {}
    nd = TTGlyphPen(None)
    glyf[".notdef"] = nd.glyph()

    idx = 0
    for (ry0, ry1) in rows:
        comps = connected_components_in_band(b, W, ry0, ry1, min_area=400)
        for (cx0, cy0, cx1, cy1) in comps:
            res = trace_frame(b, cx0, cy0, cx1, cy1)
            if res is None:
                print(f"  runner{idx}: empty")
                glyf[f"runner{idx}"] = TTGlyphPen(None).glyph()
                h_metrics[f"runner{idx}"] = (600, 0)
                idx += 1
                continue
            contour, advance = res
            pen = TTGlyphPen(None)
            pen.moveTo(contour[0])
            for p in contour[1:]:
                pen.lineTo(p)
            pen.closePath()
            glyf[f"runner{idx}"] = pen.glyph()
            h_metrics[f"runner{idx}"] = (advance, 0)
            print(f"  runner{idx}: {len(contour)} pts, advance {advance}")
            idx += 1
    if idx < 16:
        for k in range(idx, 16):
            glyf[f"runner{k}"] = TTGlyphPen(None).glyph()
            h_metrics[f"runner{k}"] = (600, 0)

    for i in range(6):
        g, advance = capacity_glyph(i + 1)
        glyf[f"crew{i}"] = g
        h_metrics[f"crew{i}"] = (advance, 0)
        print(f"  crew{i}: advance {advance}")

    fb.setupHorizontalMetrics(h_metrics)
    fb.setupGlyf(glyf)
    fb.setupNameTable({"familyName": "Crew Vibes", "styleName": "Regular"})
    fb.setupOS2(sTypoAscender=ASCENT, sTypoDescender=0, sTypoLineGap=0)
    fb.setupPost()
    fb.font.save(TTF_OUT)
    print(f"Wrote {TTF_OUT} ({os.path.getsize(TTF_OUT)} bytes)")


if __name__ == "__main__":
    main()
