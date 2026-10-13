#!/usr/bin/env python3
"""Export Yami app icons from the Lucide fish source PNG.

Produces RGB 8-bit sRGB PNGs (72 DPI) and a multi-size Windows .ico.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "resources" / "icons"
SOURCE_DIR = ROOT / "resources" / "icon-source"
SOURCE = SOURCE_DIR / "icon-source.png"
SOURCE_TRAY = SOURCE_DIR / "icon-source-tray.png"
SIZES = (16, 32, 48, 128, 256)
DPI = (72, 72)


def to_srgb_rgb(image: Image.Image) -> Image.Image:
    if image.mode in ("RGBA", "LA"):
        background = Image.new("RGB", image.size, (9, 9, 8))  # #090908
        alpha = image.getchannel("A") if "A" in image.getbands() else None
        base = image.convert("RGBA")
        background.paste(base, mask=alpha)
        return background
    return image.convert("RGB")


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"Missing source: {SOURCE}")

    master = to_srgb_rgb(Image.open(SOURCE))
    if master.size != (256, 256):
        master = master.resize((256, 256), Image.Resampling.LANCZOS)

    tray_master = master
    if SOURCE_TRAY.exists():
        tray_master = to_srgb_rgb(Image.open(SOURCE_TRAY))
        if tray_master.size != (256, 256):
            tray_master = tray_master.resize((256, 256), Image.Resampling.LANCZOS)

    ICONS.mkdir(parents=True, exist_ok=True)
    png_paths: list[Path] = []
    for size in SIZES:
        src = tray_master if size <= 32 else master
        out = ICONS / f"icon-{size}.png"
        src.resize((size, size), Image.Resampling.LANCZOS).save(out, format="PNG", dpi=DPI, optimize=True)
        print(f"wrote {out.name}")
        png_paths.append(out)

    # multi-size ICO (embedded PNGs) for Windows window + tray
    import struct

    entries = [(size, path.read_bytes()) for size, path in zip(SIZES, png_paths, strict=True)]
    header = bytearray(6)
    header[2] = 1
    header[4] = len(entries)
    directory = bytearray(len(entries) * 16)
    offset = 6 + len(directory)
    blobs: list[bytes] = []
    for index, (size, png) in enumerate(entries):
        pos = index * 16
        directory[pos] = 0 if size >= 256 else size
        directory[pos + 1] = 0 if size >= 256 else size
        directory[pos + 4] = 1
        directory[pos + 6] = 32
        struct.pack_into("<I", directory, pos + 8, len(png))
        struct.pack_into("<I", directory, pos + 12, offset)
        offset += len(png)
        blobs.append(png)
    ico_path = ICONS / "icon.ico"
    ico_path.write_bytes(bytes(header) + bytes(directory) + b"".join(blobs))
    print(f"wrote {ico_path.name}")

    # user-requested master name (kept with sources, not packaged)
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    master.save(SOURCE_DIR / "Icon.png", format="PNG", dpi=DPI, optimize=True)
    print("wrote resources/icon-source/Icon.png")


if __name__ == "__main__":
    main()
