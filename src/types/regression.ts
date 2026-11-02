export type ChangeType =
  | "new_failure"
  | "recurring_failure"
  | "fixed"
  | "stable_pass"
  | "added"
  | "removed";

export interface TestComparisonItem {
  id: string;
  type: "web" | "api";
  title: string;
  base_status: string | null;
  target_status: string | null;
  change_type: ChangeType;
  duration_ms?: number | null;
  duration_delta_ms?: number | null;
  error_message?: string | null;
  screenshot_path?: string | null;
  trace_path?: string | null;
}

export interface RunComparisonSummary {
  base_run_id: string;
  target_run_id: string;
  base_commit_sha?: string | null;
  target_commit_sha?: string | null;
  base_branch?: string | null;
  target_branch?: string | null;
  environment?: string;
  total_tests: number;
  passed_count: number;
  failed_count: number;
  new_failures_count: number;
  recurring_failures_count: number;
  fixed_tests_count: number;
  stable_passes_count: number;
  added_tests_count: number;
  removed_tests_count: number;
  duration_delta_ms: number;
  regression_detected: boolean;
}

export interface RunComparisonResult {
  summary: RunComparisonSummary;
  items: TestComparisonItem[];
}

export interface FlakyTestReportItem {
  id: string;
  type: "web" | "api";
  title: string;
  module?: string;
  total_runs: number;
  passed_runs: number;
  failed_runs: number;
  flakiness_score: number; // 0.0 to 1.0
  last_status: string;
  last_run_at: string;
  last_error?: string | null;
}

export interface TestRecommendationResult {
  changed_files: string[];
  matched_keywords: string[];
  recommended_test_cases: Array<{
    id: string;
    title: string;
    module: string;
    priority: string;
    matched_reasons: string[];
  }>;
  recommended_api_endpoints: Array<{
    id: string;
    name: string;
    method: string;
    path: string;
    matched_reasons: string[];
  }>;
}
