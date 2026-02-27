#!/usr/bin/env node

/**
 * SELF-CONTAINED CIRCLECI TIME TO GREEN (TTG) DATA COLLECTION SCRIPT
 *
 * This script collects Time to Green metrics from CircleCI by fetching Pipelines
 * and their associated workflow runs. It integrates with GitHub API to get PR details
 * for PR-triggered pipelines, providing comprehensive TTG data for analyzing
 * development velocity and CI performance.
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
 * FEATURES:
 *   - Fetches pipelines and workflows from CircleCI API
 *   - Integrates with GitHub API for PR details
 *   - Filters to only PR-triggered pipelines
 *   - Parallel processing with rate limiting
 *   - Detailed logging and progress tracking
 *   - Comprehensive error handling and retry logic
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
 * Fetch all pipelines within date range for a specific project
 * @param {string} since
 * @param {string} until
 * @returns {Promise<CircleCIPipeline[]>}
 */
async function fetchPipelines(since, until) {
  console.log('🔍 Searching Pipelines...');
  const searchStart = Date.now();

  /** @type {CircleCIPipeline[]} */
  const allPipelines = [];
  let pageToken = null;
  let hasMore = true;

  const projectSlug = `${CIRCLECI_VCS_TYPE}/${CIRCLECI_ORG}/${CIRCLECI_PROJECT}`;

  // Convert to YYYY-MM-DD format for CircleCI API
  const sinceDate = since.split('T')[0];
  const untilDate = until.split('T')[0];

  console.log(`📅 Date range: ${sinceDate} → ${untilDate}`);
  console.log(`📊 Project: ${projectSlug}`);

  while (hasMore) {
    const pageStart = Date.now();
    console.log(
      `  📄 Page ${pageToken ? `(${pageToken.substring(0, 8)}...)` : '1'}...`
    );

    const params = new URLSearchParams();
    if (pageToken) {
      params.append('page-token', pageToken);
    }

    const url = `https://circleci.com/api/v2/project/${projectSlug}/pipeline?${params.toString()}`;
    const data = await makeCircleCIRequest(url);

    if (!data.items || data.items.length === 0) {
      break;
    }

    // Filter pipelines by date range
    const filteredPipelines = data.items.filter((pipeline) => {
      const pipelineDate = new Date(pipeline.created_at);
      const isInDateRange =
        pipelineDate >= new Date(since) && pipelineDate <= new Date(until);

      return isInDateRange;
    });

    console.log(
      `    ✅ Found ${data.items.length} total, ${
        filteredPipelines.length
      } matching pipelines (${Date.now() - pageStart}ms)`
    );

    allPipelines.push(...filteredPipelines);

    // CircleCI returns pipelines in reverse chronological order (newest first).
    // Once all pipelines on a page are older than the `since` date, every
    // subsequent page will only contain even older pipelines — stop early to
    // avoid paginating through the entire project history.
    const allBeforeSince = data.items.every(
      (p) => new Date(p.created_at) < new Date(since)
    );
    if (allBeforeSince) {
      console.log(
        `  ⏹️  All pipelines on this page are before ${sinceDate}, stopping pagination`
      );
      break;
    }

    // Check for more pages
    pageToken = data.next_page_token;
    hasMore = !!pageToken;

    // Small delay between requests
    if (hasMore) {
      await delay(100);
    }
  }

  const searchEnd = Date.now();
  console.log(
    `✅ Found ${allPipelines.length} pipelines total (${Math.round(
      (searchEnd - searchStart) / 1000
    )}s)`
  );

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
 * Extract commit SHA from CircleCI pipeline
 * @param {CircleCIPipeline} pipeline
 * @returns {string|null}
 */
function extractCommitShaFromPipeline(pipeline) {
  if (pipeline.vcs && pipeline.vcs.revision) {
    return pipeline.vcs.revision;
  }
  return null;
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
// GITHUB VCS PROVIDER INTEGRATION
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

/**
 * Fetch PR details from GitHub API using commit SHA
 * @param {string} owner - GitHub repository owner
 * @param {string} repo - GitHub repository name
 * @param {string} commitSha - Commit hash to find PR for
 * @returns {Promise<GitHubPullRequest | null>}
 */
async function fetchPRDetailsFromGitHub(owner, repo, commitSha) {
  try {
    const url = `https://api.github.com/repos/${owner}/${repo}/commits/${commitSha}/pulls`;
    const pulls = await makeGitHubRequest(url);

    if (!Array.isArray(pulls) || pulls.length === 0) {
      return null;
    }

    // Return the first PR associated with this commit
    const pr = pulls[0];
    return {
      number: pr.number,
      title: pr.title,
      state: pr.state,
      created_at: pr.created_at,
      merged_at: pr.merged_at,
      closed_at: pr.closed_at,
      merged: pr.merged || false,
    };
  } catch (error) {
    console.log(
      `    ⚠️  Failed to fetch PR for commit ${commitSha}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}

// ============================================================================
// MAIN EXECUTION FUNCTION
// ============================================================================

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

  // Step 1: Fetch Pipelines
  logger.logStep('Fetching Pipelines');
  const pipelines = await fetchPipelines(sinceISO, untilISO);
  logger.logSuccess(`${pipelines.length} pipelines found`);

  if (pipelines.length === 0) {
    console.log('❌ No pipelines found');
    return;
  }

  // Step 2: Collect Pipeline and PR data in parallel
  logger.logStep('Collecting pipeline and PR data');
  const collectionStart = Date.now();

  /** @type {TTGDataRow[]} */
  const csvData = [];
  const repository = `${CIRCLECI_ORG}/${CIRCLECI_PROJECT}`;

  // Process pipelines in parallel batches
  const batchSize = 6;
  let processedCount = 0;
  let totalRecords = 0;
  let prPipelinesCount = 0;

  for (let i = 0; i < pipelines.length; i += batchSize) {
    const batch = pipelines.slice(i, i + batchSize);
    const batchStart = Date.now();

    // Log batch start
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(pipelines.length / batchSize);
    console.log(
      `\n📦 Processing batch ${batchNum}/${totalBatches} (${batch.length} pipelines):`
    );
    batch.forEach((pipeline, idx) => {
      console.log(
        `  • Pipeline #${pipeline.number} (${i + idx + 1}/${
          pipelines.length
        }): ${pipeline.id.substring(0, 8)}... (${new Date(
          pipeline.created_at
        ).toLocaleDateString()})`
      );
    });

    const batchPromises = batch.map(async (pipeline) => {
      try {
        // Extract commit SHA from pipeline
        const commitSha = extractCommitShaFromPipeline(pipeline);

        if (!commitSha) {
          return {
            pipeline: pipeline.number,
            workflows: 0,
            records: 0,
            data: [],
            skip_reason: 'no_commit_sha',
          };
        }

        // Fetch PR details from GitHub (only for GitHub VCS type)
        let prDetails = null;
        if (CIRCLECI_VCS_TYPE === 'github') {
          prDetails = await fetchPRDetailsFromGitHub(
            CIRCLECI_ORG,
            CIRCLECI_PROJECT,
            commitSha
          );
        }

        // Skip non-PR pipelines
        if (!prDetails) {
          return {
            pipeline: pipeline.number,
            workflows: 0,
            records: 0,
            data: [],
            skip_reason: 'no_pr_found',
          };
        }

        // Skip pipelines run on excluded branches - only include feature branch pipelines
        const branch = pipeline.vcs?.branch;
        if (isBranchExcluded(branch, excludedBranchPatterns)) {
          return {
            pipeline: pipeline.number,
            workflows: 0,
            records: 0,
            data: [],
            skip_reason: 'excluded_branch',
            branch: branch || 'unknown',
            excluded_patterns: CIRCLECI_EXCLUDED_BRANCHES,
          };
        }

        // Fetch workflows for this pipeline
        const workflows = await fetchWorkflowsForPipeline(pipeline.id);

        // Only record pipeline if there are workflows
        if (workflows.length > 0) {
          /** @type {TTGDataRow[]} */
          const pipelineData = [];

          // Convert each workflow to CSV format
          for (const workflow of workflows) {
            const prStatus = prDetails.merged
              ? `${prDetails.state}:merged`
              : prDetails.state;

            pipelineData.push({
              platform: 'circleci',
              repository,
              pr_id: prDetails.number.toString(),
              pr_title: prDetails.title,
              pr_status: prStatus,
              pr_created_at: prDetails.created_at,
              pr_closed_at: prDetails.closed_at || prDetails.merged_at || null,
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
              pipeline_excluded_duration_ms: 0, // No stage exclusions for CircleCI
              pipeline_excluded_stages: '', // No stage exclusions for CircleCI
              pipeline_author: pipeline.trigger?.actor?.login || '',
              pipeline_requested_for: pipeline.trigger?.actor?.login || '',
            });
          }

          return {
            pipeline: pipeline.number,
            workflows: workflows.length,
            records: pipelineData.length,
            data: pipelineData,
            pr_id: prDetails.number,
            pr_title: prDetails.title.substring(0, 50),
          };
        } else {
          return {
            pipeline: pipeline.number,
            workflows: 0,
            records: 0,
            data: [],
            skip_reason: 'no_workflows',
          };
        }
      } catch (error) {
        console.log(
          `    ❌ Pipeline #${pipeline.number}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return {
          pipeline: pipeline.number,
          workflows: 0,
          records: 0,
          data: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

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
        prPipelinesCount++;
        console.log(
          `    ✅ Pipeline #${result.pipeline} (PR #${result.pr_id}): ${result.workflows} workflows, ${result.records} records - ${result.pr_title}`
        );
      } else {
        const reason =
          result.skip_reason === 'no_commit_sha'
            ? 'no commit SHA'
            : result.skip_reason === 'no_pr_found'
            ? 'not a PR'
            : result.skip_reason === 'excluded_branch'
            ? `excluded branch (${result.branch || 'unknown'}) - patterns: ${
                result.excluded_patterns
              }`
            : result.skip_reason === 'no_workflows'
            ? 'no workflows'
            : 'unknown reason';
        console.log(
          `    ⚠️  Pipeline #${result.pipeline}: skipped (${reason})`
        );
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
      `📊 Progress: ${processedCount}/${
        pipelines.length
      } pipelines (${Math.round(
        (processedCount / pipelines.length) * 100
      )}%) | ${prPipelinesCount} PR pipelines | ${totalRecords} total records`
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
  console.log(`  📊 Pipelines processed: ${pipelines.length}`);
  console.log(`  📊 PR pipelines: ${prPipelinesCount}`);
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
