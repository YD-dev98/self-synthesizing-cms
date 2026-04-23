export type IntentStatus = "pending" | "processing" | "completed" | "failed";

export interface IntentSubmissionState {
  id: string;
  status: IntentStatus;
}

export function normalizeIntentText(value: string): string {
  return value.trim();
}

export function canSubmitIntent(
  intentText: string,
  accessGranted: boolean,
  isSubmitting: boolean
): boolean {
  return accessGranted && !isSubmitting && normalizeIntentText(intentText).length > 0;
}

export function isTerminalIntentStatus(status: IntentStatus): boolean {
  return status === "completed" || status === "failed";
}

export function getIntentStatusMessage(
  submission: IntentSubmissionState | null
): string | null {
  if (!submission) {
    return null;
  }

  switch (submission.status) {
    case "pending":
      return "Intent queued. Waiting for the worker to pick it up.";
    case "processing":
      return "Intent is processing. The site is evolving now.";
    case "completed":
      return "Intent completed. The surface has been updated.";
    case "failed":
      return "Intent failed. Try again or re-enter access if the session expired.";
    default:
      return null;
  }
}
