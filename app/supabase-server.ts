// app/supabase-server.ts
import { cookies, headers } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

type CookieToSet = {
  name: string;
  value: string;
  options: CookieOptions;
};

function parseHost(raw: string): string {
  return (raw ?? "").split(",")[0]?.trim() ?? "";
}

async function getHost(): Promise<string> {
  const h = await headers();
  const xf = h.get("x-forwarded-host");
  return parseHost(xf ?? h.get("host") ?? "");
}

function withSharedDomain(options: CookieOptions, host: string): CookieOptions {
  const normalizedHost = (host.split(":")[0] ?? "").trim();

  const isLocal =
    normalizedHost === "localhost" ||
    normalizedHost === "127.0.0.1" ||
    normalizedHost.endsWith(".localhost");

  const isPasadena =
    normalizedHost === "pasadenagenerator.com" ||
    normalizedHost.endsWith(".pasadenagenerator.com");

  if (isLocal || !isPasadena) return options;

  return { ...options, domain: ".pasadenagenerator.com" };
}

export async function getSupabaseServerClient() {
  const cookieStore = await cookies();
  const host = await getHost();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnon =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  if (!supabaseAnon)
    throw new Error(
      "Missing anon key: set NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY)",
    );

  return createServerClient(supabaseUrl, supabaseAnon, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        cookiesToSet.forEach(({ name, value, options }) => {
          cookieStore.set(name, value, withSharedDomain(options, host));
        });
      },
    },
  });
}