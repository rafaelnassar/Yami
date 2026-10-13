/** Node `fs` implementation of `MediaFileAccess`. */
import type { BigIntStats } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { isSameMediaFile, type MediaFileIdentity } from './media-identity.ts';
import type { MediaFileAccess } from './media-protocol.ts';

function identityOf(realPath: string, info: BigIntStats): MediaFileIdentity {
  return { realPath, dev: info.dev, ino: info.ino, size: Number(info.size), mtimeNs: info.mtimeNs };
}

async function* readVerified(expected: MediaFileIdentity, start: number, end: number): AsyncGenerator<Buffer> {
  const handle = await open(expected.realPath, 'r');
  try {
    // Checked on the open descriptor: a swap after `identify` cannot redirect the read.
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || !isSameMediaFile(expected, identityOf(expected.realPath, info))) {
      throw new Error('media file changed');
    }
    // The handle is closed below, also when the consumer cancels (seeking aborts ranges).
    for await (const chunk of handle.createReadStream({ start, end, autoClose: false })) {
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    }
  } finally {
    await handle.close();
  }
}

export const nodeMediaFiles: MediaFileAccess = {
  async identify(file) {
    try {
      const realPath = await realpath(file);
      const info = await stat(realPath, { bigint: true });
      return info.isFile() ? identityOf(realPath, info) : null;
    } catch {
      return null;
    }
  },
  open(file, start, end) {
    // I/O adapter: Node's web stream type is structurally the global ReadableStream.
    return Readable.toWeb(
      Readable.from(readVerified(file, start, end), { objectMode: false })
    ) as ReadableStream<Uint8Array>;
  }
};
