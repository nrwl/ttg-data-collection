#!/usr/bin/env node

/**
 * SELF-CONTAINED GITHUB TIME TO GREEN (TTG) DATA COLLECTION SCRIPT
 *
 * This script collects Time to Green metrics from GitHub by fetching Pull Requests
 * and their associated workflow runs (CI builds). It provides comprehensive TTG data
 * for analyzing development velocity and CI performance.
 *
 * USAGE:
 *   node github-ttg.js
 *
 * REQUIRED ENVIRONMENT VARIABLES:
 *   GITHUB_TOKEN - GitHub Personal Access Token with repo and actions read permissions
 *   GITHUB_OWNER - GitHub repository owner (user or organization name)
 *   GITHUB_REPO - GitHub repository name
 *
 * OPTIONAL ENVIRONMENT VARIABLES:
 *   SINCE_DATE - Start date for analysis (YYYY-MM-DD format, default: 2025-08-11)
 *   UNTIL_DATE - End date for analysis (YYYY-MM-DD format, default: 2025-08-19)
 *   GITHUB_WORKFLOW_RUN_NAME - Name of the workflow to analyze (default: CI)
 *
 * EXAMPLES:
 *   # Basic usage
 *   GITHUB_TOKEN=ghp_xxx GITHUB_OWNER=nrwl GITHUB_REPO=nx \
 *   node github-ttg.js
 *
 *   # Custom date range and workflow
 *   SINCE_DATE=2025-01-01 UNTIL_DATE=2025-01-31 \
 *   GITHUB_WORKFLOW_RUN_NAME="Build and Test" \
 *   GITHUB_TOKEN=ghp_xxx GITHUB_OWNER=myorg GITHUB_REPO=myrepo \
 *   node github-ttg.js
 *
 * OUTPUT:
 *   Creates CSV file in ./output/ttg/ directory with PR and workflow run data including:
 *   - PR information (title, status, creation/close dates)
 *   - Workflow run details (status, result, start/finish times)
 *   - Build duration calculations for TTG analysis
 *   - Summary statistics
 *
 * FEATURES:
 *   - Fetches PRs and workflow runs from GitHub API
 *   - Uses GitHub Search API for efficient PR discovery
 *   - Parallel processing with rate limiting
 *   - Detailed logging and progress tracking
 *   - Handles merged vs closed PR status distinction
 *   - Comprehensive error handling and retry logic
 */

const { mkdirSync, writeFileSync } = require('fs');
const { join } = require('path');

// ============================================================================
// CONFIGURATION
// ============================================================================

// Global configuration from environment variables
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'nrwl';
const GITHUB_REPO = process.env.GITHUB_REPO || 'nx';
const SINCE_DATE = process.env.SINCE_DATE || '2025-08-11';
const UNTIL_DATE = process.env.UNTIL_DATE || '2025-08-19';
const GITHUB_WORKFLOW_RUN_NAME = process.env.GITHUB_WORKFLOW_RUN_NAME || 'CI';

// ============================================================================
// TYPE DEFINITIONS (JSDoc)
// ============================================================================

/**
 * @typedef {'azure-devops' | 'github'} Platform
 */

/**
 * @typedef {Object} GitHubPullRequest
 * @property {number} number
 * @property {string} title
 * @property {'open' | 'closed' | 'merged'} state
 * @property {string} created_at
 * @property {string} [merged_at]
 * @property {string} [closed_at]
 */

/**
 * @typedef {'success' | 'completed' | 'queued' | 'in_progress' | 'waiting' | 'action_required' | 'cancelled' | 'failure' | 'neutral' | 'skipped' | 'stale' | 'timed_out' | 'pending' | 'requested'} GitHubWorkflowRunStatus
 */

/**
 * @typedef {Object} GitHubWorkflowRun
 * @property {number} id
 * @property {string} name
 * @property {string} head_sha
 * @property {'completed' | 'queued' | 'in_progress' | 'waiting'} status
 * @property {GitHubWorkflowRunStatus | null} conclusion
 * @property {number} workflow_id
 * @property {string} created_at
 * @property {string} updated_at
 * @property {string} run_started_at
 * @property {number} run_attempt
 * @property {Array<{number: number}>} pull_requests
 * @property {Object} [actor]
 * @property {string} actor.login
 * @property {Object} [triggering_actor]
 * @property {string} triggering_actor.login
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
 * @property {string} build_id
 * @property {string} build_status
 * @property {string} build_result
 * @property {string} build_start_time
 * @property {string} build_finish_time
 * @property {number} build_excluded_duration_ms
 * @property {string} build_excluded_stages
 * @property {string} build_author
 * @property {string} build_requested_for
 */

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Convert YYYY-MM-DD to ISO UTC
 * @param {string} dateString
 * @returns {string}
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
    'build_id',
    'build_status',
    'build_result',
    'build_start_time',
    'build_finish_time',
    'build_excluded_duration_ms',
    'build_excluded_stages',
    'build_author',
    'build_requested_for',
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
        escapeCsvField(row.build_id),
        escapeCsvField(row.build_status),
        escapeCsvField(row.build_result),
        escapeCsvField(row.build_start_time),
        escapeCsvField(row.build_finish_time),
        escapeCsvField(row.build_excluded_duration_ms?.toString() || '0'),
        escapeCsvField(row.build_excluded_stages || ''),
        escapeCsvField(row.build_author || ''),
        escapeCsvField(row.build_requested_for || ''),
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
  const outputPath = join(process.cwd(), 'output', 'ttg');
  mkdirSync(outputPath, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `ttg-${platform}-data-${identifier}-${timestamp}.csv`;
  const filepath = join(outputPath, filename);

  const csvContent = convertTTGDataToCSV(data);
  writeFileSync(filepath, csvContent);

  console.log(`💾 Saved TTG data: ${filepath}`);
  console.log(`📊 Records: ${data.length} PR/build combinations`);

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
// GITHUB API FUNCTIONS
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
      'User-Agent': 'github-ttg-analyzer/1.0.0',
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
 * Fetch all pull requests within date range using GitHub Search API
 * @param {string} since
 * @param {string} until
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
    const searchQuery = `repo:${GITHUB_OWNER}/${GITHUB_REPO} is:pr created:${sinceDate}..${untilDate}`;
    const encodedQuery = encodeURIComponent(searchQuery);
    const url = `https://api.github.com/search/issues?q=${encodedQuery}&sort=created&order=desc&per_page=100&page=${page}`;

    const data = await makeGitHubRequest(url);

    if (!data.items || data.items.length === 0) {
      break;
    }

    console.log(
      `    ✅ Found ${data.items.length} PRs (${Date.now() - pageStart}ms)`
    );

    // Convert search results to our PR format
    for (const item of data.items) {
      /** @type {GitHubPullRequest} */
      const convertedPR = {
        number: item.number,
        title: item.title,
        state: item.state,
        created_at: item.created_at,
        merged_at: item.pull_request?.merged_at || null,
        closed_at: item.closed_at,
      };
      allPRs.push(convertedPR);
    }

    // Continue to next page if we have more data
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
 * Fetch commits for a pull request
 * @param {number} prNumber
 * @returns {Promise<string[]>}
 */
async function fetchPRCommits(prNumber) {
  /** @type {string[]} */
  const commits = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls/${prNumber}/commits?page=${page}&per_page=100`;
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
 * Fetch CI workflow runs for specific commit SHAs (only specified workflow name) in parallel
 * @param {string[]} commitShas
 * @returns {Promise<GitHubWorkflowRun[]>}
 */
async function fetchWorkflowRunsForCommits(commitShas) {
  /** @type {GitHubWorkflowRun[]} */
  const allRuns = [];

  // Process commits in parallel batches to avoid overwhelming the API
  const commitBatchSize = 6;

  for (let i = 0; i < commitShas.length; i += commitBatchSize) {
    const batch = commitShas.slice(i, i + commitBatchSize);

    const batchPromises = batch.map(async (sha) => {
      /** @type {GitHubWorkflowRun[]} */
      const runs = [];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs?head_sha=${sha}&page=${page}&per_page=100`;
        const data = await makeGitHubRequest(url);

        const items = data.workflow_runs || [];

        // Filter to only include specific run name
        const ciRuns = items.filter(
          (run) => run.name === GITHUB_WORKFLOW_RUN_NAME
        );
        runs.push(...ciRuns);

        hasMore = items.length === 100;
        page++;

        if (hasMore) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }

      return runs;
    });

    const batchResults = await Promise.all(batchPromises);
    batchResults.forEach((runs) => allRuns.push(...runs));

    // Small delay between batches
    if (i + commitBatchSize < commitShas.length) {
      await delay(20);
    }
  }

  return allRuns;
}

// ============================================================================
// LOGGING UTILITIES
// ============================================================================

// ============================================================================
// MAIN EXECUTION FUNCTION
// ============================================================================

/**
 * Main execution function
 */
async function runAnalysis() {
  const totalStart = Date.now();
  const logger = new TTGAnalysisLogger();

  logger.logAnalysisStart('GitHub');

  if (!GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN environment variable is required');
  }

  const sinceISO = convertDateToISO(SINCE_DATE);
  const untilISO = convertDateToISO(UNTIL_DATE);

  console.log(`📊 Repository: ${GITHUB_OWNER}/${GITHUB_REPO}`);
  console.log(`📊 Workflow: ${GITHUB_WORKFLOW_RUN_NAME}`);
  console.log(`📅 Period: ${SINCE_DATE} → ${UNTIL_DATE}`);

  // Step 1: Fetch PRs
  logger.logStep('Fetching PRs');
  const pullRequests = await fetchPullRequests(sinceISO, untilISO);
  logger.logSuccess(`${pullRequests.length} PRs found`);

  if (pullRequests.length === 0) {
    console.log('❌ No PRs found');
    return;
  }

  // Step 2: Collect PR and workflow run data in parallel
  logger.logStep('Collecting PR and workflow run data');
  const collectionStart = Date.now();

  /** @type {TTGDataRow[]} */
  const csvData = [];
  const repository = `${GITHUB_OWNER}/${GITHUB_REPO}`;

  // Process PRs in parallel batches
  const batchSize = 8;
  let processedCount = 0;
  let totalRecords = 0;

  for (let i = 0; i < pullRequests.length; i += batchSize) {
    const batch = pullRequests.slice(i, i + batchSize);
    const batchStart = Date.now();

    // Log batch start
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(pullRequests.length / batchSize);
    console.log(
      `\n📦 Processing batch ${batchNum}/${totalBatches} (${batch.length} PRs):`
    );
    batch.forEach((pr, idx) => {
      console.log(
        `  • PR #${pr.number} (${i + idx + 1}/${
          pullRequests.length
        }): ${pr.title.substring(0, 60)}${pr.title.length > 60 ? '...' : ''}`
      );
    });

    const batchPromises = batch.map(async (pr) => {
      try {
        // Fetch all commits for this PR
        const commits = await fetchPRCommits(pr.number);

        // Fetch workflow runs for all commits in this PR
        const workflowRuns = await fetchWorkflowRunsForCommits(commits);

        // Only record PR if there are workflow runs
        if (workflowRuns.length > 0) {
          /** @type {TTGDataRow[]} */
          const prData = [];
          // Convert each workflow run to CSV format
          for (const run of workflowRuns) {
            // Calculate build duration (GitHub doesn't need stage exclusion)
            const buildStart = new Date(run.run_started_at || run.created_at);
            const buildFinish = new Date(run.updated_at);
            const buildDurationMs =
              buildFinish.getTime() - buildStart.getTime();

            prData.push({
              platform: 'github',
              repository,
              pr_id: pr.number.toString(),
              pr_title: pr.title,
              pr_status: pr.merged_at ? `${pr.state}:merged` : pr.state,
              pr_created_at: pr.created_at,
              pr_closed_at: pr.closed_at || pr.merged_at || null,
              build_id: run.id.toString(),
              build_status: run.status,
              build_result: run.conclusion || '',
              build_start_time: run.run_started_at || run.created_at,
              build_finish_time: run.updated_at,
              build_excluded_duration_ms: 0, // No stage exclusions for GitHub
              build_excluded_stages: '', // No stage exclusions for GitHub
              build_author: run.actor?.login || '',
              build_requested_for: run.triggering_actor?.login || run.actor?.login || '',
            });
          }
          return {
            pr: pr.number,
            commits: commits.length,
            runs: workflowRuns.length,
            records: prData.length,
            data: prData,
          };
        } else {
          return {
            pr: pr.number,
            commits: commits.length,
            runs: 0,
            records: 0,
            data: [],
          };
        }
      } catch (error) {
        console.log(
          `    ❌ PR #${pr.number}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return {
          pr: pr.number,
          commits: 0,
          runs: 0,
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
      } else if (result.runs > 0) {
        console.log(
          `    ✅ PR #${result.pr}: ${result.commits} commits, ${result.runs} runs, ${result.records} records`
        );
      } else {
        console.log(
          `    ⚠️  PR #${result.pr}: ${result.commits} commits, no workflow runs`
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
      `📊 Progress: ${processedCount}/${pullRequests.length} PRs (${Math.round(
        (processedCount / pullRequests.length) * 100
      )}%) | ${totalRecords} total records`
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
  const identifier = `${GITHUB_OWNER}-${GITHUB_REPO}`;
  const csvFilePath = saveTTGDataToCSV(csvData, 'github', identifier);

  const totalTime = Date.now() - totalStart;

  console.log('\n🎉 Data Collection Summary');
  console.log(`  📊 Platform: GitHub (${GITHUB_OWNER}/${GITHUB_REPO})`);
  console.log(`  📊 PRs processed: ${pullRequests.length}`);
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
  console.error('Failed to run GitHub TTG analysis:', error);
  process.exit(1);
});
