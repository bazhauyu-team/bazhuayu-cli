import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const EngineModule = require('@octopus/browser-runtime') as {
  browserLifecycle: BrowserLifecycleApi;
};

export type BrowserMode = 'independent' | 'user';
export type UserBrowserId = 'chrome' | 'edge';

export type BrowserLifecycleErrorCode =
  | 'UNSUPPORTED_BROWSER'
  | 'BROWSER_NOT_INSTALLED'
  | 'BROWSER_RUNNING'
  | 'PROFILE_RUNNING'
  | 'BROWSER_STILL_RUNNING'
  | 'BROWSER_CLOSE_FAILED'
  | 'INSTALL_FAILED'
  | 'UNSUPPORTED_PLATFORM'
  | 'EXTENSION_NOT_READY'
  | 'BROWSER_PATH_MISSING'
  | 'PROFILE_NOT_FOUND'
  | 'CRX_MISSING';

interface BrowserLifecycleApi {
  inspect(options?: BrowserLaunchContext): BrowserInspection;
  close(options?: BrowserLaunchContext): Promise<BrowserActionResult>;
  install(options?: BrowserLaunchContext): Promise<BrowserActionResult>;
}

interface BrowserLaunchContext {
  browserId?: UserBrowserId;
  browserName?: string;
  userDataDirectory?: string;
  profileName?: string;
}

interface BrowserActionResult {
  ok: boolean;
  browserName: string | null;
  errorCode?: BrowserLifecycleErrorCode | string | null;
  errorProfileName?: string | null;
  errorMessage?: string | null;
}

export interface BrowserInspection {
  browser: {
    id: UserBrowserId;
    name: string;
    path: string | null;
    installed: boolean;
    userDataDirectory: string | null;
    extensionsPageUrl: string | null;
  };
  profiles: Array<{
    profileName: string;
    profileDisplayName: string;
    userName: string | null;
    gaiaName: string | null;
    isDefaultProfile: boolean;
    isLastActiveProfile: boolean;
    plugin: { installed: boolean };
  }>;
  defaultProfileName: string | null;
  browserConfigured: boolean;
  extensionStatus: {
    configured: boolean;
    configuredVersion: string | null;
    installedVersion: string | null;
    bundledVersion: string | null;
    configuredPath: string | null;
    installed: boolean;
    versionMatched: boolean;
    needsInstallOrUpdate: boolean;
  };
  installGuide: {
    extensionId: string;
    browserName: string;
    extensionsPageUrl: string | null;
    chromeStoreUrl: string;
    crxPath: string | null;
  };
  launch: {
    ok: boolean;
    requiresClose: boolean;
    browserName: string | null;
    lockInfo: unknown;
    runningProcesses: Array<{ pid: number | null; imageName?: string }>;
    errorCode?: BrowserLifecycleErrorCode | string | null;
    errorProfileName?: string | null;
  };
}

export interface UserBrowserLaunchPlan {
  browserId: UserBrowserId;
  browserName: string;
  chromePath: string;
  userDataDirectory: string;
  profileName: string;
  profileDisplayName: string;
  extensionStatus: BrowserInspection['extensionStatus'];
  installGuide: BrowserInspection['installGuide'];
}

export class UserBrowserError extends Error {
  readonly code: BrowserLifecycleErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: BrowserLifecycleErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'UserBrowserError';
    this.code = code;
    this.details = details;
  }
}

export function isUserBrowserPlatformSupported(platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

export function userBrowserPlatformNote(): string {
  return 'User browser mode requires Windows or macOS because permanent Chrome/Edge extension install uses OS-specific External Extensions / registry hooks. Linux continues to use independent Chrome mode.';
}

export function parseBrowserMode(value: string | undefined): BrowserMode {
  if (!value || value === 'independent' || value === 'managed') return 'independent';
  if (value === 'user' || value === 'local') return 'user';
  throw new UserBrowserError(
    'UNSUPPORTED_BROWSER',
    `Invalid --browser value: ${value}. Use independent or user.`
  );
}

export function parseBrowserId(value: string | undefined): UserBrowserId {
  if (!value || value === 'chrome') return 'chrome';
  if (value === 'edge') return 'edge';
  throw new UserBrowserError(
    'UNSUPPORTED_BROWSER',
    `Invalid --browser-id value: ${value}. Use chrome or edge.`
  );
}

export interface BrowserLaunchPreference {
  mode?: BrowserMode;
  browserId?: UserBrowserId;
  profile?: string;
}

export interface ResolvedBrowserLaunchOptions {
  browserMode: BrowserMode;
  browserId: UserBrowserId;
  browserProfile?: string;
  /** Where browserMode came from (for diagnostics / human logs). */
  modeSource: 'cli' | 'env' | 'config' | 'default';
}

/**
 * Resolve browser launch options for run/detect.
 * Priority: CLI flags > env (OCTOPUS_BROWSER*) > saved config > built-in default (independent).
 */
export function resolveBrowserLaunchOptions(options: {
  browserFlag?: string;
  browserIdFlag?: string;
  profileFlag?: string;
  preference?: BrowserLaunchPreference;
  env?: NodeJS.ProcessEnv;
}): ResolvedBrowserLaunchOptions {
  const env = options.env ?? process.env;
  const envMode = env.OCTOPUS_BROWSER || env.OCTOPUS_BROWSER_MODE;
  const envBrowserId = env.OCTOPUS_BROWSER_ID;
  const envProfile = env.OCTOPUS_BROWSER_PROFILE;

  let browserMode: BrowserMode;
  let modeSource: ResolvedBrowserLaunchOptions['modeSource'];
  if (options.browserFlag !== undefined) {
    browserMode = parseBrowserMode(options.browserFlag);
    modeSource = 'cli';
  } else if (envMode) {
    browserMode = parseBrowserMode(envMode);
    modeSource = 'env';
  } else if (options.preference?.mode) {
    browserMode = options.preference.mode;
    modeSource = 'config';
  } else {
    browserMode = 'independent';
    modeSource = 'default';
  }

  const browserId = parseBrowserId(
    options.browserIdFlag
    ?? envBrowserId
    ?? options.preference?.browserId
  );
  const browserProfile = options.profileFlag
    ?? envProfile
    ?? options.preference?.profile
    ?? undefined;

  return {
    browserMode,
    browserId,
    ...(browserProfile ? { browserProfile } : {}),
    modeSource
  };
}

export function describeBrowserMode(mode: BrowserMode): string {
  return mode === 'user'
    ? 'user (system Chrome/Edge + installed extension)'
    : 'independent (Chrome for Testing)';
}

export function inspectUserBrowser(options: {
  browserId?: UserBrowserId;
  profileName?: string;
  userDataDirectory?: string;
} = {}): BrowserInspection {
  return EngineModule.browserLifecycle.inspect({
    browserId: options.browserId ?? 'chrome',
    profileName: options.profileName,
    userDataDirectory: options.userDataDirectory
  }) as BrowserInspection;
}

export async function closeUserBrowser(options: {
  browserId?: UserBrowserId;
  profileName?: string;
  userDataDirectory?: string;
} = {}): Promise<BrowserActionResult> {
  const inspection = inspectUserBrowser(options);
  return EngineModule.browserLifecycle.close({
    browserId: options.browserId ?? inspection.browser.id,
    browserName: inspection.browser.name,
    profileName: options.profileName ?? inspection.defaultProfileName ?? undefined,
    userDataDirectory: options.userDataDirectory ?? inspection.browser.userDataDirectory ?? undefined
  });
}

export async function installUserBrowserExtension(options: {
  browserId?: UserBrowserId;
  profileName?: string;
  forceClose?: boolean;
} = {}): Promise<{
  ok: boolean;
  browserName: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  closedBrowser?: boolean;
  inspectionBefore?: BrowserInspection;
  inspectionAfter?: BrowserInspection;
  nextSteps?: string[];
}> {
  assertUserBrowserPlatformSupported();
  const browserId = options.browserId ?? 'chrome';
  const before = inspectUserBrowser({ browserId, profileName: options.profileName });

  if (!before.browser.installed) {
    return {
      ok: false,
      browserName: before.browser.name,
      errorCode: 'BROWSER_NOT_INSTALLED',
      errorMessage: `${before.browser.name} was not found on this machine.`,
      inspectionBefore: before
    };
  }

  const requestedProfile = options.profileName
    ? before.profiles.find((profile) => profile.profileName === options.profileName)
    : undefined;
  if (options.profileName && before.profiles.length > 0 && !requestedProfile) {
    return {
      ok: false,
      browserName: before.browser.name,
      errorCode: 'PROFILE_NOT_FOUND',
      errorMessage: `Browser profile not found: ${options.profileName}`,
      inspectionBefore: before
    };
  }
  const installProfileName = options.profileName ?? before.defaultProfileName ?? undefined;

  if (!before.installGuide.crxPath || !existsSync(before.installGuide.crxPath)) {
    return {
      ok: false,
      browserName: before.browser.name,
      errorCode: 'CRX_MISSING',
      errorMessage: 'Bundled OctopusAutomation.crx was not found in @octopus/browser-runtime.',
      inspectionBefore: before
    };
  }

  let closedBrowser = false;
  if (before.launch.requiresClose) {
    if (!options.forceClose) {
      return {
        ok: false,
        browserName: before.browser.name,
        errorCode: before.launch.errorCode ?? 'BROWSER_RUNNING',
        errorMessage: [
          `${before.browser.name} is still running.`,
          'Close it first, or re-run with --force-close to let the CLI close it before installing the extension.'
        ].join(' '),
        inspectionBefore: before
      };
    }
    const closed = await closeUserBrowser({
      browserId,
      profileName: installProfileName,
      userDataDirectory: before.browser.userDataDirectory ?? undefined
    });
    if (!closed.ok) {
      return {
        ok: false,
        browserName: closed.browserName ?? before.browser.name,
        errorCode: closed.errorCode ?? 'BROWSER_CLOSE_FAILED',
        errorMessage: closed.errorMessage ?? `Failed to close ${before.browser.name}.`,
        inspectionBefore: before
      };
    }
    closedBrowser = true;
  }

  const installed = await EngineModule.browserLifecycle.install({
    browserId,
    browserName: before.browser.name,
    userDataDirectory: before.browser.userDataDirectory ?? undefined,
    profileName: installProfileName
  });

  const after = inspectUserBrowser({ browserId });
  if (!installed.ok) {
    return {
      ok: false,
      browserName: installed.browserName ?? before.browser.name,
      errorCode: installed.errorCode ?? 'INSTALL_FAILED',
      errorMessage: installed.errorMessage ?? `Failed to install the Octopus browser extension into ${before.browser.name}.`,
      closedBrowser,
      inspectionBefore: before,
      inspectionAfter: after
    };
  }

  return {
    ok: true,
    browserName: installed.browserName ?? before.browser.name,
    closedBrowser,
    inspectionBefore: before,
    inspectionAfter: after,
    nextSteps: [
      `Open ${before.browser.name} once so it can load the staged extension.`,
      before.installGuide.extensionsPageUrl
        ? `Confirm the extension is enabled at ${before.installGuide.extensionsPageUrl}`
        : 'Confirm the extension is enabled on the browser extensions page.',
      `Then set default: bazhuayu browser use user --browser-id ${browserId}${installProfileName ? ` --profile ${JSON.stringify(installProfileName)}` : ''}`,
      `Or run once with: bazhuayu run <taskId> --browser user --browser-id ${browserId}${installProfileName ? ` --profile ${JSON.stringify(installProfileName)}` : ''}`
    ]
  };
}

export function resolveUserBrowserLaunchPlan(options: {
  browserId?: UserBrowserId;
  profileName?: string;
  chromePath?: string;
  requireExtensionReady?: boolean;
}): UserBrowserLaunchPlan {
  assertUserBrowserPlatformSupported();
  const browserId = options.browserId ?? 'chrome';
  const inspection = inspectUserBrowser({
    browserId,
    profileName: options.profileName
  });

  if (!inspection.browser.installed) {
    throw new UserBrowserError(
      'BROWSER_NOT_INSTALLED',
      `${inspection.browser.name} was not found on this machine.`,
      { browserId, inspection: summarizeInspection(inspection) }
    );
  }

  const profileName = options.profileName
    ?? inspection.defaultProfileName
    ?? inspection.profiles[0]?.profileName
    ?? 'Default';
  const profile = inspection.profiles.find((item) => item.profileName === profileName);
  if (options.profileName && !profile && inspection.profiles.length > 0) {
    throw new UserBrowserError(
      'PROFILE_NOT_FOUND',
      `Browser profile not found: ${options.profileName}`,
      {
        browserId,
        requestedProfile: options.profileName,
        availableProfiles: inspection.profiles.map((item) => item.profileName)
      }
    );
  }

  const chromePath = options.chromePath ?? inspection.browser.path ?? undefined;
  if (!chromePath) {
    throw new UserBrowserError(
      'BROWSER_PATH_MISSING',
      `Could not resolve executable path for ${inspection.browser.name}.`,
      { browserId, inspection: summarizeInspection(inspection) }
    );
  }

  const userDataDirectory = inspection.browser.userDataDirectory;
  if (!userDataDirectory) {
    throw new UserBrowserError(
      'BROWSER_PATH_MISSING',
      `Could not resolve user data directory for ${inspection.browser.name}.`,
      { browserId, inspection: summarizeInspection(inspection) }
    );
  }

  if (options.requireExtensionReady !== false && inspection.extensionStatus.needsInstallOrUpdate) {
    throw new UserBrowserError(
      'EXTENSION_NOT_READY',
      [
        `Octopus browser extension is not ready in ${inspection.browser.name}.`,
        `bundled=${inspection.extensionStatus.bundledVersion ?? 'unknown'}`,
        `installed=${inspection.extensionStatus.installedVersion ?? 'none'}`,
        'Run: bazhuayu browser install',
        // Install (not run/detect) needs the browser closed so prefs/CRX can be written.
        inspection.launch.requiresClose ? '(close the browser first, or use --force-close with browser install)' : ''
      ].filter(Boolean).join(' '),
      { browserId, profileName, inspection: summarizeInspection(inspection) }
    );
  }

  // NOTE: launch.requiresClose is intentionally NOT a hard error for run/detect.
  // browser-runtime localBrowserMode reuses the real profile and opens a new session
  // window (--new-window). Chrome singleton handoff keeps the existing process.
  // requiresClose is only enforced by browserLifecycle.install / browser install.

  return {
    browserId,
    browserName: inspection.browser.name,
    chromePath,
    userDataDirectory,
    profileName,
    profileDisplayName: profile?.profileDisplayName ?? profileName,
    extensionStatus: inspection.extensionStatus,
    installGuide: inspection.installGuide
  };
}

export async function prepareUserBrowserForRun(options: {
  browserId?: UserBrowserId;
  profileName?: string;
  chromePath?: string;
  forceClose?: boolean;
}): Promise<UserBrowserLaunchPlan> {
  assertUserBrowserPlatformSupported();
  const browserId = options.browserId ?? 'chrome';
  const inspection = inspectUserBrowser({
    browserId,
    profileName: options.profileName
  });

  // forceClose is optional for run/detect. Default is leave the user browser running
  // and open a new session window (matches browser-runtime localBrowserMode).
  if (options.forceClose && inspection.launch.requiresClose) {
    const closed = await closeUserBrowser({
      browserId,
      profileName: options.profileName ?? inspection.defaultProfileName ?? undefined,
      userDataDirectory: inspection.browser.userDataDirectory ?? undefined
    });
    if (!closed.ok) {
      throw new UserBrowserError(
        (closed.errorCode as BrowserLifecycleErrorCode | undefined) ?? 'BROWSER_CLOSE_FAILED',
        closed.errorMessage ?? `Failed to close ${inspection.browser.name}.`,
        { browserId, inspection: summarizeInspection(inspection) }
      );
    }
  }

  return resolveUserBrowserLaunchPlan({
    browserId,
    profileName: options.profileName,
    chromePath: options.chromePath,
    requireExtensionReady: true
  });
}

export interface UserBrowserInspectionSummary {
  browser: {
    id: UserBrowserId;
    name: string;
    path: string | null;
    installed: boolean;
    userDataDirectory: string | null;
  };
  defaultProfileName: string | null;
  browserConfigured: boolean;
  extensionStatus: BrowserInspection['extensionStatus'];
  launch: {
    ok: boolean;
    requiresClose: boolean;
    errorCode: string | null;
    runningProcessCount: number;
  };
  profiles: Array<{
    profileName: string;
    profileDisplayName: string;
    isDefaultProfile: boolean;
    isLastActiveProfile: boolean;
    pluginInstalled: boolean;
  }>;
  installGuide: BrowserInspection['installGuide'];
}

export function summarizeInspection(inspection: BrowserInspection): UserBrowserInspectionSummary {
  return {
    browser: {
      id: inspection.browser.id,
      name: inspection.browser.name,
      path: inspection.browser.path,
      installed: inspection.browser.installed,
      userDataDirectory: inspection.browser.userDataDirectory
    },
    defaultProfileName: inspection.defaultProfileName,
    browserConfigured: inspection.browserConfigured,
    extensionStatus: inspection.extensionStatus,
    launch: {
      ok: inspection.launch.ok,
      requiresClose: inspection.launch.requiresClose,
      errorCode: inspection.launch.errorCode ?? null,
      runningProcessCount: inspection.launch.runningProcesses?.length ?? 0
    },
    profiles: inspection.profiles.map((profile) => ({
      profileName: profile.profileName,
      profileDisplayName: profile.profileDisplayName,
      isDefaultProfile: profile.isDefaultProfile,
      isLastActiveProfile: profile.isLastActiveProfile,
      pluginInstalled: profile.plugin.installed
    })),
    installGuide: inspection.installGuide
  };
}

function assertUserBrowserPlatformSupported(): void {
  if (isUserBrowserPlatformSupported()) return;
  throw new UserBrowserError(
    'UNSUPPORTED_PLATFORM',
    userBrowserPlatformNote(),
    { platform: process.platform }
  );
}
