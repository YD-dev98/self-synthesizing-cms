import { NextRequest, NextResponse } from "next/server";
import {
  isValidAccessPassword,
  setAccessSessionCookie,
} from "@/lib/access-session";

export async function POST(request: NextRequest) {
  let body: { password?: string };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.password || !isValidAccessPassword(body.password)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  setAccessSessionCookie(response);
  return response;
}
