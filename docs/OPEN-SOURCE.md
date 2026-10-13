# Security & release checklist (maintainers)

Before making the repository public or pushing to `main`:

1. `npm run check:secrets` — no cookies, downloads, keys, or credentials tracked / in the repo root.
2. Releases are unsigned by default. When you have a cert, set the signing secrets and `YAMI_REQUIRE_SIGNING=1`.
3. Confirm `electron-builder.config.cjs` `publish.owner` / `publish.repo` match the public GitHub repo.
4. Push to `main` → Release workflow publishes installers + `latest.yml` for electron-updater.

Personal runtime data stays on the machine:

| Local (gitignored) | Notes                                                             |
| ------------------ | ----------------------------------------------------------------- |
| `/downloads`       | User media — never commit                                         |
| `/cookies`         | Session jars — never commit; prod vault is under `%APPDATA%\Yami` |
| `.pem` / `.pfx`    | Keep outside the clone (e.g. `Documents\yami-secrets`)            |

The installer only packs `dist-electron/**`, `dist/renderer/**` and `package.json`. Cookie files are never shipped.
