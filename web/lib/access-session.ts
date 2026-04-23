import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

export const ACCESS_COOKIE_NAME = "self_synth_access";
export const ACCESS_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

type CookieStoreLike = {
  get(name: string): { value: string } | undefined;
};

function getAccessPassword(): string {
  const password = process.env.ACCESS_PASSWORD;

  if (!password) {
    throw new Error("Missing ACCESS_PASSWORD");
  }

  return password;
}

function createSessionToken(password: string): string {
  return createHmac("sha256", password)
    .update("self-synth-access")
    .digest("hex");
}

function safeTokenEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function isValidAccessPassword(password: string): boolean {
  return safeTokenEquals(password, getAccessPassword());
}

export function getAccessSessionToken(): string {
  return createSessionToken(getAccessPassword());
}

export function hasAccessSession(
  cookieStore: CookieStoreLike | NextRequest
): boolean {
  const token =
    "cookies" in cookieStore
      ? cookieStore.cookies.get(ACCESS_COOKIE_NAME)?.value
      : cookieStore.get(ACCESS_COOKIE_NAME)?.value;

  if (!token) {
    return false;
  }

  return safeTokenEquals(token, getAccessSessionToken());
}

export function setAccessSessionCookie(response: NextResponse): void {
  response.cookies.set({
    name: ACCESS_COOKIE_NAME,
    value: getAccessSessionToken(),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ACCESS_COOKIE_MAX_AGE,
  });
}

export function clearAccessSessionCookie(response: NextResponse): void {
  response.cookies.set({
    name: ACCESS_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}
