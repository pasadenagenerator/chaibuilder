import { createClient, SupabaseClient } from "@supabase/supabase-js";

let CLIENT_INSTANCE: SupabaseClient | null = null;

const checkForEnv = (envVar: string | undefined, name: string) => {
  if (!envVar) {
    throw new Error(`Environment variable ${name} is not set`);
  }
  return envVar;
};

function isDirectSupabaseAllowed(): boolean {
  return (
    process.env.NEXT_PUBLIC_CHAIBUILDER_ALLOW_DIRECT_SUPABASE === "true" ||
    process.env.CHAIBUILDER_ALLOW_DIRECT_SUPABASE === "true"
  );
}

export const getSupabaseClient = () => {
  if (!isDirectSupabaseAllowed()) {
    throw new Error(`Direct Supabase CLIENT access is disabled in this Builder deployment.
Use the GNR8 Platform API instead (Builder mode A).

If you *really* need direct access for local debugging, set:
  NEXT_PUBLIC_CHAIBUILDER_ALLOW_DIRECT_SUPABASE=true
and provide:
  NEXT_PUBLIC_SUPABASE_URL
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`);
  }

  checkForEnv(process.env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL");
  checkForEnv(
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY,
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY",
  );

  if (CLIENT_INSTANCE) {
    return CLIENT_INSTANCE;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const supabaseKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY || "";

  CLIENT_INSTANCE = createClient(supabaseUrl, supabaseKey, {
    realtime: { worker: true },
  });

  return CLIENT_INSTANCE;
};