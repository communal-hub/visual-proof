export type FrameStatus = 'clean' | 'loading' | 'error' | 'blank';

export interface TriageSignals {
  navOk: boolean;
  httpStatus: number | null;
  consoleErrors: string[];
  pageErrors: string[];
  appRootPresent: boolean;
  appRootChildCount: number;
  visibleSpinnerCount: number;
}

export interface TriageResult {
  status: FrameStatus;
  reasons: string[];
}

const MAX_REASON_LENGTH = 200;

/** DOM heuristics, first match wins: error, blank, loading, clean. */
export function triage(signals: TriageSignals): TriageResult {
  const errors: string[] = [];
  if (!signals.navOk) errors.push('navigation failed');
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
