/**
 * GitHub delivery for non-web projects (CLI, library, desktop, mobile)
 * 
 * Uses the user's own `gh` CLI auth — no org token needed.
 * Creates a private repo under their account, pushes code, creates release.
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { join, basename } from "path";

interface GitHubDeliverOptions {
  projectDir: string;
  appName: string;
  description?: string;
  visibility?: "private" | "public";
}

interface GitHubDeliverResult {
  repoUrl: string;
  releaseUrl?: string;
  artifacts: string[];
}

function exec(cmd: string, cwd?: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8", timeout: 120_000 }).trim();
}

/**
 * Check if `gh` CLI is authenticated
 */
export function isGhAuthenticated(): boolean {
  try {
    exec("gh auth status");
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the authenticated GitHub username
 */
export function getGhUsername(): string | null {
  try {
    return exec("gh api user -q .login");
  } catch {
    return null;
  }
}

/**
 * Deliver a non-web project to the user's GitHub
 */
export async function deliverToUserGitHub(opts: GitHubDeliverOptions): Promise<GitHubDeliverResult> {
  const { projectDir, appName, description, visibility = "private" } = opts;

  // 1. Check gh auth
  if (!isGhAuthenticated()) {
    console.log("\n⚠️  GitHub CLI not authenticated. Run: gh auth login\n");
    console.log("Your built project is at:", projectDir);
    return { repoUrl: "", artifacts: [] };
  }

  const username = getGhUsername();
  if (!username) {
    console.log("\n⚠️  Could not determine GitHub username.");
    return { repoUrl: "", artifacts: [] };
  }

  const repoName = `${appName}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 100);
  const fullRepo = `${username}/${repoName}`;
  const repoUrl = `https://github.com/${fullRepo}`;

  console.log(`\n📦 Delivering to GitHub: ${fullRepo}`);

  // 2. Init git if needed
  if (!existsSync(join(projectDir, ".git"))) {
    exec("git init", projectDir);
    exec('git add -A && git commit -m "Initial commit — built by TurkeyCode"', projectDir);
  }

  // 3. Create repo + push
  try {
    exec(
      `gh repo create ${repoName} --${visibility} --description "${(description || `Built by TurkeyCode`).replace(/"/g, '\\"')}" --source . --push`,
      projectDir
    );
    console.log(`✅ Repo created: ${repoUrl}`);
  } catch {
    // Repo might already exist — try pushing
    console.log("   Repo may exist, pushing...");
    try {
      exec(`git remote add origin ${repoUrl}.git 2>/dev/null || git remote set-url origin ${repoUrl}.git`, projectDir);
      exec("git push -u origin main --force", projectDir);
      console.log(`✅ Pushed to: ${repoUrl}`);
    } catch (e: any) {
      console.error("❌ Failed to push:", e.message);
      return { repoUrl: "", artifacts: [] };
    }
  }

  // 4. Build artifacts
  const artifacts = buildArtifacts(projectDir, appName);

  // 5. Create release if we have artifacts
  let releaseUrl: string | undefined;
  if (artifacts.length > 0) {
    try {
      const artifactFlags = artifacts.map(a => `"${a}"`).join(" ");
      exec(
        `gh release create v1.0.0 ${artifactFlags} --repo ${fullRepo} --title "v1.0.0" --notes "Built and QA-tested by [TurkeyCode](https://turkeycode.ai)."`,
      );
      releaseUrl = `${repoUrl}/releases/tag/v1.0.0`;
      console.log(`📦 Release created: ${releaseUrl}`);
    } catch {
      console.log("⚠️  Release creation failed — source code still pushed.");
    }
  }

  return { repoUrl, releaseUrl, artifacts };
}

/**
 * Build platform-specific artifacts
 */
function buildArtifacts(projectDir: string, appName: string): string[] {
  const artifacts: string[] = [];
  const binName = appName.replace(/[^a-z0-9-]/gi, "-");

  if (existsSync(join(projectDir, "go.mod"))) {
    // Go — cross-compile
    for (const [goos, goarch, suffix] of [
      ["linux", "amd64", "linux-x64"],
      ["linux", "arm64", "linux-arm64"],
      ["darwin", "amd64", "macos-x64"],
      ["darwin", "arm64", "macos-arm64"],
      ["windows", "amd64", "windows-x64.exe"],
    ] as const) {
      const outPath = join(projectDir, `${binName}-${suffix}`);
      try {
        exec(`GOOS=${goos} GOARCH=${goarch} CGO_ENABLED=0 go build -o "${outPath}" .`, projectDir);
        artifacts.push(outPath);
      } catch {}
    }
  } else if (existsSync(join(projectDir, "Cargo.toml"))) {
    // Rust — native build only (cross-compile needs `cross`)
    try {
      exec("cargo build --release", projectDir);
      const bins = exec(
        `find target/release -maxdepth 1 -type f -executable ! -name '*.d' ! -name '*.so' ! -name '*.dylib'`,
        projectDir
      );
      for (const bin of bins.split("\n").filter(Boolean)) {
        artifacts.push(join(projectDir, bin));
      }
    } catch {}
  }

  return artifacts;
}
