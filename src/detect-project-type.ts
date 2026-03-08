/**
 * Project type detection — shared between orchestrator and deploy
 * Detects what KIND of project this is (web app, CLI, library, etc.)
 *
 * This is separate from deploy/detect.ts which detects runtime/framework/features
 * for deployment purposes. This module answers: "what QA strategy should we use?"
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { ProjectType } from './types';

/**
 * Detect the project type for a given directory.
 *
 * Resolution order:
 * 1. Explicit metadata (.turkey/project-type or turkey.type in package.json)
 * 2. Heuristics from project files
 * 3. Default to 'web-fullstack' for ambiguous projects (backwards compatible)
 */
export function detectProjectType(cwd: string): ProjectType {
  // 1. Check explicit metadata
  const explicit = checkExplicitType(cwd);
  if (explicit) return explicit;

  // 2. Apply heuristics
  const detected = applyHeuristics(cwd);
  if (detected !== 'unknown') return detected;

  // 3. Default to web-fullstack for ambiguous projects (backwards compatible)
  return 'web-fullstack';
}

// ==================== Explicit Metadata ====================

function checkExplicitType(cwd: string): ProjectType | null {
  // Check .turkey/project-type file
  const typeFile = join(cwd, '.turkey', 'project-type');
  if (existsSync(typeFile)) {
    const type = readFileSync(typeFile, 'utf-8').trim() as ProjectType;
    if (isValidProjectType(type)) return type;
  }

  // Check turkey.type in package.json
  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.turkey?.type && isValidProjectType(pkg.turkey.type)) {
        return pkg.turkey.type;
      }
    } catch { /* ignore parse errors */ }
  }

  return null;
}

function isValidProjectType(type: string): type is ProjectType {
  return [
    'web-fullstack', 'web-frontend', 'web-api', 'cli',
    'library', 'desktop', 'mobile', 'monorepo', 'unknown'
  ].includes(type);
}

// ==================== Heuristic Detection ====================

function applyHeuristics(cwd: string): ProjectType {
  // Check for monorepo first
  if (isMonorepo(cwd)) return 'monorepo';

  // Check Node.js projects
  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const nodeType = detectNodeProjectType(pkg);
      if (nodeType) return nodeType;
    } catch { /* ignore parse errors */ }
  }

  // Check Rust projects
  const cargoPath = join(cwd, 'Cargo.toml');
  if (existsSync(cargoPath)) {
    return detectRustProjectType(cwd);
  }

  // Check Python projects
  if (existsSync(join(cwd, 'pyproject.toml')) || existsSync(join(cwd, 'setup.py')) || existsSync(join(cwd, 'requirements.txt'))) {
    return detectPythonProjectType(cwd);
  }

  // Check Go projects
  if (existsSync(join(cwd, 'go.mod'))) {
    return detectGoProjectType(cwd);
  }

  // Check Ruby projects
  if (existsSync(join(cwd, 'Gemfile'))) {
    return detectRubyProjectType(cwd);
  }

  // Check PHP projects
  if (existsSync(join(cwd, 'composer.json'))) {
    return detectPhpProjectType(cwd);
  }

  // Check Flutter/mobile
  if (existsSync(join(cwd, 'pubspec.yaml'))) {
    return 'mobile';
  }

  return 'unknown';
}

// ==================== Monorepo Detection ====================

function isMonorepo(cwd: string): boolean {
  // pnpm workspaces
  if (existsSync(join(cwd, 'pnpm-workspace.yaml'))) return true;

  // npm/yarn workspaces in package.json
  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.workspaces) return true;
    } catch { /* ignore */ }
  }

  // Cargo workspace
  const cargoPath = join(cwd, 'Cargo.toml');
  if (existsSync(cargoPath)) {
    try {
      const cargo = readFileSync(cargoPath, 'utf-8');
      if (cargo.includes('[workspace]')) return true;
    } catch { /* ignore */ }
  }

  return false;
}

// ==================== Node.js Type Detection ====================

function detectNodeProjectType(pkg: any): ProjectType | null {
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const depKeys = Object.keys(deps);
  const hasAny = (...names: string[]) => names.some(n => depKeys.includes(n));

  // Desktop apps
  if (hasAny('electron', '@electron/packager', 'electron-builder')) return 'desktop';
  if (hasAny('@tauri-apps/cli', '@tauri-apps/api')) return 'desktop';

  // Mobile apps
  if (hasAny('react-native', 'expo', '@expo/cli')) return 'mobile';

  // CLI tools — bin field is a strong signal
  if (pkg.bin) {
    // But if it also has a web framework, it's probably a web app with a CLI helper
    if (!hasAny('next', 'nuxt', '@sveltejs/kit', 'remix', '@remix-run/node',
      'react', 'vue', 'svelte', 'angular', '@angular/core',
      'express', 'fastify', '@nestjs/core', 'hono', 'koa')) {
      return 'cli';
    }
  }

  // CLI by dependency (commander, yargs, etc.)
  if (hasAny('commander', 'yargs', 'meow', 'cac', 'clipanion', 'oclif', 'inquirer', 'prompts') && !hasAny(
    'next', 'nuxt', 'react', 'vue', 'express', 'fastify', '@nestjs/core'
  )) {
    // Only if there's a bin field or no web framework
    if (pkg.bin) return 'cli';
  }

  // Fullstack frameworks
  if (hasAny('next', 'nuxt', '@sveltejs/kit', 'remix', '@remix-run/node')) return 'web-fullstack';

  // Frontend-only (has frontend framework, no server framework)
  const hasFrontend = hasAny('react', 'vue', 'svelte', '@angular/core', 'solid-js', 'preact');
  const hasServer = hasAny('express', 'fastify', '@nestjs/core', 'hono', 'koa', '@hapi/hapi');

  if (hasFrontend && !hasServer) return 'web-frontend';

  // API-only (has server framework, no frontend)
  if (hasServer && !hasFrontend) return 'web-api';

  // Has both frontend and server = fullstack
  if (hasServer && hasFrontend) return 'web-fullstack';

  // Library — has main/exports but no bin and no server/frontend deps
  if ((pkg.main || pkg.exports || pkg.module || pkg.types) && !pkg.bin && !hasServer && !hasFrontend) {
    return 'library';
  }

  // Vite/CRA without explicit framework detection
  if (hasAny('vite', 'react-scripts', '@vitejs/plugin-react', '@vitejs/plugin-vue')) {
    return 'web-frontend';
  }

  return null;
}

// ==================== Rust Type Detection ====================

function detectRustProjectType(cwd: string): ProjectType {
  const cargoToml = readFileSync(join(cwd, 'Cargo.toml'), 'utf-8');
  const cargoLower = cargoToml.toLowerCase();

  // Desktop
  if (cargoLower.includes('tauri') || cargoLower.includes('druid') || cargoLower.includes('iced') || cargoLower.includes('egui')) {
    return 'desktop';
  }

  // Web frameworks
  if (cargoLower.includes('axum') || cargoLower.includes('actix-web') || cargoLower.includes('rocket') || cargoLower.includes('warp')) {
    return 'web-api';
  }

  // CLI detection
  if (cargoLower.includes('clap') || cargoLower.includes('structopt')) {
    return 'cli';
  }

  // [[bin]] section = binary/CLI
  if (cargoToml.includes('[[bin]]')) return 'cli';

  // [lib] only = library
  if (cargoToml.includes('[lib]') && !cargoToml.includes('[[bin]]')) return 'library';

  // Default Rust projects with a src/main.rs are CLIs
  if (existsSync(join(cwd, 'src', 'main.rs'))) return 'cli';

  // Default Rust projects with only src/lib.rs are libraries
  if (existsSync(join(cwd, 'src', 'lib.rs')) && !existsSync(join(cwd, 'src', 'main.rs'))) return 'library';

  return 'cli'; // Rust default
}

// ==================== Python Type Detection ====================

function detectPythonProjectType(cwd: string): ProjectType {
  const reqs = existsSync(join(cwd, 'requirements.txt'))
    ? readFileSync(join(cwd, 'requirements.txt'), 'utf-8').toLowerCase()
    : '';
  const pyproject = existsSync(join(cwd, 'pyproject.toml'))
    ? readFileSync(join(cwd, 'pyproject.toml'), 'utf-8').toLowerCase()
    : '';
  const setupPy = existsSync(join(cwd, 'setup.py'))
    ? readFileSync(join(cwd, 'setup.py'), 'utf-8').toLowerCase()
    : '';
  const allContent = reqs + '\n' + pyproject + '\n' + setupPy;
  const has = (...pkgs: string[]) => pkgs.some(p => allContent.includes(p));

  // Mobile
  if (has('kivy', 'beeware', 'briefcase')) return 'mobile';

  // Desktop
  if (has('pyqt', 'pyside', 'tkinter', 'wxpython')) return 'desktop';

  // Web frameworks (fullstack)
  if (has('django')) return 'web-fullstack';

  // Web API
  if (has('fastapi', 'flask', 'starlette', 'tornado', 'aiohttp', 'sanic', 'falcon')) return 'web-api';

  // CLI tools
  if (has('click', 'argparse', 'typer', 'fire')) return 'cli';
  if (pyproject.includes('console_scripts') || setupPy.includes('console_scripts')) return 'cli';

  // Library (has setup.py or pyproject.toml but no CLI/web signals)
  if (existsSync(join(cwd, 'pyproject.toml')) || existsSync(join(cwd, 'setup.py'))) {
    return 'library';
  }

  return 'unknown';
}

// ==================== Go Type Detection ====================

function detectGoProjectType(cwd: string): ProjectType {
  const goMod = readFileSync(join(cwd, 'go.mod'), 'utf-8').toLowerCase();
  const has = (...pkgs: string[]) => pkgs.some(p => goMod.includes(p));

  // Web frameworks
  if (has('github.com/gin-gonic/gin', 'github.com/labstack/echo', 'github.com/gofiber/fiber',
    'github.com/go-chi/chi', 'net/http')) {
    return 'web-api';
  }

  // CLI tools
  if (has('github.com/spf13/cobra', 'github.com/urfave/cli', 'github.com/alecthomas/kong')) {
    return 'cli';
  }

  // Default Go project with main package = CLI
  if (existsSync(join(cwd, 'main.go')) || existsSync(join(cwd, 'cmd'))) {
    return 'cli';
  }

  return 'library';
}

// ==================== Ruby Type Detection ====================

function detectRubyProjectType(cwd: string): ProjectType {
  const gemfile = readFileSync(join(cwd, 'Gemfile'), 'utf-8').toLowerCase();
  const has = (...gems: string[]) => gems.some(g => gemfile.includes(g));

  if (has('rails')) return 'web-fullstack';
  if (has('sinatra', 'grape', 'hanami')) return 'web-api';
  if (has('thor', 'gli')) return 'cli';

  // .gemspec = library
  try {
    const gemspecs = readdirSync(cwd).filter(f => f.endsWith('.gemspec'));
    if (gemspecs.length > 0) return 'library';
  } catch { /* ignore */ }

  return 'unknown';
}

// ==================== PHP Type Detection ====================

function detectPhpProjectType(cwd: string): ProjectType {
  const composerPath = join(cwd, 'composer.json');
  try {
    const composer = JSON.parse(readFileSync(composerPath, 'utf-8'));
    const require = composer.require || {};
    const requireKeys = Object.keys(require);
    const has = (...pkgs: string[]) => pkgs.some(p => requireKeys.some(k => k.includes(p)));

    if (has('laravel/framework')) return 'web-fullstack';
    if (has('symfony/framework-bundle')) return 'web-fullstack';
    if (has('slim/slim')) return 'web-api';

    // CLI tools
    if (has('symfony/console') && !has('laravel', 'symfony/framework')) return 'cli';

    // Has bin field = CLI
    if (composer.bin) return 'cli';

    return 'library';
  } catch {
    return 'unknown';
  }
}
