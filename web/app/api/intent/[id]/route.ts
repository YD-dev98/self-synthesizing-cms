import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase-server";
import {
  clearAccessSessionCookie,
  hasAccessSession,
} from "@/lib/access-session";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!hasAccessSession(request)) {
    const response = NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
    clearAccessSessionCookie(response);
    return response;
  }

  const { id } = await params;

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("user_intents")
    .select("id, status")
    .eq("id", id)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Intent not found" }, { status: 404 });
  }

  return NextResponse.json({ id: data.id, status: data.status });
}
