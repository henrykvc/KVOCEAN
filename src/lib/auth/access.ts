import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { getAllowedEmailDomains, getAllowedEmailList } from "@/lib/supabase/env";

function isEmailAllowedByEnv(email: string | null | undefined) {
  const normalizedEmail = email?.trim().toLowerCase() ?? "";
  if (!normalizedEmail) {
    return false;
  }

  const explicitAllowList = new Set(getAllowedEmailList());
  if (explicitAllowList.size > 0) {
    return explicitAllowList.has(normalizedEmail);
  }

  const allowedDomains = getAllowedEmailDomains();
  if (!allowedDomains.length) {
    return true;
  }

  const domain = normalizedEmail.split("@")[1] ?? "";
  return allowedDomains.includes(domain);
}

export async function isEmailAllowed(email: string | null | undefined) {
  const normalizedEmail = email?.trim().toLowerCase() ?? "";
  if (!normalizedEmail) {
    return false;
  }

  const adminClient = createAdminClient();
  if (!adminClient) {
    return isEmailAllowedByEnv(normalizedEmail);
  }

  const { data, error } = await adminClient
    .from("allowed_users")
    .select("email, is_active")
    .eq("email", normalizedEmail)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    return false;
  }

  return Boolean(data);
}

export async function isAdminEmail(email: string | null | undefined) {
  const normalizedEmail = email?.trim().toLowerCase() ?? "";
  if (!normalizedEmail) {
    return false;
  }

  const adminClient = createAdminClient();
  if (!adminClient) {
    return false;
  }

  const { data, error } = await adminClient
    .from("admin_users")
    .select("email, is_active")
    .eq("email", normalizedEmail)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    return false;
  }

  return Boolean(data);
}
