import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  const cookieStore = cookies();
  const savedToken = cookieStore.get("kvocean-google-token")?.value;

  return NextResponse.json({
    loggedIn: !!session,
    provider: session?.user?.app_metadata?.provider ?? null,
    hasSessionToken: !!session?.provider_token,
    hasCookieToken: !!savedToken,
    tokenPreview: savedToken ? savedToken.slice(0, 20) + "..." : null,
    sessionTokenPreview: session?.provider_token ? session.provider_token.slice(0, 20) + "..." : null,
  });
}
