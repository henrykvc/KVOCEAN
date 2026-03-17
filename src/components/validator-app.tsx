"use client";

import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import {
  DEFAULT_COMPANY_CONFIGS,
  DEFAULT_LOGIC_CONFIG,
  LAST_PATCH,
  type CompanyConfigs,
  type LogicConfig,
  type SignCode
} from "@/lib/validation/defaults";
import {
  STORAGE_KEYS,
  buildCopyText,
  diagnoseDiff,
  formatNumber,
  getDefaultPersistedState,
  parsePersistedState,
  runValidation,
  safeFloat,
  type SessionSignFixes
} from "@/lib/validation/engine";

type TabKey = "validate" | "config" | "export";

type OverrideRow = {
  section: string;
  keyword: string;
  sign: SignCode;
};

function renderDiagnosisText(text: string) {
  const parts = text.split("**");
  return parts.map((part, index) =>
    index % 2 === 1 ? <strong key={`${part}-${index}`}>{part}</strong> : <span key={`${part}-${index}`}>{part}</span>
  );
}

function upsertOverrideRow(rows: OverrideRow[], nextRow: OverrideRow) {
  const foundIndex = rows.findIndex((row) => row.section === nextRow.section && row.keyword === nextRow.keyword);
  if (foundIndex === -1) {
    const cleanedRows = rows.filter((row) => row.section.trim() || row.keyword.trim());
    return [...cleanedRows, nextRow];
  }

  return rows.map((row, index) => (index === foundIndex ? nextRow : row));
}

type MapRow = {
  section: string;
  parent: string;
};

type PreviewGroup = {
  label: string;
  start: number;
  span: number;
  tone: number;
};

function cloneLogicConfig(config: LogicConfig): LogicConfig {
  return structuredClone(config);
}

function cloneCompanyConfigs(configs: CompanyConfigs): CompanyConfigs {
  return structuredClone(configs);
}

function parseKeywordList(value: string) {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function objectEntriesToRows(record: Record<string, string>): MapRow[] {
  return Object.entries(record).map(([section, parent]) => ({ section, parent }));
}

function overridesToRows(record: Record<string, Record<string, SignCode>>): OverrideRow[] {
  return Object.entries(record).flatMap(([section, items]) =>
    Object.entries(items).map(([keyword, sign]) => ({ section, keyword, sign }))
  );
}

function rowsToMap(rows: MapRow[]) {
  return rows.reduce<Record<string, string>>((acc, row) => {
    if (row.section.trim() && row.parent.trim()) {
      acc[row.section.trim()] = row.parent.trim();
    }
    return acc;
  }, {});
}

function rowsToOverrides(rows: OverrideRow[]) {
  return rows.reduce<Record<string, Record<string, SignCode>>>((acc, row) => {
    const section = row.section.trim();
    const keyword = row.keyword.trim();
    if (!section || !keyword) {
      return acc;
    }
    acc[section] ??= {};
    acc[section][keyword] = row.sign;
    return acc;
  }, {});
}

function signLabel(sign: SignCode) {
  return sign === 0 ? "가산(+)" : sign === 1 ? "차감(−)" : "제외";
}

function displayedSignToCode(sign: string): SignCode {
  if (sign === "−") {
    return 1;
  }
  if (sign === "제외") {
    return 2;
  }
  return 0;
}

function countSessionFixes(sessionSignFixes: SessionSignFixes) {
  return Object.values(sessionSignFixes).reduce((count, items) => count + Object.keys(items).length, 0);
}

function buildPreviewGroups(catRow: string[], nameRow: string[]): { groups: PreviewGroup[]; tones: number[] } {
  const length = Math.max(catRow.length, nameRow.length);
  const tones = Array.from({ length }, () => 0);
  const groups: PreviewGroup[] = [];
  let currentLabel = "기타";
  let toneIndex = -1;

  for (let index = 0; index < length; index += 1) {
    const nextLabel = catRow[index]?.trim();
    if (nextLabel) {
      currentLabel = nextLabel;
    }

    const lastGroup = groups[groups.length - 1];
    if (!lastGroup || lastGroup.label !== currentLabel) {
      toneIndex += 1;
      groups.push({ label: currentLabel, start: index, span: 1, tone: toneIndex % 6 });
    } else {
      lastGroup.span += 1;
    }

    tones[index] = groups[groups.length - 1].tone;
  }

  return { groups, tones };
}

export function ValidatorApp() {
  const [activeTab, setActiveTab] = useState<TabKey>("validate");
  const [mounted, setMounted] = useState(false);
  const [pastedText, setPastedText] = useState("");
  const [tolerance, setTolerance] = useState(1);
  const [selectedCompany, setSelectedCompany] = useState("");
  const [logicConfig, setLogicConfig] = useState<LogicConfig>(cloneLogicConfig(DEFAULT_LOGIC_CONFIG));
  const [companyConfigs, setCompanyConfigs] = useState<CompanyConfigs>(cloneCompanyConfigs(DEFAULT_COMPANY_CONFIGS));
  const [pasteEdits, setPasteEdits] = useState<Record<number, number>>({});
  const [sessionSignFixes, setSessionSignFixes] = useState<SessionSignFixes>({});
  const [globalOverrideRows, setGlobalOverrideRows] = useState<OverrideRow[]>(overridesToRows(DEFAULT_LOGIC_CONFIG.sectionSignOverrides));
  const [companyOverrideRows, setCompanyOverrideRows] = useState<OverrideRow[]>([]);
  const [pasteSectionRows, setPasteSectionRows] = useState<MapRow[]>(objectEntriesToRows(DEFAULT_LOGIC_CONFIG.pasteSectToParent));
  const [resultOpenState, setResultOpenState] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setMounted(true);
    const persisted = parsePersistedState(window.localStorage.getItem(STORAGE_KEYS.config));
    setLogicConfig(cloneLogicConfig(persisted.logicConfig));
    setCompanyConfigs(cloneCompanyConfigs(persisted.companyConfigs));
    setGlobalOverrideRows(overridesToRows(persisted.logicConfig.sectionSignOverrides));
    setPasteSectionRows(objectEntriesToRows(persisted.logicConfig.pasteSectToParent));
  }, []);

  useEffect(() => {
    if (!mounted) {
      return;
    }
    window.localStorage.setItem(
      STORAGE_KEYS.config,
      JSON.stringify({ logicConfig, companyConfigs })
    );
  }, [mounted, logicConfig, companyConfigs]);

  useEffect(() => {
    const autoCompany = runValidation({
      pastedText,
      selectedCompany: selectedCompany || null,
      tolerance,
      logicConfig,
      companyConfigs,
      pasteEdits,
      sessionSignFixes
    }).detectedCompany;

    if (autoCompany && autoCompany !== selectedCompany.trim()) {
      setSelectedCompany(autoCompany);
    }
  }, [pastedText, tolerance, logicConfig, companyConfigs, pasteEdits, sessionSignFixes, selectedCompany]);

  useEffect(() => {
    const company = selectedCompany.trim();
    const rows = overridesToRows(companyConfigs[company]?.sectionSignOverrides ?? {});
    setCompanyOverrideRows(rows.length ? rows : [{ section: "", keyword: "", sign: 0 }]);
  }, [selectedCompany, companyConfigs]);

  const validation = useMemo(
    () =>
      runValidation({
        pastedText,
        selectedCompany: selectedCompany.trim() || null,
        tolerance,
        logicConfig,
        companyConfigs,
        pasteEdits,
        sessionSignFixes
      }),
    [pastedText, selectedCompany, tolerance, logicConfig, companyConfigs, pasteEdits, sessionSignFixes]
  );

  const companyKnown = selectedCompany.trim() && companyConfigs[selectedCompany.trim()];
  const inputReady = pastedText.trim().length > 0;
  const failedDateCount = Object.values(validation.resultsByDate).filter((items) => items.some((item) => !item.passed)).length;
  const sessionFixCount = countSessionFixes(sessionSignFixes);
  const editedValueCount = Object.keys(pasteEdits).length;
  const previewGroups = useMemo(
    () => buildPreviewGroups(validation.parsed.catRow, validation.parsed.nameRow),
    [validation.parsed.catRow, validation.parsed.nameRow]
  );

  function resetAdjustments() {
    setPasteEdits({});
    setSessionSignFixes({});
  }

  function updateEditableValue(colIndex: number, rawValue: number, nextValue: string) {
    const parsed = safeFloat(nextValue);
    setPasteEdits((prev) => {
      const next = { ...prev };
      if (parsed === null || Math.abs(parsed - rawValue) < 0.5) {
        delete next[colIndex];
      } else {
        next[colIndex] = parsed;
      }
      return next;
    });
  }

  function applySessionFix(sect: string, acct: string, newSign: SignCode) {
    setSessionSignFixes((prev) => ({
      ...prev,
      [sect]: {
        ...(prev[sect] ?? {}),
        [acct]: newSign
      }
    }));
  }

  function saveCompanyFix(sect: string, acct: string, newSign: SignCode) {
    const company = selectedCompany.trim();
    if (!company) {
      return;
    }
    setCompanyConfigs((prev) => ({
      ...prev,
      [company]: {
        ...(prev[company] ?? {}),
        sectionSignOverrides: {
          ...(prev[company]?.sectionSignOverrides ?? {}),
          [sect]: {
            ...(prev[company]?.sectionSignOverrides?.[sect] ?? {}),
            [acct]: newSign
          }
        }
      }
    }));
    setCompanyOverrideRows((prev) => upsertOverrideRow(prev, { section: sect, keyword: acct, sign: newSign }));
    applySessionFix(sect, acct, newSign);
  }

  function updateDetailSign(sect: string, acct: string, nextSign: SignCode) {
    applySessionFix(sect, acct, nextSign);
  }

  function toggleResultCard(cardKey: string, defaultOpen: boolean) {
    setResultOpenState((prev) => ({
      ...prev,
      [cardKey]: !(prev[cardKey] ?? defaultOpen)
    }));
  }

  function openAllResultCards() {
    const next: Record<string, boolean> = {};
    for (const [dateLabel, results] of Object.entries(validation.resultsByDate)) {
      results.forEach((result, index) => {
        next[`${dateLabel}-${result.rule}-${index}`] = true;
      });
    }
    setResultOpenState(next);
  }

  function focusFailedResultCards() {
    setResultOpenState({});
  }

  function copyModifiedText() {
    const text = buildCopyText(
      validation.parsed.catRow,
      validation.parsed.nameRow,
      validation.previewRow,
      pasteEdits
    );
    navigator.clipboard.writeText(text).catch(() => undefined);
  }

  function exportWorkbook() {
    if (!validation.allResults.length) {
      return;
    }

    const workbook = XLSX.utils.book_new();
    const allRows = validation.allResults.map((result) => ({
      날짜: result.날짜 ?? "",
      분류: result.분류,
      규칙: result.rule,
      부모계정: result.parent,
      재무제표값: result.parent_val,
      OCR합산: result.computed,
      차이: result.diff,
      통과: result.passed ? "Y" : "N"
    }));
    const failRows = allRows.filter((row) => row.통과 === "N");
    const configRows = [
      { key: "회사명", value: selectedCompany || "" },
      { key: "허용오차", value: tolerance },
      { key: "lastPatch", value: LAST_PATCH },
      { key: "sessionSignFixes", value: JSON.stringify(sessionSignFixes) }
    ];

    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(allRows), "전체결과");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(failRows), "실패항목");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(configRows), "설정값");
    XLSX.writeFile(workbook, "ocr-validation-results.xlsx");
  }

  function resetConfig() {
    const defaults = getDefaultPersistedState();
    setLogicConfig(cloneLogicConfig(defaults.logicConfig));
    setCompanyConfigs(cloneCompanyConfigs(defaults.companyConfigs));
    setGlobalOverrideRows(overridesToRows(defaults.logicConfig.sectionSignOverrides));
    setPasteSectionRows(objectEntriesToRows(defaults.logicConfig.pasteSectToParent));
  }

  function saveConfigEditors() {
    setLogicConfig((prev) => ({
      ...prev,
      pasteSectToParent: rowsToMap(pasteSectionRows),
      sectionSignOverrides: rowsToOverrides(globalOverrideRows)
    }));

    const company = selectedCompany.trim();
    if (company) {
      setCompanyConfigs((prev) => ({
        ...prev,
        [company]: {
          ...(prev[company] ?? {}),
          sectionSignOverrides: rowsToOverrides(companyOverrideRows)
        }
      }));
    }
  }

  const configPayload = JSON.stringify({ logicConfig, companyConfigs }, null, 2);

  return (
    <main className="page-shell">
      <section className="hero">
        <span className="hero-eyebrow">KVOCEAN OCR Validator</span>
        <h1>붙여넣고 바로 확인하는 OCR 검증</h1>
        <p>최종 수정: {LAST_PATCH}</p>
        <div className="hero-meta">
          <span className="pill">1. 텍스트 붙여넣기</span>
          <span className="pill">2. 실패 항목 확인</span>
          <span className="pill">3. 값/부호 바로 수정</span>
        </div>
      </section>

      <section className="summary-strip">
        <article className="summary-card">
          <span className="summary-label">입력 상태</span>
          <strong>{inputReady ? "준비됨" : "대기 중"}</strong>
          <p>{inputReady ? "붙여넣은 데이터를 기준으로 즉시 검증 중" : "왼쪽 입력창에 OCR 3행 텍스트를 넣어 주세요"}</p>
        </article>
        <article className="summary-card">
          <span className="summary-label">실패 묶음</span>
          <strong>{failedDateCount}건</strong>
          <p>날짜별 결과 중 실패 항목이 포함된 묶음 수</p>
        </article>
        <article className="summary-card">
          <span className="summary-label">세션 수정</span>
          <strong>{editedValueCount + sessionFixCount}건</strong>
          <p>값 수정 {editedValueCount}건 / 부호 수정 {sessionFixCount}건</p>
        </article>
        <article className="summary-card">
          <span className="summary-label">로직 기준</span>
          <strong>v31</strong>
          <p>{LAST_PATCH}</p>
        </article>
      </section>

      <section className="layout-grid">
        <aside className="panel sidebar">
          <div className="section-title panel-title-wrap">
            <div>
              <span className="section-kicker">1. 입력</span>
              <h2>검증할 데이터를 넣어 주세요</h2>
              <p className="panel-desc">회사명과 허용 오차를 확인한 뒤 OCR 3행 텍스트를 그대로 붙여넣으면 됩니다.</p>
            </div>
            <span className={`tag ${companyKnown ? "pass" : ""}`}>{companyKnown ? "회사 규칙 적용 중" : "공통 규칙 사용"}</span>
          </div>

          <div className="field-grid">
            <label className="field">
              <span>허용 오차 (원)</span>
              <input className="number-input" type="number" min={0} step={1} value={tolerance} onChange={(event) => setTolerance(Number(event.target.value) || 0)} />
            </label>
            <label className="field">
              <span>회사명</span>
              <input className="input" value={selectedCompany} onChange={(event) => setSelectedCompany(event.target.value)} placeholder="예) 소셜빈" />
            </label>
          </div>

          <label className="field">
            <span>3행 OCR 텍스트</span>
            <textarea
              className="textarea"
              value={pastedText}
              onChange={(event) => {
                setPastedText(event.target.value);
                setPasteEdits({});
                setSessionSignFixes({});
              }}
              placeholder={"행1: 기타\t재무상태표\t유동자산\t...\n행2: 회사명\t날짜\t...\n행3: 에이슬립\t2024-12-31\t..."}
            />
          </label>

          <div className="button-row">
            <button className="button" onClick={() => setActiveTab("validate")}>검증 결과 보기</button>
            <button className="ghost-button" onClick={resetAdjustments}>입력 수정 초기화</button>
          </div>

          <div className="notice input-helper">
            <strong>입력 팁</strong>
            <ul className="helper-list muted">
              <li>행 1은 섹션명, 행 2는 계정명, 행 3부터 값입니다.</li>
              <li>회사명이 자동 감지되면 회사별 부호 규칙을 바로 불러옵니다.</li>
              <li>값 수정과 부호 수정은 검증 화면에서 바로 반영됩니다.</li>
            </ul>
          </div>
        </aside>

        <section className="panel main-panel">
          <div className="tab-list">
            <button className={`tab ${activeTab === "validate" ? "active" : ""}`} onClick={() => setActiveTab("validate")}>검증</button>
            <button className={`tab ${activeTab === "config" ? "active" : ""}`} onClick={() => setActiveTab("config")}>규칙 관리</button>
            <button className={`tab ${activeTab === "export" ? "active" : ""}`} onClick={() => setActiveTab("export")}>내보내기</button>
          </div>

          {activeTab === "validate" && (
            <>
              {!pastedText.trim() && <div className="notice">사이드바에 OCR 3행 텍스트를 붙여넣으면 검증 결과가 나타납니다.</div>}
              {validation.parsed.error && pastedText.trim() && <div className="notice">{validation.parsed.error}</div>}

              {!validation.parsed.error && validation.parsed.nameRow.length > 0 && (
                <>
                  <section className="overview-card">
                    <div className="section-title">
                      <div>
                        <span className="section-kicker">2. 검증</span>
                        <h3>한눈에 결과 보기</h3>
                      </div>
                      <div className="result-actions">
                        <span className="soft-badge">수정값 {editedValueCount}</span>
                        <span className="soft-badge">부호 변경 {sessionFixCount}</span>
                        <button className="tiny-button" onClick={focusFailedResultCards}>실패만 펼치기</button>
                        <button className="tiny-button" onClick={openAllResultCards}>전체 펼치기</button>
                      </div>
                    </div>
                    <div className="metric-grid compact-metrics">
                      <article className="metric-card"><span className="muted">전체 검증</span><strong>{validation.stats.total}</strong></article>
                      <article className="metric-card"><span className="muted">통과</span><strong>{validation.stats.passed}</strong></article>
                      <article className="metric-card"><span className="muted">실패</span><strong>{validation.stats.failed}</strong></article>
                      <article className="metric-card"><span className="muted">통과율</span><strong>{validation.stats.rate.toFixed(1)}%</strong></article>
                    </div>
                  </section>

                  <div className="preview-table-wrap">
                    <div className="section-title">
                      <div>
                        <h3>붙여넣기 미리보기</h3>
                        <p className="result-meta">계정 {validation.parsed.nameRow.length}개 / 데이터 {validation.parsed.dataRows.length}행</p>
                      </div>
                      <span className="preview-scroll-chip">좌우로 넘겨서 전체 열 보기</span>
                    </div>
                    <div className="preview-scroll-wrap">
                      <div className="preview-scroll-shadow left" aria-hidden="true" />
                      <div className="preview-scroll-shadow right" aria-hidden="true" />
                      <div className="preview-scroll" role="region" aria-label="붙여넣기 미리보기 가로 스크롤 영역">
                        <table className="preview-grid-table">
                        <tbody>
                          <tr>
                            <th className="preview-row-label">분류</th>
                            {previewGroups.groups.map((group) => (
                              <th key={`group-${group.start}`} colSpan={group.span} className={`preview-group-cell tone-${group.tone}`}>
                                {group.label}
                              </th>
                            ))}
                          </tr>
                          <tr>
                            <th className="preview-row-label">계정명</th>
                            {validation.parsed.nameRow.map((name, index) => (
                              <td key={`${name}-${index}`} className={`preview-name-cell tone-${previewGroups.tones[index] ?? 0}`}>
                                {name || `열${index}`}
                              </td>
                            ))}
                          </tr>
                          <tr>
                            <th className="preview-row-label">값</th>
                            {validation.editableRow.map((value, index) => (
                              <td key={`val-${index}`} className={`preview-value-cell tone-${previewGroups.tones[index] ?? 0}`}>
                                {typeof value === "number" ? formatNumber(value) : value ?? ""}
                              </td>
                            ))}
                          </tr>
                        </tbody>
                        </table>
                      </div>
                    </div>
                    <div className="preview-scroll-note muted">모바일이나 트랙패드에서는 표를 좌우로 밀어서 나머지 계정 열을 확인할 수 있습니다.</div>
                  </div>

                  {validation.stats.total === 0 && <div className="notice">검증 결과가 없습니다. 섹션명 1행이 `유동자산`, `판관비` 같은 검증 대상 형식인지 확인해 주세요.</div>}

                  {Object.entries(validation.resultsByDate).map(([dateLabel, results]) => (
                    <section className="result-group" key={dateLabel}>
                      <div className="section-title">
                        <div>
                          <h3>{dateLabel}</h3>
                          <p className="muted result-meta">검증 {results.length}건</p>
                        </div>
                        <span className={`tag ${results.some((item) => !item.passed) ? "fail" : "pass"}`}>{results.some((item) => !item.passed) ? "실패 항목 포함" : "전부 통과"}</span>
                      </div>

                      {results.map((result, resultIndex) => {
                        const actions = result.passed ? [] : diagnoseDiff(result);
                        const resultSection = result.sect ?? result.parent;
                        const cardKey = `${dateLabel}-${result.rule}-${resultIndex}`;
                        const isOpen = resultOpenState[cardKey] ?? !result.passed;
                        return (
                          <article className={`result-card ${isOpen ? "" : "collapsed"}`} key={cardKey}>
                            <div className="result-header">
                              <div>
                                <div className={result.passed ? "status-pass" : "status-fail"}>{result.passed ? "통과" : "실패"}</div>
                                <strong>{result.rule}</strong>
                              </div>
                              <div className="result-header-actions">
                                <div className="muted">차이</div>
                                <strong className={result.passed ? "status-pass" : "status-fail"}>{formatNumber(result.diff)}원</strong>
                                <button className="collapse-toggle" onClick={() => toggleResultCard(cardKey, !result.passed)} aria-expanded={isOpen}>
                                  {isOpen ? "접기" : "펼치기"}
                                </button>
                              </div>
                            </div>
                            {isOpen && <div className="result-body">
                              {result.detail.length > 0 ? (
                                <div style={{ overflowX: "auto" }}>
                                  <table className="table">
                                    <thead>
                                      <tr>
                                        <th>계정명</th>
                                        <th>원본값</th>
                                        <th>OCR 수정값</th>
                                        <th>검증 규칙</th>
                                        <th>적용값</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {result.detail.map((detail, index) => {
                                        const currentValue = detail._col !== undefined && pasteEdits[detail._col] !== undefined ? pasteEdits[detail._col] : detail.원본값;
                                        const currentSign = displayedSignToCode(detail.부호);
                                        return (
                                          <tr key={`${detail.계정명}-${index}`}>
                                            <td>{detail.계정명}</td>
                                            <td>{formatNumber(detail.원본값)}</td>
                                            <td>
                                              {detail._col !== undefined ? (
                                                <input className="mini-input" type="number" step={1} value={String(currentValue)} onChange={(event) => updateEditableValue(detail._col!, detail.원본값, event.target.value)} />
                                              ) : (
                                                <span className="muted">자동 계산</span>
                                              )}
                                            </td>
                                            <td>
                                              <div className="sign-editor">
                                                <select
                                                  className="mini-select"
                                                  value={String(currentSign)}
                                                  onChange={(event) => updateDetailSign(resultSection, detail.계정명, Number(event.target.value) as SignCode)}
                                                >
                                                  <option value="0">가산(+)</option>
                                                  <option value="1">차감(−)</option>
                                                  <option value="2">제외</option>
                                                </select>
                                                <button
                                                  className="tiny-button"
                                                  disabled={!selectedCompany.trim()}
                                                  onClick={() => saveCompanyFix(resultSection, detail.계정명, currentSign)}
                                                >
                                                  회사별 규칙 저장
                                                </button>
                                              </div>
                                            </td>
                                            <td>{formatNumber(detail.적용값)}</td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              ) : null}

                              {result.detail.length > 0 && (
                                <div className="rule-helper muted">
                                  `OCR 수정값`은 복사/내보내기 되는 실제 데이터에 반영됩니다. `검증 규칙`은 이번 검증 해석과 회사별 규칙 저장에만 사용됩니다.
                                </div>
                              )}

                              <div className="two-col">
                                <div className="diagnosis-card">
                                  <strong>합계 비교</strong>
                                  <p className="muted">OCR 합산 {formatNumber(result.computed)}원 / 재무제표 값 {formatNumber(result.parent_val)}원</p>
                                </div>
                                <div className="diagnosis-card">
                                  <strong>누락 계정</strong>
                                  <p className="muted">{result.missing.length ? result.missing.join(", ") : "없음"}</p>
                                </div>
                              </div>

                              {!result.passed && actions.length > 0 && (
                                <div className="diagnosis-card">
                                  <strong>원인 추정과 처리 방향</strong>
                                  <p className="muted diagnosis-note">먼저 `OCR 수정값`을 확인하고, 반복되는 패턴만 `검증 규칙`으로 저장하는 흐름을 권장합니다.</p>
                                  <div className="list-editor" style={{ marginTop: 12 }}>
                                    {actions.map((action, index) => (
                                      <div key={`${action.text}-${index}`} className="notice">
                                        <div className="pre diagnosis-copy">{renderDiagnosisText(action.text)}</div>
                                        {action.fix ? (
                                          <div className="inline-actions" style={{ marginTop: 12 }}>
                                            <button className="secondary-button" onClick={() => applySessionFix(action.fix!.sect, action.fix!.acct, action.fix!.newSign)}>
                                              이번 검증 규칙 적용: {action.label}
                                            </button>
                                            <button className="ghost-button" disabled={!selectedCompany.trim()} onClick={() => saveCompanyFix(action.fix!.sect, action.fix!.acct, action.fix!.newSign)}>
                                              {selectedCompany.trim() ? `[${selectedCompany.trim()}] 회사별 검증 규칙 저장` : "회사명 입력 필요"}
                                            </button>
                                          </div>
                                        ) : null}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>}
                          </article>
                        );
                      })}
                    </section>
                  ))}

                  <div className="export-card">
                    <div className="section-title">
                      <h3>수정된 OCR 데이터 복사</h3>
                      <button className="secondary-button" onClick={copyModifiedText}>클립보드 복사</button>
                    </div>
                    <textarea className="textarea" value={validation.copyText} readOnly style={{ minHeight: 140, marginTop: 12 }} />
                  </div>
                </>
              )}
            </>
          )}

          {activeTab === "config" && (
            <>
              <div className="footer-actions">
                <div>
                  <h3 style={{ margin: 0 }}>규칙 관리</h3>
                  <p className="muted" style={{ margin: "6px 0 0" }}>붙여넣기 검증에 실제 쓰는 키워드/섹션/회사 규칙만 남겼습니다.</p>
                </div>
                <div className="inline-actions">
                  <button className="ghost-button" onClick={resetConfig}>기본값 복원</button>
                  <button className="button" onClick={saveConfigEditors}>편집값 반영</button>
                </div>
              </div>

              <div className="two-col">
                <section className="config-card">
                  <h3>부호 키워드</h3>
                  <label className="field">
                    <span>양수 우선 키워드</span>
                    <textarea className="textarea" value={logicConfig.plusOverrideKeywords.join("\n")} onChange={(event) => setLogicConfig((prev) => ({ ...prev, plusOverrideKeywords: parseKeywordList(event.target.value) }))} />
                  </label>
                  <label className="field">
                    <span>차감 키워드</span>
                    <textarea className="textarea" value={logicConfig.minusKeywords.join("\n")} onChange={(event) => setLogicConfig((prev) => ({ ...prev, minusKeywords: parseKeywordList(event.target.value) }))} />
                  </label>
                  <label className="field">
                    <span>비용 가산 키워드</span>
                    <textarea className="textarea" value={logicConfig.plusCostKeywords.join("\n")} onChange={(event) => setLogicConfig((prev) => ({ ...prev, plusCostKeywords: parseKeywordList(event.target.value) }))} />
                  </label>
                </section>

                <section className="config-card">
                  <h3>섹션 검증 범위</h3>
                  <div className="list-editor">
                    {pasteSectionRows.map((row, index) => (
                      <div className="map-row" key={`paste-map-${index}`}>
                        <input className="input" value={row.section} placeholder="섹션명" onChange={(event) => setPasteSectionRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, section: event.target.value } : item))} />
                        <input className="input" value={row.parent} placeholder="비교할 합계 계정" onChange={(event) => setPasteSectionRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, parent: event.target.value } : item))} />
                        <button className="danger-button" onClick={() => setPasteSectionRows((prev) => prev.filter((_, itemIndex) => itemIndex !== index))}>삭제</button>
                      </div>
                    ))}
                    <button className="ghost-button" onClick={() => setPasteSectionRows((prev) => [...prev, { section: "", parent: "" }])}>섹션 규칙 추가</button>
                  </div>
                </section>
              </div>

              <div className="two-col">
                <section className="config-card">
                  <h3>전역 섹션별 부호 재정의</h3>
                  <div className="list-editor">
                    {globalOverrideRows.map((row, index) => (
                      <div className="override-row" key={`global-override-${index}`}>
                        <input className="input" value={row.section} placeholder="섹션명" onChange={(event) => setGlobalOverrideRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, section: event.target.value } : item))} />
                        <input className="input" value={row.keyword} placeholder="계정명 / 키워드" onChange={(event) => setGlobalOverrideRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, keyword: event.target.value } : item))} />
                        <select className="select" value={String(row.sign)} onChange={(event) => setGlobalOverrideRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, sign: Number(event.target.value) as SignCode } : item))}>
                          <option value="0">가산(+)</option>
                          <option value="1">차감(−)</option>
                          <option value="2">제외</option>
                        </select>
                        <button className="danger-button" onClick={() => setGlobalOverrideRows((prev) => prev.filter((_, itemIndex) => itemIndex !== index))}>삭제</button>
                      </div>
                    ))}
                    <button className="ghost-button" onClick={() => setGlobalOverrideRows((prev) => [...prev, { section: "", keyword: "", sign: 0 }])}>전역 규칙 추가</button>
                  </div>
                </section>

                <section className="config-card">
                  <h3>회사별 부호 재정의</h3>
                  <p className="muted">회사명을 입력한 뒤 편집하면 브라우저 저장소에 유지됩니다.</p>
                  <div className="list-editor">
                    {companyOverrideRows.map((row, index) => (
                      <div className="override-row" key={`company-override-${index}`}>
                        <input className="input" value={row.section} placeholder="섹션명" onChange={(event) => setCompanyOverrideRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, section: event.target.value } : item))} />
                        <input className="input" value={row.keyword} placeholder="계정명 / 키워드" onChange={(event) => setCompanyOverrideRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, keyword: event.target.value } : item))} />
                        <select className="select" value={String(row.sign)} onChange={(event) => setCompanyOverrideRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, sign: Number(event.target.value) as SignCode } : item))}>
                          <option value="0">가산(+)</option>
                          <option value="1">차감(−)</option>
                          <option value="2">제외</option>
                        </select>
                        <button className="danger-button" onClick={() => setCompanyOverrideRows((prev) => prev.filter((_, itemIndex) => itemIndex !== index))}>삭제</button>
                      </div>
                    ))}
                    <button className="ghost-button" onClick={() => setCompanyOverrideRows((prev) => [...prev, { section: "", keyword: "", sign: 0 }])}>회사 규칙 추가</button>
                  </div>
                </section>
              </div>

              <section className="config-card">
                <h3>현재 설정 JSON</h3>
                <textarea className="textarea" value={configPayload} readOnly />
              </section>
            </>
          )}

          {activeTab === "export" && (
            <>
              <section className="export-card">
                <div className="section-title">
                  <h3>검증 결과 내보내기</h3>
                  <button className="button" disabled={!validation.allResults.length} onClick={exportWorkbook}>Excel 다운로드</button>
                </div>
                <p className="muted">전체 결과, 실패 항목, 현재 설정값을 `ocr-validation-results.xlsx`로 저장합니다.</p>
              </section>

              <section className="export-card">
                <h3>수정된 OCR 3행 텍스트</h3>
                <textarea className="textarea" value={validation.copyText} readOnly />
                <div className="inline-actions" style={{ marginTop: 12 }}>
                  <button className="secondary-button" onClick={copyModifiedText}>클립보드 복사</button>
                  <button
                    className="ghost-button"
                    onClick={() => {
                      const blob = new Blob([validation.copyText], { type: "text/plain;charset=utf-8" });
                      const url = URL.createObjectURL(blob);
                      const link = document.createElement("a");
                      link.href = url;
                      link.download = "modified-ocr.txt";
                      link.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    TXT 다운로드
                  </button>
                </div>
              </section>
            </>
          )}
        </section>
      </section>
    </main>
  );
}
