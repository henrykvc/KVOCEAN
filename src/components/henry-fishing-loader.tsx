"use client";

/**
 * 로그인 직후 전체 앱 로딩 화면의 애니메이션 — 정장 입은 앙리가 부두에 앉아
 * 물속의 재무제표 종이를 낚는다. 순수 SVG+CSS keyframes(이미지 에셋 없음).
 * 낚싯대가 까딱이다 주기적으로 훅 꺾이고(입질), 찌·바늘에 걸린 재무제표가
 * 같이 출렁인다. 물속엔 재무제표 종이들이 떠다니고 기포가 올라온다.
 */
export function HenryFishingLoader() {
  return (
    <div style={{ textAlign: "center" }}>
      <style>{`
@keyframes henry-rod{0%,100%{transform:rotate(0deg)}35%{transform:rotate(-2.5deg)}55%{transform:rotate(1.5deg)}72%{transform:rotate(-5deg)}82%{transform:rotate(0.5deg)}}
@keyframes henry-wave-l{0%{transform:translateX(0)}100%{transform:translateX(-48px)}}
@keyframes henry-wave-r{0%{transform:translateX(-48px)}100%{transform:translateX(0)}}
@keyframes henry-drift{0%{transform:translateX(0) rotate(0deg)}100%{transform:translateX(-780px) rotate(-10deg)}}
@keyframes henry-drift2{0%{transform:translateX(0) rotate(0deg)}100%{transform:translateX(780px) rotate(8deg)}}
@keyframes henry-sway{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(5deg)}}
@keyframes henry-bub{0%{transform:translateY(0);opacity:0}15%{opacity:.8}100%{transform:translateY(-46px);opacity:0}}
@keyframes henry-nib{0%,60%,100%{transform:translateY(0)}70%{transform:translateY(6px)}78%{transform:translateY(1px)}86%{transform:translateY(4px)}}
@keyframes henry-cloud{0%,100%{transform:translateX(0)}50%{transform:translateX(22px)}}
@keyframes henry-dot{0%,60%,100%{opacity:.15}30%{opacity:1}}
.henry-rod-g{animation:henry-rod 3.2s ease-in-out infinite;transform-origin:474px 188px}
.henry-bob-g{animation:henry-nib 3.2s ease-in-out infinite}
.henry-dot{display:inline-block;animation:henry-dot 1.4s infinite}
      `}</style>
      <svg width="100%" viewBox="0 0 680 300" role="img" aria-label="앙리가 낚시로 데이터를 가져오는 중" style={{ maxWidth: 560, display: "block", margin: "0 auto" }}>
        <defs><clipPath id="henryWaterClip"><rect x="0" y="218" width="680" height="82" /></clipPath></defs>
        {/* 구름 */}
        <g style={{ animation: "henry-cloud 9s ease-in-out infinite" }}>
          <ellipse cx="150" cy="60" rx="34" ry="12" fill="#DCE8F2" /><ellipse cx="178" cy="52" rx="24" ry="10" fill="#DCE8F2" />
        </g>
        <g style={{ animation: "henry-cloud 12s ease-in-out infinite reverse" }}>
          <ellipse cx="430" cy="40" rx="28" ry="10" fill="#E4EEF6" /><ellipse cx="452" cy="34" rx="18" ry="8" fill="#E4EEF6" />
        </g>
        {/* 바다 */}
        <rect x="0" y="218" width="680" height="82" fill="#9CC6EE" />
        <g clipPath="url(#henryWaterClip)">
          {/* 떠다니는 재무제표들 */}
          <g style={{ animation: "henry-drift 17s linear infinite" }}>
            <g transform="translate(720 246) rotate(-8)">
              <rect width="26" height="34" rx="2" fill="#EAF2FA" stroke="#B9D2E8" strokeWidth="0.7" />
              <line x1="4" y1="6" x2="16" y2="6" stroke="#54718C" strokeWidth="1.6" />
              <line x1="4" y1="12" x2="22" y2="12" stroke="#8FA9C0" strokeWidth="0.9" />
              <line x1="4" y1="16" x2="22" y2="16" stroke="#8FA9C0" strokeWidth="0.9" />
              <line x1="4" y1="20" x2="22" y2="20" stroke="#8FA9C0" strokeWidth="0.9" />
              <line x1="4" y1="24" x2="22" y2="24" stroke="#8FA9C0" strokeWidth="0.9" />
              <line x1="4" y1="28" x2="22" y2="28" stroke="#8FA9C0" strokeWidth="0.9" />
              <line x1="13" y1="10" x2="13" y2="28" stroke="#8FA9C0" strokeWidth="0.7" />
            </g>
          </g>
          <g style={{ animation: "henry-drift2 21s linear infinite", animationDelay: "-8s" }}>
            <g transform="translate(-80 272) rotate(6)">
              <rect width="22" height="29" rx="2" fill="#E2EDF8" stroke="#B9D2E8" strokeWidth="0.7" />
              <line x1="4" y1="5" x2="13" y2="5" stroke="#54718C" strokeWidth="1.4" />
              <line x1="4" y1="10" x2="18" y2="10" stroke="#8FA9C0" strokeWidth="0.8" />
              <line x1="4" y1="14" x2="18" y2="14" stroke="#8FA9C0" strokeWidth="0.8" />
              <line x1="4" y1="18" x2="18" y2="18" stroke="#8FA9C0" strokeWidth="0.8" />
              <line x1="4" y1="22" x2="18" y2="22" stroke="#8FA9C0" strokeWidth="0.8" />
            </g>
          </g>
          <g style={{ animation: "henry-drift 25s linear infinite", animationDelay: "-14s" }}>
            <g transform="translate(740 284) rotate(12)">
              <rect width="18" height="24" rx="2" fill="#DDE9F6" stroke="#B9D2E8" strokeWidth="0.6" />
              <line x1="3" y1="4.5" x2="11" y2="4.5" stroke="#54718C" strokeWidth="1.2" />
              <line x1="3" y1="9" x2="15" y2="9" stroke="#8FA9C0" strokeWidth="0.7" />
              <line x1="3" y1="13" x2="15" y2="13" stroke="#8FA9C0" strokeWidth="0.7" />
              <line x1="3" y1="17" x2="15" y2="17" stroke="#8FA9C0" strokeWidth="0.7" />
            </g>
          </g>
          {/* 기포 */}
          <circle cx="350" cy="262" r="2.4" fill="#E6F1FB" style={{ animation: "henry-bub 3.4s linear infinite" }} />
          <circle cx="358" cy="270" r="1.8" fill="#E6F1FB" style={{ animation: "henry-bub 4.1s linear infinite", animationDelay: "1.2s" }} />
          <circle cx="343" cy="274" r="1.5" fill="#E6F1FB" style={{ animation: "henry-bub 3.8s linear infinite", animationDelay: "2.1s" }} />
        </g>
        {/* 물결 */}
        <g style={{ animation: "henry-wave-l 5s linear infinite" }}>
          <path d="M-48 218 q12 -5 24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0" fill="none" stroke="#FFFFFF" strokeWidth="1.6" opacity="0.85" />
        </g>
        <g style={{ animation: "henry-wave-r 7s linear infinite" }}>
          <path d="M-48 226 q12 -4 24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0" fill="none" stroke="#C3DCF3" strokeWidth="1.2" opacity="0.8" />
        </g>
        {/* 부두 */}
        <rect x="492" y="226" width="9" height="70" fill="#8A6A4F" />
        <rect x="612" y="226" width="9" height="70" fill="#8A6A4F" />
        <rect x="470" y="214" width="210" height="11" rx="2" fill="#B08968" />
        <rect x="470" y="222" width="210" height="3" fill="#96714F" />
        {/* 앙리 — 정장 차림 */}
        <g>
          <path d="M497 206 q-4 10 -12 12 l0 6 l5 0 q9 -4 12 -12 Z" fill="#23303F" />
          <rect x="481" y="222" width="10" height="5" rx="2" fill="#1A1A18" />
          <rect x="485" y="168" width="29" height="40" rx="9" fill="#2C3E50" />
          <path d="M499 170 l-6 9 l6 22 l6 -22 Z" fill="#F4F7FA" />
          <path d="M499 173 l-3 4 l3 18 l3 -18 Z" fill="#A32D2D" />
          <path d="M492 177 q-13 4 -19 11" fill="none" stroke="#2C3E50" strokeWidth="7.5" strokeLinecap="round" />
          <circle cx="472" cy="190" r="4.5" fill="#F0C4A8" />
          <circle cx="499" cy="152" r="13.5" fill="#F0C4A8" />
          <path d="M486 149 a14 14 0 0 1 26 -5 q2 4 1 7 q-5 -6 -12 -6 q-9 0 -15 4 Z" fill="#3B2F2A" />
          <circle cx="493" cy="154" r="1.4" fill="#2C2C2A" />
          <path d="M489 161 q3 2.5 6 0" fill="none" stroke="#2C2C2A" strokeWidth="1.1" strokeLinecap="round" />
        </g>
        {/* 낚싯대 + 줄 + 찌 + 걸린 재무제표 */}
        <g className="henry-rod-g">
          <line x1="478" y1="191" x2="350" y2="100" stroke="#5F5E5A" strokeWidth="2.6" strokeLinecap="round" />
          <circle cx="468" cy="196" r="3.4" fill="#444441" />
          <g className="henry-bob-g">
            <line x1="350" y1="100" x2="350" y2="222" stroke="#7A8A99" strokeWidth="0.9" />
            <circle cx="350" cy="225" r="4.6" fill="#E24B4A" />
            <path d="M345.4 225 a4.6 4.6 0 0 0 9.2 0 Z" fill="#FFFFFF" />
            <g style={{ animation: "henry-sway 3.2s ease-in-out infinite", transformOrigin: "350px 238px" }}>
              <line x1="350" y1="229" x2="350" y2="240" stroke="#7A8A99" strokeWidth="0.8" />
              <g transform="translate(338 240) rotate(-4)">
                <rect width="25" height="33" rx="2" fill="#F4F8FC" stroke="#AECBE6" strokeWidth="0.8" />
                <line x1="4" y1="5.5" x2="15" y2="5.5" stroke="#3E5A76" strokeWidth="1.5" />
                <line x1="4" y1="11" x2="21" y2="11" stroke="#7E9CB8" strokeWidth="0.9" />
                <line x1="4" y1="15" x2="21" y2="15" stroke="#7E9CB8" strokeWidth="0.9" />
                <line x1="4" y1="19" x2="21" y2="19" stroke="#7E9CB8" strokeWidth="0.9" />
                <line x1="4" y1="23" x2="21" y2="23" stroke="#7E9CB8" strokeWidth="0.9" />
                <line x1="4" y1="27" x2="21" y2="27" stroke="#7E9CB8" strokeWidth="0.9" />
                <line x1="13" y1="9" x2="13" y2="27" stroke="#7E9CB8" strokeWidth="0.7" />
              </g>
            </g>
          </g>
        </g>
      </svg>
    </div>
  );
}

/** "앙리가 데이터 가져오는 중..." 점 세 개 깜빡임. HenryFishingLoader와 같이 쓴다. */
export function HenryLoadingDots() {
  return (
    <>
      <span className="henry-dot">.</span>
      <span className="henry-dot" style={{ animationDelay: ".25s" }}>.</span>
      <span className="henry-dot" style={{ animationDelay: ".5s" }}>.</span>
    </>
  );
}
