# Yami

Desktop app for [gallery-dl](https://github.com/mikf/gallery-dl) and [yt-dlp](https://github.com/yt-dlp/yt-dlp) — download queue, local library, media preview, system tray, and native notifications.

[![Release](https://img.shields.io/github/v/release/rafaelnassar/Yami?label=release)](https://github.com/rafaelnassar/Yami/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/rafaelnassar/Yami/total)](https://github.com/rafaelnassar/Yami/releases)

**Site:** [rafaelnassar.github.io/Yami](https://rafaelnassar.github.io/Yami/) · **Download:** [latest release](https://github.com/rafaelnassar/Yami/releases/latest)

## Requirements

- **Run:** Windows 10+ (primary). Linux AppImage when published in releases.
- **Develop:** Node.js ≥ 22.18 and npm 10+

## Quick start

```bash
git clone https://github.com/rafaelnassar/Yami.git
cd Yami
npm ci
npm run dev
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev app with hot reload |
| `npm run check` | Typecheck + lint + tests |
| `npm run build` | Build Electron bundles + renderer |
| `npm run dist` | Build Windows installers into `release/` |

## License

[MIT](LICENSE) © Rafael Nassar
