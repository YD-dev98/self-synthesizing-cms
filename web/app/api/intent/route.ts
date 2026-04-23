import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase-server";
import {
  clearAccessSessionCookie,
  hasAccessSession,
} from "@/lib/access-session";

export async function POST(request: NextRequest) {
  if (!hasAccessSession(request)) {
    const response = NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
    clearAccessSessionCookie(response);
    return response;
  }

  let body: { intent_text?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.intent_text || body.intent_text.trim().length === 0) {
    return NextResponse.json(
      { error: "intent_text is required" },
      { status: 400 }
    );
  }

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("user_intents")
    .insert({ intent_text: body.intent_text.trim() })
    .select("id")
    .single();

  if (error) {
    return NextResponse.json(
      { error: "Failed to create intent" },
      { status: 500 }
    );
  }

  return NextResponse.json({ id: data.id });
}
