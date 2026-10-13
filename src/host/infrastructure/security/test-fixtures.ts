/** Test-only helpers for the secret vaults. */
import { randomBytes } from 'node:crypto';
import { unwrap } from '../../../shared/kernel/result.ts';
import { SecretBox } from './secret-box.ts';

export function testKey(): string {
  return randomBytes(32).toString('base64');
}

export function testBox(key = testKey()): SecretBox {
  return unwrap(SecretBox.fromBase64(key));
}

export const VALID_COOKIES = [
  '# Netscape HTTP Cookie File',
  '# https://curl.se/docs/http-cookies.html',
  '',
  '.x.com\tTRUE\t/\tTRUE\t1893456000\tauth_token\tabc123',
  '#HttpOnly_.Example.COM\tTRUE\t/\tFALSE\t0\tsession\tvalue with spaces',
  'danbooru.donmai.us\tFALSE\t/\tfalse\t1893456000\tpass_hash\t',
  '.x.com\tTRUE\t/\tTRUE\t1893456000\tct0\tzzz'
].join('\r\n');
