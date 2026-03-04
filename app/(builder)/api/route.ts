import "@/data/global";
import { registerPageTypes } from "@/page-types";
import {
  ChaiActionsRegistry,
  initChaiBuilderActionHandler,
} from "@chaibuilder/next/actions";
import { revalidateTag } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/app/supabase-server";

registerPageTypes();

/**
 * A mode:
 * - Builder UI runs standalone
 * - Auth MUST come from platform Supabase cookies (shared on .pasadenagenerator.com)
 * - Data read/write will be proxied via Platform API (custom actions later)
 */

let actionsRegistered = false;
function ensureActionsRegistered() {
  if (actionsRegistered) return;

  // TODO next: register custom actions that talk to Platform API
  // ChaiActionsRegistry.registerActions(...)

  actionsRegistered = true;
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

    // cookie-based auth (shared domain)
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase.auth.getUser();
    const userId = data?.user?.id ?? null;

    if (error || !userId) {
      return NextResponse.json(
        { error: "Not authenticated (missing Supabase session cookie)" },
        { status: 401 },
      );
    }

    const handleAction = initChaiBuilderActionHandler({ apiKey, userId });
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