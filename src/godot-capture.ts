/**
 * Deterministic Godot frame capture. turkeycode runs this itself instead of
 * asking an agent session to: same frames every time, no tokens, and no test
 * hooks in the game.
 *
 * The driver below lives under .turkey, outside the game's sources, and runs the
 * real main scene through `--script`. To get past a title screen or reach a
 * later state it replays capture-timeline.json, which is data rather than game
 * code. Measured on Godot 4.7.1: Movie Maker records with --script, and input
 * sent with Input.parse_input_event reaches the scene during recording.
 */

import { execFile } from 'child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { STATE_DIR } from './constants';
import { findGodotProjectDir } from './detect-project-type';

export const GODOT_CAPTURE_TIMELINE = 'capture-timeline.json';

/** 30 seconds at 10fps. One frame every 3 seconds goes to the reviewer. */
const CAPTURE_FPS = 10;
const CAPTURE_FRAMES = 300;
const FRAME_STRIDE = 30;
const IMPORT_TIMEOUT_MS = 300_000;
const CAPTURE_TIMEOUT_MS = 180_000;

export const GODOT_CAPTURE_DRIVER = `extends SceneTree
# Written by turkeycode. Plays the real main scene and replays a data-only input
# timeline, so a game needs no capture or autoplay code of its own.
var events := []
var releases := []
var elapsed := 0.0

func _initialize():
	var path := OS.get_environment("TURKEYCODE_CAPTURE_TIMELINE")
	if path != "" and FileAccess.file_exists(path):
		var data = JSON.parse_string(FileAccess.get_file_as_string(path))
		if data is Dictionary:
			events = data.get("events", [])
			Engine.time_scale = max(float(data.get("time_scale", 1)), 0.01)
	change_scene_to_file(ProjectSettings.get_setting("application/run/main_scene"))

func send_action(action: String, pressed: bool):
	var event := InputEventAction.new()
	event.action = action
	event.pressed = pressed
	Input.parse_input_event(event)

func _process(delta):
	elapsed += delta / Engine.time_scale
	while events.size() > 0 and float(events[0].get("at", 0)) <= elapsed:
		var event = events.pop_front()
		if event.has("mouse"):
			var motion := InputEventMouseMotion.new()
			motion.position = Vector2(event["mouse"][0], event["mouse"][1])
			motion.global_position = motion.position
			Input.parse_input_event(motion)
		if event.has("action"):
			send_action(event["action"], true)
			releases.append({"at": elapsed + float(event.get("hold", 0)), "action": event["action"]})
	for release in releases.duplicate():
		if float(release["at"]) <= elapsed:
			send_action(release["action"], false)
			releases.erase(release)
	return false
`;

export interface GodotCaptureResult {
  /** Frame file names kept in framesDir, oldest first. */
  frames: string[];
  /** Set when no frames could be produced. */
  error?: string;
  usedTimeline: boolean;
}

/** One frame every FRAME_STRIDE, starting with the first. */
export function selectCaptureFrames(names: string[]): string[] {
  return names
    .filter(name => name.endsWith('.png'))
    .sort()
    .filter((_, index) => index % FRAME_STRIDE === 0);
}

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout: number
): Promise<{ failed: boolean; output: string }> {
  return new Promise(done => {
    execFile(command, args, { env, timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      done({ failed: !!error, output: `${stdout}${stderr}${error ? `\n${error.message}` : ''}` });
    });
  });
}

export async function captureGodotFrames(workDir: string, framesDir: string): Promise<GodotCaptureResult> {
  const projectDir = findGodotProjectDir(workDir);
  if (!projectDir) {
    return { frames: [], usedTimeline: false, error: `No project.godot found under ${workDir}` };
  }

  const frames = resolve(workDir, framesDir);
  mkdirSync(frames, { recursive: true });
  // A retry must not review the last attempt's frames.
  for (const name of readdirSync(frames)) rmSync(join(frames, name), { force: true });

  const driverDir = resolve(workDir, STATE_DIR, 'capture');
  mkdirSync(driverDir, { recursive: true });
  const driver = join(driverDir, 'turkeycode_capture.gd');
  writeFileSync(driver, GODOT_CAPTURE_DRIVER);

  const timeline = join(projectDir, GODOT_CAPTURE_TIMELINE);
  const usedTimeline = existsSync(timeline);
  const env = { ...process.env, TURKEYCODE_CAPTURE_TIMELINE: usedTimeline ? timeline : '' };

  await run('godot', ['--headless', '--import', '--path', projectDir], env, IMPORT_TIMEOUT_MS);

  // Windowed on purpose: --headless has no renderer and crashes on --write-movie.
  const godotArgs = [
    '--path', projectDir,
    '--script', driver,
    '--write-movie', join(frames, 'frame.png'),
    '--fixed-fps', String(CAPTURE_FPS),
    '--quit-after', String(CAPTURE_FRAMES),
  ];
  const needsDisplay = process.platform === 'linux' && !process.env.DISPLAY;
  const result = needsDisplay
    ? await run('xvfb-run', ['-a', 'godot', ...godotArgs], env, CAPTURE_TIMEOUT_MS)
    : await run('godot', godotArgs, env, CAPTURE_TIMEOUT_MS);

  const recorded = readdirSync(frames);
  const kept = selectCaptureFrames(recorded);
  for (const name of recorded) {
    if (!kept.includes(name)) rmSync(join(frames, name), { force: true });
  }

  if (kept.length === 0) {
    return {
      frames: [],
      usedTimeline,
      error: `Godot produced no frames.\n${result.output.slice(-2000)}`,
    };
  }
  return { frames: kept, usedTimeline };
}
