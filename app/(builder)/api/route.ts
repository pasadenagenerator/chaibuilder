// app/(builder)/api/route.ts

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
 * - Auth SHOULD come from platform Supabase cookies (shared on .pasadenagenerator.com)
 * - Data read/write will be proxied via Platform API (custom actions later)
 *
 * For robustness / debugging we also allow Bearer token fallback.
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

async function getUserIdFromBearer(req: NextRequest): Promise<string | null> {
  const token = getBearerToken(req);
  if (!token) return null;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const supabaseAnon =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY ||
    "";

  if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  if (!supabaseAnon) {
    throw new Error(
      "Missing anon key: set NEXT_PUBLIC_SUPABASE_ANON_KEY (or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY)",
    );
  }

  const supabase = createClient(supabaseUrl, supabaseAnon);
  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user?.id) return null;
  return data.user.id;
}

async function resolveUserId(req: NextRequest): Promise<{
  userId: string | null;
  source: "cookie" | "bearer" | null;
  details?: string;
}> {
  // 1) cookie-based auth
  try {
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase.auth.getUser();
    if (!error && data?.user?.id) {
      return { userId: data.user.id, source: "cookie" };
    }
  } catch (e) {
    // ignore and try bearer
  }

  // 2) bearer fallback
  try {
    const userId = await getUserIdFromBearer(req);
    if (userId) return { userId, source: "bearer" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { userId: null, source: null, details: msg };
  }

  return { userId: null, source: null };
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

    // easy sanity check (works even before Chai actions are wired)
    if ((body as any)?.action === "ping") {
      const auth = await resolveUserId(req);
      return NextResponse.json(
        {
          ok: true,
          pong: true,
          auth: {
            userId: auth.userId,
            source: auth.source,
            details: auth.details ?? null,
          },
        },
        { status: auth.userId ? 200 : 401 },
      );
    }

    // real auth (must have user)
    const auth = await resolveUserId(req);
    if (!auth.userId) {
      return NextResponse.json(
        {
          error:
            "Not authenticated. Missing Supabase session cookie AND missing/invalid Bearer token.",
          details: auth.details ?? null,
        },
        { status: 401 },
      );
    }

    const handleAction = initChaiBuilderActionHandler({
      apiKey,
      userId: auth.userId,
    });

    const response: any = await handleAction(body);

    // cache tags revalidation
    if (
      response &&
      typeof response === "object" &&
      "tags" in response &&
      Array.isArray(response.tags)
    ) {
      response.tags.forEach((tag: string) => revalidateTag(tag, "max"));
    }

    // streaming responses
    if (response?._streamingResponse && response?._streamResult) {
      const result = response._streamResult;
      if (!result?.textStream) {
        return NextResponse.json(
          { error: "No streaming response available" },
          { status: 500 },
        );
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