import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { POST } from "@/app/api/intent/route";
import { GET } from "@/app/api/intent/[id]/route";

const TEST_PASSWORD = "test-secret-123";
const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

let service: SupabaseClient;

beforeAll(() => {
  // Set env vars for the route handlers
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
  process.env.ACCESS_PASSWORD = TEST_PASSWORD;

  service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
});

beforeEach(async () => {
  await service
    .from("user_intents")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");
});

function makePostRequest(
  body: Record<string, unknown>,
  token?: string
): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token) headers["x-access-token"] = token;

  return new NextRequest("http://localhost:3000/api/intent", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function makeGetRequest(id: string, token?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers["x-access-token"] = token;

  return new NextRequest(`http://localhost:3000/api/intent/${id}`, {
    method: "GET",
    headers,
  });
}

// ---------------------------------------------------------
// POST /api/intent
// ---------------------------------------------------------
describe("POST /api/intent", () => {
  it("returns 401 without password", async () => {
    const res = await POST(makePostRequest({ intent_text: "test" }));
    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong password", async () => {
    const res = await POST(
      makePostRequest({ intent_text: "test" }, "wrong-password")
    );
    expect(res.status).toBe(401);
  });

  it("returns 200 with valid password and creates intent", async () => {
    const res = await POST(
      makePostRequest({ intent_text: "show me AI trends" }, TEST_PASSWORD)
    );
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.id).toBeDefined();
    expect(typeof json.id).toBe("string");

    // Verify row exists in DB with status pending
    const { data } = await service
      .from("user_intents")
      .select("*")
      .eq("id", json.id)
      .single();
    expect(data).not.toBeNull();
    expect(data!.intent_text).toBe("show me AI trends");
    expect(data!.status).toBe("pending");
  });

  it("returns 400 with empty intent_text", async () => {
    const res = await POST(
      makePostRequest({ intent_text: "" }, TEST_PASSWORD)
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 with missing intent_text", async () => {
    const res = await POST(makePostRequest({}, TEST_PASSWORD));
    expect(res.status).toBe(400);
  });

  it("returns 400 with whitespace-only intent_text", async () => {
    const res = await POST(
      makePostRequest({ intent_text: "   " }, TEST_PASSWORD)
    );
    expect(res.status).toBe(400);
  });

  it("trims whitespace from intent_text", async () => {
    const res = await POST(
      makePostRequest({ intent_text: "  show weather  " }, TEST_PASSWORD)
    );
    const json = await res.json();

    const { data } = await service
      .from("user_intents")
      .select("intent_text")
      .eq("id", json.id)
      .single();
    expect(data!.intent_text).toBe("show weather");
  });
});

// ---------------------------------------------------------
// GET /api/intent/[id]
// ---------------------------------------------------------
describe("GET /api/intent/[id]", () => {
  it("returns 401 without password", async () => {
    const res = await GET(makeGetRequest("some-id"), {
      params: Promise.resolve({ id: "some-id" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for nonexistent id", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000001";
    const res = await GET(makeGetRequest(fakeId, TEST_PASSWORD), {
      params: Promise.resolve({ id: fakeId }),
    });
    expect(res.status).toBe(404);
  });

  it("returns correct status for existing intent", async () => {
    // Create an intent via POST
    const postRes = await POST(
      makePostRequest({ intent_text: "test intent" }, TEST_PASSWORD)
    );
    const { id } = await postRes.json();

    // Poll status
    const res = await GET(makeGetRequest(id, TEST_PASSWORD), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.id).toBe(id);
    expect(json.status).toBe("pending");
  });

  it("reflects status changes", async () => {
    // Create an intent
    const postRes = await POST(
      makePostRequest({ intent_text: "test" }, TEST_PASSWORD)
    );
    const { id } = await postRes.json();

    // Simulate worker marking it as processing
    await service
      .from("user_intents")
      .update({ status: "processing" })
      .eq("id", id);

    const res = await GET(makeGetRequest(id, TEST_PASSWORD), {
      params: Promise.resolve({ id }),
    });
    const json = await res.json();
    expect(json.status).toBe("processing");
  });

  it("only returns id and status, not intent_text or errors", async () => {
    const postRes = await POST(
      makePostRequest({ intent_text: "secret intent" }, TEST_PASSWORD)
    );
    const { id } = await postRes.json();

    const res = await GET(makeGetRequest(id, TEST_PASSWORD), {
      params: Promise.resolve({ id }),
    });
    const json = await res.json();

    expect(Object.keys(json).sort()).toEqual(["id", "status"]);
  });
});
