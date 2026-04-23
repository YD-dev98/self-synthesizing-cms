"use client";

import { startTransition, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface AccessGateProps {
  message?: string | null;
  onAccessGranted: () => void;
}

export function AccessGate({ message, onAccessGranted }: AccessGateProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(message ?? null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!password.trim()) {
      setError("Enter the shared password to unlock the magic bar.");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/access", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ password }),
      });

      if (!response.ok) {
        setError("Invalid password. Access was not granted.");
        return;
      }

      startTransition(() => {
        setPassword("");
        onAccessGranted();
      });
    } catch {
      setError("Could not validate access. Try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
      <Card
        role="dialog"
        aria-modal="true"
        aria-labelledby="access-gate-title"
        className="w-full max-w-md shadow-2xl"
      >
        <CardHeader>
          <p className="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground">
            Shared Access
          </p>
          <CardTitle id="access-gate-title" className="text-2xl">
            Unlock the surface
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            This v0 build is gated so only invited testers can queue intents and
            spend worker cycles.
          </p>

          <form className="space-y-3" onSubmit={handleSubmit}>
            <Input
              autoFocus
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                if (error) {
                  setError(null);
                }
              }}
              placeholder="Shared password"
              aria-label="Shared password"
              disabled={isSubmitting}
            />

            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}

            <Button type="submit" size="lg" disabled={isSubmitting}>
              {isSubmitting ? "Unlocking..." : "Unlock access"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
