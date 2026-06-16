/**
 * Jira integration for turkey-enterprise-v3
 * Uses Jira REST API directly (no CLI dependency)
 * v3: Auto-creates projects if they don't exist
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { audit } from './audit';

interface JiraConfig {
  host: string;
  email: string;
  token: string;
  project: string;
}

export interface TicketSummary {
  key: string;
  summary: string;
  status: string;
  issueType: string;
  priority?: string;
  updated?: string;
}

export interface AttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  contentUrl: string;
}

export interface TicketComment {
  author: string;
  created: string;
  body: string;
}

export interface TicketDetail {
  key: string;
  summary: string;
  description: string;
  status: string;
  issueType: string;
  priority?: string;
  labels: string[];
  attachments: AttachmentMeta[];
  comments: TicketComment[];
}

interface JiraRawIssue {
  key: string;
  fields?: Record<string, unknown>;
}

interface JiraRawAttachment {
  id: string | number;
  filename?: string;
  mimeType?: string;
  size?: number;
  content?: string;
}

interface JiraRawComment {
  author?: unknown;
  created?: string;
  body?: unknown;
}

/**
 * Flatten Atlassian Document Format (ADF) or a plain string into readable text.
 * We don't render formatting — just concatenate text nodes with reasonable spacing
 * so the result is usable in Claude prompts.
 */
export function flattenAdf(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (typeof input !== 'object') return String(input);

  const parts: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; text?: string; content?: unknown[]; attrs?: Record<string, unknown> };

    if (typeof n.text === 'string') {
      parts.push(n.text);
    }

    if (n.type === 'hardBreak') parts.push('\n');

    // Render mention/link attrs inline so ticket references survive
    if (n.type === 'mention' && n.attrs && typeof n.attrs.text === 'string') {
      parts.push(n.attrs.text);
    }
    if (n.type === 'inlineCard' && n.attrs && typeof n.attrs.url === 'string') {
      parts.push(n.attrs.url);
    }

    if (Array.isArray(n.content)) {
      for (const child of n.content) visit(child);
    }

    // Block-level separators go after children so runs of empty blocks still collapse
    if (n.type === 'paragraph' || n.type === 'heading') parts.push('\n\n');
    if (n.type === 'listItem') parts.push('\n');
  };

  visit(input);
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Check if Jira is configured (env vars set)
 * JIRA_PROJECT is optional - can be auto-created
 */
export function isJiraConfigured(): boolean {
  return !!(
    process.env.JIRA_HOST &&
    process.env.JIRA_EMAIL &&
    process.env.JIRA_TOKEN
  );
}

/**
 * Get Jira config from environment
 */
function getConfig(): JiraConfig | null {
  if (!isJiraConfigured()) return null;

  return {
    host: process.env.JIRA_HOST!,
    email: process.env.JIRA_EMAIL!,
    token: process.env.JIRA_TOKEN!,
    project: process.env.JIRA_PROJECT || ''
  };
}

/**
 * Make an authenticated request to Jira REST API
 */
async function jiraRequest(
  config: JiraConfig,
  method: string,
  endpoint: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
  const url = `https://${config.host}/rest/api/3/${endpoint}`;
  const auth = Buffer.from(`${config.email}:${config.token}`).toString('base64');

  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });

    let data: unknown;
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      data = await response.json();
    }

    if (!response.ok) {
      let errorMsg = `HTTP ${response.status}`;
      if (typeof data === 'object' && data !== null) {
        const d = data as Record<string, unknown>;
        const messages = (d.errorMessages as string[]) || [];
        const errors = d.errors ? Object.entries(d.errors as Record<string, string>).map(([k, v]) => `${k}: ${v}`) : [];
        const combined = [...messages, ...errors].filter(Boolean).join('; ');
        if (combined) errorMsg = combined;
      }
      return { ok: false, status: response.status, error: errorMsg };
    }

    return { ok: true, status: response.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
}

/**
 * Make an authenticated request to Jira Agile API (for sprints)
 */
async function agileRequest(
  config: JiraConfig,
  method: string,
  endpoint: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
  const url = `https://${config.host}/rest/agile/1.0/${endpoint}`;
  const auth = Buffer.from(`${config.email}:${config.token}`).toString('base64');

  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });

    let data: unknown;
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      data = await response.json();
    }

    if (!response.ok) {
      let errorMsg = `HTTP ${response.status}`;
      if (typeof data === 'object' && data !== null) {
        const d = data as Record<string, unknown>;
        const messages = (d.errorMessages as string[]) || [];
        const errors = d.errors ? Object.entries(d.errors as Record<string, string>).map(([k, v]) => `${k}: ${v}`) : [];
        const combined = [...messages, ...errors].filter(Boolean).join('; ');
        if (combined) errorMsg = combined;
      }
      return { ok: false, status: response.status, error: errorMsg };
    }

    return { ok: true, status: response.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
}

/**
 * Jira client - uses REST API directly
 * All methods skip gracefully if Jira is not configured
 */
export class JiraClient {
  private config: JiraConfig | null;
  private boardId: number | null = null;

  constructor(project?: string) {
    this.config = getConfig();

    // Override project if provided
    if (this.config && project) {
      this.config.project = project;
    }

    if (!this.config) {
      console.log('[jira] Not configured (need JIRA_HOST, JIRA_EMAIL, JIRA_TOKEN)');
    } else if (this.config.project) {
      console.log(`[jira] Configured for ${this.config.host} / ${this.config.project}`);
    } else {
      console.log(`[jira] Configured for ${this.config.host} (no project set - will auto-create)`);
    }
  }

  /**
   * Check if Jira operations will work
   */
  isEnabled(): boolean {
    return this.config !== null;
  }

  /**
   * Ensure a Jira project exists, creating it if necessary.
   * Generates a project key from the description if JIRA_PROJECT is not set.
   * Returns the project key or null if Jira is not configured.
   */
  async ensureProject(description: string): Promise<string | null> {
    if (!this.config) return null;

    // Generate project key if not set
    if (!this.config.project) {
      this.config.project = this.generateProjectKey(description);
      console.log(`[jira] Auto-generated project key: ${this.config.project}`);
    }

    // Get current user's accountId (required as project lead)
    const meResult = await jiraRequest(this.config, 'GET', 'myself');
    if (!meResult.ok || !meResult.data) {
      console.error(`[jira] Failed to get current user: ${meResult.error}`);
      return null;
    }
    const accountId = (meResult.data as { accountId: string }).accountId;

    // Try to create project, incrementing key suffix if taken (handles ghost/deleted projects too)
    const baseKey = this.config.project;
    let suffix = 1;
    const maxAttempts = 10;

    while (suffix <= maxAttempts) {
      console.log(`[jira] Trying to create project with key: ${this.config.project}...`);

      const createResult = await jiraRequest(this.config, 'POST', 'project', {
        key: this.config.project,
        name: `${description.substring(0, 80)}${suffix > 1 ? ` (${suffix})` : ''}`,
        projectTypeKey: 'software',
        leadAccountId: accountId,
        projectTemplateKey: 'com.pyxis.greenhopper.jira:gh-scrum-template'
      });

      if (createResult.ok) {
        const project = createResult.data as { key: string; id: string };
        console.log(`[jira] Created project: ${project.key} (id: ${project.id})`);
        audit('jira_sprint_created', { details: { projectKey: project.key, projectId: project.id } });
        break;
      }

      const errMsg = createResult.error || '';
      // Key conflict — try next suffix
      if (errMsg.includes('project key') || errMsg.includes('already') || createResult.status === 400) {
        suffix++;
        this.config.project = `${baseKey}${suffix}`;
        console.log(`[jira] Key taken, trying ${this.config.project}...`);
        continue;
      }

      // Some other error — bail
      console.error(`[jira] Failed to create project: ${errMsg}`);
      return null;
    }

    if (suffix > maxAttempts) {
      console.error(`[jira] Could not find available project key after ${maxAttempts} attempts`);
      return null;
    }

    // The Scrum template auto-creates a board, so just let getBoardId() find it
    // Give Jira a moment to provision the board
    await new Promise(resolve => setTimeout(resolve, 2000));

    return this.config.project;
  }

  /**
   * Generate a Jira project key from a description.
   * Takes uppercase initials of first 2-4 words, max 10 chars.
   */
  private generateProjectKey(description: string): string {
    const words = description
      .replace(/[^a-zA-Z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 0);

    if (words.length === 0) return 'PROJ';

    // Take first letter of each word (up to 4 words)
    let key = words
      .slice(0, 4)
      .map(w => w[0].toUpperCase())
      .join('');

    // If too short, pad with more letters from the first word
    if (key.length < 2 && words[0].length > 1) {
      key = words[0].substring(0, 4).toUpperCase();
    }

    // Jira keys must start with a letter and be 2-10 uppercase chars
    key = key.replace(/[^A-Z]/g, '');
    if (key.length < 2) key = 'PROJ';
    if (key.length > 10) key = key.substring(0, 10);

    return key;
  }

  /**
   * Get the project key (after ensureProject has been called)
   */
  getProjectKey(): string | null {
    return this.config?.project || null;
  }

  /**
   * Get the board ID for the project (needed for sprint operations)
   */
  private async getBoardId(): Promise<number | null> {
    if (this.boardId) return this.boardId;
    if (!this.config) return null;

    const result = await agileRequest(
      this.config,
      'GET',
      `board?projectKeyOrId=${this.config.project}`
    );

    if (result.ok && result.data) {
      const boards = result.data as { values: Array<{ id: number; name: string }> };
      if (boards.values && boards.values.length > 0) {
        this.boardId = boards.values[0].id;
        console.log(`[jira] Found board ID: ${this.boardId}`);
        return this.boardId;
      }
    }

    console.log(`[jira] No board found for project ${this.config.project}`);
    return null;
  }

  /**
   * Create a new sprint
   * Returns sprint ID or null if skipped
   */
  async createSprint(name: string): Promise<number | null> {
    if (!this.config) return null;

    const boardId = await this.getBoardId();
    if (!boardId) {
      console.log('[jira] Cannot create sprint without board ID');
      return null;
    }

    const result = await agileRequest(this.config, 'POST', 'sprint', {
      name,
      originBoardId: boardId
    });

    if (result.ok && result.data) {
      const sprint = result.data as { id: number; name: string };
      console.log(`[jira] Created sprint: ${sprint.id} - ${sprint.name}`);
      audit('jira_sprint_created', { details: { sprintId: sprint.id, name: sprint.name } });
      return sprint.id;
    }

    console.error(`[jira] Failed to create sprint: ${result.error}`);
    return null;
  }

  /**
   * Start a sprint
   */
  async startSprint(sprintId: number): Promise<boolean> {
    if (!this.config) return false;

    const startDate = new Date().toISOString();
    const endDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(); // 2 weeks

    const result = await agileRequest(this.config, 'POST', `sprint/${sprintId}`, {
      state: 'active',
      startDate,
      endDate
    });

    if (result.ok) {
      console.log(`[jira] Started sprint: ${sprintId}`);
      return true;
    }

    console.error(`[jira] Failed to start sprint: ${result.error}`);
    return false;
  }

  /**
   * Complete a sprint
   */
  async completeSprint(sprintId: number): Promise<boolean> {
    if (!this.config) return false;

    const result = await agileRequest(this.config, 'POST', `sprint/${sprintId}`, {
      state: 'closed'
    });

    if (result.ok) {
      console.log(`[jira] Completed sprint: ${sprintId}`);
      return true;
    }

    console.error(`[jira] Failed to complete sprint: ${result.error}`);
    return false;
  }

  /**
   * Create a ticket (issue)
   * Returns ticket key or null if skipped
   */
  async createTicket(options: {
    summary: string;
    description?: string;
    sprintId?: number;
    storyPoints?: number;
    issueType?: string;
  }): Promise<string | null> {
    if (!this.config) return null;

    // Create issue
    const issueData: Record<string, unknown> = {
      fields: {
        project: { key: this.config.project },
        summary: options.summary,
        issuetype: { name: options.issueType || 'Task' }
      }
    };

    // Add description in Atlassian Document Format (ADF)
    if (options.description) {
      (issueData.fields as Record<string, unknown>).description = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: options.description
              }
            ]
          }
        ]
      };
    }

    let result = await jiraRequest(this.config, 'POST', 'issue', issueData);

    // If project key is invalid, try to find the right one by checking with suffix
    if (!result.ok && result.error && (result.error.includes('valid project') || result.error.includes('does not exist'))) {
      console.log(`[jira] Project key '${this.config.project}' invalid, searching for correct key...`);
      const baseKey = this.config.project.replace(/\d+$/, '');
      for (let suffix = 1; suffix <= 15; suffix++) {
        const tryKey = suffix === 1 ? baseKey : `${baseKey}${suffix}`;
        const checkResult = await jiraRequest(this.config, 'GET', `project/${tryKey}`);
        if (checkResult.ok) {
          console.log(`[jira] Found valid project: ${tryKey}`);
          this.config.project = tryKey;
          (issueData.fields as Record<string, unknown>).project = { key: tryKey };
          result = await jiraRequest(this.config, 'POST', 'issue', issueData);
          break;
        }
      }
    }

    if (result.ok && result.data) {
      const issue = result.data as { key: string; id: string };
      console.log(`[jira] Created ticket: ${issue.key}`);
      audit('jira_ticket_created', { details: { ticket: issue.key } });

      // Add to sprint if specified
      if (options.sprintId) {
        await this.addToSprint(issue.key, options.sprintId);
      }

      return issue.key;
    }

    console.error(`[jira] Failed to create ticket: ${result.error}`);
    return null;
  }

  /**
   * Add issue to sprint
   */
  private async addToSprint(issueKey: string, sprintId: number): Promise<boolean> {
    if (!this.config) return false;

    const result = await agileRequest(this.config, 'POST', `sprint/${sprintId}/issue`, {
      issues: [issueKey]
    });

    if (result.ok) {
      console.log(`[jira] Added ${issueKey} to sprint ${sprintId}`);
      return true;
    }

    console.error(`[jira] Failed to add issue to sprint: ${result.error}`);
    return false;
  }

  /**
   * Transition a ticket to a new status
   */
  async transitionTicket(ticketKey: string, status: string): Promise<boolean> {
    if (!this.config) return false;

    // First, get available transitions
    const transResult = await jiraRequest(
      this.config,
      'GET',
      `issue/${ticketKey}/transitions`
    );

    if (!transResult.ok) {
      console.error(`[jira] Failed to get transitions: ${transResult.error}`);
      return false;
    }

    const transitions = transResult.data as { transitions: Array<{ id: string; name: string }> };
    const transition = transitions.transitions.find(
      t => t.name.toLowerCase() === status.toLowerCase()
    );

    if (!transition) {
      console.log(`[jira] No transition found for status "${status}" on ${ticketKey}`);
      console.log(`[jira] Available: ${transitions.transitions.map(t => t.name).join(', ')}`);
      return false;
    }

    const result = await jiraRequest(
      this.config,
      'POST',
      `issue/${ticketKey}/transitions`,
      { transition: { id: transition.id } }
    );

    if (result.ok) {
      console.log(`[jira] Transitioned ${ticketKey} to ${status}`);
      return true;
    }

    console.error(`[jira] Failed to transition ticket: ${result.error}`);
    return false;
  }

  /**
   * Log work time to a ticket
   */
  async logWork(ticketKey: string, time: string, comment?: string): Promise<boolean> {
    if (!this.config) return false;

    // Parse time string (e.g., "2h 30m" or "1h" or "30m")
    const timeSeconds = this.parseTimeToSeconds(time);
    if (timeSeconds === 0) {
      console.log(`[jira] Invalid time format: ${time}`);
      return false;
    }

    const worklog: Record<string, unknown> = {
      timeSpentSeconds: timeSeconds
    };

    if (comment) {
      worklog.comment = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: comment }]
          }
        ]
      };
    }

    const result = await jiraRequest(
      this.config,
      'POST',
      `issue/${ticketKey}/worklog`,
      worklog
    );

    if (result.ok) {
      console.log(`[jira] Logged ${time} to ${ticketKey}`);
      audit('jira_time_logged', { details: { ticket: ticketKey, time } });
      return true;
    }

    console.error(`[jira] Failed to log work: ${result.error}`);
    return false;
  }

  /**
   * Parse time string to seconds
   */
  private parseTimeToSeconds(time: string): number {
    let seconds = 0;

    const hourMatch = time.match(/(\d+)\s*h/i);
    if (hourMatch) {
      seconds += parseInt(hourMatch[1], 10) * 3600;
    }

    const minMatch = time.match(/(\d+)\s*m/i);
    if (minMatch) {
      seconds += parseInt(minMatch[1], 10) * 60;
    }

    const secMatch = time.match(/(\d+)\s*s/i);
    if (secMatch) {
      seconds += parseInt(secMatch[1], 10);
    }

    return seconds;
  }

  /**
   * Add a comment to a ticket
   */
  async addComment(ticketKey: string, comment: string): Promise<boolean> {
    if (!this.config) return false;

    const result = await jiraRequest(
      this.config,
      'POST',
      `issue/${ticketKey}/comment`,
      {
        body: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: comment }]
            }
          ]
        }
      }
    );

    if (result.ok) {
      console.log(`[jira] Added comment to ${ticketKey}`);
      return true;
    }

    console.error(`[jira] Failed to add comment: ${result.error}`);
    return false;
  }

  /**
   * Close a ticket with optional PR reference
   */
  async closeTicket(ticketKey: string, prNumber?: number): Promise<boolean> {
    if (prNumber) {
      await this.addComment(ticketKey, `Closed via PR #${prNumber}`);
    }
    return this.transitionTicket(ticketKey, 'Done');
  }

  /**
   * Find tickets assigned to the current user (from the Jira API token's owner)
   * Filters out Done-status-category tickets by default.
   */
  async searchAssignedToMe(opts: { includeDone?: boolean; maxResults?: number } = {}): Promise<TicketSummary[]> {
    if (!this.config) return [];

    const jql = opts.includeDone
      ? 'assignee = currentUser() ORDER BY updated DESC'
      : 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
    const maxResults = opts.maxResults ?? 50;

    const result = await jiraRequest(
      this.config,
      'POST',
      'search/jql',
      {
        jql,
        fields: ['summary', 'status', 'issuetype', 'priority', 'updated'],
        maxResults,
      },
    );

    if (!result.ok) {
      console.error(`[jira] searchAssignedToMe failed: ${result.error}`);
      return [];
    }

    const data = result.data as { issues?: JiraRawIssue[] };
    return (data.issues ?? []).map((issue): TicketSummary => ({
      key: issue.key,
      summary: (issue.fields?.summary as string) ?? '',
      status: (issue.fields?.status as { name?: string })?.name ?? '',
      issueType: (issue.fields?.issuetype as { name?: string })?.name ?? '',
      priority: (issue.fields?.priority as { name?: string })?.name,
      updated: issue.fields?.updated as string | undefined,
    }));
  }

  /**
   * Fetch a single ticket with description, comments, and attachment metadata.
   * Description is flattened from ADF to plain text.
   */
  async getTicket(key: string): Promise<TicketDetail | null> {
    if (!this.config) return null;

    const result = await jiraRequest(
      this.config,
      'GET',
      `issue/${encodeURIComponent(key)}?fields=summary,description,status,issuetype,priority,attachment,comment,labels,assignee,reporter`,
    );

    if (!result.ok) {
      console.error(`[jira] getTicket(${key}) failed: ${result.error}`);
      return null;
    }

    const issue = result.data as JiraRawIssue;
    const fields = issue.fields ?? {};

    const description = flattenAdf(fields.description);
    const attachments: AttachmentMeta[] = Array.isArray(fields.attachment)
      ? (fields.attachment as JiraRawAttachment[]).map((a) => ({
          id: String(a.id),
          filename: a.filename ?? 'unnamed',
          mimeType: a.mimeType ?? 'application/octet-stream',
          size: typeof a.size === 'number' ? a.size : 0,
          contentUrl: a.content ?? '',
        }))
      : [];

    const commentData = fields.comment as { comments?: JiraRawComment[] } | undefined;
    const comments: TicketComment[] = (commentData?.comments ?? []).map((c) => ({
      author: (c.author as { displayName?: string } | undefined)?.displayName ?? 'unknown',
      created: c.created ?? '',
      body: flattenAdf(c.body),
    }));

    return {
      key: issue.key,
      summary: (fields.summary as string) ?? '',
      description,
      status: (fields.status as { name?: string })?.name ?? '',
      issueType: (fields.issuetype as { name?: string })?.name ?? '',
      priority: (fields.priority as { name?: string })?.name,
      labels: Array.isArray(fields.labels) ? (fields.labels as string[]) : [],
      attachments,
      comments,
    };
  }

  /**
   * Download an attachment to disk. Uses basic auth so private attachments work.
   * Returns true on success. Creates parent directories as needed.
   */
  async downloadAttachment(attachment: AttachmentMeta, destPath: string): Promise<boolean> {
    if (!this.config) return false;
    if (!attachment.contentUrl) {
      console.error(`[jira] attachment ${attachment.id} has no content URL`);
      return false;
    }

    const auth = Buffer.from(`${this.config.email}:${this.config.token}`).toString('base64');

    try {
      const response = await fetch(attachment.contentUrl, {
        method: 'GET',
        headers: { Authorization: `Basic ${auth}` },
        redirect: 'follow',
      });

      if (!response.ok) {
        console.error(`[jira] attachment download failed for ${attachment.filename}: HTTP ${response.status}`);
        return false;
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      mkdirSync(dirname(destPath), { recursive: true });
      writeFileSync(destPath, bytes);
      return true;
    } catch (err) {
      console.error(`[jira] attachment download error for ${attachment.filename}: ${String(err)}`);
      return false;
    }
  }
}

/**
 * Create a Jira client
 */
export function createJiraClient(project?: string): JiraClient {
  return new JiraClient(project);
}
