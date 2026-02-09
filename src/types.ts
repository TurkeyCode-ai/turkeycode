/**
 * Type definitions for turkey-enterprise-v3
 * Phase-based orchestrator model
 */

// ============================================================================
// PHASE TYPES
// ============================================================================

export type Phase =
  | 'init'
  | 'research'
  | 'plan'
  | 'build'
  | 'quick-check'
  | 'qa'
  | 'review'
  | 'aar'
  | 'done';

export type BuildPhaseStatus = 'planned' | 'building' | 'qa' | 'fixing' | 'done';

export type QaVerdict = 'CLEAN' | 'NEEDS_FIX' | 'INCOMPLETE';

// ============================================================================
// BUILD PHASE TYPES
// ============================================================================

export interface BuildPhase {
  /** Phase number (1-indexed) */
  number: number;
  /** Human-readable phase name (e.g., "Foundation & Core UI") */
  name: string;
  /** Detailed description of what to build */
  scope: string;
  /** Concrete outputs this phase produces */
  deliverables: string[];
  /** Testable statements for QA */
  acceptanceCriteria: string[];
  /** What must exist from prior phases */
  prerequisites: string[];
  /** Relevant spec excerpts */
  specContext: string;
  /** Current status */
  status: BuildPhaseStatus;
  /** Number of build attempts */
  buildAttempts: number;
  /** Number of QA attempts */
  qaAttempts: number;
  /** Last QA verdict for this phase */
  lastQaVerdict?: QaVerdict;
  /** Git branch name */
  branchName?: string;
  /** PR number if created */
  prNumber?: number;
  /** Jira ticket key if created */
  jiraTicketKey?: string;
  /** Build duration */
  buildTime?: string;
  /** QA duration */
  qaTime?: string;
  /** Total duration */
  totalTime?: string;
  /** When phase started */
  startedAt?: string;
  /** When phase completed */
  completedAt?: string;
}

// ============================================================================
// PHASE PLAN
// ============================================================================

export interface PhasePlan {
  projectName: string;
  totalPhases: number;
  phases: BuildPhase[];
  architecture: {
    stack: string;
    structure: string;
    patterns: string[];
  };
}

// ============================================================================
// TECH CONTEXT (for compaction recovery)
// ============================================================================

export interface TechContext {
  /** Backend framework (e.g., "Express 4.18", "Spring Boot 3.2") */
  backend?: string;
  /** Frontend framework (e.g., "React 18", "Vue 3") */
  frontend?: string;
  /** Database (e.g., "PostgreSQL 15", "MongoDB 7") */
  database?: string;
  /** ORM (e.g., "Prisma 5", "TypeORM") */
  orm?: string;
  /** Package manager (npm, yarn, pnpm) */
  packageManager?: string;
  /** Java version if applicable */
  javaVersion?: string;
  /** Node version if applicable */
  nodeVersion?: string;
  /** Key dependencies with versions */
  dependencies?: Record<string, string>;
  /** Port mappings */
  ports?: Record<string, number>;
  /** Build/run commands */
  buildCommands?: Record<string, string>;
  /** Code conventions established */
  conventions?: string[];
}

// ============================================================================
// PROJECT STATE
// ============================================================================

export interface ProjectState {
  // Project metadata
  projectName: string;
  projectDescription: string;
  specFile: string;
  workDir: string;

  // External integrations
  jiraProject?: string;
  githubRepo?: string;

  // Phase tracking
  currentPhase: Phase;
  currentStep: string;

  // Build phase tracking
  currentBuildPhaseNumber: number;
  buildPhases: BuildPhase[];
  completedPhases: CompletedPhase[];

  // Tech context (survives compaction)
  tech: TechContext;

  // What has been built (survives compaction)
  entities: string[];
  endpoints: string[];
  uiPages: string[];
  knownIssues: string[];

  // QA state (for current phase)
  qaAttempts: number;
  lastQaVerdict?: QaVerdict;
  lastQaFindings?: string;

  // Timestamps
  startedAt: string;
  lastUpdatedAt: string;
}

export interface CompletedPhase {
  number: number;
  name: string;
  completedAt: string;
  buildTime: string;
  prNumber?: number;
  aarPath?: string;
}

// ============================================================================
// GATE TYPES
// ============================================================================

export interface ArtifactCheck {
  /** Artifact name for logging */
  name: string;
  /** File path checked */
  path: string;
  /** Whether the file exists */
  exists: boolean;
  /** Whether the content is valid */
  valid: boolean;
  /** Validation error if invalid */
  validationError?: string;
}

export interface GateResult {
  /** Whether the gate passed */
  passed: boolean;
  /** Gate name */
  gate: string;
  /** Human-readable message */
  message: string;
  /** Artifacts checked */
  artifacts: ArtifactCheck[];
  /** Timestamp */
  timestamp: string;
}

// ============================================================================
// SPAWNER TYPES
// ============================================================================

export interface SpawnOptions {
  /** Working directory */
  cwd?: string;
  /** Timeout in milliseconds */
  timeoutMs?: number;
  /** Session name for logging */
  sessionName?: string;
}

export interface SpawnResult {
  /** Process exit code */
  exitCode: number;
  /** Stdout output */
  stdout: string;
  /** Stderr output */
  stderr: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Whether rate limiting was detected in agent output */
  rateLimited?: boolean;
}
