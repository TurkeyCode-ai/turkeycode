/**
 * Hard artifact checks for turkey-enterprise-v3
 * Gates are WALLS - if they fail, the pipeline stops with process.exit(1)
 * Phase-based orchestrator model
 */

import { existsSync, readFileSync } from 'fs';
import { GateResult, ArtifactCheck, PhasePlan } from './types';
import {
  SPECS_FILE,
  RESEARCH_DONE,
  PHASE_PLAN_FILE,
  PLAN_DONE,
  PHASES_DIR,
  QA_DIR,
  REVIEWS_DIR,
  AAR_DIR,
  MIN_SPECS_LENGTH,
  MIN_PHASE_SCOPE_LENGTH,
  STRICT_QA
} from './constants';

/**
 * Gates class - all checks return GateResult
 * On failure: log details and call process.exit(1)
 */
export class Gates {
  /**
   * Check the research gate
   * - research.done exists and starts with "DONE"
   * - specs.md exists and is > MIN_SPECS_LENGTH chars
   */
  checkResearch(): GateResult {
    const artifacts: ArtifactCheck[] = [];

    // Check research.done signal
    artifacts.push(this.checkDoneSignal('research.done', RESEARCH_DONE));

    // Check specs.md exists and has content
    artifacts.push(this.checkFile(
      'specs.md',
      SPECS_FILE,
      (content) => {
        if (content.length < MIN_SPECS_LENGTH) {
          return `Content too short: ${content.length} chars (minimum: ${MIN_SPECS_LENGTH})`;
        }
        return null;
      }
    ));

    return this.buildResult('research', artifacts);
  }

  /**
   * Check the plan gate
   * - phase-plan.json exists and is valid
   * - exactly 1 phase with name/scope/deliverables/acceptanceCriteria
   * - plan.done signal exists
   */
  checkPlan(): GateResult {
    const artifacts: ArtifactCheck[] = [];

    // Check plan.done signal
    artifacts.push(this.checkDoneSignal('plan.done', PLAN_DONE));

    // Check phase-plan.json exists and is valid
    artifacts.push(this.checkFile(
      'phase-plan.json',
      PHASE_PLAN_FILE,
      (content) => {
        try {
          const plan = JSON.parse(content) as PhasePlan;

          // Must have phases array
          if (!Array.isArray(plan.phases) || plan.phases.length === 0) {
            return 'No phases defined in plan';
          }

          // Must have exactly 1 phase (sprint = phase)
          if (plan.phases.length !== 1) {
            return `Plan has ${plan.phases.length} phases (expected exactly 1 — the sprint IS the phase)`;
          }

          // Validate each phase
          for (const phase of plan.phases) {
            if (!phase.number || !phase.name) {
              return `Phase missing number or name`;
            }

            if (!phase.scope || phase.scope.length < MIN_PHASE_SCOPE_LENGTH) {
              return `Phase ${phase.number} has missing or too short scope (minimum: ${MIN_PHASE_SCOPE_LENGTH} chars)`;
            }

            if (!Array.isArray(phase.deliverables) || phase.deliverables.length === 0) {
              return `Phase ${phase.number} has no deliverables`;
            }

            if (!Array.isArray(phase.acceptanceCriteria) || phase.acceptanceCriteria.length === 0) {
              return `Phase ${phase.number} has no acceptance criteria`;
            }
          }

          return null;
        } catch (err) {
          return `Invalid JSON: ${err}`;
        }
      }
    ));

    return this.buildResult('plan', artifacts);
  }

  /**
   * Check the phase build gate
   * - .turkey/phases/phase-{n}/build.done exists
   */
  checkPhaseBuild(phaseNumber: number): GateResult {
    const artifacts: ArtifactCheck[] = [];

    const buildDonePath = `${PHASES_DIR}/phase-${phaseNumber}/build.done`;
    artifacts.push(this.checkDoneSignal(`phase-${phaseNumber}/build.done`, buildDonePath));

    return this.buildResult(`build-phase-${phaseNumber}`, artifacts);
  }

  /**
   * Check QA smoke gate
   */
  checkQaSmoke(phaseNumber: number, attempt: number): GateResult {
    const artifacts: ArtifactCheck[] = [];

    const smokeDonePath = `${QA_DIR}/phase-${phaseNumber}/smoke-${attempt}.done`;
    artifacts.push(this.checkDoneSignal(`smoke-${attempt}.done`, smokeDonePath));

    return this.buildResult(`qa-smoke-${phaseNumber}-${attempt}`, artifacts);
  }

  /**
   * Check QA functional gate
   */
  checkQaFunctional(phaseNumber: number, attempt: number): GateResult {
    const artifacts: ArtifactCheck[] = [];

    const functionalDonePath = `${QA_DIR}/phase-${phaseNumber}/functional-${attempt}.done`;
    artifacts.push(this.checkDoneSignal(`functional-${attempt}.done`, functionalDonePath));

    return this.buildResult(`qa-functional-${phaseNumber}-${attempt}`, artifacts);
  }

  /**
   * Check QA visual gate
   */
  checkQaVisual(phaseNumber: number, attempt: number): GateResult {
    const artifacts: ArtifactCheck[] = [];

    const visualDonePath = `${QA_DIR}/phase-${phaseNumber}/visual-${attempt}.done`;
    artifacts.push(this.checkDoneSignal(`visual-${attempt}.done`, visualDonePath));

    return this.buildResult(`qa-visual-${phaseNumber}-${attempt}`, artifacts);
  }

  /**
   * Check QA verdict gate
   * - verdict-{attempt}.json exists
   * - verdict === "CLEAN"
   * - When STRICT_QA is true: zero blockers AND zero warnings
   * - When STRICT_QA is false: zero blockers only (warnings allowed)
   */
  checkQaVerdict(phaseNumber: number, attempt: number): GateResult {
    const artifacts: ArtifactCheck[] = [];

    const verdictPath = `${QA_DIR}/phase-${phaseNumber}/verdict-${attempt}.json`;
    artifacts.push(this.checkFile(
      `verdict-${attempt}.json`,
      verdictPath,
      (content) => {
        try {
          const verdict = JSON.parse(content);

          // Always require ZERO blockers
          const blockers = verdict.blockers?.length || 0;
          const warnings = verdict.warnings?.length || 0;

          if (blockers > 0) {
            return `Has ${blockers} blockers - CLEAN requires ZERO blockers`;
          }

          // Only check warnings if STRICT_QA is enabled
          if (STRICT_QA && warnings > 0) {
            return `Has ${warnings} warnings - strict mode requires ZERO issues (use --allow-warnings to skip)`;
          }

          // If we get here: zero blockers (and zero warnings or --allow-warnings).
          // Accept even if verdict agent wrote NEEDS_FIX due to warnings only.
          return null;
        } catch (err) {
          return `Invalid JSON: ${err}`;
        }
      }
    ));

    return this.buildResult(`qa-verdict-${phaseNumber}-${attempt}`, artifacts);
  }

  /**
   * Check code review gate
   */
  checkCodeReview(phaseNumber: number): GateResult {
    const artifacts: ArtifactCheck[] = [];

    const reviewPath = `${REVIEWS_DIR}/phase-${phaseNumber}.md`;
    artifacts.push(this.checkFileExists(`phase-${phaseNumber}.md`, reviewPath));

    return this.buildResult(`code-review-${phaseNumber}`, artifacts);
  }

  /**
   * Check AAR gate
   */
  checkAAR(phaseNumber: number): GateResult {
    const artifacts: ArtifactCheck[] = [];

    const aarDonePath = `${AAR_DIR}/phase-${phaseNumber}.done`;
    artifacts.push(this.checkDoneSignal(`aar-phase-${phaseNumber}.done`, aarDonePath));

    return this.buildResult(`aar-${phaseNumber}`, artifacts);
  }

  // ========== HELPER METHODS ==========

  /**
   * Check a done signal file exists and starts with "DONE"
   */
  private checkDoneSignal(name: string, path: string): ArtifactCheck {
    if (!existsSync(path)) {
      return {
        name,
        path,
        exists: false,
        valid: false,
        validationError: 'File does not exist'
      };
    }

    try {
      const content = readFileSync(path, 'utf-8');
      if (!content.trim().toUpperCase().startsWith('DONE')) {
        return {
          name,
          path,
          exists: true,
          valid: false,
          validationError: 'File does not start with "DONE"'
        };
      }

      return { name, path, exists: true, valid: true };
    } catch (err) {
      return {
        name,
        path,
        exists: true,
        valid: false,
        validationError: `Could not read file: ${err}`
      };
    }
  }

  /**
   * Check a file exists and optionally validate its content
   */
  private checkFile(
    name: string,
    path: string,
    validator?: (content: string) => string | null
  ): ArtifactCheck {
    if (!existsSync(path)) {
      return {
        name,
        path,
        exists: false,
        valid: false,
        validationError: 'File does not exist'
      };
    }

    if (!validator) {
      return { name, path, exists: true, valid: true };
    }

    try {
      const content = readFileSync(path, 'utf-8');
      const error = validator(content);
      return {
        name,
        path,
        exists: true,
        valid: error === null,
        validationError: error || undefined
      };
    } catch (err) {
      return {
        name,
        path,
        exists: true,
        valid: false,
        validationError: `Could not read file: ${err}`
      };
    }
  }

  /**
   * Check a file exists (no content validation)
   */
  private checkFileExists(name: string, path: string): ArtifactCheck {
    return {
      name,
      path,
      exists: existsSync(path),
      valid: existsSync(path),
      validationError: existsSync(path) ? undefined : 'File does not exist'
    };
  }

  /**
   * Build a GateResult from artifact checks
   */
  private buildResult(gate: string, artifacts: ArtifactCheck[]): GateResult {
    const passed = artifacts.every(a => a.exists && a.valid);
    const failed = artifacts.filter(a => !a.exists || !a.valid);

    let message: string;
    if (passed) {
      message = `Gate ${gate} PASSED`;
    } else {
      const failedNames = failed.map(a => a.name).join(', ');
      message = `Gate ${gate} FAILED: ${failedNames}`;
    }

    return {
      passed,
      gate,
      message,
      artifacts,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Enforce a gate - log result and exit(1) if failed
 */
export function enforceGate(result: GateResult): void {
  console.log(`\n=== GATE CHECK: ${result.gate} ===`);
  console.log(`Status: ${result.passed ? 'PASSED' : 'FAILED'}`);
  console.log(`Time: ${result.timestamp}`);

  for (const artifact of result.artifacts) {
    const status = artifact.valid ? '✓' : '✗';
    console.log(`  ${status} ${artifact.name}: ${artifact.path}`);
    if (artifact.validationError) {
      console.log(`    Error: ${artifact.validationError}`);
    }
  }

  if (!result.passed) {
    console.error(`\n❌ Gate ${result.gate} FAILED - stopping pipeline`);
    process.exit(1);
  }

  console.log(`\n✓ Gate ${result.gate} passed\n`);
}

/**
 * Create a Gates instance
 */
export function createGates(): Gates {
  return new Gates();
}
