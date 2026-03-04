import "@/data/global";
import { registerPageTypes } from "@/page-types";
import {
  ChaiActionsRegistry,
  initChaiBuilderActionHandler,
} from "@chaibuilder/next/actions";
import { createClient } from "@supabase/supabase-js";
import { revalidateTag } from "next/cache";
import { NextRequest, NextResponse } from "next/server";

registerPageTypes();

/**
 * "A mode":
 * - Builder is UI-only.
 * - Auth: Supabase access token (Bearer) ONLY to identify user.
 * - Data read/write: proxy through GNR8 Platform API via custom actions (next step).
 */

let actionsRegistered = false;
function ensureActionsRegistered() {
  if (actionsRegistered) return;

  // TODO (next step):
  // Register custom actions that proxy to your GNR8 Platform API.
  //
  // Example (pseudo):
  // ChaiActionsRegistry.registerActions(PlatformActions({ baseUrl: ..., internalKey: ... }))

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

function getRequiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

async function getUserIdFromBearer(req: NextRequest): Promise<string | null> {
  const token = getBearerToken(req);
  if (!token) return null;

  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_URL ||
    "";

  // Prefer the key you already use in this repo (publishable default),
  // but allow NEXT_PUBLIC_SUPABASE_ANON_KEY as alias.
  const supabaseAnonKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "";

  if (!supabaseUrl) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  }
  if (!supabaseAnonKey) {
    throw new Error(
      "Missing Supabase publishable key: set NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY)",
    );
  }

  // NOTE: We create a fresh client per request to avoid any cross-request state issues in serverless.
  const supabase = createClient(supabaseUrl, supabaseAnonKey);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user?.id) return null;

  return data.user.id;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unstringifiable]";
  }
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = getRequiredEnv("CHAIBUILDER_APP_KEY");

    ensureActionsRegistered();

    // Parse body early (Chai sends JSON actions envelope)
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // --- DEBUG LOGS (safe, no tokens) ---
    console.log(
      "CHAIBUILDER /api request:",
      safeJsonStringify({
        hasAuthHeader: Boolean(req.headers.get("authorization")),
        bodyKeys: Object.keys(body as Record<string, unknown>),
        action: (body as any)?.action ?? null,
      }),
    );

    // Auth: require Bearer token so we can reliably identify the user
    const userId = await getUserIdFromBearer(req);
    if (!userId) {
      return NextResponse.json(
        { error: "Not authenticated (missing/invalid Bearer token)" },
        { status: 401 },
      );
    }

    const handleAction = initChaiBuilderActionHandler({
      apiKey,
      userId,
    });

    const response: any = await handleAction(body);

    console.log(
      "CHAIBUILDER /api response:",
      safeJsonStringify({
        status: response?.status ?? 200,
        code: response?.code ?? null,
        error: response?.error ?? null,
        hasTags: Array.isArray(response?.tags),
      }),
    );

    // Cache tags revalidation (kept from original)
    if (
      response &&
      typeof response === "object" &&
      "tags" in response &&
      Array.isArray(response.tags)
    ) {
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
          } catch (e) {
            controller.error(e);
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
    console.error("CHAIBUILDER /api fatal:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
