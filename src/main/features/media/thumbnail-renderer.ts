/**
 * Thumbnail rendering with Electron `nativeImage`: the OS thumbnailer on Windows/macOS
 * (images and videos), decode + resize for images elsewhere (PNG/JPEG only on Linux).
 */
import { nativeImage, type NativeImage } from 'electron';
import type { ThumbnailRenderer } from './media-service.ts';

function fit(image: NativeImage, maxEdge: number): NativeImage {
  const { width, height } = image.getSize();
  if (width <= maxEdge && height <= maxEdge) return image;
  return width >= height
    ? image.resize({ width: maxEdge, quality: 'good' })
    : image.resize({ height: maxEdge, quality: 'good' });
}

function toPng(image: NativeImage, maxEdge: number): Uint8Array | null {
  if (image.isEmpty()) return null;
  const png = fit(image, maxEdge).toPNG();
  return png.byteLength > 0 ? png : null;
}

export function createNativeThumbnailRenderer(platform: NodeJS.Platform): ThumbnailRenderer {
  const osThumbnails = platform === 'win32' || platform === 'darwin';
  return {
    async render(filePath, mediaType, maxEdge) {
      if (osThumbnails && (mediaType === 'image' || mediaType === 'video')) {
        try {
          const thumb = await nativeImage.createThumbnailFromPath(filePath, { width: maxEdge, height: maxEdge });
          const png = toPng(thumb, maxEdge);
          if (png) return png;
        } catch {
          // Fall through to direct decoding for images.
        }
      }
      if (mediaType !== 'image') return null;
      return toPng(nativeImage.createFromPath(filePath), maxEdge);
    }
  };
}
