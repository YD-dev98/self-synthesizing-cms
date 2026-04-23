import { describe, expect, it, beforeAll } from "vitest";
import { NextResponse } from "next/server";
import {
  ACCESS_COOKIE_NAME,
  hasAccessSession,
  setAccessSessionCookie,
} from "@/lib/access-session";
import {
  canSubmitIntent,
  getIntentStatusMessage,
  normalizeIntentText,
} from "@/lib/magic-bar-state";

beforeAll(() => {
  process.env.ACCESS_PASSWORD = "test-secret-123";
});

describe("access session", () => {
  it("sets a cookie that is recognized as a valid session", () => {
    const response = NextResponse.json({ ok: true });
    setAccessSessionCookie(response);

    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain(`${ACCESS_COOKIE_NAME}=`);

    const token = setCookie!.split(";")[0].split("=")[1];
    expect(
      hasAccessSession({
        get(name: string) {
          if (name !== ACCESS_COOKIE_NAME) {
            return undefined;
          }

          return { value: token };
        },
      })
    ).toBe(true);
  });

  it("rejects an invalid session cookie", () => {
    expect(
      hasAccessSession({
        get(name: string) {
          if (name !== ACCESS_COOKIE_NAME) {
            return undefined;
          }

          return { value: "invalid-token" };
        },
      })
    ).toBe(false);
  });
});

describe("magic bar state", () => {
  it("trims intent text before submission", () => {
    expect(normalizeIntentText("  show weather  ")).toBe("show weather");
  });

  it("prevents submit without access, with empty input, or while submitting", () => {
    expect(canSubmitIntent("show trends", false, false)).toBe(false);
    expect(canSubmitIntent("   ", true, false)).toBe(false);
    expect(canSubmitIntent("show trends", true, true)).toBe(false);
  });

  it("allows submit when access is granted and text is non-empty", () => {
    expect(canSubmitIntent("show trends", true, false)).toBe(true);
  });

  it("maps status polling states to user-facing messages", () => {
    expect(
      getIntentStatusMessage({ id: "intent-1", status: "pending" })
    ).toContain("queued");
    expect(
      getIntentStatusMessage({ id: "intent-1", status: "processing" })
    ).toContain("processing");
    expect(
      getIntentStatusMessage({ id: "intent-1", status: "completed" })
    ).toContain("completed");
    expect(
      getIntentStatusMessage({ id: "intent-1", status: "failed" })
    ).toContain("failed");
  });
});
