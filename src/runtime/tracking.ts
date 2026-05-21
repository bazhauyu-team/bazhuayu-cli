import { createCipheriv, randomUUID } from 'node:crypto';
import { hostname, platform, release } from 'node:os';
import { clientVersion } from './client-headers.js';
import type { AuthSource } from './auth.js';
import type { RunOptions, RunStatus, TaskDefinition } from '../types.js';

const TRACKING_URL_ENV = 'OCTOPUS_TRACKING_URL';
const TRACKING_DISABLED_ENV = 'OCTOPUS_TRACKING_DISABLED';
const TRACKING_DEBUG_ENV = 'OCTOPUS_TRACKING_DEBUG';
const DEFAULT_CN_TRACKING_URL = 'https://tracking.bazhuayu.com';
const UPLOAD_ENDPOINT = '/extract/upload';
const ENCRYPTION_KEY = 'Octopus1';

export type TrackingEventName =
  | 'TrackCollectStart'
  | 'TrackCollectEnd'
  | 'CollectHistory'
  | 'TaskSettings'
  | 'TaskExecutionResult';

export interface TrackingEvent {
  time: string;
  name: TrackingEventName;
  content: Record<string, unknown>;
}

export interface CliTrackingContext {
  userId?: string;
  authSource?: AuthSource;
}

export interface TrackingRunContext {
  runId?: string;
  lotId?: string;
  taskId: string;
  taskName?: string;
  taskType?: string;
  collectType?: string;
  outputDir: string;
  options: RunOptions;
  startedAt: number;
  startUtc: string;
  startEntrance: string;
  startWay: 'manual';
  resourceWarningCount: number;
  billingWarningCount: number;
}

export class TrackingClient {
  private readonly launchId = randomUUID();

  constructor(
    private readonly context: CliTrackingContext = {},
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
  ) {}

  send(event: TrackingEvent): void {
    this.sendMany([event]);
  }

  sendMany(events: TrackingEvent[]): void {
    if (!isTrackingEnabled()) return;
    if (!events.length) return;
    void this.upload(events).catch((error) => {
      if (process.env[TRACKING_DEBUG_ENV] === '1') {
        console.error(`tracking upload failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  private async upload(events: TrackingEvent[]): Promise<void> {
    const payload = {
      product: 'Bazhuayu',
      channel: 'Cli',
      version: clientVersion(),
      common: {
        launchId: this.launchId,
        userId: this.context.userId ?? '',
        os: `${platform()} ${release()}`,
        platform: process.platform,
        arch: process.arch,
        hostname: hostname(),
        language: process.env.LANG ?? '',
        nodeVersion: process.version,
        keySource: this.context.authSource ?? 'none',
        time: utcNow()
      },
      events
    };

    const response = await this.fetchImpl(`${trackingBaseUrl()}${UPLOAD_ENDPOINT}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        data: encryptTrackingPayload(JSON.stringify(payload))
      })
    });
    if (!response.ok) {
      throw new Error(`tracking HTTP ${response.status}`);
    }
    if (process.env[TRACKING_DEBUG_ENV] === '1') {
      console.error(`tracking upload success: ${response.status} ${events.map((event) => event.name).join(',')}`);
    }
  }
}

export function createTrackingClient(context: CliTrackingContext = {}): TrackingClient {
  return new TrackingClient(context);
}

export function createTrackingRunContext(options: {
  taskId: string;
  runOptions: RunOptions;
  resourceWarningCount: number;
  billingWarningCount: number;
}): TrackingRunContext {
  const now = Date.now();
  return {
    taskId: options.taskId,
    outputDir: options.runOptions.outputDir,
    options: options.runOptions,
    startedAt: now,
    startUtc: new Date(now).toUTCString(),
    startEntrance: 'cli_run_command',
    startWay: 'manual',
    resourceWarningCount: options.resourceWarningCount,
    billingWarningCount: options.billingWarningCount
  };
}

export function markTrackingRunStarted(context: TrackingRunContext, event: {
  runId: string;
  lotId: string;
  taskId: string;
  taskName: string;
}): void {
  context.runId = event.runId;
  context.lotId = event.lotId;
  context.taskId = event.taskId;
  context.taskName = event.taskName;
}

export function markTrackingTaskLoaded(context: TrackingRunContext, task: TaskDefinition): void {
  context.taskId = task.taskId;
  context.taskName = task.taskName;
  context.collectType = inferCollectType(task);
  context.taskType = task.isTemplate ? 'template' : 'custom';
}

export function collectStartTrackingEvent(
  context: TrackingRunContext,
  success: boolean,
  failReason = ''
): TrackingEvent {
  return {
    time: utcNow(),
    name: 'TrackCollectStart',
    content: {
      taskId: context.taskId,
      taskFile: context.options.taskFile ?? '',
      collectType: context.collectType ?? 'Unknown',
      entrance: context.startEntrance,
      speed: false,
      startWay: context.startWay,
      success,
      fail_reason: failReason,
      timeSpend: Date.now() - context.startedAt,
      newCreate: false,
      taskType: context.taskType ?? 'unknown'
    }
  };
}

export function collectEndTrackingEvents(context: TrackingRunContext, options: {
  status: RunStatus;
  endWay: 'manual' | 'finish';
  success: boolean;
  failReason?: string;
  total: number;
  stoppedAt?: string;
  useCaptchaCount?: number | null;
  useProxyCount?: number | null;
  localTaskCharge?: number | null;
}): TrackingEvent[] {
  const endUtc = options.stoppedAt ? new Date(options.stoppedAt).toUTCString() : utcNow();
  return [
    {
      time: utcNow(),
      name: 'TrackCollectEnd',
      content: {
        taskId: context.taskId,
        taskFile: context.options.taskFile ?? '',
        collectType: context.collectType ?? 'Unknown',
        speed: false,
        endWay: options.endWay,
        success: options.success,
        fail_reason: options.failReason ?? ''
      }
    },
    {
      time: utcNow(),
      name: 'CollectHistory',
      content: collectHistoryContent(context, options.total, endUtc)
    },
    {
      time: utcNow(),
      name: 'TaskExecutionResult',
      content: {
        taskId: context.taskId,
        taskFile: context.options.taskFile ?? '',
        subTaskId: null,
        lotNo: context.lotId ?? '',
        taskExecutionResult: {
          status: options.status,
          startTime: context.startedAt,
          endTime: Date.now(),
          useTime: Date.now() - context.startedAt,
          endWay: options.endWay,
          total: options.total,
          useCaptchaCount: options.useCaptchaCount ?? null,
          useProxyCount: options.useProxyCount ?? null,
          balance: null,
          localTaskCharge: options.localTaskCharge ?? null
        }
      }
    }
  ];
}

function collectHistoryContent(
  context: TrackingRunContext,
  collectCount: number,
  collectEnd: string
): Record<string, unknown> {
  return {
    taskId: context.taskId,
    taskFile: context.options.taskFile ?? '',
    speed: false,
    collectType: context.collectType ?? 'Unknown',
    collectCount,
    collectStart: context.startUtc,
    collectEnd,
    collectUrl: []
  };
}

export function taskSettingsTrackingEvent(context: TrackingRunContext, task: TaskDefinition): TrackingEvent {
  return {
    time: utcNow(),
    name: 'TaskSettings',
    content: {
      taskId: context.taskId,
      taskFile: context.options.taskFile ?? '',
      subTaskId: null,
      lotNo: context.lotId ?? '',
      taskSettings: {
        taskName: task.taskName,
        taskType: task.workFlowType ?? null,
        runnerType: 'chrome',
        isSpeedMode: false,
        isJson: false,
        ipProxy: { type: null, period: null },
        userAgent: { switchType: task.userAgent ? 'Custom' : null, period: null },
        cookie: { clearType: null, period: null }
      }
    }
  };
}

export function trackingBaseUrl(): string {
  return (process.env[TRACKING_URL_ENV] || DEFAULT_CN_TRACKING_URL).replace(/\/+$/, '');
}

function isTrackingEnabled(): boolean {
  return process.env[TRACKING_DISABLED_ENV] !== '1';
}

function inferCollectType(task: TaskDefinition): string {
  if (task.isTemplate) return 'Template';
  if (typeof task.workFlowType === 'number') return String(task.workFlowType);
  return 'Custom';
}

function encryptTrackingPayload(clearText: string): string {
  const keyBuffer = Buffer.alloc(16);
  keyBuffer.write(ENCRYPTION_KEY);
  const cipher = createCipheriv('aes-128-ecb', keyBuffer, null);
  return cipher.update(clearText, 'utf8', 'base64') + cipher.final('base64');
}

function utcNow(): string {
  return new Date().toUTCString();
}
