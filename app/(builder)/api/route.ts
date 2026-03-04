import "@/data/global";
import { registerPageTypes } from "@/page-types";
import {
  ChaiActionsRegistry,
  initChaiBuilderActionHandler,
} from "@chaibuilder/next/actions";
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
 * - Data read/write will be proxied via Platform API (custom actions later)
 */

let actionsRegistered = false;
function ensureActionsRegistered() {
  if (actionsRegistered) return;

  // TODO next: register custom actions that talk to Platform API
  // ChaiActionsRegistry.registerActions(...)

  actionsRegistered = true;
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

async function getUserIdFromCookieOrBearer(req: NextRequest): Promise<{
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

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.CHAIBUILDER_APP_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Server misconfiguration: CHAIBUILDER_APP_KEY is not set" },
        { status: 500 },
      );
    }

    ensureActionsRegistered();

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // mini ping (for smoke test)
    if ((body as any).action === "ping") {
      const auth = await getUserIdFromCookieOrBearer(req);
      if (!auth.userId) {
        return NextResponse.json({ error: auth.error ?? "Not authenticated" }, { status: 401 });
      }
      return NextResponse.json({ ok: true, userId: auth.userId, mode: auth.mode });
    }

    const auth = await getUserIdFromCookieOrBearer(req);
    if (!auth.userId) {
      return NextResponse.json({ error: auth.error ?? "Not authenticated" }, { status: 401 });
    }

    const handleAction = initChaiBuilderActionHandler({ apiKey, userId: auth.userId });
    const response: any = await handleAction(body);

    if (
      response &&
      typeof response === "object" &&
      "tags" in response &&
      Array.isArray(response.tags)
    ) {
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