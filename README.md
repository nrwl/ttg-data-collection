# TTG Data Collection

Self-contained scripts for collecting Time to Green (TTG) metrics from multiple CI/CD platforms. These scripts gather pull request/merge request data along with their associated CI pipelines to analyze development velocity and CI performance.

## Overview

This repository contains several platform-specific TTG data collection scripts:

- **Azure DevOps** (`devops-ttg.js`) - Collects PR and pipeline data from Azure DevOps + Azure DevOps Pipelines
- **GitHub** (`github-ttg.js`) - Collects PR and workflow run data from GitHub + GitHub Actions
- **GitLab** (`gitlab-ttg.js`) - Collects MR and pipeline data from GitLab + GitLab Pipelines

All scripts output standardized CSV files with TTG metrics for downstream analysis.

## Getting Started

### Prerequisites

- Node.js v18+
- Platform-specific API tokens with appropriate permissions

### Azure DevOps

```bash
# Required environment variables
export AZURE_DEVOPS_TOKEN="your-api-token"
export AZURE_ORG="your-org-name"
export AZURE_PROJECT="your-project-name"
export AZURE_REPO_ID="your-repo-guid"
export AZURE_BUILD_DEFINITION_NAME="CI"
export SINCE_DATE="2025-10-01"
export UNTIL_DATE="2025-10-16"

# Optional: Stages of the pipeline to exclude
export EXCLUDED_STAGES="deployment,approval,manual validation"

node devops-ttg.js
```

### GitHub

```bash
# Required environment variables
export GITHUB_TOKEN="ghp_your-token"
export GITHUB_OWNER="owner-name"
export GITHUB_REPO="repo-name"
export SINCE_DATE="2025-10-01"
export UNTIL_DATE="2025-10-16"
export GITHUB_WORKFLOW_RUN_NAME="CI"

node github-ttg.js
```

### GitLab

```bash
# Required environment variables
export GITLAB_TOKEN="glpat-your-token"
export GITLAB_PROJECT_ID="12345"

# Optional: GitLab URL and stages of the pipeline to exclude
export GITLAB_URL="https://gitlab.com"
export EXCLUDED_STAGES="deploy,manual"

node gitlab-ttg.js
```

## Output

All scripts create CSV files in the `./output` directory containing:

- **Pull/Merge Request Data**: ID, title, status, creation/close dates
- **Pipeline Data**: ID, status, result, start/finish times, duration
- **Author Information**: PR author and build requester details

## Configuration Options

### Date Range

- `SINCE_DATE`: Start date (YYYY-MM-DD format)
- `UNTIL_DATE`: End date (YYYY-MM-DD format)

### Stage Filtering

- **Azure DevOps**: `EXCLUDED_STAGES` (comma-separated stage names)
- **GitLab**: `EXCLUDED_STAGES` or `INCLUDED_STAGES` (comma-separated)
- **GitHub**: No stage filtering implemented yet

### Platform-Specific Options

#### Azure DevOps

- `AZURE_BUILD_DEFINITION_NAME`: Build definition to analyze

#### GitHub

- `GITHUB_WORKFLOW_RUN_NAME`: Workflow name to analyze

#### GitLab

- `GITLAB_URL`: GitLab instance URL (default: https://gitlab.com)
- `INCLUDED_STAGES`: Only include specified stages (takes priority over exclusions)

## Output Schema

Each CSV file contains the following columns:

| Column                                     | Description                                |
| ------------------------------------------ | ------------------------------------------ |
| `platform`                                 | CI platform (azure-devops, github, gitlab) |
| `repository`                               | Repository identifier                      |
| `pr_id`                                    | Pull/merge request ID                      |
| `pr_title`                                 | PR/MR title                                |
| `pr_status`                                | PR/MR status (open, closed, merged)        |
| `pr_created_at`                            | PR/MR creation timestamp                   |
| `pr_closed_at`                             | PR/MR close/merge timestamp                |
| `build_id`/`pipeline_id`                   | Build/pipeline ID                          |
| `build_status`/`pipeline_status`           | Build/pipeline status                      |
| `build_result`/`pipeline_result`           | Build/pipeline result                      |
| `build_start_time`/`pipeline_start_time`   | Start timestamp                            |
| `build_finish_time`/`pipeline_finish_time` | Finish timestamp                           |
| `build_excluded_duration_ms`               | Excluded stage duration (milliseconds)     |
| `build_excluded_stages`                    | List of excluded stages                    |
| `build_author`                             | Build author/requester                     |
| `build_requested_for`                      | Build triggered for user                   |
