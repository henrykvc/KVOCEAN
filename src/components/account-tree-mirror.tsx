"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AccountTreeRow } from "@/lib/validation/account-tree";

type TreeMeta = {
  cached: boolean;
  syncedAt: string | null;
  syncedBy: string | null;
  stats: { total: number; leaves: number; structural: number; pending: number } | null;
  warningCount: number;
};

type SyncState = { status: "idle" | "syncing" | "ok" | "error"; message?: string };

const PAGE_SIZE = 100;

/**
 * 4. 분류DB 탭 — 구글시트에서 동기화한 계정트리를 그대로 비추는 읽기 전용 거울.
 * 편집은 시트에서 하고, "시트에서 동기화"로 앱 캐시를 갱신한다.
 */
export function AccountTreeMirror() {
  const [rows, setRows] = useState<AccountTreeRow[]>([]);
  const [meta, setMeta] = useState<TreeMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncState>({ status: "idle" });
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/classification-tree");
      const data = await res.json().catch(() => null) as
        | ({ ok?: boolean; reason?: string; rows?: AccountTreeRow[] } & TreeMeta)
        | null;
      if (data?.reason === "migration_needed") {
        setLoadError("DB 준비 안 됨 — 마이그레이션 007 먼저 실행하세요.");
        setRows([]);
        setMeta(null);
      } else if (data?.ok) {
        setRows(Array.isArray(data.rows) ? data.rows : []);
        setMeta({ cached: data.cached, syncedAt: data.syncedAt, syncedBy: data.syncedBy, stats: data.stats, warningCount: data.warningCount });
      } else {
        setLoadError("불러오기 실패");
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "불러오기 실패");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const runSync = useCallback(async () => {
    setSync({ status: "syncing", message: "시트 읽고 검증 중..." });
    try {
      const res = await fetch("/api/classification-tree", { method: "POST" });
      const data = await res.json().catch(() => null) as {
        ok?: boolean; reason?: string; error?: string;
        stats?: { total: number; leaves: number }; errorCount?: number; warningCount?: number;
      } | null;
      if (data?.ok) {
        setSync({ status: "ok", message: `동기화 완료 — ${data.stats?.total ?? 0}행${data.warningCount ? `, 경고 ${data.warningCount}` : ""}` });
        await load();
        window.setTimeout(() => setSync((p) => p.status === "ok" ? { status: "idle" } : p), 5000);
      } else if (data?.reason === "validation_failed") {
        setSync({ status: "error", message: `검증 실패 — 오류 ${data.errorCount ?? 0}건. 반영 안 됨(직전 정상본 유지)` });
      } else if (data?.reason === "migration_needed") {
        setSync({ status: "error", message: "DB 준비 안 됨 — 마이그레이션 007 먼저 실행" });
      } else {
        setSync({ status: "error", message: data?.error ?? "동기화 실패" });
      }
    } catch (e) {
      setSync({ status: "error", message: e instanceof Error ? e.message : "동기화 실패" });
    }
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.l1, r.l2, r.l3, r.l4, r.l5, r.code].some((v) => v.toLowerCase().includes(q))
    );
  }, [rows, search]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const syncedLabel = meta?.syncedAt ? new Date(meta.syncedAt).toLocaleString("ko-KR") : "없음";

  return (
    <div className="classification-table-view">
      <div className="classification-table-toolbar">
        <button type="button" className="button" onClick={runSync} disabled={sync.status === "syncing"}>
          {sync.status === "syncing" ? "동기화 중..." : "시트에서 동기화"}
        </button>
        {sync.message && sync.status !== "syncing" && (
          <span className={`sheets-sync-status sheets-sync-${sync.status}`}>{sync.message}</span>
        )}
        <input
          className="input"
          placeholder="코드/이름 검색"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          style={{ minWidth: 200, flex: "0 1 280px" }}
        />
        <span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>
          최근 동기화: {syncedLabel}{meta?.stats ? ` · ${meta.stats.total.toLocaleString()}행 (계정 ${meta.stats.leaves.toLocaleString()})` : ""}{meta?.warningCount ? ` · 경고 ${meta.warningCount}` : ""}
        </span>
      </div>

      {loading && <div className="notice" style={{ marginTop: 12 }}>불러오는 중...</div>}
      {loadError && <div className="notice" style={{ marginTop: 12, color: "#b91c1c" }}>{loadError}</div>}
      {!loading && !loadError && !rows.length && (
        <div className="notice" style={{ marginTop: 12 }}>
          아직 동기화된 분류표가 없습니다. 위 <strong>「시트에서 동기화」</strong>를 눌러 구글시트에서 불러오세요.
        </div>
      )}

      {!!rows.length && (
        <>
          <div className="classification-table-scroll">
            <table className="table report-table classification-flat-table">
              <thead>
                <tr>
                  <th>계정코드</th>
                  <th>대분류</th>
                  <th>중분류</th>
                  <th>소분류</th>
                  <th>세분류</th>
                  <th>계정명</th>
                  <th>부호</th>
                  <th>차대</th>
                  <th>변동/고정</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r, i) => (
                  <tr key={`${r.code}-${r.rowIndex}-${i}`}>
                    <td className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>{r.code}</td>
                    <td>{r.l1}</td>
                    <td>{r.l2}</td>
                    <td>{r.l3}</td>
                    <td>{r.l4}</td>
                    <td><strong>{r.l5}</strong></td>
                    <td style={{ textAlign: "center", color: r.sign === "-" ? "#b91c1c" : undefined }}>{r.sign}</td>
                    <td style={{ textAlign: "center" }}>{r.debitCredit}</td>
                    <td style={{ textAlign: "center" }}>{r.varFix}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="classification-table-pager">
            <button type="button" className="ghost-button" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>이전</button>
            <span className="muted" style={{ fontSize: 12 }}>
              {safePage + 1} / {pageCount} · 필터 {filtered.length.toLocaleString()}행
            </span>
            <button type="button" className="ghost-button" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>다음</button>
          </div>
        </>
      )}
    </div>
  );
}
