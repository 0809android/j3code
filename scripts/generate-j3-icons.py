#!/usr/bin/env python3
"""
J3 Code オリジナルブランドアイコン生成スクリプト。
assets/{prod,dev,nightly} の全 PNG / ICO および apps/web/public のアイコンを一括生成する。
"""

from __future__ import annotations

import io
import math
import os
import struct
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

REPO_ROOT = Path(__file__).resolve().parent.parent

WINDOWS_ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
FAVICON_ICO_SIZES = (16, 32, 48)


def find_bold_font_path() -> Path:
    """アプリ公式の DM Sans ExtraBold / Bold を優先探索し、無ければシステム太字へフォールバック。"""
    pnpm_dir = REPO_ROOT / "node_modules" / ".pnpm"
    if pnpm_dir.exists():
        for pattern in (
            "*dm-sans*/node_modules/@expo-google-fonts/dm-sans/800ExtraBold/DMSans_800ExtraBold.ttf",
            "*dm-sans*/node_modules/@expo-google-fonts/dm-sans/700Bold/DMSans_700Bold.ttf",
        ):
            matches = sorted(pnpm_dir.glob(pattern))
            if matches:
                return matches[0]
    for fallback in (
        Path("C:/Windows/Fonts/segoeuib.ttf"),
        Path("C:/Windows/Fonts/arialbd.ttf"),
        Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
    ):
        if fallback.exists():
            return fallback
    raise FileNotFoundError("No bold TrueType font found for J3 icon generation.")


FONT_PATH = find_bold_font_path()


def encode_png_ico(images: list[tuple[int, bytes]]) -> bytes:
    """scripts/lib/icon-export.ts と同一仕様の PNG-in-ICO エンコーダ。"""
    header_size = 6
    dir_size = 16 * len(images)
    offset = header_size + dir_size
    parts = [struct.pack("<HHH", 0, 1, len(images))]
    payloads: list[bytes] = []
    for size, png_bytes in images:
        dim = 0 if size == 256 else size
        parts.append(struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(png_bytes), offset))
        offset += len(png_bytes)
        payloads.append(png_bytes)
    return b"".join(parts + payloads)


def png_bytes_from_image(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def create_squircle_mask(size: int, radius_ratio: float = 0.225) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    radius = int(round(size * radius_ratio))
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def render_gradient_bg(
    size: int,
    top_left: tuple[int, int, int],
    bottom_right: tuple[int, int, int],
    glow_color: tuple[int, int, int],
    glow_strength: float = 0.34,
    grid: bool = False,
) -> Image.Image:
    """滑らかな斜めグラデーション＋ラジアルアクセントグロウを生成する。"""
    small = 256
    bg = Image.new("RGBA", (small, small))
    px = bg.load()
    assert px is not None
    for y in range(small):
        ny = y / (small - 1)
        for x in range(small):
            nx = x / (small - 1)
            t = 0.55 * ny + 0.45 * nx
            r = top_left[0] * (1 - t) + bottom_right[0] * t
            g = top_left[1] * (1 - t) + bottom_right[1] * t
            b = top_left[2] * (1 - t) + bottom_right[2] * t

            # 右下寄りの微細なオーロラグロウ
            dx = nx - 0.78
            dy = ny - 0.22
            dist = math.sqrt(dx * dx + dy * dy)
            glow = max(0.0, 1.0 - dist / 0.85) ** 2.2 * glow_strength
            r = min(255.0, r + glow_color[0] * glow)
            g = min(255.0, g + glow_color[1] * glow)
            b = min(255.0, b + glow_color[2] * glow)

            px[x, y] = (int(r), int(g), int(b), 255)

    img = bg.resize((size, size), Image.Resampling.BICUBIC)

    if grid:
        overlay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        step = size // 12
        line_w = max(1, size // 256)
        for i in range(step, size, step):
            draw.line([(i, 0), (i, size)], fill=(125, 211, 252, 26), width=line_w)
            draw.line([(0, i), (size, i)], fill=(125, 211, 252, 26), width=line_w)
        img = Image.alpha_composite(img, overlay)

    return img


def draw_j3_glyphs(
    canvas: Image.Image,
    accent_color: tuple[int, int, int],
    scale_factor: float = 1.0,
) -> Image.Image:
    """
    DM Sans ExtraBold による光学補正済み "J3" モノグラム＋アクセントバーを描画する。
    高解像度キャンバス（2048x2048）に描いてダウンサンプリングすることで超滑らかなエッジを得る。
    """
    size = canvas.width
    glyph_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(glyph_layer)

    white = (248, 250, 252, 255)
    accent = (*accent_color, 255)

    font_size = int(round(size * 0.56 * scale_factor))
    font = ImageFont.truetype(str(FONT_PATH), font_size)

    # J と 3 のカーニングを光学的に最適配置して中央揃え
    letter_gap = -int(round(size * 0.012 * scale_factor))
    j_bbox = draw.textbbox((0, 0), "J", font=font)
    three_bbox = draw.textbbox((0, 0), "3", font=font)
    j_w = j_bbox[2] - j_bbox[0]
    three_w = three_bbox[2] - three_bbox[0]
    total_w = j_w + letter_gap + three_w
    min_top = min(j_bbox[1], three_bbox[1])
    max_bot = max(j_bbox[3], three_bbox[3])
    total_h = max_bot - min_top

    start_x = (size - total_w) / 2.0
    # 下部アクセントバーの余白を考慮してわずかに上寄せ
    base_y = (size - total_h) / 2.0 - min_top - size * 0.045 * scale_factor

    draw.text((start_x - j_bbox[0], base_y), "J", font=font, fill=white)
    draw.text((start_x + j_w + letter_gap - three_bbox[0], base_y), "3", font=font, fill=white)

    # 下部のシャープなアクセントバー（J3 Code の象徴ライン）
    bar_w = size * 0.30 * scale_factor
    bar_h = size * 0.036 * scale_factor
    bar_x0 = (size - bar_w) / 2.0
    bar_y0 = base_y + max_bot + size * 0.072 * scale_factor
    draw.rounded_rectangle(
        (bar_x0, bar_y0, bar_x0 + bar_w, bar_y0 + bar_h),
        radius=bar_h / 2.0,
        fill=accent,
    )

    # ほのかなドロップシャドウで立体感を出す
    shadow = glyph_layer.split()[3].filter(ImageFilter.GaussianBlur(radius=size * 0.018))
    shadow_img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow_fill = Image.new("RGBA", (size, size), (0, 0, 0, 125))
    shadow_img.paste(shadow_fill, (0, int(size * 0.016)), shadow)

    out = Image.alpha_composite(canvas, shadow_img)
    out = Image.alpha_composite(out, glyph_layer)
    return out


def render_master_icon(
    *,
    top_left: tuple[int, int, int],
    bottom_right: tuple[int, int, int],
    glow_color: tuple[int, int, int],
    accent_color: tuple[int, int, int],
    border_color: tuple[int, int, int, int],
    rounded: bool,
    grid: bool = False,
    padding_ratio: float = 0.0,
) -> Image.Image:
    work_size = 2048
    bg = render_gradient_bg(work_size, top_left, bottom_right, glow_color, grid=grid)
    full = draw_j3_glyphs(bg, accent_color=accent_color, scale_factor=0.92 if rounded else 0.88)

    if rounded:
        # 繊細な内側ハイライト枠
        border_layer = Image.new("RGBA", (work_size, work_size), (0, 0, 0, 0))
        bd = ImageDraw.Draw(border_layer)
        inset = int(work_size * 0.014)
        radius = int(work_size * 0.225) - inset
        bd.rounded_rectangle(
            (inset, inset, work_size - 1 - inset, work_size - 1 - inset),
            radius=radius,
            outline=border_color,
            width=max(4, work_size // 128),
        )
        full = Image.alpha_composite(full, border_layer)

        mask = create_squircle_mask(work_size, 0.225)
        shaped = Image.new("RGBA", (work_size, work_size), (0, 0, 0, 0))
        shaped.paste(full, (0, 0), mask)
        full = shaped

    if padding_ratio > 0:
        inner_size = int(round(work_size * (1.0 - padding_ratio * 2)))
        resized = full.resize((inner_size, inner_size), Image.Resampling.LANCZOS)
        padded = Image.new("RGBA", (work_size, work_size), (0, 0, 0, 0))
        pad = (work_size - inner_size) // 2
        padded.paste(resized, (pad, pad), resized)
        full = padded

    return full.resize((1024, 1024), Image.Resampling.LANCZOS)


def save_resized_png(master: Image.Image, size: int, dest: Path) -> bytes:
    resized = master.resize((size, size), Image.Resampling.LANCZOS)
    data = png_bytes_from_image(resized)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return data


def save_ico(master: Image.Image, sizes: tuple[int, ...], dest: Path) -> None:
    renditions = [
        (size, png_bytes_from_image(master.resize((size, size), Image.Resampling.LANCZOS)))
        for size in sizes
    ]
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(encode_png_ico(renditions))


def generate_variant(
    *,
    name: str,
    top_left: tuple[int, int, int],
    bottom_right: tuple[int, int, int],
    glow_color: tuple[int, int, int],
    accent_color: tuple[int, int, int],
    border_color: tuple[int, int, int, int],
    outputs: dict[str, str],
    grid: bool = False,
) -> None:
    ios_master = render_master_icon(
        top_left=top_left,
        bottom_right=bottom_right,
        glow_color=glow_color,
        accent_color=accent_color,
        border_color=border_color,
        rounded=False,
        grid=grid,
    )
    universal_master = render_master_icon(
        top_left=top_left,
        bottom_right=bottom_right,
        glow_color=glow_color,
        accent_color=accent_color,
        border_color=border_color,
        rounded=True,
        grid=grid,
    )
    macos_master = render_master_icon(
        top_left=top_left,
        bottom_right=bottom_right,
        glow_color=glow_color,
        accent_color=accent_color,
        border_color=border_color,
        rounded=True,
        grid=grid,
        padding_ratio=0.075,
    )

    save_resized_png(ios_master, 1024, REPO_ROOT / outputs["ios"])
    save_resized_png(macos_master, 1024, REPO_ROOT / outputs["macos"])
    save_resized_png(universal_master, 1024, REPO_ROOT / outputs["universal"])
    save_resized_png(ios_master, 180, REPO_ROOT / outputs["apple_touch"])
    save_resized_png(universal_master, 192, REPO_ROOT / outputs["web192"])
    save_resized_png(universal_master, 512, REPO_ROOT / outputs["web512"])
    save_resized_png(universal_master, 16, REPO_ROOT / outputs["fav16"])
    save_resized_png(universal_master, 32, REPO_ROOT / outputs["fav32"])
    save_ico(universal_master, FAVICON_ICO_SIZES, REPO_ROOT / outputs["fav_ico"])
    save_ico(universal_master, WINDOWS_ICO_SIZES, REPO_ROOT / outputs["win_ico"])
    print(f"[generate-j3-icons] Generated variant '{name}' (10 files)")


def main() -> None:
    # 1. Production: Deep Midnight Slate -> Rich Emerald Teal + Emerald Accent
    generate_variant(
        name="prod",
        top_left=(11, 18, 32),
        bottom_right=(13, 47, 58),
        glow_color=(16, 185, 129),
        accent_color=(52, 211, 153),
        border_color=(52, 211, 153, 95),
        outputs={
            "ios": "assets/prod/black-ios-1024.png",
            "macos": "assets/prod/black-macos-1024.png",
            "universal": "assets/prod/black-universal-1024.png",
            "apple_touch": "assets/prod/t3-black-web-apple-touch-180.png",
            "web192": "assets/prod/t3-black-web-icon-192x192.png",
            "web512": "assets/prod/t3-black-web-icon-512x512.png",
            "fav16": "assets/prod/t3-black-web-favicon-16x16.png",
            "fav32": "assets/prod/t3-black-web-favicon-32x32.png",
            "fav_ico": "assets/prod/t3-black-web-favicon.ico",
            "win_ico": "assets/prod/t3-black-windows.ico",
        },
    )

    # 2. Development: Blueprint Deep Cyan + Grid + Sky Accent
    generate_variant(
        name="dev",
        top_left=(10, 31, 56),
        bottom_right=(17, 68, 114),
        glow_color=(56, 189, 248),
        accent_color=(56, 189, 248),
        border_color=(125, 211, 252, 115),
        grid=True,
        outputs={
            "ios": "assets/dev/blueprint-ios-1024.png",
            "macos": "assets/dev/blueprint-macos-1024.png",
            "universal": "assets/dev/blueprint-universal-1024.png",
            "apple_touch": "assets/dev/blueprint-web-apple-touch-180.png",
            "web192": "assets/dev/blueprint-web-icon-192x192.png",
            "web512": "assets/dev/blueprint-web-icon-512x512.png",
            "fav16": "assets/dev/blueprint-web-favicon-16x16.png",
            "fav32": "assets/dev/blueprint-web-favicon-32x32.png",
            "fav_ico": "assets/dev/blueprint-web-favicon.ico",
            "win_ico": "assets/dev/blueprint-windows.ico",
        },
    )

    # 3. Nightly / Preview: Deep Indigo Violet + Amber Accent
    generate_variant(
        name="nightly",
        top_left=(26, 16, 48),
        bottom_right=(54, 24, 86),
        glow_color=(245, 158, 11),
        accent_color=(251, 191, 36),
        border_color=(251, 191, 36, 105),
        outputs={
            "ios": "assets/nightly/nightly-ios-1024.png",
            "macos": "assets/nightly/nightly-macos-1024.png",
            "universal": "assets/nightly/nightly-universal-1024.png",
            "apple_touch": "assets/nightly/nightly-web-apple-touch-180.png",
            "web192": "assets/nightly/nightly-web-icon-192x192.png",
            "web512": "assets/nightly/nightly-web-icon-512x512.png",
            "fav16": "assets/nightly/nightly-web-favicon-16x16.png",
            "fav32": "assets/nightly/nightly-web-favicon-32x32.png",
            "fav_ico": "assets/nightly/nightly-web-favicon.ico",
            "win_ico": "assets/nightly/nightly-windows.ico",
        },
    )

    # 4. Web public icons (dev default + prod sync)
    web_public_map = {
        "assets/prod/t3-black-web-favicon.ico": "apps/web/public/favicon.ico",
        "assets/prod/t3-black-web-favicon-16x16.png": "apps/web/public/favicon-16x16.png",
        "assets/prod/t3-black-web-favicon-32x32.png": "apps/web/public/favicon-32x32.png",
        "assets/prod/t3-black-web-apple-touch-180.png": "apps/web/public/apple-touch-icon.png",
        "assets/prod/t3-black-web-icon-192x192.png": "apps/web/public/icon-192x192.png",
        "assets/prod/t3-black-web-icon-512x512.png": "apps/web/public/icon-512x512.png",
    }
    for src_rel, dst_rel in web_public_map.items():
        (REPO_ROOT / dst_rel).write_bytes((REPO_ROOT / src_rel).read_bytes())
    print("[generate-j3-icons] Synced apps/web/public icons (6 files)")


if __name__ == "__main__":
    main()
