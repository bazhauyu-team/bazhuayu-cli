import { hasFlag, valueAfter } from '../cli/args.js';
import { printEnvelope, printUsageError } from '../cli/output.js';
import { configFilePath, readCliConfig, saveBrowserPreference } from '../runtime/config.js';
import {
  closeUserBrowser,
  describeBrowserMode,
  installUserBrowserExtension,
  inspectUserBrowser,
  isUserBrowserPlatformSupported,
  parseBrowserId,
  parseBrowserMode,
  resolveBrowserLaunchOptions,
  summarizeInspection,
  UserBrowserError,
  userBrowserPlatformNote,
  type BrowserInspection,
  type BrowserMode,
  type UserBrowserId
} from '../runtime/user-browser.js';
import { EXIT_OK, EXIT_OPERATION_FAILED, EXIT_RUNTIME_FAILED } from '../types.js';

interface BrowserNextAction {
  action: 'install_browser' | 'list_profiles' | 'install_extension' | 'reopen_browser' | 'verify_extension' | 'set_default' | 'run';
  command?: string;
  reason: string;
  requiresHuman: boolean;
}

const USAGE = '用法: bazhuayu browser <status|use|install|close|profiles> [options] [--json]';

export async function browserCommand(subcommand: string | undefined, args: string[]): Promise<number> {
  const json = hasFlag([subcommand ?? '', ...args], '--json');

  if (!subcommand || subcommand.startsWith('-')) {
    return printUsageError(json, '错误: 缺少 browser 子命令', USAGE);
  }

  try {
    if (subcommand === 'status') return browserStatus(args, json);
    if (subcommand === 'use') return browserUse(args, json);
    if (subcommand === 'install') return browserInstall(args, json);
    if (subcommand === 'close') return browserClose(args, json);
    if (subcommand === 'profiles') return browserProfiles(args, json);
  } catch (error) {
    return printBrowserError(json, error);
  }

  return printUsageError(json, `错误: 未知 browser 子命令: ${subcommand}`, USAGE);
}

async function browserStatus(args: string[], json: boolean): Promise<number> {
  const browserId = parseBrowserIdArg(args);
  const profileName = valueAfter(args, '--profile');
  const preference = await readEffectiveBrowserPreference();

  if (!isUserBrowserPlatformSupported()) {
    const data = {
      supported: false,
      platform: process.platform,
      note: userBrowserPlatformNote(),
      browserId,
      defaultBrowser: preference
    };
    if (json) printEnvelope(true, data);
    else {
      printDefaultBrowserPreference(preference);
      console.log(`User browser mode: unsupported on ${process.platform}`);
      console.log(userBrowserPlatformNote());
    }
    return EXIT_OK;
  }

  const inspection = inspectUserBrowser({ browserId, profileName });
  const summary = summarizeInspection(inspection);
  const selectedProfileName = profileName ?? inspection.defaultProfileName;
  const readyForUserBrowserRun = isReadyForUserBrowserRun(inspection, selectedProfileName);
  const data = {
    supported: true as const,
    platform: process.platform,
    defaultBrowser: preference,
    selectedProfileName,
    ...summary,
    readyForUserBrowserRun,
    hints: buildStatusHints(inspection, preference.mode, selectedProfileName),
    nextActions: buildStatusNextActions(inspection, preference.mode, selectedProfileName)
  };

  if (json) {
    printEnvelope(true, data);
    return EXIT_OK;
  }

  printDefaultBrowserPreference(preference);
  printHumanStatus({
    browser: summary.browser,
    defaultProfileName: summary.defaultProfileName,
    extensionStatus: summary.extensionStatus,
    launch: summary.launch,
    readyForUserBrowserRun: data.readyForUserBrowserRun,
    hints: data.hints,
    profiles: summary.profiles
  });
  return EXIT_OK;
}

/**
 * Set the default browser for run/detect:
 *   bazhuayu browser use independent
 *   bazhuayu browser use user [--browser-id chrome|edge] [--profile Default]
 *   bazhuayu browser use status
 */
async function browserUse(args: string[], json: boolean): Promise<number> {
  const modeArg = args.find((arg) => !arg.startsWith('-'));
  if (!modeArg || modeArg === 'status' || modeArg === 'show') {
    const preference = await readEffectiveBrowserPreference();
    if (json) printEnvelope(true, preference);
    else printDefaultBrowserPreference(preference);
    return EXIT_OK;
  }

  let mode: BrowserMode;
  try {
    mode = parseBrowserMode(modeArg);
  } catch {
    return printUsageError(
      json,
      `错误: 未知浏览器模式: ${modeArg}`,
      '用法: bazhuayu browser use independent|user [--browser-id chrome|edge] [--profile <name>] [--json]'
    );
  }

  const browserIdFlag = valueAfter(args, '--browser-id') ?? valueAfter(args, '--browser');
  const profileFlag = valueAfter(args, '--profile');
  const browserId = browserIdFlag ? parseBrowserId(browserIdFlag) : undefined;
  const profile = profileFlag ?? undefined;

  if (mode === 'user' && !isUserBrowserPlatformSupported()) {
    return printBrowserError(json, new UserBrowserError('UNSUPPORTED_PLATFORM', userBrowserPlatformNote()));
  }

  const selectedBrowserId = browserId ?? 'chrome';
  const inspection = mode === 'user'
    ? inspectUserBrowser({ browserId: selectedBrowserId, profileName: profile })
    : undefined;
  if (profile && inspection && inspection.profiles.length > 0
      && !inspection.profiles.some((item) => item.profileName === profile)) {
    return printBrowserError(json, new UserBrowserError(
      'PROFILE_NOT_FOUND',
      `Browser profile not found: ${profile}`,
      {
        browserId: selectedBrowserId,
        requestedProfile: profile,
        availableProfiles: inspection.profiles.map((item) => item.profileName),
        nextActions: [{
          action: 'list_profiles',
          command: `bazhuayu browser profiles --browser-id ${selectedBrowserId} --json`,
          reason: 'Choose an existing browser profile before enabling user mode.',
          requiresHuman: false
        } satisfies BrowserNextAction]
      }
    ));
  }

  // When switching to independent, clear user-only fields so status stays clear.
  const saved = await saveBrowserPreference(
    mode === 'independent'
      ? { mode: 'independent' }
      : {
          mode: 'user',
          ...(browserId ? { browserId } : { browserId: selectedBrowserId }),
          ...(profile ? { profile } : {})
        }
  );

  const preference = {
    mode: saved.browser?.mode ?? mode,
    browserId: saved.browser?.browserId ?? (mode === 'user' ? 'chrome' as const : undefined),
    profile: saved.browser?.profile,
    configFile: configFilePath(),
    source: 'config' as const
  };
  const data = {
    ...preference,
    readyForUserBrowserRun: inspection
      ? isReadyForUserBrowserRun(inspection, profile ?? inspection.defaultProfileName)
      : false,
    nextActions: inspection
      ? buildStatusNextActions(inspection, preference.mode, profile ?? inspection.defaultProfileName)
      : []
  };

  if (json) {
    printEnvelope(true, data);
    return EXIT_OK;
  }

  console.log(`Default browser set to: ${describeBrowserMode(preference.mode)}`);
  if (preference.mode === 'user') {
    console.log(`Browser: ${preference.browserId ?? 'chrome'}`);
    if (preference.profile) console.log(`Profile: ${preference.profile}`);
    console.log('Tip: if extension is not ready, run: bazhuayu browser install');
  }
  console.log(`Saved to: ${preference.configFile}`);
  console.log('Applies to: bazhuayu run / bazhuayu detect (override with --browser independent|user)');
  return EXIT_OK;
}

async function browserInstall(args: string[], json: boolean): Promise<number> {
  const browserId = parseBrowserIdArg(args);
  const profileName = valueAfter(args, '--profile');
  const forceClose = hasFlag(args, '--force-close') || hasFlag(args, '--force-close-browser');

  if (!isUserBrowserPlatformSupported()) {
    return printBrowserError(json, new UserBrowserError('UNSUPPORTED_PLATFORM', userBrowserPlatformNote()));
  }

  const result = await installUserBrowserExtension({ browserId, profileName, forceClose });
  const data = {
    ok: result.ok,
    browserName: result.browserName,
    closedBrowser: Boolean(result.closedBrowser),
    errorCode: result.errorCode ?? null,
    errorMessage: result.errorMessage ?? null,
    nextSteps: result.nextSteps ?? [],
    before: result.inspectionBefore ? summarizeInspection(result.inspectionBefore) : null,
    after: result.inspectionAfter ? summarizeInspection(result.inspectionAfter) : null,
    nextActions: result.ok
      ? buildInstallNextActions(browserId, profileName, true)
      : buildInstallFailureNextActions(browserId, profileName, result.errorCode)
  };

  if (!result.ok) {
    if (json) printEnvelope(false, undefined, result.errorCode ?? 'INSTALL_FAILED', result.errorMessage ?? 'install failed', data);
    else {
      console.error(result.errorMessage ?? 'install failed');
      if (result.errorCode === 'BROWSER_RUNNING' || result.errorCode === 'PROFILE_RUNNING') {
        console.error('提示: 先关闭浏览器，或使用 --force-close');
      }
    }
    return EXIT_OPERATION_FAILED;
  }

  if (json) {
    printEnvelope(true, data);
    return EXIT_OK;
  }

  console.log(`Installed Octopus browser extension into ${result.browserName ?? browserId}.`);
  if (result.closedBrowser) console.log('Closed the running browser before install.');
  for (const step of result.nextSteps ?? []) {
    console.log(`- ${step}`);
  }
  return EXIT_OK;
}

async function browserClose(args: string[], json: boolean): Promise<number> {
  const browserId = parseBrowserIdArg(args);
  const profileName = valueAfter(args, '--profile');

  if (!isUserBrowserPlatformSupported()) {
    return printBrowserError(json, new UserBrowserError('UNSUPPORTED_PLATFORM', userBrowserPlatformNote()));
  }

  const result = await closeUserBrowser({ browserId, profileName });
  if (!result.ok) {
    const message = result.errorMessage
      ?? `Failed to close ${result.browserName ?? browserId}${result.errorCode ? ` (${result.errorCode})` : ''}`;
    if (json) printEnvelope(false, undefined, result.errorCode ?? 'BROWSER_CLOSE_FAILED', message, {
      browserId,
      profileName: profileName ?? null,
      nextActions: [{
        action: 'verify_extension',
        command: `bazhuayu browser status --browser-id ${browserId}${profileArg(profileName)} --json`,
        reason: 'Inspect the browser lock and profile state before retrying.',
        requiresHuman: false
      } satisfies BrowserNextAction]
    });
    else console.error(message);
    return EXIT_OPERATION_FAILED;
  }

  const data = {
    ok: true,
    browserName: result.browserName,
    browserId
  };
  if (json) printEnvelope(true, data);
  else console.log(`Closed ${result.browserName ?? browserId}.`);
  return EXIT_OK;
}

async function browserProfiles(args: string[], json: boolean): Promise<number> {
  const browserId = parseBrowserIdArg(args);

  if (!isUserBrowserPlatformSupported()) {
    return printBrowserError(json, new UserBrowserError('UNSUPPORTED_PLATFORM', userBrowserPlatformNote()));
  }

  const inspection = inspectUserBrowser({ browserId });
  const data = {
    browserId: inspection.browser.id,
    browserName: inspection.browser.name,
    defaultProfileName: inspection.defaultProfileName,
    profiles: inspection.profiles.map((profile) => ({
      profileName: profile.profileName,
      profileDisplayName: profile.profileDisplayName,
      userName: profile.userName,
      gaiaName: profile.gaiaName,
      isDefaultProfile: profile.isDefaultProfile,
      isLastActiveProfile: profile.isLastActiveProfile,
      pluginInstalled: profile.plugin.installed
    }))
  };

  if (json) {
    printEnvelope(true, data);
    return EXIT_OK;
  }

  console.log(`${data.browserName} profiles (${data.profiles.length}):`);
  for (const profile of data.profiles) {
    const tags = [
      profile.isDefaultProfile ? 'default' : null,
      profile.isLastActiveProfile ? 'last-active' : null,
      profile.pluginInstalled ? 'plugin' : null
    ].filter(Boolean);
    console.log(
      `- ${profile.profileName} (${profile.profileDisplayName})${tags.length ? ` [${tags.join(', ')}]` : ''}`
    );
  }
  if (data.defaultProfileName) {
    console.log(`Default selection: ${data.defaultProfileName}`);
  }
  return EXIT_OK;
}

async function readEffectiveBrowserPreference(): Promise<{
  mode: BrowserMode;
  browserId?: UserBrowserId;
  profile?: string;
  configFile: string;
  source: 'cli' | 'env' | 'config' | 'default';
}> {
  const config = await readCliConfig();
  const resolved = resolveBrowserLaunchOptions({
    preference: config.browser
  });
  return {
    mode: resolved.browserMode,
    browserId: resolved.browserId,
    profile: resolved.browserProfile,
    configFile: configFilePath(),
    source: resolved.modeSource
  };
}

function printDefaultBrowserPreference(preference: {
  mode: BrowserMode;
  browserId?: UserBrowserId;
  profile?: string;
  configFile: string;
  source: string;
}): void {
  console.log(`Default browser: ${describeBrowserMode(preference.mode)} (source=${preference.source})`);
  if (preference.mode === 'user') {
    console.log(`User browser id: ${preference.browserId ?? 'chrome'}`);
    if (preference.profile) console.log(`User profile: ${preference.profile}`);
  }
  console.log(`Config: ${preference.configFile}`);
  console.log('Change with: bazhuayu browser use independent|user');
}

function parseBrowserIdArg(args: string[]): UserBrowserId {
  // Prefer --browser-id. --browser is accepted only for chrome|edge values so it
  // does not collide with run's --browser independent|user mode flag.
  const browserIdFlag = valueAfter(args, '--browser-id');
  if (browserIdFlag) return parseBrowserId(browserIdFlag);
  const browserFlag = valueAfter(args, '--browser');
  if (browserFlag === 'chrome' || browserFlag === 'edge') return parseBrowserId(browserFlag);
  return 'chrome';
}

function isReadyForUserBrowserRun(
  inspection: BrowserInspection,
  selectedProfileName?: string | null
): boolean {
  const selectedProfile = selectedProfileName
    ? inspection.profiles.find((profile) => profile.profileName === selectedProfileName)
    : undefined;
  const selectedProfileReady = inspection.profiles.length === 0
    || Boolean(selectedProfile?.plugin.installed);
  return inspection.browser.installed
    && !inspection.extensionStatus.needsInstallOrUpdate
    && selectedProfileReady
    && Boolean(inspection.browser.path)
    && Boolean(inspection.browser.userDataDirectory);
}

function buildStatusHints(
  inspection: BrowserInspection,
  defaultMode: BrowserMode,
  selectedProfileName?: string | null
): string[] {
  const hints: string[] = [];
  if (!inspection.browser.installed) {
    hints.push(`Install ${inspection.browser.name} first.`);
    return hints;
  }
  if (inspection.extensionStatus.needsInstallOrUpdate) {
    hints.push(inspection.launch.requiresClose
      ? 'Close the browser, then run: bazhuayu browser install'
      : 'Run: bazhuayu browser install');
  } else if (inspection.launch.requiresClose) {
    hints.push('Browser is running. User-mode run/detect can reuse it (opens a new session window).');
  }
  if (defaultMode === 'independent') {
    hints.push('Default is independent. Switch with: bazhuayu browser use user');
  } else {
    hints.push('Default is user browser. Switch back with: bazhuayu browser use independent');
  }
  if (isReadyForUserBrowserRun(inspection, selectedProfileName)) {
    hints.push('Ready for user mode. Example: bazhuayu run <taskId>   (uses saved default)');
    hints.push('Or override once: bazhuayu run <taskId> --browser independent');
  }
  return hints;
}

function buildStatusNextActions(
  inspection: BrowserInspection,
  defaultMode: BrowserMode,
  selectedProfileName?: string | null
): BrowserNextAction[] {
  const browserId = inspection.browser.id;
  if (!inspection.browser.installed) {
    return [{
      action: 'install_browser',
      reason: `Install ${inspection.browser.name} before using user-browser mode.`,
      requiresHuman: true
    }];
  }

  const selectedProfile = selectedProfileName
    ? inspection.profiles.find((profile) => profile.profileName === selectedProfileName)
    : undefined;
  if (selectedProfileName && inspection.profiles.length > 0 && !selectedProfile) {
    return [{
      action: 'list_profiles',
      command: `bazhuayu browser profiles --browser-id ${browserId} --json`,
      reason: `Profile ${selectedProfileName} was not found. Choose an available profile.`,
      requiresHuman: false
    }];
  }

  const extensionReady = !inspection.extensionStatus.needsInstallOrUpdate
    && (inspection.profiles.length === 0 || Boolean(selectedProfile?.plugin.installed));
  if (!extensionReady) {
    const installCommand = `bazhuayu browser install --browser-id ${browserId}${profileArg(selectedProfileName)}${inspection.launch.requiresClose ? ' --force-close' : ''} --json`;
    return [
      {
        action: 'install_extension',
        command: installCommand,
        reason: 'Install or update the Octopus extension for the selected browser profile.',
        requiresHuman: false
      },
      ...buildInstallNextActions(browserId, selectedProfileName, true)
    ];
  }

  if (defaultMode !== 'user') {
    return [{
      action: 'set_default',
      command: `bazhuayu browser use user --browser-id ${browserId}${profileArg(selectedProfileName)} --json`,
      reason: 'Persist user-browser mode as the default for run and detect.',
      requiresHuman: false
    }];
  }

  return [{
    action: 'run',
    command: 'bazhuayu run <taskId> --json',
    reason: 'User-browser mode is ready and selected as the default.',
    requiresHuman: false
  }];
}

function buildInstallFailureNextActions(
  browserId: UserBrowserId,
  profileName: string | null | undefined,
  errorCode: string | null | undefined
): BrowserNextAction[] {
  if (errorCode === 'BROWSER_RUNNING' || errorCode === 'PROFILE_RUNNING') {
    return [{
      action: 'install_extension',
      command: `bazhuayu browser install --browser-id ${browserId}${profileArg(profileName)} --force-close --json`,
      reason: 'Retry extension installation after allowing the CLI to close the running browser.',
      requiresHuman: false
    }];
  }
  if (errorCode === 'PROFILE_NOT_FOUND') {
    return [{
      action: 'list_profiles',
      command: `bazhuayu browser profiles --browser-id ${browserId} --json`,
      reason: 'Choose an existing browser profile before installing the extension.',
      requiresHuman: false
    }];
  }
  if (errorCode === 'BROWSER_NOT_INSTALLED') {
    return [{
      action: 'install_browser',
      reason: `Install ${browserId === 'edge' ? 'Microsoft Edge' : 'Google Chrome'} before installing the extension.`,
      requiresHuman: true
    }];
  }
  return [];
}

function buildInstallNextActions(
  browserId: UserBrowserId,
  profileName: string | null | undefined,
  installed: boolean
): BrowserNextAction[] {
  if (!installed) return [];
  const statusCommand = `bazhuayu browser status --browser-id ${browserId}${profileArg(profileName)} --json`;
  return [
    {
      action: 'reopen_browser',
      reason: 'Open the browser once so it loads the staged extension.',
      requiresHuman: true
    },
    {
      action: 'verify_extension',
      command: statusCommand,
      reason: 'Confirm readyForUserBrowserRun is true before enabling user mode.',
      requiresHuman: true
    },
    {
      action: 'set_default',
      command: `bazhuayu browser use user --browser-id ${browserId}${profileArg(profileName)} --json`,
      reason: 'Persist the verified user browser and profile.',
      requiresHuman: false
    }
  ];
}

function profileArg(profileName: string | null | undefined): string {
  return profileName ? ` --profile ${JSON.stringify(profileName)}` : '';
}

function printHumanStatus(data: {
  browser: {
    id: string;
    name: string;
    path: string | null;
    installed: boolean;
    userDataDirectory: string | null;
  };
  defaultProfileName: string | null;
  extensionStatus: {
    configured: boolean;
    installed: boolean;
    versionMatched: boolean;
    needsInstallOrUpdate: boolean;
    bundledVersion: string | null;
    installedVersion: string | null;
  };
  launch: {
    ok: boolean;
    requiresClose: boolean;
    errorCode: string | null;
    runningProcessCount: number;
  };
  readyForUserBrowserRun: boolean;
  hints: string[];
  profiles: Array<{
    profileName: string;
    profileDisplayName: string;
    pluginInstalled: boolean;
  }>;
}): void {
  console.log(`Browser: ${data.browser.name} (${data.browser.id})`);
  console.log(`Installed: ${data.browser.installed ? 'yes' : 'no'}`);
  console.log(`Path: ${data.browser.path ?? 'n/a'}`);
  console.log(`User data: ${data.browser.userDataDirectory ?? 'n/a'}`);
  console.log(`Default profile: ${data.defaultProfileName ?? 'n/a'}`);
  console.log(
    `Extension: configured=${data.extensionStatus.configured} installed=${data.extensionStatus.installed} ` +
    `versionMatched=${data.extensionStatus.versionMatched} ` +
    `bundled=${data.extensionStatus.bundledVersion ?? 'n/a'} ` +
    `installedVersion=${data.extensionStatus.installedVersion ?? 'n/a'}`
  );
  console.log(
    `Launch lock: requiresClose=${data.launch.requiresClose} ` +
    `runningProcesses=${data.launch.runningProcessCount}` +
    (data.launch.errorCode ? ` error=${data.launch.errorCode}` : '')
  );
  console.log(`Ready for user browser: ${data.readyForUserBrowserRun ? 'yes' : 'no'}`);
  if (data.profiles.length) {
    console.log('Profiles:');
    for (const profile of data.profiles) {
      console.log(
        `- ${profile.profileName} (${profile.profileDisplayName})` +
        `${profile.pluginInstalled ? ' [plugin]' : ''}`
      );
    }
  }
  if (data.hints.length) {
    console.log('Next:');
    for (const hint of data.hints) console.log(`- ${hint}`);
  }
}

function printBrowserError(json: boolean, error: unknown): number {
  if (error instanceof UserBrowserError) {
    if (json) printEnvelope(false, undefined, error.code, error.message, error.details);
    else console.error(error.message);
    return error.code === 'UNSUPPORTED_PLATFORM' ? EXIT_RUNTIME_FAILED : EXIT_OPERATION_FAILED;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (json) printEnvelope(false, undefined, 'BROWSER_COMMAND_FAILED', message);
  else console.error(message);
  return EXIT_OPERATION_FAILED;
}
