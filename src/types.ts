export const EXIT_OK = 0;
export const EXIT_OPERATION_FAILED = 1;
export const EXIT_RUNTIME_FAILED = 2;
export const EXIT_UNSUPPORTED_TASK = 3;

export type DataExportFormat = 'xlsx' | 'csv' | 'html' | 'json' | 'xml';
export type RunStatus = 'running' | 'paused' | 'stopping' | 'completed' | 'failed' | 'stopped';

export interface TaskDefinition {
  taskId: string;
  taskName: string;
  xml: string;
  xoml: string;
  fieldNames: string[];
  workflowSetting?: unknown;
  brokerSettings?: unknown;
  userAgent?: string;
  disableAD?: boolean;
  disableImage?: boolean;
}

export interface RunOptions {
  taskId: string;
  taskFile?: string;
  outputDir: string;
  headless: boolean;
  json: boolean;
  jsonl: boolean;
  chromePath?: string;
  disableImage: boolean;
  disableAD: boolean;
  runTimeoutMs: number;
  extensionTimeoutMs: number;
  debugBridge: boolean;
  detach: boolean;
}

export interface RunSummary {
  runId: string;
  lotId: string;
  taskId: string;
  taskName?: string;
  status: RunStatus;
  total: number;
  outputDir: string;
  startedAt: string;
  stoppedAt?: string;
}

export interface JsonEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}
