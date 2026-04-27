"use client";

import { useState } from "react";

const CREATOR_EMAIL = "henry@kakaoventures.co.kr";

type UserRole = "creator" | "admin" | "manager";

type AllowedUser = {
  email: string;
  display_name: string | null;
  is_active: boolean;
  role: UserRole;
  created_at: string;
  hasAuthAccount?: boolean;
};

const ROLE_LABELS: Record<UserRole, string> = {
  creator: "제작자",
  admin: "관리자",
  manager: "매니저",
};

const ROLE_COLORS: Record<UserRole, string> = {
  creator: "#7c3aed",
  admin: "#2563eb",
  manager: "#374151",
};

export function AdminPanel({ initialUsers }: { initialUsers: AllowedUser[] }) {
  const [users, setUsers] = useState<AllowedUser[]>(initialUsers);
  const [newEmail, setNewEmail] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "manager">("manager");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSuccess, setAddSuccess] = useState<string | null>(null);
  const [loadingEmail, setLoadingEmail] = useState<string | null>(null);
  const [bulkReinviting, setBulkReinviting] = useState(false);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    setAddError(null);
    setAddSuccess(null);

    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: newEmail, display_name: newDisplayName, role: newRole }),
    });
    const json = await res.json() as AllowedUser & { error?: string; inviteSent?: boolean };

    if (!res.ok) {
      setAddError(json.error ?? "추가에 실패했습니다.");
    } else {
      setUsers((prev) => {
        const exists = prev.find((u) => u.email === json.email);
        if (exists) return prev.map((u) => u.email === json.email ? json : u);
        return [json, ...prev];
      });
      setNewEmail("");
      setNewDisplayName("");
      setNewRole("manager");
      setAddSuccess(json.inviteSent ? "추가 완료. 초대 메일을 발송했습니다." : "추가 완료.");
    }
    setAdding(false);
  }

  async function handleRoleChange(email: string, role: "admin" | "manager") {
    setLoadingEmail(email);
    setAddError(null);
    const res = await fetch(`/api/admin/users/${encodeURIComponent(email)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    const json = await res.json() as AllowedUser & { error?: string };
    if (res.ok) {
      setUsers((prev) => prev.map((u) => u.email === email ? json : u));
    } else {
      setAddError(`역할 변경 실패: ${json.error ?? "알 수 없는 오류"}`);
    }
    setLoadingEmail(null);
  }

  async function handleReinvite(user: AllowedUser) {
    setLoadingEmail(user.email);
    setAddError(null);
    setAddSuccess(null);
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email, display_name: user.display_name, role: user.role }),
    });
    const json = await res.json() as AllowedUser & { error?: string; inviteSent?: boolean };
    if (!res.ok) {
      setAddError(json.error ?? "재초대에 실패했습니다.");
    } else {
      setUsers((prev) => prev.map((u) => u.email === user.email ? { ...u, hasAuthAccount: true } : u));
      setAddSuccess(json.inviteSent ? "초대 메일을 재발송했습니다." : "계정이 동기화되었습니다.");
    }
    setLoadingEmail(null);
  }

  async function handleBulkReinvite() {
    const unsynced = users.filter((u) => u.hasAuthAccount === false);
    if (unsynced.length === 0) return;
    setBulkReinviting(true);
    setAddError(null);
    setAddSuccess(null);
    let successCount = 0;
    for (const user of unsynced) {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, display_name: user.display_name, role: user.role }),
      });
      if (res.ok) {
        setUsers((prev) => prev.map((u) => u.email === user.email ? { ...u, hasAuthAccount: true } : u));
        successCount++;
      }
    }
    setAddSuccess(`${successCount}명에게 초대 메일을 발송했습니다.`);
    setBulkReinviting(false);
  }

  async function handleDelete(email: string) {
    if (!confirm(`${email} 계정을 삭제하시겠습니까?`)) return;
    setLoadingEmail(email);
    const res = await fetch(`/api/admin/users/${encodeURIComponent(email)}`, { method: "DELETE" });
    if (res.ok) setUsers((prev) => prev.filter((u) => u.email !== email));
    setLoadingEmail(null);
  }

  const activeCount = users.filter((u) => u.is_active && u.role !== "creator").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem", padding: "1.5rem 1rem", maxWidth: 760, margin: "0 auto" }}>
      <section className="config-card">
        <div className="section-title">
          <div>
            <span className="section-kicker">접근 제어</span>
            <h3>계정 초대</h3>
            <p className="result-meta">추가 후 해당 이메일로 초대 메일이 자동 발송됩니다.</p>
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
          <select
            value={newRole}
            onChange={(e) => setNewRole(e.target.value as "admin" | "manager")}
            style={{ padding: "0.55rem 0.75rem", border: "1px solid var(--line-strong)", borderRadius: 10, fontSize: "0.875rem", background: "white" }}
          >
            <option value="manager">매니저</option>
            <option value="admin">관리자</option>
          </select>
          <button className="button" type="submit" disabled={adding} style={{ flexShrink: 0 }}>
            {adding ? "추가 중..." : "초대"}
          </button>
        </form>
        {addError && <p style={{ color: "var(--red)", fontSize: "0.875rem", marginTop: "0.5rem" }}>{addError}</p>}
        {addSuccess && <p style={{ color: "var(--green)", fontSize: "0.875rem", marginTop: "0.5rem" }}>{addSuccess}</p>}
      </section>

      <section className="config-card">
        <div className="section-title">
          <div><h3>허용 계정 목록</h3></div>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            {users.some((u) => u.hasAuthAccount === false) && (
              <button
                className="button"
                style={{ fontSize: "0.8rem", padding: "0.35rem 0.75rem", borderRadius: 8 }}
                disabled={bulkReinviting}
                onClick={handleBulkReinvite}
              >
                {bulkReinviting ? "초대 중..." : "미완료 전체 재초대"}
              </button>
            )}
            <span className="soft-badge">활성 {activeCount}명</span>
          </div>
        </div>

        {users.length === 0 && (
          <div className="notice" style={{ marginTop: "1rem" }}>등록된 계정이 없습니다.</div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "1rem" }}>
          {users.map((user) => {
            const isCreator = user.email === CREATOR_EMAIL;
            const isLoading = loadingEmail === user.email;
            return (
              <div
                key={user.email}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.75rem",
                  padding: "0.75rem 1rem",
                  border: `1px solid ${isCreator ? "rgba(124,58,237,0.2)" : "var(--line)"}`,
                  borderRadius: 12,
                  background: isCreator ? "rgba(124,58,237,0.04)" : "var(--panel-strong)",
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem", minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                    {user.display_name && (
                      <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>{user.display_name}</span>
                    )}
                    <span style={{ fontSize: "0.875rem", color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.email}</span>
                    <span style={{
                      fontSize: "0.7rem",
                      fontWeight: 700,
                      padding: "0.1rem 0.45rem",
                      borderRadius: 6,
                      background: `rgba(${ROLE_COLORS[user.role]}, 0.1)`,
                      color: ROLE_COLORS[user.role],
                      border: `1px solid ${ROLE_COLORS[user.role]}30`,
                      letterSpacing: "0.02em",
                    }}>
                      {ROLE_LABELS[user.role]}
                    </span>
                    {user.hasAuthAccount === false && (
                      <span style={{
                        fontSize: "0.7rem",
                        fontWeight: 700,
                        padding: "0.1rem 0.45rem",
                        borderRadius: 6,
                        background: "rgba(234,88,12,0.1)",
                        color: "#ea580c",
                        border: "1px solid rgba(234,88,12,0.3)",
                        letterSpacing: "0.02em",
                      }}>
                        초대 미완료
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
                    {new Date(user.created_at).toLocaleDateString("ko-KR")} 추가
                  </span>
                </div>

                {isCreator ? (
                  <span style={{ fontSize: "0.75rem", color: "#7c3aed", fontWeight: 600, flexShrink: 0 }}>수정 불가</span>
                ) : (
                  <div style={{ display: "flex", gap: "0.4rem", flexShrink: 0, alignItems: "center" }}>
                    <select
                      value={user.role}
                      disabled={isLoading}
                      onChange={(e) => handleRoleChange(user.email, e.target.value as "admin" | "manager")}
                      style={{ padding: "0.35rem 0.6rem", border: "1px solid var(--line-strong)", borderRadius: 8, fontSize: "0.8rem", background: "white", cursor: "pointer" }}
                    >
                      <option value="manager">매니저</option>
                      <option value="admin">관리자</option>
                    </select>
                    {user.hasAuthAccount === false && (
                      <button
                        className="button"
                        style={{ padding: "0.4rem 0.75rem", fontSize: "0.8rem", borderRadius: 8 }}
                        disabled={isLoading}
                        onClick={() => handleReinvite(user)}
                      >
                        재초대
                      </button>
                    )}
                    <button
                      className="danger-button"
                      style={{ padding: "0.4rem 0.75rem", fontSize: "0.8rem", borderRadius: 8 }}
                      disabled={isLoading}
                      onClick={() => handleDelete(user.email)}
                    >
                      삭제
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="config-card">
        <div className="section-title">
          <div>
            <h3>직책 안내</h3>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "0.5rem" }}>
          {(["creator", "admin", "manager"] as UserRole[]).map((role) => (
            <div key={role} style={{ display: "flex", gap: "0.75rem", alignItems: "flex-start" }}>
              <span style={{ fontSize: "0.75rem", fontWeight: 700, padding: "0.15rem 0.5rem", borderRadius: 6, background: `${ROLE_COLORS[role]}15`, color: ROLE_COLORS[role], border: `1px solid ${ROLE_COLORS[role]}30`, flexShrink: 0, marginTop: 1 }}>
                {ROLE_LABELS[role]}
              </span>
              <span style={{ fontSize: "0.85rem", color: "var(--muted)" }}>
                {role === "creator" && "모든 기능에 접근 가능. 데이터 삭제 포함. 계정 수정 불가."}
                {role === "admin" && "계정 관리 페이지 접근 가능. 앱 내 모든 탭 수정 가능. 데이터 삭제는 제작자만 가능."}
                {role === "manager" && "OCR검증, 데이터, 결과물 탭 사용 가능. 1-1, 3-1, 3-2, 4번 탭 및 데이터 삭제 불가."}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
