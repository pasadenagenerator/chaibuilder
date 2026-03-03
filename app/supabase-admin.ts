import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Builder mode A (recommended):
 * - ChaiBuilder is UI-only
 * - All data access MUST go through the Platform API (GNR8)
 * - Direct Supabase access is disabled by default
 *
 * To temporarily allow direct Supabase access (local debugging only), set:
 *   CHAIBUILDER_ALLOW_DIRECT_SUPABASE=true
 * and provide the required env vars.
 */

let ADMIN_INSTANCE: SupabaseClient | null = null;

function isDirectSupabaseAllowed(): boolean {
  const v = process.env.CHAIBUILDER_ALLOW_DIRECT_SUPABASE;
  return v === "true" || v === "1" || v === "yes";
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Environment variable ${name} is not set`);
  return v;
}

export const getSupabaseAdmin = (): SupabaseClient => {
  if (!isDirectSupabaseAllowed()) {
    throw new Error(
      [
        "Direct Supabase ADMIN access is disabled in this Builder deployment.",
        "Use the GNR8 Platform API instead (Builder mode A).",
        "",
        "If you *really* need direct access for local debugging, set:",
        "  CHAIBUILDER_ALLOW_DIRECT_SUPABASE=true",
        "and provide:",
        "  NEXT_PUBLIC_SUPABASE_URL",
        "  SUPABASE_SECRET_KEY",
      ].join("\n"),
    );
  }

  if (ADMIN_INSTANCE) return ADMIN_INSTANCE;

  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const supabaseKey = requireEnv("SUPABASE_SECRET_KEY");

  ADMIN_INSTANCE = createClient(supabaseUrl, supabaseKey);
  return ADMIN_INSTANCE;
};