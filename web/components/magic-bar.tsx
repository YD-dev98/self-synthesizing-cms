"use client";

import { startTransition, useEffect, useState } from "react";
import { AccessGate } from "@/components/access-gate";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  canSubmitIntent,
  getIntentStatusMessage,
  isTerminalIntentStatus,
  normalizeIntentText,
  type IntentSubmissionState,
  type IntentStatus,
} from "@/lib/magic-bar-state";

const POLL_INTERVAL_MS = 2000;

interface MagicBarProps {
  initialAccessGranted: boolean;
}

function parseStatus(value: unknown): IntentStatus | null {
  switch (value) {
    case "pending":
    case "processing":
    case "completed":
    case "failed":
      return value;
    default:
      return null;
  }
}

export function MagicBar({ initialAccessGranted }: MagicBarProps) {
  const [accessGranted, setAccessGranted] = useState(initialAccessGranted);
  const [accessMessage, setAccessMessage] = useState<string | null>(null);
  const [intentText, setIntentText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submission, setSubmission] = useState<IntentSubmissionState | null>(
    null
  );
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (
      !accessGranted ||
      !submission ||
      isTerminalIntentStatus(submission.status)
    ) {
      return;
    }

    let cancelled = false;

    const timeoutId = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/intent/${submission.id}`, {
          method: "GET",
          cache: "no-store",
        });

        if (cancelled) {
          return;
        }

        if (response.status === 401) {
          startTransition(() => {
            setAccessGranted(false);
            setAccessMessage("Session expired. Re-enter the shared password.");
            setSubmitError(null);
          });
          return;
        }

        if (!response.ok) {
          startTransition(() => {
            setSubmission((current) =>
              current ? { ...current, status: "failed" } : current
            );
            setSubmitError("Could not refresh intent status.");
          });
          return;
        }

        const json = (await response.json()) as { status?: unknown };
        const nextStatus = parseStatus(json.status);

        if (!nextStatus) {
          startTransition(() => {
            setSubmission((current) =>
              current ? { ...current, status: "failed" } : current
            );
            setSubmitError("Intent status response was invalid.");
          });
          return;
        }

        startTransition(() => {
          setSubmission((current) =>
            current ? { ...current, status: nextStatus } : current
          );
          setSubmitError(null);
        });
      } catch {
        if (!cancelled) {
          startTransition(() => {
            setSubmission((current) =>
              current ? { ...current, status: "failed" } : current
            );
            setSubmitError("Could not reach the intent status endpoint.");
          });
        }
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [accessGranted, submission]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const nextIntentText = normalizeIntentText(intentText);
    if (!canSubmitIntent(nextIntentText, accessGranted, isSubmitting)) {
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const response = await fetch("/api/intent", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ intent_text: nextIntentText }),
      });

      if (response.status === 401) {
        startTransition(() => {
          setAccessGranted(false);
          setAccessMessage("Access is required before you can queue intents.");
        });
        return;
      }

      if (!response.ok) {
        const json = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        setSubmitError(json?.error ?? "Could not queue the intent.");
        return;
      }

      const json = (await response.json()) as { id?: unknown };
      const intentId = typeof json.id === "string" ? json.id : null;

      if (!intentId) {
        setSubmitError("Intent creation returned an invalid response.");
        return;
      }

      startTransition(() => {
        setIntentText("");
        setSubmission({ id: intentId, status: "pending" });
        setAccessMessage(null);
      });
    } catch {
      setSubmitError("Could not reach the intent API.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const statusMessage = submitError ?? getIntentStatusMessage(submission);

  return (
    <>
      {!accessGranted ? (
        <AccessGate
          message={accessMessage}
          onAccessGranted={() => {
            startTransition(() => {
              setAccessGranted(true);
              setAccessMessage(null);
              setSubmitError(null);
            });
          }}
        />
      ) : null}

      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 p-4">
        <div className="pointer-events-auto mx-auto w-full max-w-3xl">
          <Card className="border-border/80 bg-background/95 shadow-2xl backdrop-blur">
            <CardContent className="space-y-3 pt-4">
              {statusMessage ? (
                <p
                  className="text-sm text-muted-foreground"
                  role={submitError ? "alert" : "status"}
                >
                  {statusMessage}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Express a goal and let the background agent reshape the site.
                </p>
              )}

              <form className="flex gap-2" onSubmit={handleSubmit}>
                <Input
                  value={intentText}
                  onChange={(event) => setIntentText(event.target.value)}
                  placeholder="Show me AI industry trends this week"
                  aria-label="Intent input"
                  disabled={!accessGranted || isSubmitting}
                />
                <Button
                  type="submit"
                  size="lg"
                  disabled={
                    !canSubmitIntent(intentText, accessGranted, isSubmitting)
                  }
                >
                  {isSubmitting ? "Queueing..." : "Send"}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
