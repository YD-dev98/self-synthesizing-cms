import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase-server";

export async function POST(request: NextRequest) {
  const token = request.headers.get("x-access-token");
  if (!token || token !== process.env.ACCESS_PASSWORD) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
