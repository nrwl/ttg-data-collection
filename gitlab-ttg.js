#!/usr/bin/env node

/**
 * SELF-CONTAINED GITLAB TIME TO GREEN (TTG) DATA COLLECTION SCRIPT
 *
 * This script collects Time to Green metrics from GitLab by fetching Merge Requests
 * and their associated pipelines. It supports stage exclusion to filter out non-development
 * pipeline stages (like deployment, approval) for more accurate TTG measurements.
 *
 * USAGE:
 *   node gitlab-ttg.js
 *
 * REQUIRED ENVIRONMENT VARIABLES:
 *   GITLAB_TOKEN - GitLab Personal Access Token with API read permissions
 *   GITLAB_PROJECT_ID - GitLab project ID (numeric ID)
 *
 * OPTIONAL ENVIRONMENT VARIABLES:
 *   GITLAB_URL - GitLab instance URL (default: https://gitlab.com)
 *   SINCE_DATE - Start date for analysis (YYYY-MM-DD format, default: 2025-08-11)
 *   UNTIL_DATE - End date for analysis (YYYY-MM-DD format, default: 2025-08-19)
 *   INCLUDED_STAGES - Comma-separated list of pipeline stage names to include in duration calculation (all others excluded)
 *   EXCLUDED_STAGES - Comma-separated list of pipeline stage names to exclude from duration calculation
 *   OUTPUT_FILE_NAME - Name of the output file (default: ttg-gitlab-data-<identifier>-<timestamp>.csv)
 *
 *   NOTE: If both INCLUDED_STAGES and EXCLUDED_STAGES are provided, only INCLUDED_STAGES will be used
 *
 * EXAMPLES:
 *   # Basic usage
 *   GITLAB_TOKEN=glpat-xxx GITLAB_PROJECT_ID=12345 \
 *   node gitlab-ttg.js
 *
 *   # With stage exclusions
 *   EXCLUDED_STAGES="deploy,manual" \
 *   GITLAB_TOKEN=glpat-xxx GITLAB_PROJECT_ID=12345 \
 *   node gitlab-ttg.js
 *
 *   # With stage inclusions (only include test and build stages)
 *   INCLUDED_STAGES="test,build" \
 *   GITLAB_TOKEN=glpat-xxx GITLAB_PROJECT_ID=12345 \
 *   node gitlab-ttg.js
 *
 * OUTPUT:
 *   Creates CSV file in ./output/gitlab/ directory with MR and pipeline data including:
 *   - MR information (title, status, creation/close dates)
 *   - Pipeline details (status, result, start/finish times)
 *   - Build duration calculations for TTG analysis
 *   - Stage exclusion information
 *
 * FEATURES:
 *   - Fetches MRs and pipelines from GitLab REST API
 *   - Parallel processing with rate limiting
 *   - Detailed logging and progress tracking
 *   - Configurable stage exclusion (e.g., exclude deployment stages)
 *   - Handles GitLab-specific pipeline sources and merge request events
 *   - Comprehensive error handling and retry logic
 */

const { mkdirSync, writeFileSync } = require('fs');
const { join } = require('path');

// ============================================================================
// CONFIGURATION
// ============================================================================

// Global configuration from environment variables
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
const GITLAB_URL = process.env.GITLAB_URL || 'https://gitlab.com';
const GITLAB_PROJECT_ID = process.env.GITLAB_PROJECT_ID;
const SINCE_DATE = process.env.SINCE_DATE || '2025-08-11';
const UNTIL_DATE = process.env.UNTIL_DATE || '2025-08-19';
const EXCLUDED_STAGES = process.env.EXCLUDED_STAGES
  ? process.env.EXCLUDED_STAGES.split(',').map((s) => s.trim())
  : [];
const INCLUDED_STAGES = process.env.INCLUDED_STAGES
  ? process.env.INCLUDED_STAGES.split(',').map((s) => s.trim())
  : [];

// ============================================================================
// TYPE DEFINITIONS (JSDoc)
// ============================================================================

/**
 * @typedef {'gitlab'} Platform
 */

/**
 * @typedef {Object} GitLabMergeRequest
 * @property {number} iid
 * @property {number} id
 * @property {string} title
 * @property {'opened' | 'closed' | 'merged'} state
 * @property {string} created_at
 * @property {string} [merged_at]
 * @property {string} [closed_at]
 * @property {string} source_branch
 * @property {string} target_branch
 * @property {Object} [author]
 * @property {string} author.name
 * @property {string} author.username
 */

/**
 * @typedef {Object} GitLabPipeline
 * @property {number} id
 * @property {string} ref
 * @property {string} sha
 * @property {'created' | 'waiting_for_resource' | 'preparing' | 'pending' | 'running' | 'success' | 'failed' | 'canceled' | 'skipped' | 'manual' | 'scheduled'} status
 * @property {'created' | 'waiting_for_resource' | 'preparing' | 'pending' | 'running' | 'success' | 'failed' | 'canceled' | 'skipped' | 'manual' | 'scheduled'} detailed_status
 * @property {string} source
 * @property {string} created_at
 * @property {string} updated_at
 * @property {string} [started_at]
 * @property {string} [finished_at]
 * @property {number} [duration]
 * @property {Object} [user]
 * @property {string} user.name
 * @property {string} user.username
 */

/**
 * @typedef {Object} GitLabJob
 * @property {number} id
 * @property {string} name
 * @property {string} stage
 * @property {'created' | 'pending' | 'running' | 'success' | 'failed' | 'canceled' | 'skipped' | 'manual'} status
 * @property {string} created_at
 * @property {string} [started_at]
 * @property {string} [finished_at]
 * @property {number} [duration]
 * @property {Object} [user]
 * @property {string} user.name
 * @property {string} user.username
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
 * @param {string | number | undefined | null} value
 * @returns {string}
 */
function escapeCsvField(value) {
  const safeValue = String(value || '');
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
  console.log(`📊 Records: ${data.length} MR/pipeline combinations`);

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
   * @param {number|string} mrIid
   * @param {number} current
   * @param {number} total
   * @param {string} title
   */
  logMRProcessing(mrIid, current, total, title) {
    console.log(
      `  📝 MR !${mrIid} (${current}/${total}): ${truncateString(title, 50)}`
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
// GITLAB API FUNCTIONS
// ============================================================================

/**
 * Make GitLab API request
 * @param {string} endpoint
 * @param {URLSearchParams} [params]
 * @returns {Promise<any>}
 */
async function makeGitLabRequest(endpoint, params = new URLSearchParams()) {
  if (!GITLAB_TOKEN) {
    throw new Error('GITLAB_TOKEN environment variable is required');
  }

  const url = `${GITLAB_URL}/api/v4${endpoint}?${params.toString()}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITLAB_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(
      `GitLab API request failed: ${response.status} ${response.statusText} - ${url}`
    );
  }

  return response.json();
}

/**
 * Fetch all merge requests within date range
 * @param {string} since
 * @param {string} until
 * @returns {Promise<GitLabMergeRequest[]>}
 */
async function fetchMergeRequests(since, until) {
  console.log('🔍 Searching MRs...');
  const searchStart = Date.now();

  /** @type {GitLabMergeRequest[]} */
  const allMRs = [];
  let page = 1;
  let hasMore = true;

  console.log(`📅 Date range: ${since.split('T')[0]} → ${until.split('T')[0]}`);

  while (hasMore) {
    const pageStart = Date.now();
    console.log(`  📄 Page ${page}...`);

    const params = new URLSearchParams({
      state: 'all',
      created_after: since,
      created_before: until,
      per_page: '100',
      page: page.toString(),
      sort: 'desc',
      order_by: 'created_at',
    });

    const endpoint = `/projects/${GITLAB_PROJECT_ID}/merge_requests`;
    const data = await makeGitLabRequest(endpoint, params);

    if (!Array.isArray(data) || data.length === 0) {
      break;
    }

    console.log(
      `    ✅ Found ${data.length} MRs (${Date.now() - pageStart}ms)`
    );

    allMRs.push(...data);

    // Continue to next page if we have more data
    hasMore = data.length === 100;
    page++;

    // Small delay between requests
    if (hasMore) {
      await delay(100);
    }
  }

  const searchEnd = Date.now();
  console.log(
    `✅ Found ${allMRs.length} MRs total (${Math.round(
      (searchEnd - searchStart) / 1000
    )}s)`
  );

  return allMRs;
}

/**
 * Fetch pipelines for a specific merge request
 * @param {number} mrIid
 * @returns {Promise<GitLabPipeline[]>}
 */
async function fetchPipelinesForMR(mrIid) {
  const params = new URLSearchParams({
    per_page: '100',
    sort: 'desc',
    order_by: 'id',
  });

  const endpoint = `/projects/${GITLAB_PROJECT_ID}/merge_requests/${mrIid}/pipelines`;
  const pipelines = await makeGitLabRequest(endpoint, params);

  if (!Array.isArray(pipelines)) {
    return [];
  }

  // The MR pipelines endpoint may not include full user details
  // Fetch individual pipeline details to get complete user information
  const enrichedPipelines = [];
  for (const pipeline of pipelines) {
    try {
      const detailedPipeline = await fetchPipelineDetails(pipeline.id);
      enrichedPipelines.push(detailedPipeline);

      // Small delay to avoid rate limiting
      await delay(50);
    } catch (error) {
      console.log(
        `    ⚠️  Could not fetch details for pipeline ${pipeline.id}, using basic data`
      );
      enrichedPipelines.push(pipeline);
    }
  }

  return enrichedPipelines;
}

/**
 * Fetch detailed information for a specific pipeline
 * @param {number} pipelineId
 * @returns {Promise<GitLabPipeline>}
 */
async function fetchPipelineDetails(pipelineId) {
  const endpoint = `/projects/${GITLAB_PROJECT_ID}/pipelines/${pipelineId}`;
  return await makeGitLabRequest(endpoint);
}

/**
 * Fetch jobs for a specific pipeline
 * @param {number} pipelineId
 * @returns {Promise<GitLabJob[]>}
 */
async function fetchJobsForPipeline(pipelineId) {
  const params = new URLSearchParams({
    per_page: '100',
    include_retried: 'false',
  });

  const endpoint = `/projects/${GITLAB_PROJECT_ID}/pipelines/${pipelineId}/jobs`;

  try {
    const jobs = await makeGitLabRequest(endpoint, params);
    return Array.isArray(jobs) ? jobs : [];
  } catch (error) {
    console.log(
      `    ⚠️  Failed to fetch jobs for pipeline ${pipelineId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return [];
  }
}

/**
 * Calculate excluded stages duration using either INCLUDED_STAGES or EXCLUDED_STAGES
 * If INCLUDED_STAGES is specified, only those stages are included (all others excluded)
 * If only EXCLUDED_STAGES is specified, those stages are excluded
 * If both are provided, INCLUDED_STAGES takes priority
 * Matching is done only on stage names, not job names
 * @param {GitLabJob[]} jobs
 * @returns {{ excludedDurationMs: number; excludedStages: string[] }}
 */
function calculateExcludedStagesDuration(jobs) {
  // If neither included nor excluded stages are specified, no exclusions
  if (INCLUDED_STAGES.length === 0 && EXCLUDED_STAGES.length === 0) {
    return {
      excludedDurationMs: 0,
      excludedStages: [],
    };
  }

  let excludedDurationMs = 0;
  /** @type {string[]} */
  const excludedStageNames = [];

  for (const job of jobs) {
    if (!job.started_at || !job.finished_at || !job.duration) {
      continue;
    }

    let isExcludedJob = false;

    if (INCLUDED_STAGES.length > 0) {
      // INCLUDED_STAGES takes priority - exclude everything NOT in the included list
      const stageMatches = INCLUDED_STAGES.some((stage) =>
        job.stage.toLowerCase().includes(stage.toLowerCase())
      );
      // Exclude jobs that don't match any included stages
      isExcludedJob = !stageMatches;
    } else if (EXCLUDED_STAGES.length > 0) {
      // Use EXCLUDED_STAGES only if INCLUDED_STAGES is not specified
      const stageMatches = EXCLUDED_STAGES.some((stage) =>
        job.stage.toLowerCase().includes(stage.toLowerCase())
      );
      // Exclude jobs that match any excluded stages
      isExcludedJob = stageMatches;
    }

    if (isExcludedJob) {
      excludedDurationMs += job.duration * 1000; // Convert to milliseconds
      excludedStageNames.push(`${job.name} (${job.stage})`);
    }
  }

  return {
    excludedDurationMs,
    excludedStages: excludedStageNames,
  };
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

  logger.logAnalysisStart('GitLab');

  if (!GITLAB_TOKEN) {
    throw new Error('GITLAB_TOKEN environment variable is required');
  }

  if (!GITLAB_PROJECT_ID) {
    throw new Error('GITLAB_PROJECT_ID environment variable is required');
  }

  const sinceISO = convertDateToISO(SINCE_DATE);
  const untilISO = convertDateToISO(UNTIL_DATE);

  console.log(`📊 GitLab URL: ${GITLAB_URL}`);
  console.log(`📊 Project ID: ${GITLAB_PROJECT_ID}`);
  console.log(`📅 Period: ${SINCE_DATE} → ${UNTIL_DATE}`);

  // Display stage filtering configuration
  if (INCLUDED_STAGES.length > 0) {
    console.log('\n✅ Stage Inclusions (takes priority):');
    console.log(`  📋 Included stages: ${INCLUDED_STAGES.join(', ')}`);
    if (EXCLUDED_STAGES.length > 0) {
      console.log(
        `  ⚠️  EXCLUDED_STAGES ignored due to INCLUDED_STAGES priority`
      );
    }
  } else if (EXCLUDED_STAGES.length > 0) {
    console.log('\n🚫 Stage Exclusions:');
    console.log(`  📋 Excluded stages: ${EXCLUDED_STAGES.join(', ')}`);
  } else {
    console.log('📊 No stage filtering configured');
  }

  // Step 1: Fetch MRs
  logger.logStep('Fetching MRs');
  const mergeRequests = await fetchMergeRequests(sinceISO, untilISO);
  logger.logSuccess(`${mergeRequests.length} MRs found`);

  if (mergeRequests.length === 0) {
    console.log('❌ No MRs found');
    return;
  }

  // Step 2: Collect MR and pipeline data in parallel
  logger.logStep('Collecting MR and pipeline data');
  const collectionStart = Date.now();

  /** @type {TTGDataRow[]} */
  const csvData = [];
  const repository = `gitlab-project-${GITLAB_PROJECT_ID}`;

  // Process MRs in parallel batches
  const batchSize = 6;
  let processedCount = 0;
  let totalRecords = 0;

  for (let i = 0; i < mergeRequests.length; i += batchSize) {
    const batch = mergeRequests.slice(i, i + batchSize);
    const batchStart = Date.now();

    // Log batch start
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(mergeRequests.length / batchSize);
    console.log(
      `\n📦 Processing batch ${batchNum}/${totalBatches} (${batch.length} MRs):`
    );
    batch.forEach((mr, idx) => {
      console.log(
        `  • MR !${mr.iid} (${i + idx + 1}/${
          mergeRequests.length
        }): ${mr.title.substring(0, 60)}${mr.title.length > 60 ? '...' : ''}`
      );
    });

    const batchPromises = batch.map(async (mr) => {
      try {
        // Fetch pipelines for this MR
        const pipelines = await fetchPipelinesForMR(mr.iid);

        // Only record MR if there are pipelines
        if (pipelines.length > 0) {
          /** @type {TTGDataRow[]} */
          const mrData = [];

          // Convert each pipeline to CSV format
          for (const pipeline of pipelines) {
            // Fetch jobs for this pipeline to calculate stage exclusions
            const jobs = await fetchJobsForPipeline(pipeline.id);

            // Calculate excluded stages duration
            const exclusionData = calculateExcludedStagesDuration(jobs);

            // Determine pipeline start and finish times
            const pipelineStart = pipeline.started_at || pipeline.created_at;
            const pipelineFinish = pipeline.finished_at || pipeline.updated_at;

            // For GitLab, prefer MR author over pipeline user for attribution
            // This is similar to Azure DevOps logic where PR author is preferred over service accounts
            const mrAuthor = mr.author?.name || mr.author?.username || '';
            const pipelineUser =
              pipeline.user?.name || pipeline.user?.username || '';

            // Use MR author as the primary author, fall back to pipeline user
            const effectiveAuthor = mrAuthor || pipelineUser;

            // Pipeline requested_for is the person who triggered the pipeline (pipeline.user)
            // This is typically the person who pushed or triggered the pipeline run
            const requestedFor = pipelineUser;

            mrData.push({
              platform: 'gitlab',
              repository,
              pr_id: mr.iid.toString(),
              pr_title: mr.title,
              pr_status: mr.state,
              pr_created_at: mr.created_at,
              pr_closed_at: mr.closed_at || mr.merged_at || null,
              pipeline_id: pipeline.id.toString(),
              pipeline_status: pipeline.status,
              pipeline_result:
                pipeline.detailed_status?.group || pipeline.status,
              pipeline_start_time: pipelineStart,
              pipeline_finish_time: pipelineFinish,
              pipeline_excluded_duration_ms: exclusionData.excludedDurationMs,
              pipeline_excluded_stages: exclusionData.excludedStages.join('; '),
              pipeline_author: effectiveAuthor,
              pipeline_requested_for: requestedFor,
            });
          }
          return {
            mr: mr.iid,
            pipelines: pipelines.length,
            records: mrData.length,
            data: mrData,
          };
        } else {
          return {
            mr: mr.iid,
            pipelines: 0,
            records: 0,
            data: [],
          };
        }
      } catch (error) {
        console.log(
          `    ❌ MR !${mr.iid}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return {
          mr: mr.iid,
          pipelines: 0,
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
      } else if (result.pipelines > 0) {
        console.log(
          `    ✅ MR !${result.mr}: ${result.pipelines} pipelines, ${result.records} records`
        );
      } else {
        console.log(`    ⚠️  MR !${result.mr}: no pipelines found`);
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
      `📊 Progress: ${processedCount}/${mergeRequests.length} MRs (${Math.round(
        (processedCount / mergeRequests.length) * 100
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
  const identifier = `project-${GITLAB_PROJECT_ID}`;
  const csvFilePath = saveTTGDataToCSV(csvData, 'gitlab', identifier);

  const totalTime = Date.now() - totalStart;

  // Calculate exclusion statistics
  const recordsWithExclusions = csvData.filter(
    (record) =>
      record.pipeline_excluded_stages &&
      record.pipeline_excluded_stages.length > 0
  );

  const totalOriginalDuration = csvData.reduce((sum, record) => {
    if (record.pipeline_start_time && record.pipeline_finish_time) {
      const original =
        new Date(record.pipeline_finish_time).getTime() -
        new Date(record.pipeline_start_time).getTime();
      return sum + original;
    }
    return sum;
  }, 0);

  const totalExcludedDuration = csvData.reduce(
    (sum, record) => sum + record.pipeline_excluded_duration_ms,
    0
  );
  const totalAdjustedDuration = totalOriginalDuration - totalExcludedDuration;

  console.log('\n🎉 Data Collection Summary');
  console.log(`  📊 Platform: GitLab (Project ${GITLAB_PROJECT_ID})`);
  console.log(`  📊 MRs processed: ${mergeRequests.length}`);
  console.log(`  📊 Total records: ${csvData.length}`);

  // Show exclusion statistics if any stages were excluded (from either inclusion or exclusion logic)
  if (recordsWithExclusions.length > 0 && totalExcludedDuration > 0) {
    const exclusionType = INCLUDED_STAGES.length > 0 ? 'inclusion' : 'exclusion';
    console.log(`\n🔧 Stage ${exclusionType} statistics:`);
    console.log(
      `  🚫 Records with exclusions: ${recordsWithExclusions.length}/${csvData.length}`
    );
    console.log(
      `  ⏱️  Original total pipeline time: ${Math.round(
        totalOriginalDuration / 1000 / 60
      )} minutes`
    );
    console.log(
      `  ⏱️  Adjusted total pipeline time: ${Math.round(
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
    
    if (INCLUDED_STAGES.length > 0) {
      console.log(`  ✅ Only included stages: ${INCLUDED_STAGES.join(', ')}`);
    } else if (EXCLUDED_STAGES.length > 0) {
      console.log(`  🚫 Excluded stages: ${EXCLUDED_STAGES.join(', ')}`);
    }
  }

  console.log(`  📁 CSV file: ${csvFilePath}`);
  console.log(`  ⏱️  Total time: ${Math.round(totalTime / 1000)}s`);
  console.log('✅ Data collection complete!');
}

// ============================================================================
// SCRIPT EXECUTION
// ============================================================================

// Run the analysis
runAnalysis().catch((error) => {
  console.error('Failed to run GitLab TTG analysis:', error);
  process.exit(1);
});
