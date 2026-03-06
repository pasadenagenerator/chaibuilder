import "@/data/global";
import { registerPageTypes } from "@gnr8/chai-renderer";
import { initChaiBuilderActionHandler } from "@chaibuilder/next/actions";
import { revalidateTag } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/app/supabase-server";
import { createClient } from "@supabase/supabase-js";

registerPageTypes();

/**
 * A mode:
 * - Builder UI runs standalone
 * - Auth primarily via platform Supabase cookies (shared on .pasadenagenerator.com)
 * - Fallback auth via Authorization: Bearer <access_token> (useful for debugging)
 * - Data read/write goes through Platform API (custom proxy actions)
 */

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function getBearerToken(req: NextRequest): string {
  const authorization = req.headers.get("authorization") || "";
  const parts = authorization
    .split(" ")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") return parts[1];
  return "";
}

async function getUserIdFromCookieOrBearer(
  req: NextRequest,
): Promise<{
  userId: string | null;
  mode: "cookie" | "bearer" | null;
  error?: string;
}> {
  // 1) cookie-based session (preferred)
  const supabaseCookie = await getSupabaseServerClient();
  const cookieRes = await supabaseCookie.auth.getUser();
  const cookieUserId = cookieRes.data?.user?.id ?? null;
  if (!cookieRes.error && cookieUserId) {
    return { userId: cookieUserId, mode: "cookie" };
  }

  // 2) bearer fallback
  const token = getBearerToken(req);
  if (!token) {
    return {
      userId: null,
      mode: null,
      error: "Missing Supabase session cookie AND missing/invalid Bearer token",
    };
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const supabaseAnon =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "";

  if (!supabaseUrl) {
    return { userId: null, mode: null, error: "NEXT_PUBLIC_SUPABASE_URL is not set" };
  }
  if (!supabaseAnon) {
    return {
      userId: null,
      mode: null,
      error:
        "Missing anon key: set NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY)",
    };
  }

  const supabaseBearer = createClient(supabaseUrl, supabaseAnon);
  const bearerRes = await supabaseBearer.auth.getUser(token);
  const bearerUserId = bearerRes.data?.user?.id ?? null;

  if (bearerRes.error || !bearerUserId) {
    return {
      userId: null,
      mode: null,
      error:
        "Bearer token invalid for this Supabase project (check NEXT_PUBLIC_SUPABASE_URL/ANON key match the token issuer)",
    };
  }

  return { userId: bearerUserId, mode: "bearer" };
}

async function platformFetch<T>(
  path: string,
  input: { actorUserId: string; method?: string; body?: any },
): Promise<{ status: number; body: T }> {
  const baseUrl = getEnv("PLATFORM_API_BASE_URL").replace(/\/+$/, "");
  const internalKey = getEnv("PLATFORM_INTERNAL_API_KEY");

  const res = await fetch(`${baseUrl}${path}`, {
    method: input.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-gnr8-internal-key": internalKey,
      "x-actor-user-id": input.actorUserId,
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }

  return { status: res.status, body: json as T };
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.CHAIBUILDER_APP_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Server misconfiguration: CHAIBUILDER_APP_KEY is not set" },
        { status: 500 },
      );
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const auth = await getUserIdFromCookieOrBearer(req);
    if (!auth.userId) {
      return NextResponse.json({ error: auth.error ?? "Not authenticated" }, { status: 401 });
    }

    // Smoke test
    if ((body as any).action === "ping") {
      return NextResponse.json({ ok: true, userId: auth.userId, mode: auth.mode });
    }

    // ---- Platform Pages proxy actions (our integration point) ----
    if ((body as any).action === "platform.pages.list") {
      const orgId = String((body as any).orgId ?? "").trim();
      if (!orgId) return NextResponse.json({ error: "orgId is required" }, { status: 400 });

      const r = await platformFetch<{ pages: any[] }>(`/api/builder/orgs/${orgId}/pages`, {
        actorUserId: auth.userId,
      });

      return NextResponse.json(r.body, { status: r.status });
    }

    if ((body as any).action === "platform.pages.upsert") {
      const orgId = String((body as any).orgId ?? "").trim();
      const slug = String((body as any).slug ?? "").trim();
      const title = (body as any).title ?? null;
      const data = (body as any).data ?? null;

      if (!orgId) return NextResponse.json({ error: "orgId is required" }, { status: 400 });
      if (!slug) return NextResponse.json({ error: "slug is required" }, { status: 400 });
      if (data === null || data === undefined)
        return NextResponse.json({ error: "data is required" }, { status: 400 });

      const r = await platformFetch<{ page: any }>(`/api/builder/orgs/${orgId}/pages`, {
        actorUserId: auth.userId,
        method: "POST",
        body: { slug, title, data },
      });

      return NextResponse.json(r.body, { status: r.status });
    }

    // ---- Fallback: let Chai handle its own actions ----
    const handleAction = initChaiBuilderActionHandler({ apiKey, userId: auth.userId });
    const response: any = await handleAction(body);

    if (response && typeof response === "object" && Array.isArray(response.tags)) {
      response.tags.forEach((tag: string) => revalidateTag(tag, "max"));
    }

    if (response?._streamingResponse && response?._streamResult) {
      const result = response._streamResult;
      if (!result?.textStream) {
        return NextResponse.json({ error: "No streaming response available" }, { status: 500 });
      }

      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          try {
            for await (const chunk of result.textStream) {
              if (chunk) controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
          } catch (err) {
            controller.error(err);
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    }

    return NextResponse.json(response, { status: response?.status ?? 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}