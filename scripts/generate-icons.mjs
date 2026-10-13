#!/usr/bin/env node
/**
 * Gera os PNGs e o ICO do app a partir da imagem-fonte (peixe Lucide no graphite).
 *
 * Uso:
 *   node scripts/generate-icons.mjs [caminho-da-imagem]
 *
 * Padrão: resources/icon-source/icon-source.png (256×256, fundo #090908).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT_DIR, 'resources', 'icons');
const SOURCE_PATH = path.resolve(process.argv[2] || path.join(ROOT_DIR, 'resources', 'icon-source', 'icon-source.png'));
const SIZES = [16, 32, 48, 128, 256];

if (!fs.existsSync(SOURCE_PATH)) {
  throw new Error(`Imagem-fonte não encontrada: ${SOURCE_PATH}`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const resizeScript = path.join(__dirname, 'resize-icons.ps1');
const resizeResult = spawnSync(
  'powershell.exe',
  [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    resizeScript,
    '-SourcePath',
    SOURCE_PATH,
    '-OutputDirectory',
    OUT_DIR,
    '-Sizes',
    SIZES.join(',')
  ],
  { stdio: 'inherit', windowsHide: true }
);

if (resizeResult.status !== 0) {
  throw new Error('Não foi possível gerar os PNGs do ícone.');
}

function makeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(entries.length * 16);
  let offset = header.length + directory.length;
  entries.forEach(({ size, png }, index) => {
    const position = index * 16;
    directory[position] = size >= 256 ? 0 : size;
    directory[position + 1] = size >= 256 ? 0 : size;
    directory[position + 2] = 0;
    directory[position + 3] = 0;
    directory.writeUInt16LE(1, position + 4);
    directory.writeUInt16LE(32, position + 6);
    directory.writeUInt32LE(png.length, position + 8);
    directory.writeUInt32LE(offset, position + 12);
    offset += png.length;
  });

  return Buffer.concat([header, directory, ...entries.map(({ png }) => png)]);
}

const entries = SIZES.map((size) => ({
  size,
  png: fs.readFileSync(path.join(OUT_DIR, `icon-${size}.png`))
}));

fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), makeIco(entries));
console.log(`✓ icon.ico`);
console.log(`Ícones gerados a partir de ${SOURCE_PATH}`);
