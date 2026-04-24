"use client";

import { useState } from "react";

type AllowedUser = {
  email: string;
  display_name: string | null;
  is_active: boolean;
  created_at: string;
};

type AdminPanelProps = {
  initialUsers: AllowedUser[];
};

export function AdminPanel({ initialUsers }: AdminPanelProps) {
  const [users, setUsers] = useState<AllowedUser[]>(initialUsers);
  const [newEmail, setNewEmail] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingEmail, setLoadingEmail] = useState<string | null>(null);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    setError(null);

    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: newEmail, display_name: newDisplayName }),
    });
    const json = await res.json() as AllowedUser & { error?: string };

    if (!res.ok) {
      setError(json.error ?? "추가에 실패했습니다.");
    } else {
      setUsers((prev) => {
        const exists = prev.find((u) => u.email === json.email);
        if (exists) return prev.map((u) => u.email === json.email ? json : u);
        return [json, ...prev];
      });
      setNewEmail("");
      setNewDisplayName("");
    }
    setAdding(false);
  }

  async function handleToggle(email: string, is_active: boolean) {
    setLoadingEmail(email);
    const res = await fetch(`/api/admin/users/${encodeURIComponent(email)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active }),
    });
    const json = await res.json() as AllowedUser & { error?: string };

    if (res.ok) {
      setUsers((prev) => prev.map((u) => u.email === email ? json : u));
    }
    setLoadingEmail(null);
  }

  async function handleDelete(email: string) {
    if (!confirm(`${email} 계정을 삭제하시겠습니까?`)) return;
    setLoadingEmail(email);

    const res = await fetch(`/api/admin/users/${encodeURIComponent(email)}`, {
      method: "DELETE",
    });

    if (res.ok) {
      setUsers((prev) => prev.filter((u) => u.email !== email));
    }
    setLoadingEmail(null);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem", padding: "1.5rem 1rem", maxWidth: 720, margin: "0 auto" }}>
      <section className="config-card">
        <div className="section-title">
          <div>
            <span className="section-kicker">접근 제어</span>
            <h3>허용 계정 추가</h3>
            <p className="result-meta">추가된 구글 계정만 KV OCEAN에 로그인할 수 있습니다.</p>
          </div>
        </div>
        <form onSubmit={handleAdd} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
          <input
            type="email"
            placeholder="이메일 주소"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            required
            style={{ flex: "2 1 200px", padding: "0.55rem 0.75rem", border: "1px solid var(--line-strong)", borderRadius: 10, fontSize: "0.875rem" }}
          />
          <input
            type="text"
            placeholder="이름 (선택)"
            value={newDisplayName}
            onChange={(e) => setNewDisplayName(e.target.value)}
            style={{ flex: "1 1 120px", padding: "0.55rem 0.75rem", border: "1px solid var(--line-strong)", borderRadius: 10, fontSize: "0.875rem" }}
          />
          <button className="button" type="submit" disabled={adding} style={{ flexShrink: 0 }}>
            {adding ? "추가 중..." : "추가"}
          </button>
        </form>
        {error && <p style={{ color: "var(--red)", fontSize: "0.875rem", marginTop: "0.5rem" }}>{error}</p>}
      </section>

      <section className="config-card">
        <div className="section-title">
          <div>
            <h3>허용 계정 목록</h3>
          </div>
          <span className="soft-badge">총 {users.filter((u) => u.is_active).length}명 활성</span>
        </div>

        {users.length === 0 && (
          <div className="notice" style={{ marginTop: "1rem" }}>등록된 계정이 없습니다.</div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "1rem" }}>
          {users.map((user) => (
            <div
              key={user.email}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "0.75rem",
                padding: "0.75rem 1rem",
                border: "1px solid var(--line)",
                borderRadius: 12,
                background: user.is_active ? "var(--panel-strong)" : "var(--panel-soft)",
                opacity: user.is_active ? 1 : 0.6,
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem", minWidth: 0 }}>
                <span style={{ fontWeight: 600, fontSize: "0.9rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {user.display_name ? `${user.display_name} ` : ""}
                  <span style={{ fontWeight: 400, color: "var(--muted)" }}>{user.email}</span>
                </span>
                <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
                  {new Date(user.created_at).toLocaleDateString("ko-KR")} 추가
                </span>
              </div>
              <div style={{ display: "flex", gap: "0.4rem", flexShrink: 0 }}>
                <button
                  className="ghost-button"
                  style={{ padding: "0.4rem 0.75rem", fontSize: "0.8rem", borderRadius: 8 }}
                  disabled={loadingEmail === user.email}
                  onClick={() => handleToggle(user.email, !user.is_active)}
                >
                  {user.is_active ? "비활성화" : "활성화"}
                </button>
                <button
                  className="danger-button"
                  style={{ padding: "0.4rem 0.75rem", fontSize: "0.8rem", borderRadius: 8 }}
                  disabled={loadingEmail === user.email}
                  onClick={() => handleDelete(user.email)}
                >
                  삭제
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
