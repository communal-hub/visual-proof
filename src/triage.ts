export type FrameStatus = 'clean' | 'loading' | 'error' | 'blank';

export interface TriageSignals {
  navOk: boolean;
  httpStatus: number | null;
  consoleErrors: string[];
  pageErrors: string[];
  appRootPresent: boolean;
  appRootChildCount: number;
  visibleSpinnerCount: number;
  /** Set when the page could not be loaded as the logged-in user (login failed, 401/403, login redirect). */
  authFailure?: string;
  /** Sidecar scenarios only: the step that failed (`line 3 click [data-test=x]: selector not found`); the frame is an error. */
  stepFailure?: string;
  /** Set when `page.screenshot` threw: the PNG on disk is a placeholder, so the frame cannot be trusted. */
  screenshotError?: string;
}

export interface TriageResult {
  status: FrameStatus;
  reasons: string[];
}

const MAX_REASON_LENGTH = 200;

/** DOM heuristics, first match wins: error, blank, loading, clean. */
export function triage(signals: TriageSignals): TriageResult {
  const errors: string[] = [];
  if (signals.stepFailure) errors.push(signals.stepFailure);
  if (!signals.navOk) errors.push('navigation failed');
  if (signals.authFailure) errors.push(signals.authFailure);
  if (signals.screenshotError) errors.push(`screenshot failed: ${clip(signals.screenshotError)}`);
  if (signals.httpStatus !== null && signals.httpStatus >= 500) errors.push(`HTTP ${signals.httpStatus}`);
  for (const message of signals.consoleErrors) errors.push(`console error: ${clip(message)}`);
  for (const message of signals.pageErrors) errors.push(`page error: ${clip(message)}`);
  if (errors.length > 0) return { status: 'error', reasons: errors };

  if (!signals.appRootPresent) return { status: 'blank', reasons: ['app root not found'] };
  if (signals.appRootChildCount === 0) return { status: 'blank', reasons: ['app root has no element children'] };

  if (signals.visibleSpinnerCount > 0) {
    return { status: 'loading', reasons: [`${signals.visibleSpinnerCount} visible spinner(s)`] };
  }
  return { status: 'clean', reasons: [] };
}

function clip(message: string): string {
  return message.length > MAX_REASON_LENGTH ? `${message.slice(0, MAX_REASON_LENGTH)}...` : message;
}
