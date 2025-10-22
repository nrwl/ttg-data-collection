#!/usr/bin/env node

/**
 * SELF-CONTAINED AZURE DEVOPS TIME TO GREEN (TTG) DATA COLLECTION SCRIPT
 *
 * This script collects Time to Green metrics from Azure DevOps by fetching Pull Requests
 * and their associated builds. It supports stage exclusion to filter out non-development
 * pipeline stages (like deployment, approval) for more accurate TTG measurements.
 *
 * USAGE:
 *   node devops-ttg.js
 *
 * REQUIRED ENVIRONMENT VARIABLES:
 *   AZURE_DEVOPS_TOKEN - Azure DevOps Personal Access Token with build/PR read permissions
 *   AZURE_ORG - Azure DevOps organization name
 *   AZURE_PROJECT - Azure DevOps project name
 *   AZURE_REPO_ID - Azure DevOps repository ID
 *   AZURE_BUILD_DEFINITION_NAME - Name of the build definition to analyze
 *
 * OPTIONAL ENVIRONMENT VARIABLES:
 *   SINCE_DATE - Start date for analysis (YYYY-MM-DD format, default: 2025-08-11)
 *   UNTIL_DATE - End date for analysis (YYYY-MM-DD format, default: 2025-08-19)
 *   EXCLUDED_STAGES - Comma-separated list of pipeline stage names to exclude from duration calculation
 *
 * EXAMPLES:
 *   # Basic usage
 *   AZURE_DEVOPS_TOKEN=xxx AZURE_ORG=myorg AZURE_PROJECT=myproject \
 *   AZURE_REPO_ID=repo-guid AZURE_BUILD_DEFINITION_NAME=CI \
 *   node devops-ttg.js
 *
 *   # With stage exclusions
 *   EXCLUDED_STAGES="deployment,approval,manual validation" \
 *   AZURE_DEVOPS_TOKEN=xxx AZURE_ORG=myorg AZURE_PROJECT=myproject \
 *   AZURE_REPO_ID=repo-guid AZURE_BUILD_DEFINITION_NAME=CI \
 *   node devops-ttg.js
 *
 * OUTPUT:
 *   Creates CSV file in ./output/ttg/ directory with PR and build data including:
 *   - Original build times and adjusted build times (with stage exclusions)
 *   - Details of excluded stages for each build
 *   - Summary statistics showing time savings from exclusions
 *
 * FEATURES:
 *   - Fetches PRs and builds from Azure DevOps REST API
 *   - Timeline API integration for detailed stage information
 *   - Configurable stage exclusion (e.g., exclude deployment stages)
 *   - Rate limiting and error handling
 *   - Detailed logging and progress tracking
 *   - Statistics on time savings from exclusions
 */

const { mkdirSync, writeFileSync } = require('fs');
const { join, dirname } = require('path');

// Configuration
const AZURE_DEVOPS_TOKEN = process.env.AZURE_DEVOPS_TOKEN;
const AZURE_ORG = process.env.AZURE_ORG || 'your-azure-org';
const AZURE_PROJECT = process.env.AZURE_PROJECT || 'your-azure-project';
const AZURE_REPO_ID = process.env.AZURE_REPO_ID || 'your-azure-repo-id';
const SINCE_DATE = process.env.SINCE_DATE || '2025-08-11';
const UNTIL_DATE = process.env.UNTIL_DATE || '2025-08-19';
const AZURE_BUILD_DEFINITION_NAME =
  process.env.AZURE_BUILD_DEFINITION_NAME || 'your-azure-build-definition-name';
const EXCLUDED_STAGES = process.env.EXCLUDED_STAGES
  ? process.env.EXCLUDED_STAGES.split(',').map((s) => s.trim())
  : [];

// ============================================================================
// Type definitions
// ============================================================================

/**
 * @typedef {'azure-devops'} Platform
 */

/**
 * @typedef {Object} AzureDevOpsPullRequest
 * @property {number} pullRequestId
 * @property {string} title
 * @property {'active' | 'completed' | 'abandoned'} status
 * @property {string} creationDate
 * @property {string} [closedDate]
 * @property {string} sourceRefName
 * @property {string} targetRefName
 * @property {Object} [createdBy]
 * @property {string} createdBy.displayName
 * @property {string} createdBy.uniqueName
 */

/**
 * @typedef {Object} AzureDevOpsBuild
 * @property {number} id
 * @property {string} buildNumber
 * @property {'inProgress' | 'completed' | 'cancelling' | 'postponed' | 'notStarted'} status
 * @property {'succeeded' | 'failed' | 'partiallySucceeded' | 'canceled' | 'none'} result
 * @property {string} startTime
 * @property {string} finishTime
 * @property {string} sourceVersion
 * @property {string} sourceBranch
 * @property {Object} definition
 * @property {number} definition.id
 * @property {string} definition.name
 * @property {Object} repository
 * @property {string} repository.id
 * @property {string} repository.name
 * @property {string} repository.type
 * @property {string} reason
 * @property {Object} [requestedBy]
 * @property {string} requestedBy.displayName
 * @property {string} requestedBy.uniqueName
 * @property {Object} [requestedFor]
 * @property {string} requestedFor.displayName
 * @property {string} requestedFor.uniqueName
 */

/**
 * @typedef {Object} AzureDevOpsTimelineRecord
 * @property {string} id
 * @property {string} [parentId]
 * @property {string} name
 * @property {string} type
 * @property {string} [startTime]
 * @property {string} [finishTime]
 * @property {string} [currentOperation]
 * @property {number} [percentComplete]
 * @property {'pending' | 'inProgress' | 'completed'} state
 * @property {'succeeded' | 'succeededWithIssues' | 'failed' | 'canceled' | 'skipped' | 'abandoned'} [result]
 * @property {number} [order]
 * @property {Object} [details]
 * @property {string} details.id
 * @property {number} details.changeId
 * @property {number} [errorCount]
 * @property {number} [warningCount]
 */

/**
 * @typedef {Object} AzureDevOpsBuildTimeline
 * @property {string} id
 * @property {number} changeId
 * @property {string} url
 * @property {AzureDevOpsTimelineRecord[]} records
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
  const scriptDir = dirname(__filename);
  const outputPath = join(scriptDir, 'output', 'ttg');
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
// AZURE DEVOPS API FUNCTIONS
// ============================================================================

// Global variables to track API usage and cache build definitions
let apiCallCount = 0;
let lastRateLimit = { remaining: undefined, limit: undefined };
const buildDefinitionCache = {};

/**
 * Make Azure DevOps API request with PAT authentication
 * @param {string} url
 * @param {boolean} [returnHeaders=false]
 * @returns {Promise<any>}
 */
async function makeAzureDevOpsRequest(url, returnHeaders = false) {
  if (!AZURE_DEVOPS_TOKEN) {
    throw new Error('AZURE_DEVOPS_TOKEN environment variable is required');
  }

  // Encode PAT as Basic auth (empty username, PAT as password)
  const auth = Buffer.from(`:${AZURE_DEVOPS_TOKEN}`).toString('base64');

  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(
      `Azure DevOps API request failed: ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json();

  if (returnHeaders) {
    return {
      data,
      headers: {
        continuationToken: response.headers.get('x-ms-continuationtoken'),
        rateLimitRemaining: response.headers.get('X-RateLimit-Remaining'),
        rateLimitLimit: response.headers.get('X-RateLimit-Limit'),
      },
    };
  }

  return data;
}

/**
 * Enhanced API request with monitoring
 * @param {string} url
 * @param {boolean} [returnHeaders=false]
 * @returns {Promise<any>}
 */
async function makeMonitoredRequest(url, returnHeaders = false) {
  apiCallCount++;
  const result = await makeAzureDevOpsRequest(url, returnHeaders);

  if (returnHeaders && result.headers) {
    lastRateLimit = {
      remaining: result.headers.rateLimitRemaining,
      limit: result.headers.rateLimitLimit,
    };
  }

  return result;
}

/**
 * Build base URL for Azure DevOps REST API
 * @param {string} endpoint
 * @returns {string}
 */
function buildApiUrl(endpoint) {
  if (!AZURE_ORG || !AZURE_PROJECT) {
    throw new Error(
      'AZURE_ORG and AZURE_PROJECT environment variables are required'
    );
  }
  return `https://dev.azure.com/${AZURE_ORG}/${AZURE_PROJECT}/_apis${endpoint}?api-version=7.1`;
}

/**
 * Fetch all pull requests within date range
 * @param {string} since
 * @param {string} until
 * @returns {Promise<AzureDevOpsPullRequest[]>}
 */
async function fetchPullRequests(since, until) {
  console.log('🔍 Searching PRs...');
  const searchStart = Date.now();

  /** @type {AzureDevOpsPullRequest[]} */
  const allPRs = [];
  let skip = 0;
  const top = 101; // Azure DevOps supports up to 101 PRs per page
  let hasMore = true;

  console.log(`📅 Date range: ${since.split('T')[0]} → ${until.split('T')[0]}`);

  while (hasMore) {
    const pageStart = Date.now();
    console.log(`  📄 Page ${Math.floor(skip / top) + 1}...`);

    if (!AZURE_REPO_ID) {
      throw new Error('AZURE_REPO_ID environment variable is required');
    }

    // Build URL with search criteria
    const endpoint = `/git/repositories/${AZURE_REPO_ID}/pullrequests`;
    const params = new URLSearchParams({
      'searchCriteria.minTime': since,
      'searchCriteria.maxTime': until,
      'searchCriteria.queryTimeRangeType': 'created',
      'searchCriteria.status': 'all',
      $skip: skip.toString(),
      $top: top.toString(),
    });

    const url = buildApiUrl(endpoint) + '&' + params.toString();
    const data = await makeMonitoredRequest(url);

    const items = data.value || [];

    if (items.length === 0) {
      break;
    }

    console.log(
      `    ✅ Found ${items.length} PRs (${Date.now() - pageStart}ms)`
    );

    // Convert Azure DevOps PR format to our interface
    for (const item of items) {
      /** @type {AzureDevOpsPullRequest} */
      const convertedPR = {
        pullRequestId: item.pullRequestId,
        title: item.title,
        status: item.status,
        creationDate: item.creationDate,
        closedDate: item.closedDate,
        sourceRefName: item.sourceRefName,
        targetRefName: item.targetRefName,
        createdBy: item.createdBy,
      };
      allPRs.push(convertedPR);
    }

    // Continue to next page if we have more data
    hasMore = items.length === top;
    skip += top;

    // Small delay between requests
    if (hasMore) {
      await delay(100);
    }
  }

  const searchEnd = Date.now();
  console.log(
    `    ✅ Found ${allPRs.length} PRs total (${Math.round(
      (searchEnd - searchStart) / 1000
    )}s)`
  );

  return allPRs;
}

/**
 * Generate source branch name for PR
 * @param {number} prId
 * @returns {string}
 */
function getPRSourceBranch(prId) {
  return `refs/pull/${prId}/merge`;
}

/**
 * Get build definition ID with caching
 * @param {string} definitionName
 * @returns {Promise<number>}
 */
async function getBuildDefinitionId(definitionName) {
  if (buildDefinitionCache[definitionName]) {
    return buildDefinitionCache[definitionName];
  }

  const defEndpoint = '/build/definitions';
  const defParams = new URLSearchParams({
    name: definitionName,
    $top: '1',
  });
  const defUrl = buildApiUrl(defEndpoint) + '&' + defParams.toString();
  const defData = await makeMonitoredRequest(defUrl);

  if (defData.value && defData.value.length > 0) {
    buildDefinitionCache[definitionName] = defData.value[0].id;
    return defData.value[0].id;
  }

  throw new Error(`Error: Build definition '${definitionName}' not found`);
}

/**
 * Fetch build timeline data for a specific build
 * @param {number} buildId
 * @returns {Promise<AzureDevOpsBuildTimeline | null>}
 */
async function fetchBuildTimeline(buildId) {
  try {
    const endpoint = `/build/builds/${buildId}/timeline`;
    const url = buildApiUrl(endpoint);
    const timeline = await makeMonitoredRequest(url);

    return /** @type {AzureDevOpsBuildTimeline} */ (timeline);
  } catch (error) {
    console.log(
      `    ❌ Failed to fetch timeline for build ${buildId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}

/**
 * Fetch builds for a specific PR using source branch
 * @param {number} prId
 * @returns {Promise<AzureDevOpsBuild[]>}
 */
async function fetchBuildsForPR(prId) {
  const sourceBranch = getPRSourceBranch(prId);

  // Get the build definition ID (cached)
  const definitionId = await getBuildDefinitionId(AZURE_BUILD_DEFINITION_NAME);

  /** @type {AzureDevOpsBuild[]} */
  const allBuilds = [];
  const top = 200; // Azure DevOps Builds API supports up to 200 records per page
  let continuationToken = null;
  let hasMore = true;

  while (hasMore) {
    const endpoint = '/build/builds';
    const params = new URLSearchParams({
      $top: top.toString(),
      statusFilter: 'all',
      branchName: sourceBranch,
    });

    // Add definition filter if we found the ID
    if (definitionId) {
      params.append('definitions', definitionId.toString());
    }

    // Add continuation token if we have one
    if (continuationToken) {
      params.append('continuationToken', continuationToken);
    }

    const url = buildApiUrl(endpoint) + '&' + params.toString();
    const response = await makeMonitoredRequest(url, true);

    const items = response.data.value || [];

    // Filter builds for this specific source branch and definition name
    // Use strict filtering to ensure only PR branch builds are included
    const matchingBuilds = items.filter(
      (build) =>
        build.sourceBranch === sourceBranch &&
        build.definition.name === AZURE_BUILD_DEFINITION_NAME &&
        build.sourceBranch === `refs/pull/${prId}/merge`
    );

    allBuilds.push(...matchingBuilds);

    // Check if we have more pages using continuation token
    continuationToken = response.headers.continuationToken;
    hasMore = !!continuationToken && items.length === top;

    if (hasMore) {
      await delay(10);
    }
  }

  return allBuilds;
}

// ============================================================================
// STAGE EXCLUSION FUNCTIONS
// ============================================================================

/**
 * Calculate excluded stages duration
 * @param {AzureDevOpsBuild} build
 * @param {AzureDevOpsBuildTimeline} timeline
 * @returns {{ excludedDurationMs: number; excludedStages: string[] } | null}
 */
function calculateExcludedStagesDuration(build, timeline) {
  if (EXCLUDED_STAGES.length === 0) {
    return {
      excludedDurationMs: 0,
      excludedStages: [],
    };
  }

  let excludedDurationMs = 0;
  /** @type {string[]} */
  const excludedStageNames = [];

  // First, filter to only stage-level records
  const stageRecords = timeline.records.filter(
    (record) => record.type === 'Stage' || record.type === 'stage'
  );

  for (const record of stageRecords) {
    if (
      !record.startTime ||
      !record.finishTime ||
      record.state !== 'completed'
    ) {
      continue;
    }

    const recordStart = new Date(record.startTime);
    const recordFinish = new Date(record.finishTime);
    const recordDuration = recordFinish.getTime() - recordStart.getTime();

    // Check if this stage should be excluded
    const nameMatches = EXCLUDED_STAGES.some((stage) =>
      record.name.toLowerCase().includes(stage.toLowerCase())
    );
    const typeMatches = EXCLUDED_STAGES.some((stage) =>
      record.type.toLowerCase().includes(stage.toLowerCase())
    );
    const isExcludedStage = nameMatches || typeMatches;

    if (isExcludedStage) {
      excludedDurationMs += recordDuration;
      excludedStageNames.push(`${record.name} (${record.type})`);
    }
  }

  return {
    excludedDurationMs,
    excludedStages: excludedStageNames,
  };
}

// ============================================================================
// MAIN TTG DATA COLLECTION SCRIPT
// ============================================================================

/**
 * Main execution function
 */
async function runAnalysis() {
  const totalStart = Date.now();
  const logger = new TTGAnalysisLogger();

  logger.logAnalysisStart('Azure DevOps');

  if (!AZURE_DEVOPS_TOKEN) {
    throw new Error('AZURE_DEVOPS_TOKEN environment variable is required');
  }

  if (!AZURE_ORG || !AZURE_PROJECT || !AZURE_REPO_ID) {
    throw new Error(
      'AZURE_ORG, AZURE_PROJECT, and AZURE_REPO_ID environment variables are required'
    );
  }

  const sinceISO = convertDateToISO(SINCE_DATE);
  const untilISO = convertDateToISO(UNTIL_DATE);

  console.log(`📊 Organization: ${AZURE_ORG}`);
  console.log(`📊 Project: ${AZURE_PROJECT}`);
  console.log(`📊 Repository ID: ${AZURE_REPO_ID}`);
  console.log(`📊 Build Definition: ${AZURE_BUILD_DEFINITION_NAME}`);
  console.log(`📅 Period: ${SINCE_DATE} → ${UNTIL_DATE}`);

  if (EXCLUDED_STAGES.length > 0) {
    console.log('\n🚫 Stage Exclusions:');
    console.log(`  📋 Excluded stages: ${EXCLUDED_STAGES.join(', ')}`);
  } else {
    console.log('📊 No stage exclusions configured');
  }

  // Step 1: Fetch PRs
  logger.logStep('Fetching PRs');
  const pullRequests = await fetchPullRequests(sinceISO, untilISO);

  if (pullRequests.length === 0) {
    console.log('❌ No PRs found');
    return;
  }

  // Step 1.5: Pre-cache build definition
  logger.logStep('Caching build definition');
  await getBuildDefinitionId(AZURE_BUILD_DEFINITION_NAME);
  logger.logSuccess(`Build definition '${AZURE_BUILD_DEFINITION_NAME}' cached`);

  // Step 2: Collect PR and build data
  logger.logStep('Collecting PR and build data');
  const collectionStart = Date.now();

  /** @type {TTGDataRow[]} */
  const csvData = [];
  const repository = `${AZURE_ORG}/${AZURE_PROJECT}`;

  // Process PRs in parallel batches (conservative for Azure DevOps)
  const batchSize = 4;
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
        `  • PR #${pr.pullRequestId} (${i + idx + 1}/${
          pullRequests.length
        }): ${pr.title.substring(0, 60)}${pr.title.length > 60 ? '...' : ''}`
      );
    });

    const batchPromises = batch.map(async (pr) => {
      try {
        // Fetch builds for this PR using source branch
        const builds = await fetchBuildsForPR(pr.pullRequestId);

        // Only record PR if there are builds
        if (builds.length > 0) {
          /** @type {TTGDataRow[]} */
          const prData = [];
          // Convert each build to CSV format with timeline data
          for (const build of builds) {
            // Fetch timeline data for stage exclusion
            const timeline = await fetchBuildTimeline(build.id);

            if (!timeline) {
              // Skip this build if we can't get timeline data (as per requirements)
              console.log(
                `    ⚠️  Skipping build ${build.id} - no timeline data available`
              );
              continue;
            }

            // Calculate excluded stages duration
            const exclusionData = calculateExcludedStagesDuration(
              build,
              timeline
            );

            if (!exclusionData) {
              console.log(
                `    ⚠️  Skipping build ${build.id} - could not calculate exclusion data`
              );
              continue;
            }

            // Log exclusions in a compact format
            const excludedTimeStr =
              exclusionData.excludedDurationMs > 0
                ? `: ${Math.round(
                    exclusionData.excludedDurationMs / 1000
                  )}s excluded`
                : '';
            console.log(`    📊 Build ${build.id}${excludedTimeStr}`);

            // For Azure DevOps, prefer PR author over build requester since builds are often triggered by service accounts
            const prAuthor = pr.createdBy?.displayName || pr.createdBy?.uniqueName || '';
            const buildAuthor = build.requestedBy?.displayName || build.requestedBy?.uniqueName || '';
            
            // Use PR author if build author is a service account, otherwise use build author
            const isServiceAccount = buildAuthor.includes('Microsoft.VisualStudio.Services') || 
                                    buildAuthor.includes('System') || 
                                    buildAuthor === 'Microsoft.VisualStudio.Services.TFS';
            const effectiveAuthor = isServiceAccount && prAuthor ? prAuthor : buildAuthor;
            
            prData.push({
              platform: 'azure-devops',
              repository,
              pr_id: pr.pullRequestId.toString(),
              pr_title: pr.title,
              pr_status: pr.status,
              pr_created_at: pr.creationDate,
              pr_closed_at: pr.closedDate || null,
              build_id: build.id.toString(),
              build_status: build.status,
              build_result: build.result,
              build_start_time: build.startTime,
              build_finish_time: build.finishTime || '',
              build_excluded_duration_ms: exclusionData.excludedDurationMs,
              build_excluded_stages: exclusionData.excludedStages.join('; '),
              build_author: effectiveAuthor,
              build_requested_for: build.requestedFor?.displayName || build.requestedFor?.uniqueName || '',
            });
          }
          return {
            pr: pr.pullRequestId,
            builds: builds.length,
            records: prData.length,
            data: prData,
          };
        } else {
          return {
            pr: pr.pullRequestId,
            builds: 0,
            records: 0,
            data: [],
          };
        }
      } catch (error) {
        console.log(
          `    ❌ PR #${pr.pullRequestId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return {
          pr: pr.pullRequestId,
          builds: 0,
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
      } else if (result.builds > 0) {
        console.log(
          `    ✅ PR #${result.pr}: ${result.builds} builds, ${result.records} records`
        );
      } else {
        console.log(`    ⚠️  PR #${result.pr}: no builds found`);
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
      )}%) | ${totalRecords} total records | ${apiCallCount} API calls`
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
  const identifier = `${AZURE_ORG}-${AZURE_PROJECT}`;
  const csvFilePath = saveTTGDataToCSV(csvData, 'azure-devops', identifier);

  const totalTime = Date.now() - totalStart;

  // Calculate exclusion statistics
  const recordsWithExclusions = csvData.filter(
    (record) =>
      record.build_excluded_stages && record.build_excluded_stages.length > 0
  );

  const totalOriginalDuration = csvData.reduce((sum, record) => {
    const original =
      new Date(record.build_finish_time).getTime() -
      new Date(record.build_start_time).getTime();
    return sum + original;
  }, 0);

  const totalExcludedDuration = csvData.reduce(
    (sum, record) => sum + record.build_excluded_duration_ms,
    0
  );
  const totalAdjustedDuration = totalOriginalDuration - totalExcludedDuration;

  console.log('\n🎉 Data Collection Summary');
  console.log(`  📊 Platform: Azure DevOps (${AZURE_ORG}/${AZURE_PROJECT})`);
  console.log(`  📊 PRs processed: ${pullRequests.length}`);
  console.log(`  📊 Total records: ${csvData.length}`);

  if (EXCLUDED_STAGES.length > 0) {
    console.log(
      `  🚫 Records with exclusions: ${recordsWithExclusions.length}/${csvData.length}`
    );
    console.log(
      `  ⏱️  Original total build time: ${Math.round(
        totalOriginalDuration / 1000 / 60
      )} minutes`
    );
    console.log(
      `  ⏱️  Adjusted total build time: ${Math.round(
        totalAdjustedDuration / 1000 / 60
      )} minutes`
    );
    console.log(
      `  💾 Time excluded: ${Math.round(
        totalExcludedDuration / 1000 / 60
      )} minutes (${Math.round(
        (totalExcludedDuration / totalOriginalDuration) * 100
      )}%)`
    );
  }

  console.log(`  📁 CSV file: ${csvFilePath}`);
  console.log(`  📞 API calls made: ${apiCallCount}`);
  if (lastRateLimit.remaining && lastRateLimit.limit) {
    console.log(
      `  🔋 Rate limit: ${lastRateLimit.remaining}/${lastRateLimit.limit} remaining`
    );
  }
  console.log(`  ⏱️  Total analysis time: ${Math.round(totalTime / 1000)}s`);
  console.log('✅ Data collection complete!');
}

// ============================================================================
// SCRIPT EXECUTION
// ============================================================================

// Run the analysis
runAnalysis().catch((error) => {
  console.error('Failed to run TTG data collection:', error);
  process.exit(1);
});
