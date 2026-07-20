import type { Page } from 'puppeteer-core';
import type {
  DetectedCandidate,
  DetectedField,
  DetectedPopupDismissal
} from './types.js';

export interface RawCandidate {
  type: DetectedCandidate['type'];
  selector: string;
  xpath: string;
  itemSelector?: string;
  itemXPath?: string;
  itemCount: number;
  fields: DetectedField[];
  sampleRows: Record<string, string>[];
  reasons: string[];
  confidence: number;
}

export type ExtensionCommandResponse =
  | { success: true; data?: unknown }
  | { success: false; error: string };

export interface DetectorExtensionBridge {
  runtimeConfig: { sessionId: string; wsUrl: string };
  sendActionCommand(command: Record<string, unknown>): Promise<ExtensionCommandResponse>;
  resolveTabId(pageUrl: string): number | undefined;
  getTabUrl?(tabId: number): string | undefined;
  getTabWindowId?(tabId: number): number | undefined;
  getBootstrapTabId?(): number | undefined;
  getBootstrapWindowId?(): number | undefined;
  getAnyTabId?(): number | undefined;
  close(): void;
}

export interface ManualStartDecision {
  dismissPopups: boolean;
  allowSessionSave: boolean;
}

export interface LoginInterventionResult {
  handled: boolean;
  allowSessionSave: boolean;
  ignoreFuturePrompts?: boolean;
  popupDismissals?: DetectedPopupDismissal[];
}

export interface SearchInputCandidate {
  xpath: string;
  name: string;
  type: string;
  placeholder: string;
  value: string;
  formAction: string;
  buttonXPath?: string;
  buttonText?: string;
  score: number;
  reasons: string[];
}

export interface SearchSubmitInputRef {
  name: string;
  xpath: string;
}

export interface SearchSubmitButton {
  xpath: string;
  text?: string;
  score?: number;
  reasons?: string[];
}

export type ManualOverlayAction = string;

export interface ManualOverlayChoice {
  title: string;
  value: ManualOverlayAction;
  description?: string;
  primary?: boolean;
}

export interface ManualOverlaySelection {
  action?: ManualOverlayAction;
  selectedXPath?: string;
  selectedText?: string;
}

export type NewPageWatcher = Promise<Page | undefined> & {
  cancel?: () => void;
};

export interface ScrollProbeSnapshot {
  scrollY: number;
  viewportHeight: number;
  pageHeight: number;
  contentHeight: number;
  articleLikeCount: number;
  /** Anonymous record identities used to detect virtualized lists whose DOM count stays flat. */
  articleLikeKeys?: string[];
  /** A visible loading/progress indicator is present while more records are pending. */
  hasLoadingIndicator?: boolean;
  activeLoadMoreCount: number;
  activeLoadMoreTexts: string[];
  activeLoadMoreXPaths: string[];
  hasActiveLoadMore: boolean;
  atBottom: boolean;
}

export interface ScrollProbeSummary {
  snapshots: ScrollProbeSnapshot[];
  sawActiveLoadMore: boolean;
  sawGrowth: boolean;
  maxArticleLikeCount: number;
  maxContentHeight: number;
  maxPageHeight: number;
  discoveredArticleLikeCount?: number;
  grewArticleLikeCount?: number;
  grewArticleLikeKeyCount?: number;
  grewContentHeight?: number;
  grewPageHeight?: number;
  reachedBottom?: boolean;
  bestActiveLoadMoreText?: string;
  bestActiveLoadMoreXPath?: string;
}

export interface SuppressedRuntimeConsole {
  suppress(): void;
  restore(): void;
  restoreOriginal(): void;
  writeStderr(message: string): void;
  question(prompt?: string): Promise<string>;
}

export interface ExtensionDetectorHostStartHooks {
  onTargetPageReady?: (page: Page) => void;
}

export type ManualOverlayOptions = {
  title: string;
  message?: string;
  status?: string;
  choices: ManualOverlayChoice[];
  selectedXPath?: string;
  selectedText?: string;
  highlightXPaths?: string[];
  mode?: 'normal' | 'pick-search-submit';
  inputXPaths?: string[];
};
