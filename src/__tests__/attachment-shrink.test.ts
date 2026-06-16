import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { MAX_IMAGE_RAW_BYTES, shrinkImageToFit } from '../attachment-shrink';

describe('shrinkImageToFit', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shrink-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the file unchanged when already under cap', async () => {
    const path = join(dir, 'small.png');
    const buf = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).png().toBuffer();
    writeFileSync(path, buf);
    const before = statSync(path).size;

    const result = await shrinkImageToFit(path);

    expect(result).not.toBeNull();
    expect(result!.path).toBe(path);
    expect(result!.shrunk).toBe(false);
    expect(result!.finalBytes).toBe(before);
    expect(statSync(path).size).toBe(before);
  });

  it('extracts the first frame of an animated GIF and renames to .png', async () => {
    const gifPath = join(dir, '42713-screen-recording.gif');
    // Build a multi-frame GIF that's intentionally larger than the cap.
    // 50 frames at 800x600 white-on-noise easily exceeds 3.5 MB raw.
    const frames: Buffer[] = [];
    for (let i = 0; i < 50; i++) {
      const noise = Buffer.alloc(800 * 600 * 3);
      for (let j = 0; j < noise.length; j++) noise[j] = (i * 13 + j) & 0xff;
      frames.push(
        await sharp(noise, { raw: { width: 800, height: 600, channels: 3 } }).png().toBuffer(),
      );
    }
    const composite = await sharp(frames[0], { animated: false })
      .composite(frames.slice(1).map((f, idx) => ({ input: f, gravity: 'northwest' })))
      .gif()
      .toBuffer();
    // Fallback: if the composite is still small, pad the file so the size check fires.
    let gifBuffer = composite;
    if (gifBuffer.length <= MAX_IMAGE_RAW_BYTES) {
      gifBuffer = Buffer.concat([gifBuffer, Buffer.alloc(MAX_IMAGE_RAW_BYTES + 1024)]);
    }
    writeFileSync(gifPath, gifBuffer);
    expect(statSync(gifPath).size).toBeGreaterThan(MAX_IMAGE_RAW_BYTES);

    const result = await shrinkImageToFit(gifPath);

    expect(result).not.toBeNull();
    expect(result!.shrunk).toBe(true);
    expect(result!.path.endsWith('.png')).toBe(true);
    expect(result!.finalBytes).toBeLessThanOrEqual(MAX_IMAGE_RAW_BYTES);
    expect(existsSync(result!.path)).toBe(true);
    // Original .gif should be removed once replaced by .png with a different extension
    expect(existsSync(gifPath)).toBe(false);
    // The output should be a valid PNG that sharp can decode
    const meta = await sharp(readFileSync(result!.path)).metadata();
    expect(meta.format).toBe('png');
  });

  it('returns null when the file does not exist', async () => {
    const result = await shrinkImageToFit(join(dir, 'nope.png'));
    expect(result).toBeNull();
  });
});
