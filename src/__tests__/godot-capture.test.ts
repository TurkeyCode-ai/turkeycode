import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { captureGodotFrames, selectCaptureFrames, GODOT_CAPTURE_DRIVER, GODOT_CAPTURE_TIMELINE } from '../godot-capture';

describe('selectCaptureFrames', () => {
  it('keeps the first frame and one in every 30', () => {
    const names = Array.from({ length: 300 }, (_, i) => `frame${String(i).padStart(8, '0')}.png`);
    const kept = selectCaptureFrames(names);
    expect(kept).toHaveLength(10);
    expect(kept[0]).toBe('frame00000000.png');
    expect(kept[1]).toBe('frame00000030.png');
    expect(kept[9]).toBe('frame00000270.png');
  });

  it('ignores the audio track Movie Maker writes beside the frames', () => {
    expect(selectCaptureFrames(['frame.wav', 'frame00000000.png'])).toEqual(['frame00000000.png']);
  });
});

describe('GODOT_CAPTURE_DRIVER', () => {
  it('plays the real main scene and takes its input from data', () => {
    expect(GODOT_CAPTURE_DRIVER).toContain('application/run/main_scene');
    expect(GODOT_CAPTURE_DRIVER).toContain('TURKEYCODE_CAPTURE_TIMELINE');
  });
});

describe('captureGodotFrames', () => {
  let dir: string;
  let oldPath: string | undefined;

  /** A fake godot that logs each call and writes 300 frames when recording. */
  const fakeGodot = (writesFrames: boolean) => {
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const script = [
      '#!/bin/sh',
      `echo "$TURKEYCODE_CAPTURE_TIMELINE|$*" >> ${join(dir, 'calls.log')}`,
      'case "$*" in *--write-movie*) ;; *) exit 0 ;; esac',
      writesFrames ? `i=0; while [ $i -lt 300 ]; do printf x > "${join(dir, 'game/.turkey/shots')}/frame$(printf %08d $i).png"; i=$((i+1)); done; printf x > "${join(dir, 'game/.turkey/shots')}/frame.wav"` : 'echo boom >&2',
    ].join('\n');
    writeFileSync(join(bin, 'godot'), script);
    chmodSync(join(bin, 'godot'), 0o755);
    process.env.PATH = `${bin}${delimiter}${oldPath}`;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'godot-capture-'));
    mkdirSync(join(dir, 'game'));
    writeFileSync(join(dir, 'game/project.godot'), 'config_version=5');
    oldPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it('records windowed from the project, and keeps only the frames for review', async () => {
    fakeGodot(true);
    const result = await captureGodotFrames(join(dir, 'game'), '.turkey/shots');
    expect(result.error).toBeUndefined();
    expect(result.frames).toHaveLength(10);
    expect(readdirSync(join(dir, 'game/.turkey/shots'))).toHaveLength(10);

    const recording = readFileSync(join(dir, 'calls.log'), 'utf-8').split('\n').find(l => l.includes('--write-movie'))!;
    expect(recording).toContain('--script');
    expect(recording).toContain(`--path ${join(dir, 'game')}`);
    expect(recording).not.toContain('--headless');
    expect(existsSync(join(dir, 'game/.turkey/capture/turkeycode_capture.gd'))).toBe(true);
  });

  it('passes the timeline to the driver when the project has one', async () => {
    fakeGodot(true);
    writeFileSync(join(dir, 'game', GODOT_CAPTURE_TIMELINE), '{"events":[]}');
    const result = await captureGodotFrames(join(dir, 'game'), '.turkey/shots');
    expect(result.usedTimeline).toBe(true);
    expect(readFileSync(join(dir, 'calls.log'), 'utf-8')).toContain(join(dir, 'game', GODOT_CAPTURE_TIMELINE));
  });

  it('does not let a retry review the last attempt\'s frames', async () => {
    fakeGodot(false);
    mkdirSync(join(dir, 'game/.turkey/shots'), { recursive: true });
    writeFileSync(join(dir, 'game/.turkey/shots/frame00000000.png'), 'stale');
    const result = await captureGodotFrames(join(dir, 'game'), '.turkey/shots');
    expect(result.frames).toEqual([]);
    expect(result.error).toContain('no frames');
  });

  it('reports a missing project instead of throwing', async () => {
    rmSync(join(dir, 'game/project.godot'));
    const result = await captureGodotFrames(join(dir, 'game'), '.turkey/shots');
    expect(result.error).toContain('No project.godot');
  });
});
