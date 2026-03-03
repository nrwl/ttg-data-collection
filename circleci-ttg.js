#!/usr/bin/env node

/**
 * SELF-CONTAINED CIRCLECI TIME TO GREEN (TTG) DATA COLLECTION SCRIPT
 *
 * This script collects Time to Green metrics from CircleCI using a PR-first
 * architecture: it fetches PRs from GitHub with server-side date filtering,
 * then looks up CircleCI pipelines per PR branch, avoiding the need to
 * paginate through the entire pipeline history.
 *
 * USAGE:
 *   node circleci-ttg.js
 *
 * REQUIRED ENVIRONMENT VARIABLES:
 *   CIRCLECI_TOKEN - CircleCI Personal API Token with read permissions
 *   GITHUB_TOKEN - GitHub Personal Access Token with repo read permissions (for GitHub repos)
 *   CIRCLECI_ORG - CircleCI organization name
 *   CIRCLECI_PROJECT - CircleCI project name
 *   SINCE_DATE - Start date for analysis (YYYY-MM-DD format)
 *   UNTIL_DATE - End date for analysis (YYYY-MM-DD format)
 *   CIRCLECI_EXCLUDED_BRANCHES - Comma-separated list of branch patterns to exclude
 *                                (supports glob patterns: *, ?, [abc])
 *                                (default: "main,master")
 *   OUTPUT_FILE_NAME - Name of the output file (default: ttg-circleci-data-<identifier>-<timestamp>.csv)
 *
 * EXAMPLES:
 *   # Basic usage
 *   CIRCLECI_TOKEN=xxx GITHUB_TOKEN=ghp_xxx \
 *   CIRCLECI_ORG=myorg CIRCLECI_PROJECT=myproject \
 *   node circleci-ttg.js
 *
 *   # Custom date range
 *   SINCE_DATE=2025-01-01 UNTIL_DATE=2025-01-31 \
 *   CIRCLECI_TOKEN=xxx GITHUB_TOKEN=ghp_xxx \
 *   CIRCLECI_ORG=myorg CIRCLECI_PROJECT=myproject \
 *   node circleci-ttg.js
 *
 *   # Custom branch exclusions with glob patterns
 *   CIRCLECI_EXCLUDED_BRANCHES="main,master,develop,release/*,hotfix/*" \
 *   CIRCLECI_TOKEN=xxx GITHUB_TOKEN=ghp_xxx \
 *   CIRCLECI_ORG=myorg CIRCLECI_PROJECT=myproject \
 *   node circleci-ttg.js
 *
 *   # Exclude all branches starting with "staging"
 *   CIRCLECI_EXCLUDED_BRANCHES="main,master,staging*" \
 *   CIRCLECI_TOKEN=xxx GITHUB_TOKEN=ghp_xxx \
 *   CIRCLECI_ORG=myorg CIRCLECI_PROJECT=myproject \
 *   node circleci-ttg.js
 *
 * OUTPUT:
 *   Creates CSV file in ./output/circleci/ directory with PR and pipeline data including:
 *   - PR information (title, status, creation/close dates) from GitHub API
 *   - Pipeline details (status, result, start/finish times) from CircleCI API
 *   - Pipeline duration calculations for TTG analysis
 *   - Summary statistics
 *
 * ARCHITECTURE:
 *   1. Fetch PRs from GitHub Search API (server-side date filtering)
 *   2. For each PR, fetch its head branch details from GitHub
 *   3. Use CircleCI's branch filter to fetch only pipelines for that branch
 *   4. Match pipelines to the PR via commit SHA membership
 *   5. Fetch workflows for matched pipelines
 *
 *   This avoids paginating through the entire CircleCI pipeline history,
 *   making historical date range queries efficient regardless of repo age.
 */

const { mkdirSync, writeFileSync } = require('fs');
const { join } = require('path');

// ============================================================================
// CONFIGURATION
// ============================================================================

// Global configuration from environment variables
const CIRCLECI_TOKEN = process.env.CIRCLECI_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const CIRCLECI_ORG = process.env.CIRCLECI_ORG;
const CIRCLECI_PROJECT = process.env.CIRCLECI_PROJECT;
const SINCE_DATE = process.env.SINCE_DATE;
const UNTIL_DATE = process.env.UNTIL_DATE;
const CIRCLECI_EXCLUDED_BRANCHES =
  process.env.CIRCLECI_EXCLUDED_BRANCHES || 'main,master';
// Only GitHub is supported for now
const CIRCLECI_VCS_TYPE = process.env.CIRCLECI_VCS_TYPE || 'github';

// Parse excluded branch patterns
const excludedBranchPatterns = CIRCLECI_EXCLUDED_BRANCHES.split(',')
  .map((pattern) => pattern.trim())
  .filter((pattern) => pattern.length > 0);

if (CIRCLECI_VCS_TYPE !== 'github') {
  console.error('Only GitHub is supported for now');
  console.error('Please set CIRCLECI_VCS_TYPE to "github"');
  process.exit(1);
}

if (!SINCE_DATE || !UNTIL_DATE) {
  console.error('SINCE_DATE and UNTIL_DATE environment variables are required');
  console.error(
    'Example: SINCE_DATE=2026-01-01 UNTIL_DATE=2026-01-31 node circleci-ttg.js'
  );
  process.exit(1);
}

// ============================================================================
// TYPE DEFINITIONS (JSDoc)
// ============================================================================

/**
 * @typedef {'circleci'} Platform
 */

/**
 * @typedef {Object} CircleCIPipeline
 * @property {string} id
 * @property {number} number
 * @property {string} project_slug
 * @property {string} updated_at
 * @property {string} created_at
 * @property {string} state
 * @property {Object} vcs
 * @property {string} vcs.revision
 * @property {string} vcs.branch
 * @property {Object} [trigger]
 * @property {string} trigger.type
 * @property {Object} [trigger.actor]
 * @property {string} trigger.actor.login
 */

/**
 * @typedef {Object} CircleCIWorkflow
 * @property {string} id
 * @property {string} name
 * @property {string} status
 * @property {string} created_at
 * @property {string} stopped_at
 * @property {string} pipeline_id
 * @property {number} pipeline_number
 */

/**
 * @typedef {Object} GitHubPullRequest
 * @property {number} number
 * @property {string} title
 * @property {'open' | 'closed'} state
 * @property {string} created_at
 * @property {string} [merged_at]
 * @property {string} [closed_at]
 * @property {boolean} merged
 * @property {string} head_branch - Head branch name of the PR
 * @property {string[]} commit_shas - Commit SHAs belonging to this PR
 */

/**
 * @typedef {Object} TTGDataRow
 * @property {Platform} platform
 * @property {string} repository
 * @property {string} pr_id
 * @property {string} pr_title
 * @property {string} pr_status
 * @property {string} pr_created_at
 * @property {string|null} pr_closed_at
 * @property {string} pipeline_id
 * @property {string} pipeline_status
 * @property {string} pipeline_result
 * @property {string} pipeline_start_time
 * @property {string} pipeline_finish_time
 * @property {number} pipeline_excluded_duration_ms
 * @property {string} pipeline_excluded_stages
 * @property {string} pipeline_author
 * @property {string} pipeline_requested_for
 */

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Convert YYYY-MM-DD to ISO UTC
 * @param {string} dateString
 * @returns {string}
 */
/**
 * Convert date string to ISO format (start of day in UTC)
 * @param {string} dateString - Date in YYYY-MM-DD format
 * @returns {string} ISO 8601 date string at start of day (00:00:00.000Z)
 */
function convertDateToISO(dateString) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    throw new Error(
      `Invalid date format: ${dateString}. Use YYYY-MM-DD format only.`
    );
  }

  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString();
}

/**
 * Convert date string to ISO format (end of day in UTC)
 * @param {string} dateString - Date in YYYY-MM-DD format
 * @returns {string} ISO 8601 date string at end of day (23:59:59.999Z)
 */
function convertDateToISOEndOfDay(dateString) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    throw new Error(
      `Invalid date format: ${dateString}. Use YYYY-MM-DD format only.`
    );
  }

  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(
    Date.UTC(year, month - 1, day, 23, 59, 59, 999)
  ).toISOString();
}

/**
 * Generic function to add delay between API requests
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Truncate string to specified length with ellipsis
 * @param {string} str
 * @param {number} maxLength
 * @returns {string}
 */
function truncateString(str, maxLength) {
  return str.length > maxLength ? `${str.slice(0, maxLength)}...` : str;
}

/**
 * Escape CSV field values
 * @param {string | undefined | null} value
 * @returns {string}
 */
function escapeCsvField(value) {
  const safeValue = value || '';
  if (
    safeValue.includes(',') ||
    safeValue.includes('"') ||
    safeValue.includes('\n')
  ) {
    return `"${safeValue.replace(/"/g, '""')}"`;
  }
  return safeValue;
}

/**
 * Convert TTG data to CSV format
 * @param {TTGDataRow[]} data
 * @returns {string}
 */
function convertTTGDataToCSV(data) {
  const headers = [
    'platform',
    'repository',
    'pr_id',
    'pr_title',
    'pr_status',
    'pr_created_at',
    'pr_closed_at',
    'pipeline_id',
    'pipeline_status',
    'pipeline_result',
    'pipeline_start_time',
    'pipeline_finish_time',
    'pipeline_excluded_duration_ms',
    'pipeline_excluded_stages',
    'pipeline_author',
    'pipeline_requested_for',
  ];

  const csvRows = [
    headers.join(','),
    ...data.map((row) =>
      [
        escapeCsvField(row.platform),
        escapeCsvField(row.repository),
        escapeCsvField(row.pr_id),
        escapeCsvField(row.pr_title),
        escapeCsvField(row.pr_status),
        escapeCsvField(row.pr_created_at),
        escapeCsvField(row.pr_closed_at || ''),
        escapeCsvField(row.pipeline_id),
        escapeCsvField(row.pipeline_status),
        escapeCsvField(row.pipeline_result),
        escapeCsvField(row.pipeline_start_time),
        escapeCsvField(row.pipeline_finish_time),
        escapeCsvField(row.pipeline_excluded_duration_ms?.toString() || '0'),
        escapeCsvField(row.pipeline_excluded_stages || ''),
        escapeCsvField(row.pipeline_author || ''),
        escapeCsvField(row.pipeline_requested_for || ''),
      ].join(',')
    ),
  ];

  return csvRows.join('\n');
}

/**
 * Save TTG data to CSV file
 * @param {TTGDataRow[]} data
 * @param {string} platform
 * @param {string} identifier
 * @returns {string}
 */
function saveTTGDataToCSV(data, platform, identifier) {
  const outputPath = join(process.cwd(), 'output', platform);
  mkdirSync(outputPath, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename =
    process.env.OUTPUT_FILE_NAME ||
    `ttg-${platform}-data-${identifier}-${timestamp}.csv`;
  const filepath = join(outputPath, filename);

  const csvContent = convertTTGDataToCSV(data);
  writeFileSync(filepath, csvContent);

  console.log(`💾 Saved TTG data: ${filepath}`);
  console.log(`📊 Records: ${data.length} PR/pipeline combinations`);

  return filepath;
}

// ============================================================================
// LOGGING UTILITIES
// ============================================================================

/**
 * Common logging utilities for TTG analysis steps
 */
class TTGAnalysisLogger {
  constructor() {
    this.stepCount = 0;
  }

  /**
   * @param {string} platform
   */
  logAnalysisStart(platform) {
    console.log(`🚀 Starting ${platform} TTG analysis...`);
  }

  /**
   * @param {string} description
   */
  logStep(description) {
    this.stepCount++;
    console.log(`\n🔄 Step ${this.stepCount}: ${description}`);
  }

  /**
   * @param {number|string} prId
   * @param {number} current
   * @param {number} total
   * @param {string} title
   */
  logPRProcessing(prId, current, total, title) {
    console.log(
      `  📝 PR #${prId} (${current}/${total}): ${truncateString(title, 50)}`
    );
  }

  /**
   * @param {string} message
   */
  logSubStep(message) {
    console.log(`    ${message}`);
  }

  /**
   * @param {string} message
   */
  logSuccess(message) {
    console.log(`    ✅ ${message}`);
  }

  /**
   * @param {string} message
   */
  logError(message) {
    console.log(`    ❌ ${message}`);
  }
}

// ============================================================================
// CIRCLECI API FUNCTIONS
// ============================================================================

/**
 * Make CircleCI API request
 * @param {string} url
 * @returns {Promise<any>}
 */
async function makeCircleCIRequest(url) {
  const response = await fetch(url, {
    headers: {
      'Circle-Token': CIRCLECI_TOKEN,
      Accept: 'application/json',
      'User-Agent': 'circleci-ttg-analyzer/1.0.0',
    },
  });

  if (!response.ok) {
    throw new Error(
      `CircleCI API request failed: ${response.status} ${response.statusText}`
    );
  }

  return response.json();
}

/**
 * Fetch PRs from GitHub Search API with server-side date filtering
 * @param {string} since - ISO date string
 * @param {string} until - ISO date string
 * @returns {Promise<GitHubPullRequest[]>}
 */
async function fetchPullRequests(since, until) {
  console.log('🔍 Searching PRs...');
  const searchStart = Date.now();

  /** @type {GitHubPullRequest[]} */
  const allPRs = [];
  let page = 1;
  let hasMore = true;

  // Convert to YYYY-MM-DD format for GitHub search
  const sinceDate = since.split('T')[0];
  const untilDate = until.split('T')[0];

  console.log(`📅 Date range: ${sinceDate} → ${untilDate}`);

  while (hasMore) {
    const pageStart = Date.now();
    console.log(`  📄 Page ${page}...`);

    // Use GitHub Search API with precise date filtering
    const searchQuery = `repo:${CIRCLECI_ORG}/${CIRCLECI_PROJECT} is:pr created:${sinceDate}..${untilDate}`;
    const encodedQuery = encodeURIComponent(searchQuery);
    const url = `https://api.github.com/search/issues?q=${encodedQuery}&sort=created&order=desc&per_page=100&page=${page}`;

    const data = await makeGitHubRequest(url);

    if (!data.items || data.items.length === 0) {
      break;
    }

    console.log(
      `    ✅ Found ${data.items.length} PRs (${Date.now() - pageStart}ms)`
    );

    // Convert search results to our PR format (branch and commits are fetched later)
    for (const item of data.items) {
      allPRs.push({
        number: item.number,
        title: item.title,
        state: item.state,
        created_at: item.created_at,
        merged_at: item.pull_request?.merged_at || null,
        closed_at: item.closed_at,
        merged: false, // Will be enriched in fetchPRDetails
        head_branch: '', // Will be enriched in fetchPRDetails
        commit_shas: [], // Will be enriched in fetchPRCommitSHAs
      });
    }

    // GitHub Search API returns max 100 per page
    hasMore = data.items.length === 100;
    page++;

    // Small delay between requests
    if (hasMore) {
      await delay(100);
    }
  }

  const searchEnd = Date.now();
  console.log(
    `✅ Found ${allPRs.length} PRs total (${Math.round(
      (searchEnd - searchStart) / 1000
    )}s)`
  );

  return allPRs;
}

/**
 * Fetch full PR details from GitHub (includes head branch, merged status)
 * @param {number} prNumber
 * @returns {Promise<{head_branch: string, merged: boolean} | null>}
 */
async function fetchPRDetails(prNumber) {
  try {
    const url = `https://api.github.com/repos/${CIRCLECI_ORG}/${CIRCLECI_PROJECT}/pulls/${prNumber}`;
    const pr = await makeGitHubRequest(url);
    return {
      head_branch: pr.head?.ref || '',
      merged: pr.merged || false,
    };
  } catch (error) {
    console.log(
      `    ⚠️  Failed to fetch PR #${prNumber} details: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}

/**
 * Fetch commit SHAs for a pull request
 * @param {number} prNumber
 * @returns {Promise<string[]>}
 */
async function fetchPRCommitSHAs(prNumber) {
  /** @type {string[]} */
  const commits = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const url = `https://api.github.com/repos/${CIRCLECI_ORG}/${CIRCLECI_PROJECT}/pulls/${prNumber}/commits?page=${page}&per_page=100`;
    const data = await makeGitHubRequest(url);

    if (!Array.isArray(data) || data.length === 0) {
      break;
    }

    for (const commit of data) {
      commits.push(commit.sha);
    }

    hasMore = data.length === 100;
    page++;

    if (hasMore) {
      await delay(10);
    }
  }

  return commits;
}

/**
 * Fetch CircleCI pipelines for a specific branch, filtered to the date range.
 * Uses the CircleCI branch query parameter to avoid paginating through the
 * entire project history.
 * @param {string} branch - Branch name to filter by
 * @param {string} since - ISO date string (start of range)
 * @param {string} until - ISO date string (end of range)
 * @returns {Promise<CircleCIPipeline[]>}
 */
async function fetchPipelinesForBranch(branch, since, until) {
  /** @type {CircleCIPipeline[]} */
  const allPipelines = [];
  let pageToken = null;
  let hasMore = true;

  const projectSlug = `${CIRCLECI_VCS_TYPE}/${CIRCLECI_ORG}/${CIRCLECI_PROJECT}`;

  while (hasMore) {
    const params = new URLSearchParams();
    params.append('branch', branch);
    if (pageToken) {
      params.append('page-token', pageToken);
    }

    const url = `https://circleci.com/api/v2/project/${projectSlug}/pipeline?${params.toString()}`;
    const data = await makeCircleCIRequest(url);

    if (!data.items || data.items.length === 0) {
      break;
    }

    // Client-side date range filtering
    const sinceTime = new Date(since).getTime();
    const untilTime = new Date(until).getTime();

    for (const pipeline of data.items) {
      const pipelineTime = new Date(pipeline.created_at).getTime();
      if (pipelineTime >= sinceTime && pipelineTime <= untilTime) {
        allPipelines.push(pipeline);
      }
    }

    // Stop early once all pipelines on a page are older than the since date
    // (CircleCI returns pipelines newest-first)
    const allBeforeSince = data.items.every(
      (p) => new Date(p.created_at).getTime() < sinceTime
    );
    if (allBeforeSince) {
      break;
    }

    pageToken = data.next_page_token;
    hasMore = !!pageToken;

    if (hasMore) {
      await delay(100);
    }
  }

  return allPipelines;
}

/**
 * Fetch workflows for a specific pipeline
 * @param {string} pipelineId
 * @returns {Promise<CircleCIWorkflow[]>}
 */
async function fetchWorkflowsForPipeline(pipelineId) {
  const url = `https://circleci.com/api/v2/pipeline/${pipelineId}/workflow`;
  const data = await makeCircleCIRequest(url);

  return data.items || [];
}

/**
 * Check if a branch name matches any of the excluded patterns
 * Supports glob patterns: *, ?, []
 * @param {string|null} branchName
 * @param {string[]} excludedPatterns
 * @returns {boolean}
 */
function isBranchExcluded(branchName, excludedPatterns) {
  if (!branchName) return true; // Exclude branches with no name

  return excludedPatterns.some((pattern) => {
    // Convert glob pattern to regex
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special regex characters first
      .replace(/\*/g, '.*') // * matches any characters
      .replace(/\?/g, '.') // ? matches single character
      .replace(/\\\[([^\]]+)\\\]/g, '[$1]'); // [abc] character class (unescape brackets)

    const regex = new RegExp(`^${regexPattern}$`, 'i'); // case insensitive
    return regex.test(branchName);
  });
}

// ============================================================================
// GITHUB API
// ============================================================================

/**
 * Make GitHub API request
 * @param {string} url
 * @returns {Promise<any>}
 */
async function makeGitHubRequest(url) {
  const response = await fetch(url, {
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'circleci-ttg-analyzer/1.0.0',
    },
  });

  if (!response.ok) {
    throw new Error(
      `GitHub API request failed: ${response.status} ${response.statusText}`
    );
  }

  return response.json();
}

// ============================================================================
// MAIN EXECUTION FUNCTION
// ============================================================================

/**
 * Process a single PR: fetch its branch details, commit SHAs, CircleCI
 * pipelines (scoped to the branch), and workflows. Returns CSV rows.
 *
 * @param {GitHubPullRequest} pr
 * @param {string} sinceISO
 * @param {string} untilISO
 * @param {string} repository
 * @returns {Promise<{pr_id: number, pr_title: string, records: number, data: TTGDataRow[], pipelines: number, skip_reason?: string, error?: string}>}
 */
async function processPR(pr, sinceISO, untilISO, repository) {
  try {
    // Fetch full PR details (head branch, merged status)
    const details = await fetchPRDetails(pr.number);
    if (!details || !details.head_branch) {
      return {
        pr_id: pr.number,
        pr_title: pr.title,
        records: 0,
        data: [],
        pipelines: 0,
        skip_reason: 'no_branch',
      };
    }

    pr.head_branch = details.head_branch;
    pr.merged = details.merged;

    // Check branch exclusion early, before any CircleCI API calls
    if (isBranchExcluded(pr.head_branch, excludedBranchPatterns)) {
      return {
        pr_id: pr.number,
        pr_title: pr.title,
        records: 0,
        data: [],
        pipelines: 0,
        skip_reason: 'excluded_branch',
      };
    }

    // Fetch the PR's commit SHAs (used to verify pipeline ownership)
    const commitSHAs = await fetchPRCommitSHAs(pr.number);
    pr.commit_shas = commitSHAs;
    const commitSet = new Set(commitSHAs);

    // Fetch CircleCI pipelines for this branch (scoped query, not full history)
    const pipelines = await fetchPipelinesForBranch(
      pr.head_branch,
      sinceISO,
      untilISO
    );

    if (pipelines.length === 0) {
      return {
        pr_id: pr.number,
        pr_title: pr.title,
        records: 0,
        data: [],
        pipelines: 0,
        skip_reason: 'no_pipelines',
      };
    }

    // Filter pipelines to only those whose commit SHA belongs to this PR.
    // This handles the case where multiple PRs share the same branch name.
    const matchedPipelines = pipelines.filter((pipeline) => {
      const sha = pipeline.vcs?.revision;
      return sha && commitSet.has(sha);
    });

    if (matchedPipelines.length === 0) {
      return {
        pr_id: pr.number,
        pr_title: pr.title,
        records: 0,
        data: [],
        pipelines: pipelines.length,
        skip_reason: 'no_matching_pipelines',
      };
    }

    // Fetch workflows for each matched pipeline
    /** @type {TTGDataRow[]} */
    const prData = [];
    const prStatus = pr.merged ? `${pr.state}:merged` : pr.state;

    for (const pipeline of matchedPipelines) {
      const workflows = await fetchWorkflowsForPipeline(pipeline.id);

      for (const workflow of workflows) {
        prData.push({
          platform: 'circleci',
          repository,
          pr_id: pr.number.toString(),
          pr_title: pr.title,
          pr_status: prStatus,
          pr_created_at: pr.created_at,
          pr_closed_at: pr.closed_at || pr.merged_at || null,
          pipeline_id: pipeline.id,
          pipeline_status: workflow.status,
          pipeline_result:
            workflow.status === 'success'
              ? 'success'
              : workflow.status === 'failed'
              ? 'failed'
              : workflow.status,
          pipeline_start_time: workflow.created_at,
          pipeline_finish_time: workflow.stopped_at || workflow.created_at,
          pipeline_excluded_duration_ms: 0,
          pipeline_excluded_stages: '',
          pipeline_author: pipeline.trigger?.actor?.login || '',
          pipeline_requested_for: pipeline.trigger?.actor?.login || '',
        });
      }
    }

    return {
      pr_id: pr.number,
      pr_title: pr.title,
      records: prData.length,
      data: prData,
      pipelines: matchedPipelines.length,
    };
  } catch (error) {
    console.log(
      `    ❌ PR #${pr.number}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return {
      pr_id: pr.number,
      pr_title: pr.title,
      records: 0,
      data: [],
      pipelines: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Main execution function
 */
async function runAnalysis() {
  const totalStart = Date.now();
  const logger = new TTGAnalysisLogger();

  logger.logAnalysisStart('CircleCI');

  if (!CIRCLECI_TOKEN) {
    throw new Error('CIRCLECI_TOKEN environment variable is required');
  }

  if (!GITHUB_TOKEN && CIRCLECI_VCS_TYPE === 'github') {
    throw new Error(
      'GITHUB_TOKEN environment variable is required for GitHub repositories'
    );
  }

  if (!CIRCLECI_ORG || !CIRCLECI_PROJECT) {
    throw new Error(
      'CIRCLECI_ORG and CIRCLECI_PROJECT environment variables are required'
    );
  }

  const sinceISO = convertDateToISO(SINCE_DATE);
  const untilISO = convertDateToISOEndOfDay(UNTIL_DATE);

  console.log(`📊 Organization: ${CIRCLECI_ORG}`);
  console.log(`📊 Project: ${CIRCLECI_PROJECT}`);
  console.log(`📊 VCS Type: ${CIRCLECI_VCS_TYPE}`);
  console.log(`📅 Period: ${SINCE_DATE} → ${UNTIL_DATE}`);
  console.log(`🚫 Excluded branches: ${CIRCLECI_EXCLUDED_BRANCHES}`);

  // Step 1: Fetch PRs from GitHub (server-side date filtering)
  logger.logStep('Fetching PRs from GitHub');
  const prs = await fetchPullRequests(sinceISO, untilISO);
  logger.logSuccess(`${prs.length} PRs found`);

  if (prs.length === 0) {
    console.log('❌ No PRs found in date range');
    return;
  }

  // Step 2: For each PR, fetch branch pipelines and workflows
  logger.logStep('Collecting pipeline and workflow data per PR');
  const collectionStart = Date.now();

  /** @type {TTGDataRow[]} */
  const csvData = [];
  const repository = `${CIRCLECI_ORG}/${CIRCLECI_PROJECT}`;

  // Process PRs in parallel batches
  const batchSize = 6;
  let processedCount = 0;
  let totalRecords = 0;
  let prsWithPipelines = 0;

  for (let i = 0; i < prs.length; i += batchSize) {
    const batch = prs.slice(i, i + batchSize);
    const batchStart = Date.now();

    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(prs.length / batchSize);
    console.log(
      `\n📦 Processing batch ${batchNum}/${totalBatches} (${batch.length} PRs):`
    );
    batch.forEach((pr, idx) => {
      logger.logPRProcessing(pr.number, i + idx + 1, prs.length, pr.title);
    });

    const batchPromises = batch.map((pr) =>
      processPR(pr, sinceISO, untilISO, repository)
    );
    const batchResults = await Promise.all(batchPromises);

    // Log batch results
    const batchTime = Date.now() - batchStart;
    let batchRecords = 0;
    let errorCount = 0;

    batchResults.forEach((result) => {
      csvData.push(...result.data);
      batchRecords += result.records;

      if (result.error) {
        errorCount++;
      } else if (result.records > 0) {
        prsWithPipelines++;
        console.log(
          `    ✅ PR #${result.pr_id}: ${result.pipelines} pipelines, ${
            result.records
          } records - ${truncateString(result.pr_title, 50)}`
        );
      } else {
        const reason =
          result.skip_reason === 'no_branch'
            ? 'no branch info'
            : result.skip_reason === 'excluded_branch'
            ? 'excluded branch'
            : result.skip_reason === 'no_pipelines'
            ? 'no pipelines on branch'
            : result.skip_reason === 'no_matching_pipelines'
            ? 'no pipelines matched PR commits'
            : 'unknown reason';
        console.log(`    ⚠️  PR #${result.pr_id}: skipped (${reason})`);
      }
    });

    processedCount += batch.length;
    totalRecords += batchRecords;

    console.log(
      `\n✅ Batch ${batchNum} complete: ${batchRecords} records in ${Math.round(
        batchTime / 1000
      )}s${errorCount > 0 ? ` (${errorCount} errors)` : ''}`
    );
    console.log(
      `📊 Progress: ${processedCount}/${prs.length} PRs (${Math.round(
        (processedCount / prs.length) * 100
      )}%) | ${prsWithPipelines} PRs with pipelines | ${totalRecords} total records`
    );
  }

  const collectionEnd = Date.now();
  logger.logSuccess(
    `Data collection complete (${Math.round(
      (collectionEnd - collectionStart) / 1000
    )}s)`
  );

  // Step 3: Save to CSV
  logger.logStep('Saving to CSV');
  const identifier = `${CIRCLECI_ORG}-${CIRCLECI_PROJECT}`;
  const csvFilePath = saveTTGDataToCSV(csvData, 'circleci', identifier);

  const totalTime = Date.now() - totalStart;

  console.log('\n🎉 Data Collection Summary');
  console.log(`  📊 Platform: CircleCI (${CIRCLECI_ORG}/${CIRCLECI_PROJECT})`);
  console.log(`  📊 PRs found: ${prs.length}`);
  console.log(`  📊 PRs with pipelines: ${prsWithPipelines}`);
  console.log(`  📊 Total records: ${csvData.length}`);
  console.log(`  📁 CSV file: ${csvFilePath}`);
  console.log(`  ⏱️  Total time: ${Math.round(totalTime / 1000)}s`);
  console.log('✅ Data collection complete!');
}

// ============================================================================
// SCRIPT EXECUTION
// ============================================================================

// Run the analysis
runAnalysis().catch((error) => {
  console.error('Failed to run CircleCI TTG analysis:', error);
  process.exit(1);
});
