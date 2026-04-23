import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { POST as POST_ACCESS } from "@/app/api/access/route";
import { POST as POST_INTENT } from "@/app/api/intent/route";
import { GET as GET_INTENT } from "@/app/api/intent/[id]/route";
import { ACCESS_COOKIE_NAME } from "@/lib/access-session";

const TEST_PASSWORD = "test-secret-123";
const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

let service: SupabaseClient;

beforeAll(() => {
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

function makeAccessRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost:3000/api/access", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function makeIntentPostRequest(
  body: Record<string, unknown>,
  cookie?: string
): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (cookie) {
    headers.cookie = cookie;
  }

  return new NextRequest("http://localhost:3000/api/intent", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function makeIntentGetRequest(id: string, cookie?: string): NextRequest {
  const headers: Record<string, string> = {};

  if (cookie) {
    headers.cookie = cookie;
  }

  return new NextRequest(`http://localhost:3000/api/intent/${id}`, {
    method: "GET",
    headers,
  });
}

async function createAccessCookie(): Promise<string> {
  const response = await POST_ACCESS(
    makeAccessRequest({ password: TEST_PASSWORD })
  );
  const setCookie = response.headers.get("set-cookie");

  expect(response.status).toBe(200);
  expect(setCookie).toContain(`${ACCESS_COOKIE_NAME}=`);

  return setCookie!.split(";")[0];
}

describe("POST /api/access", () => {
  it("returns 401 without password", async () => {
    const res = await POST_ACCESS(makeAccessRequest({}));
    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong password", async () => {
    const res = await POST_ACCESS(
      makeAccessRequest({ password: "wrong-password" })
    );
    expect(res.status).toBe(401);
  });

  it("returns 200 and sets an httpOnly session cookie with valid password", async () => {
    const res = await POST_ACCESS(
      makeAccessRequest({ password: TEST_PASSWORD })
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain(`${ACCESS_COOKIE_NAME}=`);
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
  });
});

describe("POST /api/intent", () => {
  it("returns 401 without access cookie", async () => {
    const res = await POST_INTENT(makeIntentPostRequest({ intent_text: "test" }));
    expect(res.status).toBe(401);
  });

  it("returns 200 with valid cookie and creates intent", async () => {
    const cookie = await createAccessCookie();

    const res = await POST_INTENT(
      makeIntentPostRequest({ intent_text: "show me AI trends" }, cookie)
    );
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.id).toBeDefined();
    expect(typeof json.id).toBe("string");

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
    const cookie = await createAccessCookie();
    const res = await POST_INTENT(
      makeIntentPostRequest({ intent_text: "" }, cookie)
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 with missing intent_text", async () => {
    const cookie = await createAccessCookie();
    const res = await POST_INTENT(makeIntentPostRequest({}, cookie));
    expect(res.status).toBe(400);
  });

  it("returns 400 with whitespace-only intent_text", async () => {
    const cookie = await createAccessCookie();
    const res = await POST_INTENT(
      makeIntentPostRequest({ intent_text: "   " }, cookie)
    );
    expect(res.status).toBe(400);
  });

  it("trims whitespace from intent_text", async () => {
    const cookie = await createAccessCookie();
    const res = await POST_INTENT(
      makeIntentPostRequest({ intent_text: "  show weather  " }, cookie)
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

describe("GET /api/intent/[id]", () => {
  it("returns 401 without access cookie", async () => {
    const res = await GET_INTENT(makeIntentGetRequest("some-id"), {
      params: Promise.resolve({ id: "some-id" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for nonexistent id", async () => {
    const cookie = await createAccessCookie();
    const fakeId = "00000000-0000-0000-0000-000000000001";

    const res = await GET_INTENT(makeIntentGetRequest(fakeId, cookie), {
      params: Promise.resolve({ id: fakeId }),
    });
    expect(res.status).toBe(404);
  });

  it("returns correct status for existing intent", async () => {
    const cookie = await createAccessCookie();
    const postRes = await POST_INTENT(
      makeIntentPostRequest({ intent_text: "test intent" }, cookie)
    );
    const { id } = await postRes.json();

    const res = await GET_INTENT(makeIntentGetRequest(id, cookie), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.id).toBe(id);
    expect(json.status).toBe("pending");
  });

  it("reflects status changes", async () => {
    const cookie = await createAccessCookie();
    const postRes = await POST_INTENT(
      makeIntentPostRequest({ intent_text: "test" }, cookie)
    );
    const { id } = await postRes.json();

    await service
      .from("user_intents")
      .update({ status: "processing" })
      .eq("id", id);

    const res = await GET_INTENT(makeIntentGetRequest(id, cookie), {
      params: Promise.resolve({ id }),
    });
    const json = await res.json();
    expect(json.status).toBe("processing");
  });

  it("only returns id and status, not intent_text or errors", async () => {
    const cookie = await createAccessCookie();
    const postRes = await POST_INTENT(
      makeIntentPostRequest({ intent_text: "secret intent" }, cookie)
    );
    const { id } = await postRes.json();

    const res = await GET_INTENT(makeIntentGetRequest(id, cookie), {
      params: Promise.resolve({ id }),
    });
    const json = await res.json();

    expect(Object.keys(json).sort()).toEqual(["id", "status"]);
  });
});
