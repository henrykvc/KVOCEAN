const DEFAULT_SUPABASE_URL = "https://vpyjnfxvacsurflsagdo.supabase.co";
const DEFAULT_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_zVMjxZOpKi9vH7BdCMge4A_f-am4pKW";

function requireEnv(primaryName: string, fallbackNames: string[] = [], defaultValue?: string) {
  const candidates = [primaryName, ...fallbackNames];

  for (const name of candidates) {
    const value = process.env[name];
    if (value) {
      return value;
    }
  }

  if (defaultValue) {
    return defaultValue;
  }

  throw new Error(`Missing required environment variable: ${primaryName}`);
}

export function getSupabaseUrl() {
  return requireEnv("NEXT_PUBLIC_SUPABASE_URL", ["SUPABASE_URL"], DEFAULT_SUPABASE_URL);
}

export function getSupabasePublishableKey() {
  return requireEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", [
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_ANON_KEY"
  ], DEFAULT_SUPABASE_PUBLISHABLE_KEY);
}
