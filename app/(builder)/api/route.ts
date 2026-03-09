import "@/data/global";
import { registerPageTypes } from "@gnr8/chai-renderer";
import { initChaiBuilderActionHandler } from "@chaibuilder/next/actions";
import { revalidateTag } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/app/supabase-server";
import { createClient } from "@supabase/supabase-js";

registerPageTypes();

type PlatformPage = {
  id: string;
  orgId: string;
  slug: string;
  title: string | null;
  data: any;
  createdAt?: string;
  updatedAt?: string;
};

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

  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
    return parts[1];
  }

  return "";
}

function getAction(req: NextRequest, body: any): string {
  const bodyAction = typeof body?.action === "string" ? body.action.trim() : "";
  const queryAction = req.nextUrl.searchParams.get("action")?.trim() || "";
  return bodyAction || queryAction;
}

function getActionUpper(req: NextRequest, body: any): string {
  return getAction(req, body).toUpperCase();
}

function getOrgIdFromBody(body: any): string {
  const org =
    body?.orgId ??
    body?.organizationId ??
    body?.org_id ??
    body?.org ??
    process.env.NEXT_PUBLIC_DEFAULT_ORG_ID;

  return org ? String(org).trim() : "";
}

function getBuilderPageIdFromBody(body: any): string {
  const id =
    body?.id ??
    body?.pageId ??
    body?.data?.id ??
    body?.page?.id ??
    body?.pageData?.id ??
    "";

  return id ? String(id).trim() : "";
}

function getSlugFromBody(body: any): string {
  const raw = String(
    body?.slug ??
      body?.path ??
      body?.pageSlug ??
      body?.page_path ??
      body?.data?.slug ??
      "/",
  ).trim();

  if (!raw) return "/";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function getTitleFromBody(body: any): string | null {
  const value =
    body?.title ??
    body?.name ??
    body?.pageTitle ??
    body?.data?.title ??
    body?.data?.name ??
    null;

  if (value === null || value === undefined) return null;
  return String(value);
}

function getDataFromBody(body: any): any {
  return body?.data ?? body?.page ?? body?.pageData ?? body?.payload ?? null;
}

function normalizePageData(data: any): any {
  const d = data && typeof data === "object" ? data : {};
  return {
    ...d,
    id: d.id ?? crypto.randomUUID(),
    pageType: d.pageType ?? "page",
    lang: d.lang ?? "en",
    fallbackLang: d.fallbackLang ?? "en",
    blocks: Array.isArray(d.blocks) ? d.blocks : [],
  };
}

function makeChaiPageResponse(page: PlatformPage) {
  const data = normalizePageData(page.data);

  return {
    ok: true,
    success: true,

    // najbolj očiten shape
    page: {
      ...page,
      data,
    },

    // kompatibilnostni top-level fieldi
    data,
    id: data.id,
    pageId: data.id,
    slug: page.slug,
    path: page.slug,
    name: page.title ?? "Untitled",
    title: page.title ?? "Untitled",
    pageType: data.pageType ?? "page",
    lang: data.lang ?? "en",
    fallbackLang: data.fallbackLang ?? "en",
    blocks: Array.isArray(data.blocks) ? data.blocks : [],

    createdAt: page.createdAt ?? null,
    updatedAt: page.updatedAt ?? null,
  };
}

async function getUserIdFromCookieOrBearer(
  req: NextRequest,
): Promise<{
  userId: string | null;
  mode: "cookie" | "bearer" | null;
  error?: string;
}> {
  const supabaseCookie = await getSupabaseServerClient();
  const cookieRes = await supabaseCookie.auth.getUser();
  const cookieUserId = cookieRes.data?.user?.id ?? null;

  if (!cookieRes.error && cookieUserId) {
    return { userId: cookieUserId, mode: "cookie" };
  }

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
    return {
      userId: null,
      mode: null,
      error: "NEXT_PUBLIC_SUPABASE_URL is not set",
    };
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

async function listPages(orgId: string, actorUserId: string): Promise<PlatformPage[]> {
  const r = await platformFetch<{ pages: PlatformPage[] }>(
    `/api/builder/orgs/${orgId}/pages`,
    { actorUserId },
  );

  if (r.status < 200 || r.status >= 300) {
    return [];
  }

  return Array.isArray(r.body?.pages) ? r.body.pages : [];
}

async function resolveExistingPage(
  orgId: string,
  actorUserId: string,
  body: any,
): Promise<PlatformPage | null> {
  const builderPageId = getBuilderPageIdFromBody(body);
  const wantedSlug = getSlugFromBody(body);

  const pages = await listPages(orgId, actorUserId);

  if (builderPageId) {
    const byBuilderId = pages.find(
      (p) => String(p?.data?.id ?? "").trim() === builderPageId,
    );
    if (byBuilderId) return byBuilderId;
  }

  if (wantedSlug) {
    const bySlug = pages.find((p) => p.slug === wantedSlug);
    if (bySlug) return bySlug;
  }

  return null;
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
      return NextResponse.json(
        { error: auth.error ?? "Not authenticated" },
        { status: 401 },
      );
    }

    const action = getAction(req, body);
    const actionUpper = getActionUpper(req, body);

    if (actionUpper === "PING") {
      return NextResponse.json({
        ok: true,
        userId: auth.userId,
        mode: auth.mode,
      });
    }

    if (actionUpper === "CHECK_USER_ACCESS") {
      return NextResponse.json(
        {
          ok: true,
          success: true,
          allowed: true,
          hasAccess: true,
          authorized: true,
          userId: auth.userId,
          role: "admin",
        },
        { status: 200 },
      );
    }

    if (action === "platform.pages.list") {
      const orgId = getOrgIdFromBody(body);

      if (!orgId) {
        return NextResponse.json({ error: "orgId is required" }, { status: 400 });
      }

      const r = await platformFetch<{ pages: PlatformPage[] }>(
        `/api/builder/orgs/${orgId}/pages`,
        {
          actorUserId: auth.userId,
        },
      );

      return NextResponse.json(r.body, { status: r.status });
    }

    if (action === "platform.pages.get") {
      const orgId = getOrgIdFromBody(body);
      const slug = getSlugFromBody(body);

      if (!orgId) {
        return NextResponse.json({ error: "orgId is required" }, { status: 400 });
      }

      const r = await platformFetch<{ page: PlatformPage }>(
        `/api/builder/orgs/${orgId}/pages/${encodeURIComponent(slug)}`,
        {
          actorUserId: auth.userId,
        },
      );

      return NextResponse.json(r.body, { status: r.status });
    }

    if (action === "platform.pages.upsert") {
      const orgId = getOrgIdFromBody(body);
      const slug = getSlugFromBody(body);
      const title = getTitleFromBody(body);
      const data = getDataFromBody(body);

      if (!orgId) {
        return NextResponse.json({ error: "orgId is required" }, { status: 400 });
      }

      if (!slug) {
        return NextResponse.json({ error: "slug is required" }, { status: 400 });
      }

      if (data === null || data === undefined) {
        return NextResponse.json({ error: "data is required" }, { status: 400 });
      }

      const normalizedData = normalizePageData(data);

      const r = await platformFetch<{ page: PlatformPage }>(
        `/api/builder/orgs/${orgId}/pages`,
        {
          actorUserId: auth.userId,
          method: "POST",
          body: { slug, title, data: normalizedData },
        },
      );

      return NextResponse.json(r.body, { status: r.status });
    }

    if (actionUpper === "GET_PAGE") {
      const orgId = getOrgIdFromBody(body);
      if (!orgId) {
        return NextResponse.json({ error: "orgId is required" }, { status: 400 });
      }

      const existing = await resolveExistingPage(orgId, auth.userId, body);

      if (!existing) {
        return NextResponse.json({ error: "Page not found" }, { status: 404 });
      }

      return NextResponse.json(makeChaiPageResponse(existing), { status: 200 });
    }

    if (actionUpper === "UPDATE_PAGE") {
      const orgId = getOrgIdFromBody(body);
      if (!orgId) {
        return NextResponse.json({ error: "orgId is required" }, { status: 400 });
      }

      const existing = await resolveExistingPage(orgId, auth.userId, body);
      const incomingData = getDataFromBody(body);

      if (incomingData === null || incomingData === undefined) {
        return NextResponse.json({ error: "data is required" }, { status: 400 });
      }

      const normalizedData = normalizePageData(incomingData);
      const slug = existing?.slug ?? getSlugFromBody(body);
      const title = getTitleFromBody(body) ?? existing?.title ?? "Untitled";

      const r = await platformFetch<{ page: PlatformPage }>(
        `/api/builder/orgs/${orgId}/pages`,
        {
          actorUserId: auth.userId,
          method: "POST",
          body: { slug, title, data: normalizedData },
        },
      );

      const page = (r.body as any)?.page ?? null;

      if (!page) {
        return NextResponse.json(
          { error: "Failed to save page" },
          { status: r.status || 500 },
        );
      }

      return NextResponse.json(makeChaiPageResponse(page), { status: r.status });
    }

    if (actionUpper === "CREATE_PAGE") {
      const orgId = getOrgIdFromBody(body);
      if (!orgId) {
        return NextResponse.json({ error: "orgId is required" }, { status: 400 });
      }

      const slug = getSlugFromBody(body);
      const title = getTitleFromBody(body) ?? "Untitled";
      const incomingData = getDataFromBody(body) ?? {};

      const normalizedData = normalizePageData({
        ...incomingData,
        slug,
        title,
      });

      const r = await platformFetch<{ page: PlatformPage }>(
        `/api/builder/orgs/${orgId}/pages`,
        {
          actorUserId: auth.userId,
          method: "POST",
          body: { slug, title, data: normalizedData },
        },
      );

      const page = (r.body as any)?.page ?? null;

      if (!page) {
        return NextResponse.json(
          { error: "Failed to create page" },
          { status: r.status || 500 },
        );
      }

      return NextResponse.json(makeChaiPageResponse(page), { status: r.status });
    }

    if (actionUpper === "PUBLISH_CHANGES") {
      return NextResponse.json(
        {
          ok: true,
          success: true,
          published: true,
          ids: body?.data?.ids ?? [],
          revisions: body?.data?.revisions ?? false,
        },
        { status: 200 },
      );
    }

    const handleAction = initChaiBuilderActionHandler({
      apiKey,
      userId: auth.userId,
    });

    const response: any = await handleAction(body);

    if (response && typeof response === "object" && Array.isArray(response.tags)) {
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
              if (chunk) {
                controller.enqueue(encoder.encode(chunk));
              }
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