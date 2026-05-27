"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/browser";

type LoginFormProps = {
  nextPath?: string;
  errorCode?: string;
};

const ERROR_MESSAGES: Record<string, string> = {
  callback: "로그인 세션을 확인하지 못했습니다. 다시 시도해 주세요.",
  missing_code: "로그인 링크가 올바르지 않습니다. 다시 시도해 주세요.",
  not_allowed: "허용된 계정이 아닙니다."
};

export function LoginForm({ nextPath = "/", errorCode }: LoginFormProps) {
  const [status, setStatus] = useState<"idle" | "submitting" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  // 미승인 케이스: 콜백이 세션을 살려둔 상태 → email을 클라이언트에서 조회.
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [requestStatus, setRequestStatus] = useState<"idle" | "submitting" | "sent" | "error">("idle");
  const [requestMessage, setRequestMessage] = useState<string | null>(null);

  useEffect(() => {
    if (errorCode !== "not_allowed") return;
    let cancelled = false;
    (async () => {
      try {
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (cancelled) return;
        if (user?.email) {
          setPendingEmail(user.email);
          const meta = user.user_metadata as Record<string, unknown> | undefined;
          const name = (meta?.full_name as string | undefined) ?? (meta?.name as string | undefined) ?? null;
          setPendingName(name);
        }
      } catch {
        /* swallow — pending email은 없으면 그냥 안 보임 */
      }
    })();
    return () => { cancelled = true; };
  }, [errorCode]);

  const errorMessage = errorCode ? (ERROR_MESSAGES[errorCode] ?? "로그인 중 오류가 발생했습니다. 다시 시도해 주세요.") : null;

  async function handleGoogleLogin() {
    setStatus("submitting");
    setMessage(null);

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextPath)}`
        }
      });

      if (error) throw error;
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "로그인에 실패했습니다.");
    }
  }

  async function handleAccessRequest(event: React.FormEvent) {
    event.preventDefault();
    setRequestStatus("submitting");
    setRequestMessage(null);

    try {
      const res = await fetch("/api/access-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() || null })
      });
      const json = await res.json() as { ok?: boolean; alreadyAllowed?: boolean; error?: string };
      if (!res.ok) {
        setRequestStatus("error");
        setRequestMessage(json.error ?? "요청 제출에 실패했습니다.");
        return;
      }
      if (json.alreadyAllowed) {
        setRequestMessage("이미 승인된 계정입니다. 다시 로그인해 주세요.");
      }
      setRequestStatus("sent");
    } catch (error) {
      setRequestStatus("error");
      setRequestMessage(error instanceof Error ? error.message : "요청 제출에 실패했습니다.");
    }
  }

  return (
    <div className="auth-card">
      <div className="auth-copy">
        <span className="auth-eyebrow">Protected Workspace</span>
        <h1>KV OCEAN 로그인</h1>
        <p>승인된 구글 계정으로만 로그인할 수 있습니다.</p>
      </div>

      <div className="auth-form">
        <button
          className="button auth-submit"
          onClick={handleGoogleLogin}
          disabled={status === "submitting"}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem" }}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
            <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
            <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
            <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
            <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
          </svg>
          {status === "submitting" ? "로그인 중..." : "Google로 로그인"}
        </button>
      </div>

      {(errorMessage || message) && (
        <p className={`auth-message ${status === "error" || errorMessage ? "is-error" : "is-success"}`.trim()}>
          {errorMessage ?? message}
        </p>
      )}

      {errorCode === "not_allowed" && pendingEmail && requestStatus !== "sent" && (
        <form onSubmit={handleAccessRequest} className="auth-request" style={{ marginTop: "1rem", padding: "1rem", border: "1px solid var(--line)", borderRadius: 12, background: "var(--panel-strong)" }}>
          <p style={{ fontSize: "0.875rem", fontWeight: 600, marginBottom: "0.5rem" }}>접근 요청 보내기</p>
          <p style={{ fontSize: "0.8rem", color: "var(--muted)", marginBottom: "0.75rem" }}>
            <strong>{pendingEmail}</strong>{pendingName ? ` (${pendingName})` : ""} 계정으로 관리자에게 접근을 요청합니다. 승인되면 다시 로그인해 주세요.
          </p>
          <textarea
            placeholder="요청 사유 (선택)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={500}
            style={{ width: "100%", padding: "0.5rem 0.75rem", border: "1px solid var(--line-strong)", borderRadius: 10, fontSize: "0.875rem", fontFamily: "inherit", resize: "vertical", marginBottom: "0.5rem" }}
          />
          <button
            type="submit"
            className="button"
            disabled={requestStatus === "submitting"}
            style={{ width: "100%" }}
          >
            {requestStatus === "submitting" ? "요청 중..." : "요청 보내기"}
          </button>
          {requestStatus === "error" && requestMessage && (
            <p className="auth-message is-error" style={{ marginTop: "0.5rem" }}>{requestMessage}</p>
          )}
        </form>
      )}

      {requestStatus === "sent" && (
        <p className="auth-message is-success" style={{ marginTop: "1rem" }}>
          {requestMessage ?? "관리자에게 접근 요청을 보냈습니다. 승인 후 다시 로그인해 주세요."}
        </p>
      )}
    </div>
  );
}
