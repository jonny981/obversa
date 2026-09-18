

export interface PreflightPauseResult {
  readonly kind: 'pause';
  readonly code: 'PREFLIGHT_PAUSED';
  readonly reason: string;
  readonly preflightEventId: string;
}
export interface PreflightFailureResult {
  readonly kind: 'fail';
  readonly code: 'PREFLIGHT_FAILED';
  readonly message: string;
}

export interface RunPreflightState {
  readonly phase: 'disabled' | 'pending' | 'admitted' | 'paused' | 'failed';
  readonly pause: PreflightPauseResult | null;
  readonly resumedPreflightEventId: string | null;
  readonly unfinishedProbeEventId: string | null;
}
