// @ts-check
'use strict';
/**
 * electron-builder configuration (`npm run pack | dist | release`).
 *
 * Inputs: `npm run build` must have produced dist-electron/ (main, preload, host bundles + icons) and dist/renderer/.
 * The host is bundled into dist-electron/host.cjs, so nothing ships outside the asar.
 *
 * Code signing is opt-in through environment variables — without them the build is unsigned (fine for local
 * testing; users will see SmartScreen/Gatekeeper warnings):
 *
 *   Windows, PFX certificate (read by electron-builder itself):
 *     CSC_LINK / WIN_CSC_LINK                 path, https URL or base64 of the .pfx/.p12
 *     CSC_KEY_PASSWORD / WIN_CSC_KEY_PASSWORD password of the certificate
 *     WIN_PUBLISHER_NAME                      optional; defaults to the certificate's CN (used by auto-update checks)
 *
 *   Windows, Azure Trusted Signing (takes precedence over the PFX):
 *     AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET   Entra ID app credentials (read by the signing tool)
 *     AZURE_CODE_SIGNING_ENDPOINT             e.g. https://eus.codesigning.azure.net/
 *     AZURE_CODE_SIGNING_ACCOUNT              Trusted Signing account name
 *     AZURE_CODE_SIGNING_PROFILE              certificate profile name
 *     AZURE_CODE_SIGNING_PUBLISHER            publisher name exactly as in the certificate (CN)
 *
 *   macOS: CSC_LINK + CSC_KEY_PASSWORD (Developer ID Application .p12) or a keychain identity; notarization runs
 *     when APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER (preferred) or APPLE_ID +
 *     APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID are set.
 *
 *   YAMI_REQUIRE_SIGNING=1  fail the build instead of producing unsigned artifacts. The release workflow always sets
 *                           it, unless the repository variable YAMI_ALLOW_UNSIGNED=1 opts into an unsigned release.
 *
 * Publishing (`--publish always`) needs GH_TOKEN with `contents: write` on the repository below.
 */
const fs = require('node:fs');
const path = require('node:path');

const env = process.env;
/** @param {string | undefined} value */
const isSet = (value) => typeof value === 'string' && value.trim() !== '';

const AZURE_VARS = /** @type {const} */ ([
  'AZURE_CODE_SIGNING_ENDPOINT',
  'AZURE_CODE_SIGNING_ACCOUNT',
  'AZURE_CODE_SIGNING_PROFILE',
  'AZURE_CODE_SIGNING_PUBLISHER'
]);

/**
 * Picks the Windows signing method from the environment. A partial Azure configuration is an error: silently
 * falling back to an unsigned build would ship something nobody intended.
 * @returns {'azure' | 'pfx' | 'none'}
 */
function windowsSigningMode() {
  const azureSet = AZURE_VARS.filter((name) => isSet(env[name]));
  if (azureSet.length === AZURE_VARS.length) return 'azure';
  if (azureSet.length > 0) {
    const missing = AZURE_VARS.filter((name) => !isSet(env[name]));
    throw new Error(`Azure Trusted Signing is partially configured; missing: ${missing.join(', ')}`);
  }
  return isSet(env.WIN_CSC_LINK) || isSet(env.CSC_LINK) ? 'pfx' : 'none';
}

const winSigning = windowsSigningMode();
const winSigned = winSigning !== 'none';
const canNotarize =
  (isSet(env.APPLE_API_KEY) && isSet(env.APPLE_API_KEY_ID) && isSet(env.APPLE_API_ISSUER)) ||
  (isSet(env.APPLE_ID) && isSet(env.APPLE_APP_SPECIFIC_PASSWORD) && isSet(env.APPLE_TEAM_ID)) ||
  (isSet(env.APPLE_KEYCHAIN) && isSet(env.APPLE_KEYCHAIN_PROFILE));

/** @type {import('app-builder-lib').WindowsConfiguration['azureSignOptions']} */
const azureSignOptions =
  winSigning === 'azure'
    ? {
        endpoint: String(env.AZURE_CODE_SIGNING_ENDPOINT),
        codeSigningAccountName: String(env.AZURE_CODE_SIGNING_ACCOUNT),
        certificateProfileName: String(env.AZURE_CODE_SIGNING_PROFILE),
        publisherName: String(env.AZURE_CODE_SIGNING_PUBLISHER)
      }
    : null;

/** @type {import('app-builder-lib').WindowsConfiguration['signtoolOptions']} */
const signtoolOptions =
  winSigning === 'pfx'
    ? {
        // The certificate itself comes from CSC_LINK / CSC_KEY_PASSWORD (never put it in this file).
        signingHashAlgorithms: ['sha256'],
        rfc3161TimeStampServer: 'http://timestamp.digicert.com',
        ...(isSet(env.WIN_PUBLISHER_NAME) ? { publisherName: String(env.WIN_PUBLISHER_NAME) } : {})
      }
    : null;

// macOS needs an .icns (or a ≥512 px PNG); until one is added electron-builder falls back to the Electron icon.
const MAC_ICON = 'resources/icons/icon.icns';
const macIcon = fs.existsSync(path.join(__dirname, MAC_ICON)) ? MAC_ICON : undefined;

/** @type {import('app-builder-lib').Configuration} */
const config = {
  appId: 'io.yami.desktop', // Also the Windows AppUserModelId (notifications) and the NSIS upgrade GUID seed.
  productName: 'Yami',
  directories: {
    output: 'release',
    buildResources: 'resources'
  },
  // Only the built app — never cookies, downloads, vault data, keys, or local runtime folders.
  files: [
    'dist-electron/**',
    'dist/renderer/**',
    'package.json',
    '!**/*.map',
    '!**/cookies{,/**}',
    '!**/downloads{,/**}',
    '!**/native-host{,/**}',
    '!**/.env',
    '!**/.env.*',
    '!**/*.{pem,pfx,p12,key}',
    '!**/credentials.json'
  ],
  asar: true,
  // No native modules and no runtime dependencies: skip the (slow, toolchain-dependent) rebuild step.
  npmRebuild: false,
  // Chromium UI strings only for the languages the app ships (pt/en/es); drops tens of MB of locale .pak files.
  electronLanguages: ['en-US', 'pt-BR', 'pt-PT', 'es', 'es-419'],
  forceCodeSigning: env.YAMI_REQUIRE_SIGNING === '1',

  electronFuses: {
    runAsNode: false, // The host runs in a utilityProcess, so ELECTRON_RUN_AS_NODE is never needed.
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    grantFileProtocolExtraPrivileges: false, // The renderer is served from app://, never file://.
    // Only acts on macOS .app bundles: keeps unsigned arm64 builds launchable after the fuses are flipped.
    resetAdHocDarwinSignature: true
  },

  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] }
    ],
    icon: 'resources/icons/icon.ico',
    signtoolOptions,
    azureSignOptions,
    // electron-updater checks the update's signature against the publisher name only when we actually sign.
    verifyUpdateCodeSignature: winSigned
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false, // Downloads history, settings and the vault survive a reinstall.
    artifactName: '${productName}-Setup-${version}-${arch}.${ext}'
  },
  portable: {
    artifactName: '${productName}-Portable-${version}-${arch}.${ext}'
  },

  mac: {
    target: [
      { target: 'dmg', arch: ['x64', 'arm64'] },
      { target: 'zip', arch: ['x64', 'arm64'] } // electron-updater on macOS updates from the zip.
    ],
    category: 'public.app-category.utilities',
    hardenedRuntime: true,
    notarize: canNotarize,
    ...(macIcon ? { icon: macIcon } : {})
  },
  dmg: {
    artifactName: '${productName}-${version}-${arch}.${ext}'
  },

  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }],
    icon: 'resources/icons/icon-256.png',
    category: 'Network',
    synopsis: 'Interface desktop para gallery-dl e yt-dlp',
    artifactName: '${productName}-${version}-${arch}.${ext}'
  },

  publish: [
    {
      provider: 'github',
      owner: 'rafaelnassar',
      repo: 'Yami',
      releaseType: 'release'
    }
  ]
};

module.exports = config;
