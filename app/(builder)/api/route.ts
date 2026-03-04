import "@/data/global";
import { registerPageTypes } from "@/page-types";
import { ChaiActionsRegistry, initChaiBuilderActionHandler } from "@chaibuilder/next/actions";
import { createClient } from "@supabase/supabase-js";
import { revalidateTag } from "next/cache";
import { NextRequest, NextResponse } from "next/server";

registerPageTypes();

/**
 * A-mode:
 * - No Supabase service-role usage here
 * - We only validate Supabase Bearer token to identify userId
 * - Real data read/write will be proxied to GNR8 Platform API (next step)
 */

let actionsRegistered = false;
function ensureActionsRegistered() {
  if (actionsRegistered) return;

  // TODO (next step):
  // Register custom actions that proxy to GNR8 Platform API.

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

function getSupabaseAnonKey(): string {
  // support both naming conventions (your builder repo uses PUBLISHABLE_DEFAULT_KEY)
  return (
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY ||
    ""
  );
}

async function getUserIdFromBearer(req: NextRequest): Promise<string | null> {
  const token = getBearerToken(req);
  if (!token) return null;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const supabaseAnonKey = getSupabaseAnonKey();

  if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  if (!supabaseAnonKey) {
    throw new Error(
      "Missing Supabase anon key: set NEXT_PUBLIC_SUPABASE_ANON_KEY or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY",
    );
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user?.id) return null;

  return data.user.id;
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

    // Parse JSON body
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // Auth: require Bearer so we can reliably identify the user
    const userId = await getUserIdFromBearer(req);
    if (!userId) {
      return NextResponse.json(
        { error: "Not authenticated (missing/invalid Bearer token)" },
        { status: 401 },
      );
    }

    // Minimal smoke-test action (so you can verify /api works end-to-end)
    // This intentionally bypasses Chai action registry.
    if ((body as any).action === "ping") {
      return NextResponse.json(
        { ok: true, action: "ping", userId },
        { status: 200 },
      );
    }

    // For real builder actions:
    ensureActionsRegistered();

    const handleAction = initChaiBuilderActionHandler({
      apiKey,
      userId,
    });

    const response: any = await handleAction(body);

    // cache tags revalidation (kept from original)
    if (response && typeof response === "object" && Array.isArray(response.tags)) {
      response.tags.forEach((tag: string) => {
        revalidateTag(tag, "max");
      });
    }

    // Streaming responses (kept from original)
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
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}