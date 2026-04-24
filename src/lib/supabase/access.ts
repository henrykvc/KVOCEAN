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

export async function isActiveAdminUser(supabase: SupabaseClient, email: string) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return false;

  const { data, error } = await supabase
    .from("admin_users")
    .select("email, is_active")
    .eq("email", normalizedEmail)
    .maybeSingle();

  if (error) throw error;
  return Boolean(data?.is_active);
}

export type UserRole = "creator" | "admin" | "manager";

export const CREATOR_EMAIL = "henry@kakaoventures.co.kr";

export async function getUserRole(supabase: SupabaseClient, email: string): Promise<UserRole> {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return "manager";

  // Creator is hardcoded — DB state doesn't affect this
  if (normalizedEmail === CREATOR_EMAIL) return "creator";

  const { data } = await supabase
    .from("allowed_users")
    .select("role")
    .eq("email", normalizedEmail)
    .maybeSingle();

  const role = data?.role as UserRole | undefined;
  if (role === "creator" || role === "admin" || role === "manager") return role;
  return "manager";
}
