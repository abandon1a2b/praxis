export type Repository = {
  name: string;
  path: string;
  include: string[];
  exclude: string[];
};
export type BusinessConfig = {
  id: string;
  name: string;
  enabled: boolean;
  repositories: Repository[];
  model: { provider: string; id: string; thinking: string };
  intervalSeconds: number;
  batchCharacters: number;
  timeoutSeconds: number;
  focus: string;
};
export type Business = BusinessConfig & {
  version: number;
  nextAt: string | null;
};
export type Finding = {
  file: string;
  line: number;
  severity: string;
  title: string;
  trigger: string;
  explanation: string;
  evidence: string;
};
export type Report = {
  engine?: string;
  toolCalls?: number;
  coverage?: {
    totalFiles: number;
    fullyVerified: boolean;
    reads: {
      file: string;
      offset: number;
      limit: number | null;
      truncated: boolean;
    }[];
  };
  completed: {
    index: number;
    ranges: {
      file: string;
      start: number;
      end: number;
      startColumn?: number;
      endColumn?: number;
    }[];
  }[];
  totalBatches: number;
  findings: Finding[];
  skipped: { file: string; reason: string }[];
  revisions: Record<string, { head: string; dirty: boolean }>;
};
export type Run = {
  id: string;
  businessId: string;
  version: number;
  trigger: string;
  status: string;
  createdAt: string;
  finishedAt: string | null;
  config: BusinessConfig;
  report: Report | null;
  error: string | null;
};
export type RunSummary = Omit<Run, "report" | "config"> & {
  report: {
    completedBatches: number;
    totalBatches: number;
    findingCount: number;
  } | null;
};
export type Model = { provider: string; id: string; name: string };
