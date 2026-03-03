import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Builder mode A (recommended):
 * - ChaiBuilder is UI-only
 * - All data access MUST go through the Platform API (GNR8)
 * - Direct Supabase client access is disabled by default
 *
 * To temporarily allow direct Supabase access (local debugging only), set:
 *   CHAIBUILDER_ALLOW_DIRECT_SUPABASE=true
 * and provide the required env vars.
 */

let CLIENT_INSTANCE: SupabaseClient | null = null;

function isDirectSupabaseAllowed(): boolean {
  const v = process.env.CHAIBUILDER_ALLOW_DIRECT_SUPABASE;
  return v === "true" || v === "1" || v === "yes";
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Environment variable ${name} is not set`);
  return v;
}

export const getSupabaseClient = (): SupabaseClient => {
  if (!isDirectSupabaseAllowed()) {
    throw new Error(
      [
        "Direct Supabase CLIENT access is disabled in this Builder deployment.",
        "Use the GNR8 Platform API instead (Builder mode A).",
        "",
        "If you *really* need direct access for local debugging, set:",
        "  CHAIBUILDER_ALLOW_DIRECT_SUPABASE=true",
        "and provide:",
        "  NEXT_PUBLIC_SUPABASE_URL",
        "  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY",
      ].join("\n"),
    );
  }

  if (CLIENT_INSTANCE) return CLIENT_INSTANCE;

  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const supabaseKey = requireEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY");

  CLIENT_INSTANCE = createClient(supabaseUrl, supabaseKey, {
    realtime: { worker: true },
  });

  return CLIENT_INSTANCE;
};