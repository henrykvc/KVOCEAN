import type { SupabaseClient, User } from "@supabase/supabase-js";

export function normalizeEmail(email: string | null | undefined) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

export async function isActiveAllowedUser(supabase: SupabaseClient, email: string) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return false;
  }

  const { data, error } = await supabase
    .from("allowed_users")
    .select("email, is_active")
    .eq("email", normalizedEmail)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return Boolean(data?.is_active);
}

export async function getAllowedUser(supabase: SupabaseClient): Promise<User | null> {
  const {
    data: { user },
    error
  } = await supabase.auth.getUser();

  if (error || !user?.email) {
    return null;
  }

  return (await isActiveAllowedUser(supabase, user.email)) ? user : null;
}
