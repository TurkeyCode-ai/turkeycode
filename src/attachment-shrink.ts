/**
 * Shrink oversized image attachments so they fit under Anthropic's per-image
 * base64 cap (5 MB encoded ≈ 3.75 MB raw). The Claude API rejects the entire
 * request if any single image exceeds this, so a 7 MB screen-recording GIF
 * pulled from Jira will hard-kill a ticket build session.
 *
 * Strategy:
 *   1. For animated formats (GIF, animated WebP, multi-page TIFF/HEIC), keep
 *      only the first frame — sharp's `animated: false` reads page 0. That
 *      alone usually drops a multi-MB screen-recording to <500 KB.
 *   2. If the first-frame PNG is still over cap, progressively downscale.
 *   3. If sharp is unavailable or all attempts still exceed cap, return null
 *      and let the caller skip the attachment with a warning.
 */

import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname, extname, join } from 'path';

/**
 * Anthropic's per-image cap is 5 MB after base64 encoding. Base64 inflates
 * by 4/3, so raw bytes must stay under ~3.75 MB. We use 3.5 MB to leave
 * headroom for the JSON envelope and base64 padding rounding.
 */
export const MAX_IMAGE_RAW_BYTES = Math.floor(3.5 * 1024 * 1024);

/**
 * Resize fractions tried in order if the first-frame PNG is still over cap.
 * 1.0 means "no resize, just the first-frame transcode" — that alone clears
 * the cap for animated GIFs because the GIF container/extra frames are gone.
 */
const RESIZE_SCALES = [1.0, 0.75, 0.5, 0.33, 0.25];

export interface ShrinkResult {
  /** Final on-disk path (may differ from input if the extension changed). */
  path: string;
  /** True if the file was rewritten. False means it was already under cap. */
  shrunk: boolean;
  originalBytes: number;
  finalBytes: number;
}

/**
 * If the file at `path` exceeds the per-image cap, rewrite it as a shrunken
 * PNG in place (renaming to .png when the source extension differs). Returns
 * the result on success, or null if the file could not be brought under cap.
 *
 * Never throws — failures are reported via the null return.
 */
export async function shrinkImageToFit(path: string): Promise<ShrinkResult | null> {
  if (!existsSync(path)) return null;
  const originalBytes = statSync(path).size;
  if (originalBytes <= MAX_IMAGE_RAW_BYTES) {
    return { path, shrunk: false, originalBytes, finalBytes: originalBytes };
  }

  let sharp: typeof import('sharp');
  try {
    sharp = (await import('sharp')).default;
  } catch {
    return null;
  }

  let sourceBuffer: Buffer;
  try {
    sourceBuffer = readFileSync(path);
  } catch {
    return null;
  }

  let outBuffer: Buffer | null = null;
  for (const scale of RESIZE_SCALES) {
    try {
      const pipeline = sharp(sourceBuffer, { animated: false });
      if (scale < 1.0) {
        const meta = await sharp(sourceBuffer, { animated: false }).metadata();
        const startWidth = meta.width ?? 0;
        if (startWidth > 0) {
          pipeline.resize({ width: Math.max(1, Math.floor(startWidth * scale)), withoutEnlargement: true });
        }
      }
      const candidate = await pipeline.png().toBuffer();
      if (candidate.length <= MAX_IMAGE_RAW_BYTES) {
        outBuffer = candidate;
        break;
      }
      outBuffer = candidate;
    } catch {
      return null;
    }
  }

  if (!outBuffer || outBuffer.length > MAX_IMAGE_RAW_BYTES) return null;

  const dir = dirname(path);
  const base = basename(path, extname(path));
  const newPath = join(dir, `${base}.png`);
  try {
    writeFileSync(newPath, outBuffer);
    if (newPath !== path) {
      try { unlinkSync(path); } catch { /* ignore */ }
    }
  } catch {
    return null;
  }

  return { path: newPath, shrunk: true, originalBytes, finalBytes: outBuffer.length };
}
