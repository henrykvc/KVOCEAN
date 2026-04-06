"use client";

import { useMemo, useState } from "react";

type LoginFormProps = {
  nextPath?: string;
  errorCode?: string;
};

const ERROR_MESSAGES: Record<string, string> = {
  unauthorized: "허용된 이메일 계정만 접근할 수 있습니다.",
  callback: "로그인 세션을 확인하지 못했습니다. 다시 시도해 주세요.",
  missing_code: "이메일 링크가 올바르지 않습니다. 새 링크를 요청해 주세요."
};

export function LoginForm({ nextPath = "/", errorCode }: LoginFormProps) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "sent" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const errorMessage = useMemo(() => {
    if (!errorCode) {
      return null;
    }

    return ERROR_MESSAGES[errorCode] ?? "로그인 중 오류가 발생했습니다. 다시 시도해 주세요.";
  }, [errorCode]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("submitting");
    setMessage(null);

    try {
      const response = await fetch("/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email,
          next: nextPath
        })
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(typeof payload.error === "string" ? payload.error : "로그인 메일 발송에 실패했습니다.");
      }

      setStatus("sent");
      setMessage(typeof payload.message === "string" ? payload.message : "매직링크를 보냈습니다. 메일을 확인해 주세요.");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "로그인 메일 발송에 실패했습니다.");
    }
  }

  return (
    <div className="auth-card">
      <div className="auth-copy">
        <span className="auth-eyebrow">Protected Workspace</span>
        <h1>KV OCEAN 로그인</h1>
        <p>허용된 이메일 계정으로 로그인해야 공용 데이터와 분류 기준을 볼 수 있습니다.</p>
      </div>

      <form className="auth-form" onSubmit={handleSubmit}>
        <label className="auth-label" htmlFor="email">이메일</label>
        <input
          id="email"
          className="input auth-input"
          type="email"
          autoComplete="email"
          placeholder="name@company.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
        <button className="button auth-submit" type="submit" disabled={status === "submitting"}>
          {status === "submitting" ? "메일 보내는 중..." : "매직링크 보내기"}
        </button>
      </form>

      {(errorMessage || message) && (
        <p className={`auth-message ${status === "error" || errorMessage ? "is-error" : "is-success"}`.trim()}>
          {errorMessage ?? message}
        </p>
      )}

      <div className="auth-note">
        <strong>운영 메모</strong>
        <p>Supabase Auth에서 초대된 계정 또는 허용된 이메일만 들어올 수 있게 설정해 두세요.</p>
      </div>
    </div>
  );
}
