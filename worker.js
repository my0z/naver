/**
 * 키움 REST API 기반 5~15% 상승 종목 스크리너
 * - cron으로 키움 ka10027(전일대비등락률상위요청)을 호출해 KOSPI/KOSDAQ 5~15% 구간 종목을 D1에 저장
 * - / 로 접속하면 대시보드 표시 (최상단: 5연속/3연속 상승, 그 아래: 직전 대비 TOP5, 전체 목록)
 * - 예전엔 네이버 금융 페이지를 스크래핑했으나, 네이버가 Cloudflare 계열 IP를 차단하는 것으로
 *   보여 키움 REST API(시세조회 TR)로 전환함. 매수/매도 주문에 쓰던 앱키/시크릿을 그대로 재사용.
 *
 * 배포: GitHub 연동 (Cloudflare Workers Builds) 사용
 * - wrangler.toml 에 D1 바인딩 / cron 트리거가 정의되어 있음
 * - D1 스키마(snapshots 테이블)는 별도 schema.sql로 미리 생성해둘 것
 * - KIWOOM_APP_KEY / KIWOOM_APP_SECRET 시크릿 필요 (Cloudflare 대시보드에서 Secret으로 등록)
 *
 * Cron (UTC 기준, 평일 KST 09:01~15:15 커버):
 *   2분 간격으로 실행 (UTC 0-6시 범위, 실제 경계는 isMarketHoursKST()에서 처리)
 *   (키움 TR 초당1건 제한에는 여유있게 안 걸림. D1 무료플랜 일 5만건 쓰기 제한 감안한 값)
 * (코드 안에서도 09:01~15:15 KST가 아니면 스킵하므로 이중 안전장치)
 */

import { unzipSync } from "fflate";

const MIN_RATE = 5;
const MAX_RATE = 15;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 일반종목 필터 (ETF/ETN/인버스/레버리지 등 제외) ----------
const NON_STOCK_KEYWORD = /(ETN|ETF|인버스|레버리지|선물|커버드콜|합성|파생결합|TDF|액티브|스팩|리츠|맥쿼리인프라)/i;
const ETF_BRAND_PREFIX =
  /^(KODEX|TIGER|KBSTAR|KIWOOM|ACE|SOL|RISE|PLUS|HANARO|KOSEF|KINDEX|TIMEFOLIO|마이다스|파워|WOORI|히어로즈|신한|대신|KTOP|FOCUS|네비게이터|파빌리온|우리|코세프|VITA|1Q|삼성|미래에셋|한투|마이티|WON|IBK|메리츠)\s?[0-9A-Za-z가-힣]*(200|100|150|300|배당|채권|국고채|MSCI|합성)/i;

function isRegularStock(name) {
  if (!name) return false;
  if (NON_STOCK_KEYWORD.test(name)) return false;
  if (ETF_BRAND_PREFIX.test(name)) return false;
  return true;
}

// ---------- 키움 REST API: 등락률 상위 조회 (ka10027) ----------
// mrktTp: "001"=코스피, "101"=코스닥
async function kiwoomRankingUp(env, token, mrktTp) {
  const res = await fetch(`${kiwoomHost(env)}/api/dostk/rkinfo`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      authorization: `Bearer ${token}`,
      "cont-yn": "N",
      "next-key": "",
      "api-id": "ka10027", // 전일대비등락률상위요청
    },
    body: JSON.stringify({
      mrkt_tp: mrktTp,
      sort_tp: "1", // 1: 상승률
      trde_qty_cnd: "0000", // 거래량조건: 전체조회
      updown_incls: "1", // 상하한 포함
      stk_cnd: "0", // 종목조건: 전체조회
      crd_cnd: "0", // 신용조건: 전체조회
      pric_cnd: "0", // 가격조건: 전체조회
      trde_prica_cnd: "0", // 거래대금조건: 전체조회
      flu_cnd: "1", // 등락구분: 상승
      stex_tp: "3", // 거래소구분: 통합
    }),
  });
  const data = await res.json();
  if (!res.ok || data.return_code !== 0) {
    throw new Error(`ka10027 실패(mrkt_tp=${mrktTp}): ${JSON.stringify(data)}`);
  }
  return data;
}

// 응답에서 return_code/return_msg를 제외한 첫 배열 필드를 데이터로 간주 후 필드명 유연 매핑
function parseKiwoomRankingRows(json) {
  let rows = [];
  for (const key of Object.keys(json)) {
    if (Array.isArray(json[key])) {
      rows = json[key];
      break;
    }
  }
  return rows
    .map((row) => {
      const code = (row.stk_cd || row.stk_no || "").split("_")[0];
      const name = row.stk_nm || row.stk_name || "";
      const price =
        Math.abs(parseInt(String(row.cur_prc ?? "0").replace(/[^\d-]/g, ""), 10)) || 0;
      const rate = parseFloat(row.flu_rt ?? row.updn_rt ?? "0") || 0;
      const volume =
        Math.abs(
          parseInt(String(row.now_trde_qty ?? row.trde_qty ?? "0").replace(/[^\d-]/g, ""), 10)
        ) || 0;
      const cntrStr = parseFloat(row.cntr_str ?? "0") || 0; // 체결강도 (100 초과: 매수세 우위)
      const buyReq =
        Math.abs(parseInt(String(row.buy_req ?? "0").replace(/[^\d-]/g, ""), 10)) || 0; // 매수잔량
      const selReq =
        Math.abs(parseInt(String(row.sel_req ?? "0").replace(/[^\d-]/g, ""), 10)) || 0; // 매도잔량
      return { code, name, price, rate, volume, cntrStr, buyReq, selReq };
    })
    .filter((r) => r.code);
}

async function fetchRiseListKiwoom(env, token, mrktTp, market) {
  const json = await kiwoomRankingUp(env, token, mrktTp);
  const rows = parseKiwoomRankingRows(json);
  return rows
    .filter((r) => r.rate >= MIN_RATE && r.rate <= MAX_RATE && isRegularStock(r.name))
    .map((r) => ({ ...r, market }));
}

// ---------- KST 시간 체크 ----------
function isMarketHoursKST(date) {
  const kst = new Date(
    date.toLocaleString("en-US", { timeZone: "Asia/Seoul" })
  );
  const day = kst.getDay(); // 0=Sun
  if (day === 0 || day === 6) return false;
  const minutes = kst.getHours() * 60 + kst.getMinutes();
  return minutes >= 9 * 60 + 1 && minutes <= 15 * 60 + 15; // 09:01 ~ 15:15
}

// ---------- Cron: 저장 ----------
async function collectAndStore(env) {
  const now = new Date();
  const capturedAt = now.toISOString();

  const token = await kiwoomIssueToken(env);
  const kospi = await fetchRiseListKiwoom(env, token, "001", "KOSPI");
  await sleep(1100); // ka10027은 초당 1건 제한 -> 여유있게 1.1초 대기
  const kosdaq = await fetchRiseListKiwoom(env, token, "101", "KOSDAQ");
  const all = [...kospi, ...kosdaq];
  if (all.length === 0) return { saved: 0 };

  const stmt = env.DB.prepare(
    `INSERT INTO snapshots (code, name, price, change_rate, volume, market, captured_at, cntr_str, buy_req, sel_req)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const batch = all.map((s) =>
    stmt.bind(
      s.code, s.name, s.price, s.rate, s.volume, s.market, capturedAt,
      s.cntrStr, s.buyReq, s.selReq
    )
  );
  await env.DB.batch(batch);

  const deleted = await purgeOldRows(env);
  return { saved: all.length, capturedAt, deleted };
}

// 7일 지난 데이터 삭제
async function purgeOldRows(env) {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const result = await env.DB.prepare(
    `DELETE FROM snapshots WHERE captured_at < ?`
  )
    .bind(cutoff)
    .run();
  return result.meta?.changes ?? 0;
}

// N번 연속 상승 종목 계산 (times[0]이 최신). requiredUps번의 구간이 전부 상승이어야 함
function computeStreak(times, snapByTime, requiredUps) {
  if (times.length < requiredUps + 1) return [];
  const result = [];
  for (const code of snapByTime[times[0]].keys()) {
    const rows = [];
    let ok = true;
    for (let i = 0; i <= requiredUps; i++) {
      const row = snapByTime[times[i]]?.get(code);
      if (!row) { ok = false; break; }
      rows.push(row);
    }
    if (!ok) continue;

    let allUp = true;
    for (let i = 0; i < requiredUps; i++) {
      if (rows[i].change_rate <= rows[i + 1].change_rate) { allUp = false; break; }
    }
    if (allUp) {
      result.push({ ...rows[0], totalGain: rows[0].change_rate - rows[requiredUps].change_rate });
    }
  }
  result.sort((a, b) => b.totalGain - a.totalGain);
  return result;
}

// ---------- API: 최신 스냅샷 + 상승 TOP5 + 3/5연속 상승 ----------
async function getLatest(env) {
  const timesRes = await env.DB.prepare(
    `SELECT DISTINCT captured_at FROM snapshots ORDER BY captured_at DESC LIMIT 6`
  ).all();
  const times = timesRes.results.map((r) => r.captured_at);
  if (times.length === 0) {
    return { latest: [], risingTop5: [], streak3: [], streak5: [], capturedAt: null };
  }

  const latestRes = await env.DB.prepare(
    `SELECT * FROM snapshots WHERE captured_at = ? ORDER BY change_rate DESC`
  )
    .bind(times[0])
    .all();
  const latest = latestRes.results;

  let risingTop5 = [];
  if (times.length > 1) {
    const prevRes = await env.DB.prepare(
      `SELECT code, change_rate FROM snapshots WHERE captured_at = ?`
    )
      .bind(times[1])
      .all();
    const prevMap = new Map(prevRes.results.map((r) => [r.code, r.change_rate]));

    risingTop5 = latest
      .filter((r) => prevMap.has(r.code))
      .map((r) => ({ ...r, delta: r.change_rate - prevMap.get(r.code) }))
      .filter((r) => r.delta > 0)
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 5);
  }

  // 3연속/5연속 상승 계산에 필요한 스냅샷을 한 번에 로드
  const snapByTime = {};
  for (const t of times) {
    const r = await env.DB.prepare(
      `SELECT code, name, price, change_rate, volume, cntr_str, buy_req, sel_req FROM snapshots WHERE captured_at = ?`
    )
      .bind(t)
      .all();
    snapByTime[t] = new Map(r.results.map((row) => [row.code, row]));
  }

  const streak3 = computeStreak(times, snapByTime, 3);
  const streak5 = computeStreak(times, snapByTime, 5);

  return { latest, risingTop5, streak3, streak5, capturedAt: times[0] };
}

// ---------- 대시보드 HTML ----------
function renderDashboard() {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>급등주 스크리너 (5~15%)</title>
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#111111">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="급등주">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg">
<style>
  body { font-family: -apple-system, sans-serif; background:#111; color:#eee; margin:0; padding:16px; }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { color:#888; font-size:12px; margin-bottom:16px; }
  .board { background:#1c1c1c; border-radius:12px; padding:12px; margin-bottom:20px; }
  .board h2 { font-size:14px; margin:0 0 8px; color:#ff6b6b; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { padding:6px 4px; text-align:right; border-bottom:1px solid #2a2a2a; }
  th:first-child, td:first-child { text-align:left; }
  .up { color:#ff6b6b; }
  .down { color:#4d9fff; }
  .delta { color:#ffd43b; }
  .empty { color:#666; padding:12px 0; }
  tr.clickable { cursor:pointer; }
  tr.clickable:active { background:#2a2a2a; }

  /* 모달 */
  #modalOverlay {
    display:none; position:fixed; inset:0; background:rgba(0,0,0,0.6);
    z-index:100; align-items:flex-end; justify-content:center;
  }
  #modalOverlay.open { display:flex; }
  #modalBox {
    background:#1c1c1c; width:100%; max-width:420px; border-radius:16px 16px 0 0;
    padding:20px 16px 24px; animation:slideUp .15s ease-out;
  }
  @keyframes slideUp { from{ transform:translateY(20px); opacity:0; } to{ transform:translateY(0); opacity:1; } }
  #modalBox h3 { margin:0 0 2px; font-size:17px; }
  .clickableName { cursor:pointer; text-decoration:underline dotted; }
  .clickableName:active { opacity:0.6; }
  .modalHeadRow { display:flex; align-items:center; justify-content:space-between; gap:8px; }
  #modalBox .modalSub { color:#999; font-size:13px; margin-bottom:16px; }
  #modalBox .modalSub .up { color:#ff6b6b; margin-left:6px; }
  #modalDetail:empty { display:none; }
  #modalOrderBook { margin-bottom:12px; }
  .orderBookBar { display:flex; height:10px; border-radius:5px; overflow:hidden; background:#151515; }
  .orderBookBuy { background:#ff6b6b; }
  .orderBookSell { background:#4d9fff; }
  .orderBookLabel { display:flex; justify-content:space-between; font-size:11px; color:#888; margin-top:4px; }
  .orderBookLabel .buyLabel { color:#ff6b6b; }
  .orderBookLabel .sellLabel { color:#4d9fff; }
  #modalNewsLinks { display:flex; gap:8px; margin-bottom:12px; }
  .newsLink {
    flex:1; text-align:center; padding:8px 6px; border-radius:8px;
    background:#2a2a2a; color:#aaa; font-size:12px; text-decoration:none;
  }
  #modalNewsSummary { margin-bottom:12px; max-height:78px; overflow-y:auto; }
  .newsItem {
    display:block; background:#151515; border-radius:8px; padding:8px 10px;
    margin-bottom:6px; text-decoration:none;
  }
  .newsItemTitle { font-size:12px; color:#eee; font-weight:600; margin-bottom:2px; }
  .newsItemDesc { font-size:11px; color:#888; line-height:1.4; }
  #modalDartSummary { margin-bottom:12px; max-height:78px; overflow-y:auto; }
  .dartItem { border-left:2px solid #ffd43b; }
  .highGap { font-size:11px; color:#888; margin-top:2px; }
  .sellWarning { font-size:12px; color:#ff8787; background:#2a1616; border-radius:8px; padding:8px 10px; margin-top:8px; }
  .sellOk { font-size:12px; color:#69db7c; background:#16241c; border-radius:8px; padding:8px 10px; margin-top:8px; }
  .highGap b { color:#ffa94d; }
  #modalDetail { margin-bottom:14px; }
  .detailLoading, .detailError { color:#888; font-size:13px; padding:8px 0; }
  .detailError { color:#ff8787; }
  .detailGrid { display:grid; grid-template-columns:1fr 1fr; gap:8px; background:#151515; border-radius:10px; padding:10px 12px; font-size:12px; color:#999; }
  .detailGrid b { display:block; font-size:14px; color:#eee; margin-top:2px; }
  .detailGrid b.up { color:#ff6b6b; }
  .chartRange { font-size:11px; color:#888; text-align:center; margin-top:4px; }
  .chartTimeLabels { display:flex; justify-content:space-between; font-size:10px; color:#666; padding:2px 6px 0; }
  .liveDot { color:#69db7c; animation:blink 1.5s ease-in-out infinite; }
  @keyframes blink { 0%,100%{ opacity:1; } 50%{ opacity:0.2; } }
  .chartWrap { overflow:hidden; touch-action:none; cursor:grab; border-radius:8px; background:#151515; }
  .chartWrap:active { cursor:grabbing; }
  .chartWrap svg { display:block; will-change:transform; }
  .chartResetBtn { color:#4d9fff; text-decoration:underline dotted; cursor:pointer; }
  .periodRow { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px; }
  .periodBtn {
    flex:1; min-width:40px; padding:8px 4px; border-radius:8px; border:none;
    background:#2a2a2a; color:#aaa; font-size:12px; cursor:pointer;
  }
  .periodBtn.active { background:#ff6b6b; color:#111; font-weight:600; }
  .boardHeadRow { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }
  .boardHeadRow h2 { margin:0; }
  .sortToggle { display:flex; gap:6px; }
  .sortBtn { background:#2a2a2a; color:#aaa; border:none; border-radius:6px; padding:5px 10px; font-size:11px; cursor:pointer; }
  .sortBtn.active { background:#ff6b6b; color:#111; font-weight:600; }
  .tradeForm { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px; background:#151515; padding:10px; border-radius:10px; }
  .tradeForm input {
    flex:1; min-width:80px; background:#1c1c1c; border:1px solid #333; border-radius:6px;
    padding:8px; color:#eee; font-size:13px;
  }
  .tradeFormBtns { width:100%; display:flex; gap:8px; margin-top:4px; }
  #tradeStatsBar { display:flex; gap:14px; flex-wrap:wrap; }
  #tradeStatsBar b { color:#eee; }
  .tradeDelBtn { color:#666; cursor:pointer; font-size:14px; }
  .pnlPositive { color:#ff6b6b; }
  .pnlNegative { color:#4d9fff; }
  .modalBtn {
    display:block; width:100%; box-sizing:border-box; text-align:center;
    padding:14px; margin-bottom:10px; border-radius:10px; border:none;
    font-size:15px; font-weight:600; text-decoration:none; cursor:pointer;
  }
  .modalBtn.price { background:#2a2a2a; color:#eee; }
  .modalBtn.risk { background:#2a2a2a; color:#ffa94d; }
  .modalBtn.ai { background:#2a2a2a; color:#a78bfa; }
  .actionRow { display:flex; gap:8px; margin-bottom:10px; }
  .actionRow .modalBtn {
    flex:1; width:auto; margin-bottom:0; padding:10px 4px;
    font-size:12px; white-space:nowrap;
  }
  .aiAnalysisCard {
    background:#17141f; border:1px solid #4c3a80; border-radius:10px;
    padding:12px; font-size:13px; line-height:1.6; color:#ddd; margin-bottom:12px;
    white-space:pre-wrap; max-height:220px; overflow-y:auto;
  }
  .aiAnalysisNote { font-size:10px; color:#666; margin-top:6px; }
  .riskGrid { display:grid; grid-template-columns:1fr 1fr; gap:8px; background:#151515; border-radius:10px; padding:10px 12px; font-size:12px; color:#999; margin-bottom:12px; }
  .riskGrid b { display:block; font-size:15px; margin-top:2px; }
  .riskGrid .stopLoss b { color:#4d9fff; }
  .riskGrid .takeProfit b { color:#ff6b6b; }
  .riskNote { font-size:10px; color:#666; margin-top:6px; grid-column:1 / -1; }
  .modalBtn.cancel { background:transparent; color:#888; margin-bottom:0; padding:10px; }
  .streakBoard h2 { color:#ffd43b; }
  .streakBoard.streak5 h2 { color:#69db7c; }
  .topPicksBoard { border:1px solid #ffd43b; background:linear-gradient(180deg,#1c1a0f,#1c1c1c); }
  .topPicksBoard h2 { color:#ffd43b; }
  .topPicksBoard tr.clickable:active { background:#2a2410; }
  .intervalTag { font-size:11px; color:#888; font-weight:normal; }
  #goldenWindowBanner {
    background:linear-gradient(90deg,#ff6b6b,#ffa94d); color:#111; font-weight:600;
    font-size:12px; padding:8px 12px; border-radius:10px; margin-bottom:14px;
  }
  .streakBadge { color:#ffd43b; font-size:11px; margin-left:6px; }
  #reloadBtn {
    position:fixed; right:14px; top:calc(50% - 30px); transform:translateY(-50%);
    width:50px; height:50px; border-radius:50%; border:none;
    background:#ff6b6b; color:#111; font-size:22px; z-index:90;
    box-shadow:0 2px 8px rgba(0,0,0,0.4); cursor:pointer;
  }
  #reloadBtn.spinning { animation:spin 0.6s linear; }
  @keyframes spin { from{ transform:translateY(-50%) rotate(0deg); } to{ transform:translateY(-50%) rotate(360deg); } }
  #collectBtn:disabled, #patternScanBtn:disabled { opacity:0.35; cursor:not-allowed; }
  #collectBtn {
    position:fixed; right:14px; top:calc(50% + 30px); transform:translateY(-50%);
    width:50px; height:50px; border-radius:50%; border:none;
    background:#69db7c; color:#111; font-size:20px; z-index:90;
    box-shadow:0 2px 8px rgba(0,0,0,0.4); cursor:pointer;
  }
  #collectBtn.spinning { animation:spin 0.9s linear infinite; }
  #installBtn {
    position:fixed; left:50%; bottom:16px; transform:translateX(-50%);
    padding:10px 18px; border-radius:24px; border:none;
    background:#4d9fff; color:#111; font-size:14px; font-weight:600; z-index:95;
    box-shadow:0 2px 10px rgba(0,0,0,0.5); cursor:pointer; white-space:nowrap;
  }
</style>
</head>
<body>
  <button id="reloadBtn" title="화면 새로고침">🔄</button>
  <button id="collectBtn" title="지금 시세 즉시 수집">⚡</button>
  <button id="installBtn" title="홈 화면에 추가" style="display:none;">📲 앱 설치</button>
  <h1>🔥 급등주 스크리너</h1>
  <div class="sub" id="ts">불러오는 중...</div>
  <div id="goldenWindowBanner" style="display:none;"></div>

  <div class="board topPicksBoard">
    <h2>🏆 오늘의 TOP 10</h2>
    <table id="topPicks">
      <thead><tr><th>종목</th><th>현재가</th><th>등락률</th><th>점수</th></tr></thead>
      <tbody><tr><td class="empty">데이터 없음</td></tr></tbody>
    </table>
  </div>

  <div class="board">
    <div class="boardHeadRow">
      <h2>📒 내 매매 기록</h2>
      <button id="tradeLogAddBtn" class="sortBtn">기록 추가</button>
    </div>
    <div id="tradeStatsBar" class="sub" style="margin:0 0 8px;">기록 없음</div>
    <div id="tradeLogForm" style="display:none;" class="tradeForm">
      <input type="text" id="tlName" placeholder="종목명" />
      <input type="text" id="tlCode" placeholder="종목코드(선택)" />
      <input type="number" id="tlBuy" placeholder="매수가" />
      <input type="number" id="tlSell" placeholder="매도가" />
      <input type="number" id="tlQty" placeholder="수량" />
      <input type="text" id="tlNote" placeholder="메모(선택)" />
      <div class="tradeFormBtns">
        <button id="tradeLogSaveBtn" class="sortBtn active">저장</button>
        <button id="tradeLogCancelBtn" class="sortBtn">취소</button>
      </div>
    </div>
    <table id="tradeLog">
      <thead><tr><th>종목</th><th>매수/매도가</th><th>수량</th><th>손익</th><th></th></tr></thead>
      <tbody><tr><td class="empty">기록이 없습니다</td></tr></tbody>
    </table>
  </div>

  <div class="board">
    <div class="boardHeadRow">
      <h2>🔍 지난 1주일 패턴 유사 종목</h2>
      <button id="patternScanBtn" class="sortBtn">스캔 시작</button>
    </div>
    <table id="patternScan">
      <thead><tr><th>종목</th><th>유사한 날</th><th>유사도</th></tr></thead>
      <tbody><tr><td class="empty">스캔 시작 버튼을 눌러주세요</td></tr></tbody>
    </table>
  </div>

  <div class="board streakBoard streak5">
    <h2>🚀 5연속 상승 종목 <span class="intervalTag">(2분간격)</span></h2>
    <table id="streak5"><tbody><tr><td class="empty">데이터 없음</td></tr></tbody></table>
  </div>

  <div class="board streakBoard">
    <h2>⚡ 3연속 상승 종목 <span class="intervalTag">(2분간격)</span></h2>
    <table id="streak3"><tbody><tr><td class="empty">데이터 없음</td></tr></tbody></table>
  </div>

  <div class="board">
    <h2>2분 전보다 더 오른 TOP5</h2>
    <table id="top5"><tbody><tr><td class="empty">데이터 없음</td></tr></tbody></table>
  </div>

  <div class="board">
    <div class="boardHeadRow">
      <h2>전체 목록 (등락률 5~15%)</h2>
      <div class="sortToggle">
        <button class="sortBtn active" id="sortByMomentum">종합점수순</button>
        <button class="sortBtn" id="sortByRate">등락률순</button>
        <button class="sortBtn" id="sortByVolumeDesc">거래량 많은순</button>
        <button class="sortBtn" id="sortByVolumeAsc">거래량 적은순</button>
        <button class="sortBtn" id="sortByCntrStr">체결강도순</button>
        <button class="sortBtn" id="sortBySignal">신호점수순</button>
      </div>
    </div>
    <table id="all">
      <thead><tr><th>종목</th><th>현재가</th><th>등락률</th><th>거래량</th><th>체결강도</th><th>신호</th></tr></thead>
      <tbody><tr><td class="empty">데이터 없음</td></tr></tbody>
    </table>
  </div>

  <div id="modalOverlay">
    <div id="modalBox">
      <div class="modalHeadRow">
        <h3 id="modalName">-</h3>
      </div>
      <div id="modalCodeBadge" class="clickableName">코드: -</div>
      <div class="modalSub"><span id="modalPrice">-</span><span class="up" id="modalRate">-</span></div>
      <div id="modalOrderBook"></div>
      <div id="modalNewsLinks"></div>
      <div id="modalNewsSummary"></div>
      <div id="modalDartSummary"></div>
      <div id="modalDetail"></div>
      <div class="periodRow" id="periodRow">
        <button class="periodBtn" data-period="T">틱</button>
        <button class="periodBtn active" data-period="1">1분</button>
        <button class="periodBtn" data-period="5">5분</button>
        <button class="periodBtn" data-period="15">15분</button>
        <button class="periodBtn" data-period="30">30분</button>
        <button class="periodBtn" data-period="D">일봉</button>
        <button class="periodBtn" data-period="W">주봉</button>
        <button class="periodBtn" data-period="M">월봉</button>
      </div>
      <div class="actionRow">
        <button class="modalBtn price" id="modalPriceBtn">💰 현재가</button>
        <button class="modalBtn risk" id="modalRiskBtn">🎯 손절/익절</button>
        <button class="modalBtn ai" id="modalAiBtn">🤖 AI 분석</button>
      </div>
      <button class="modalBtn cancel" id="modalCancelBtn">닫기</button>
    </div>
  </div>

<script>
function fmt(n){ return Number(n).toLocaleString(); }

// ---------- 종목 클릭 모달 ----------
const modalOverlay = document.getElementById('modalOverlay');
const modalName = document.getElementById('modalName');
const modalPrice = document.getElementById('modalPrice');
const modalRate = document.getElementById('modalRate');
const modalDetail = document.getElementById('modalDetail');
const modalCodeBadge = document.getElementById('modalCodeBadge');
const periodRow = document.getElementById('periodRow');
const modalPriceBtn = document.getElementById('modalPriceBtn');
const modalRiskBtn = document.getElementById('modalRiskBtn');
const modalAiBtn = document.getElementById('modalAiBtn');
const modalCancelBtn = document.getElementById('modalCancelBtn');
let currentModalCode = null;
let currentModalName = null;
let currentModalPeriod = '5';
let currentModalView = 'chart'; // 'chart' | 'quote' - 자동갱신이 어느 화면을 새로고침할지
let chartRefreshTimer = null;
const CHART_REFRESH_MS = 3000; // 3초마다 자동 갱신 (ka10079~83 / ka10007, TR당 초당1건 제한에 여유있게 준수)
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const KIWOOM_SCHEME_URL = 'heromts://heromtshost';
const KIWOOM_PLAYSTORE = 'https://play.google.com/store/apps/details?id=com.kiwoom.heromts';
const KIWOOM_APPSTORE = 'https://apps.apple.com/kr/app/id1570370057';

function launchKiwoomApp() {
  // 실제 등록된 커스텀 스킴으로 바로 실행 (플레이스토어 경유 없음)
  window.location.href = KIWOOM_SCHEME_URL;
  // 스킴으로 안 열렸을 경우(앱 미설치 등) 잠시 후 스토어로 안내
  setTimeout(() => {
    if (document.hidden) return; // 이미 앱으로 전환됐으면 아무것도 안 함
    window.location.href = /Android/i.test(navigator.userAgent) ? KIWOOM_PLAYSTORE : KIWOOM_APPSTORE;
  }, 1200);
}

modalCodeBadge.addEventListener('click', () => {
  if (IS_MOBILE) launchKiwoomApp();
});

function openStockModal(item) {
  // 모달 뜨기 전에 종목코드부터 클립보드로 복사
  if (navigator.clipboard) {
    navigator.clipboard.writeText(item.code).catch(() => {});
  }
  currentModalName = item.name;
  currentModalCode = item.code;
  currentModalPeriod = '1';
  currentModalView = 'chart';
  modalName.textContent = item.name;
  modalCodeBadge.textContent = '코드: ' + item.code + ' (복사됨)';
  modalPrice.textContent = fmt(item.price) + '원';
  modalRate.textContent = '+' + Number(item.rate).toFixed(2) + '%';
  renderOrderBook(item.buyReq, item.selReq);
  renderNewsLinks(item.name, item.code);
  periodRow.querySelectorAll('.periodBtn').forEach(b => b.classList.toggle('active', b.dataset.period === '1'));
  modalPriceBtn.onclick = () => { currentModalView = 'quote'; showQuote(item.code); };
  modalRiskBtn.onclick = () => { currentModalView = 'risk'; showRiskLevels(item.code); };
  modalAiBtn.onclick = () => { currentModalView = 'ai'; showAiAnalysis(item); };
  modalOverlay.classList.add('open');
  setHeavyButtonsDisabled(true);
  chartFullPrices = []; chartWindowSize = 0; chartOffsetFromEnd = 0;
  showChart(item.code, '1');
  startChartAutoRefresh();
}

function setHeavyButtonsDisabled(disabled) {
  const patternBtn = document.getElementById('patternScanBtn');
  const collectBtn = document.getElementById('collectBtn');
  if (patternBtn) patternBtn.disabled = disabled;
  if (collectBtn) collectBtn.disabled = disabled;
}

// ---------- 실시간 WebSocket 관련 코드는 제거됨 ----------
// Cloudflare Workers의 fetch()/WebSocket 아웃바운드 연결이 비표준 포트(10000)를
// 프로덕션에서 지원하지 않아(80/443만 허용) 구현이 불가능하다고 확인됨.
// 3초 폴링(startChartAutoRefresh)만으로 갱신함.
periodRow.addEventListener('click', (e) => {
  const btn = e.target.closest('.periodBtn');
  if (!btn || !currentModalCode) return;
  periodRow.querySelectorAll('.periodBtn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentModalPeriod = btn.dataset.period;
  currentModalView = 'chart';
  chartFullPrices = []; chartWindowSize = 0; chartOffsetFromEnd = 0;
  showChart(currentModalCode, currentModalPeriod);
  startChartAutoRefresh(); // 기간 바뀌면 갱신 타이머 리셋
});

function startChartAutoRefresh() {
  stopChartAutoRefresh();
  chartRefreshTimer = setInterval(() => {
    if (!currentModalCode || !modalOverlay.classList.contains('open')) {
      stopChartAutoRefresh();
      return;
    }
    if (document.hidden) return; // 탭이 백그라운드면 갱신 스킵 (불필요한 API 호출 방지)
    if (currentModalView === 'quote') {
      showQuote(currentModalCode, true);
    } else if (currentModalView === 'chart') {
      showChart(currentModalCode, currentModalPeriod, true);
    }
    // 'risk'(손절/익절) 뷰는 일봉 기반이라 자동갱신 안 함
  }, CHART_REFRESH_MS);
}

function stopChartAutoRefresh() {
  if (chartRefreshTimer) {
    clearInterval(chartRefreshTimer);
    chartRefreshTimer = null;
  }
}

document.addEventListener('visibilitychange', () => {
  // 다시 화면으로 돌아왔을 때, 모달이 열려있으면 현재 보고 있던 화면 기준으로 바로 한 번 최신화
  if (!document.hidden && currentModalCode && modalOverlay.classList.contains('open')) {
    if (currentModalView === 'quote') {
      showQuote(currentModalCode, true);
    } else if (currentModalView === 'chart') {
      showChart(currentModalCode, currentModalPeriod, true);
    }
  }
});

function closeStockModal() {
  modalOverlay.classList.remove('open');
  stopChartAutoRefresh();
  setHeavyButtonsDisabled(false);
}

modalCancelBtn.addEventListener('click', closeStockModal);
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeStockModal();
});

function renderOrderBook(buyReq, selReq) {
  const el = document.getElementById('modalOrderBook');
  const total = (buyReq || 0) + (selReq || 0);
  if (!total) { el.innerHTML = ''; return; }
  const buyPct = (buyReq / total * 100).toFixed(1);
  const sellPct = (100 - buyPct).toFixed(1);
  el.innerHTML =
    '<div class="orderBookBar">' +
      '<div class="orderBookBuy" style="width:' + buyPct + '%"></div>' +
      '<div class="orderBookSell" style="width:' + sellPct + '%"></div>' +
    '</div>' +
    '<div class="orderBookLabel">' +
      '<span class="buyLabel">매수잔량 ' + fmt(buyReq) + ' (' + buyPct + '%)</span>' +
      '<span class="sellLabel">매도잔량 ' + fmt(selReq) + ' (' + sellPct + '%)</span>' +
    '</div>';
}

function renderNewsLinks(name, code) {
  const el = document.getElementById('modalNewsLinks');
  const q = encodeURIComponent(name);
  const dartQ = encodeURIComponent(name + ' 공시 dart');
  el.innerHTML =
    '<a class="newsLink" href="https://search.naver.com/search.naver?where=news&query=' + q + '" target="_blank" rel="noopener">📰 뉴스 검색</a>' +
    '<a class="newsLink" href="https://search.naver.com/search.naver?query=' + dartQ + '" target="_blank" rel="noopener">📋 DART 공시</a>';

  const summaryEl = document.getElementById('modalNewsSummary');
  summaryEl.innerHTML = '<div class="detailLoading">뉴스 불러오는 중...</div>';
  fetch('/api/news?q=' + encodeURIComponent(name))
    .then(res => res.json())
    .then(data => {
      if (!data.ok || !data.items.length) {
        summaryEl.innerHTML = '';
        return;
      }
      summaryEl.innerHTML = data.items.map(item =>
        '<a class="newsItem" href="' + item.link + '" target="_blank" rel="noopener">' +
          '<div class="newsItemTitle">' + item.title + '</div>' +
          '<div class="newsItemDesc">' + item.description + '</div>' +
        '</a>'
      ).join('');
    })
    .catch(() => { summaryEl.innerHTML = ''; });

  const dartEl = document.getElementById('modalDartSummary');
  dartEl.innerHTML = '';
  fetch('/api/disclosures?code=' + code)
    .then(res => res.json())
    .then(data => {
      if (!data.ok || !data.items || !data.items.length) return;
      dartEl.innerHTML = data.items.map(item =>
        '<a class="newsItem dartItem" href="' + item.link + '" target="_blank" rel="noopener">' +
          '<div class="newsItemTitle">📋 ' + item.title + '</div>' +
          '<div class="newsItemDesc">' + item.date + '</div>' +
        '</a>'
      ).join('');
    })
    .catch(() => {});
}

function showAiAnalysis(item) {
  modalDetail.innerHTML = '<div class="detailLoading">🤖 AI가 뉴스·공시·시세 종합 분석 중... (몇 초 소요)</div>';
  fetch('/api/ai-analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: item.code, name: item.name,
      cntrStr: item.cntrStr, buyReq: item.buyReq, selReq: item.selReq,
      signalChecks: item.signalChecks,
    }),
  })
    .then(res => res.json())
    .then(data => {
      if (!data.ok) {
        modalDetail.innerHTML = '<div class="detailError">분석 실패: ' + (data.error || '알 수 없는 오류') + '</div>';
        return;
      }
      modalDetail.innerHTML =
        '<div class="aiAnalysisCard">' + data.analysis + '</div>' +
        '<div class="aiAnalysisNote">⚠️ AI가 생성한 참고용 요약이며, 매매 추천이 아닙니다. 데이터 누락·오류 가능성 있음.</div>';
    })
    .catch(err => {
      modalDetail.innerHTML = '<div class="detailError">요청 오류: ' + err.message + '</div>';
    });
}

function showRiskLevels(code, silent) {
  if (!silent) modalDetail.innerHTML = '<div class="detailLoading">변동성(ATR) 계산 중...</div>';
  fetch('/api/risk-levels?code=' + code)
    .then(res => res.json())
    .then(data => {
      if (!data.ok) {
        if (!silent) modalDetail.innerHTML = '<div class="detailError">계산 실패: ' + (data.error || '알 수 없는 오류') + '</div>';
        return;
      }
      const riskPct = ((data.currentPrice - data.stopLoss) / data.currentPrice * 100).toFixed(2);
      const rewardPct = ((data.takeProfit - data.currentPrice) / data.currentPrice * 100).toFixed(2);
      modalDetail.innerHTML =
        '<div class="riskGrid">' +
        '<div>현재가<b>' + fmt(data.currentPrice) + '원</b></div>' +
        '<div>14일 ATR<b>' + fmt(Math.round(data.atr)) + '원</b></div>' +
        '<div class="stopLoss">손절 라인 (-' + riskPct + '%)<b>' + fmt(data.stopLoss) + '원</b></div>' +
        '<div class="takeProfit">익절 라인 (+' + rewardPct + '%)<b>' + fmt(data.takeProfit) + '원</b></div>' +
        '</div>';
    })
    .catch(err => {
      if (!silent) modalDetail.innerHTML = '<div class="detailError">요청 오류: ' + err.message + '</div>';
    });
}

function showQuote(code, silent) {
  if (!silent) modalDetail.innerHTML = '<div class="detailLoading">불러오는 중...</div>';
  fetch('/api/quote?code=' + code)
    .then(res => res.json())
    .then(data => {
      if (!data.ok) {
        if (!silent) modalDetail.innerHTML = '<div class="detailError">조회 실패: ' + (data.error || '알 수 없는 오류') + '</div>';
        return;
      }
      const gapFromHigh = data.high ? (((data.price - data.high) / data.high) * 100) : 0;
      const now = new Date().toLocaleTimeString('ko-KR');
      const cntrStr = (byCodeMap[code] && byCodeMap[code].cntrStr) || 0;

      const warnings = [];
      if (gapFromHigh <= -3) warnings.push('고점 대비 ' + gapFromHigh.toFixed(2) + '% 밀림');
      if (cntrStr > 0 && cntrStr < 95) warnings.push('체결강도 매도세 전환(' + cntrStr.toFixed(1) + ')');
      if ((byCodeMap[code] && byCodeMap[code].selReq > byCodeMap[code].buyReq)) warnings.push('매도잔량 우위 전환');
      const sellWarningHtml = warnings.length
        ? '<div class="sellWarning">⚠️ 매도 고려 신호: ' + warnings.join(' · ') + '</div>'
        : '<div class="sellOk">✅ 특별한 매도 경고 신호 없음</div>';

      modalDetail.innerHTML =
        '<div class="detailGrid">' +
        '<div>현재가<b>' + fmt(data.price) + '원</b></div>' +
        '<div>등락률<b class="up">' + data.rate.toFixed(2) + '%</b></div>' +
        '<div>시가<b>' + fmt(data.open) + '원</b></div>' +
        '<div>고가<b>' + fmt(data.high) + '원</b></div>' +
        '<div>저가<b>' + fmt(data.low) + '원</b></div>' +
        '<div>거래량<b>' + fmt(data.volume) + '</b></div>' +
        '</div>' +
        '<div class="highGap">오늘 고점 대비 <b>' + gapFromHigh.toFixed(2) + '%</b></div>' +
        sellWarningHtml +
        '<div class="chartRange"><span class="liveDot">●</span> 실시간 · ' + now + '</div>';
    })
    .catch(err => {
      if (!silent) modalDetail.innerHTML = '<div class="detailError">조회 요청 오류: ' + err.message + '</div>';
    });
}

const PERIOD_LABEL = { 'T':'틱차트', '1':'1분봉', '5':'5분봉', '15':'15분봉', '30':'30분봉', 'D':'일봉', 'W':'주봉', 'M':'월봉' };

// ---------- 차트 확대/축소/드래그 (구간을 실제로 좁혀서 그 구간의 최고/최저로 y축을 다시 잡음) ----------
let chartFullPrices = [];       // 서버에서 받은 전체 가격 배열 (과거→최신 순)
let chartFullTimes = [];        // 가격과 짝을 이루는 시간 배열
let chartWindowSize = 0;        // 현재 화면에 보여줄 포인트 개수 (작을수록 확대된 상태)
let chartOffsetFromEnd = 0;     // 최신 시점 기준으로 몇 칸 뒤로 가있는지 (0 = 최신 시점이 오른쪽 끝)
let chartDragging = false, chartDragStartX = 0, chartDragStartOffset = 0;
let chartPinchStartDist = 0, chartPinchStartWindow = 0;
const CHART_MIN_WINDOW = 6; // 이보다 더 좁게는 확대 안 함 (최소 6개 포인트는 보여줌)

function resetChartZoom() {
  chartWindowSize = chartFullPrices.length;
  chartOffsetFromEnd = 0;
  renderCurrentWindow();
}

function clampChartWindow() {
  const total = chartFullPrices.length;
  chartWindowSize = Math.max(CHART_MIN_WINDOW, Math.min(total, Math.round(chartWindowSize)));
  const maxOffset = Math.max(0, total - chartWindowSize);
  chartOffsetFromEnd = Math.max(0, Math.min(maxOffset, Math.round(chartOffsetFromEnd)));
}

function getVisibleSlice() {
  const total = chartFullPrices.length;
  const end = total - chartOffsetFromEnd; // 잘라낼 구간의 끝(미포함)
  const start = Math.max(0, end - chartWindowSize);
  return {
    prices: chartFullPrices.slice(start, end),
    times: chartFullTimes.slice(start, end),
  };
}

function renderCurrentWindow() {
  if (!chartFullPrices.length) return;
  clampChartWindow();
  const slice = getVisibleSlice();
  updateChartDOM(slice.prices, slice.times, currentModalPeriod, chartWindowSize < chartFullPrices.length);
}

// 시간 문자열(YYYYMMDDHHMMSS 또는 YYYYMMDD)을 기간에 맞게 짧은 라벨로 변환
function formatChartTime(t, period) {
  if (!t) return '';
  if (period === 'D' || period === 'W' || period === 'M') {
    return t.length >= 8 ? t.slice(4, 6) + '/' + t.slice(6, 8) : t;
  }
  const hhmmss = t.length >= 14 ? t.slice(8, 14) : t;
  return hhmmss.length >= 4 ? hhmmss.slice(0, 2) + ':' + hhmmss.slice(2, 4) : t;
}


// 드래그/핀치 중에는 DOM을 통째로 갈아끼우지 않고 기존 svg의 좌표만 갱신
// (모바일 터치는 원래 터치한 요소가 사라지면 이후 touchmove가 안 들어옴 -> PC에서만 되던 버그의 원인)
function pickLabelIndices(len) {
  if (len <= 1) return [0, 0, 0];
  return [0, Math.floor((len - 1) / 2), len - 1];
}

function updateChartDOM(prices, times, period, isZoomed) {
  const existingWrap = modalDetail.querySelector('#chartWrap');
  if (!existingWrap) {
    // 최초 렌더(새 종목/기간/차트 첫 표시)일 때만 전체 새로 그림
    modalDetail.innerHTML = renderSparkline(prices, times, period, isZoomed);
    return;
  }

  const w = 340, h = 120, pad = 6;
  const min = Math.min(...prices), max = Math.max(...prices);
  const range = (max - min) || 1;
  const stepX = prices.length > 1 ? (w - pad * 2) / (prices.length - 1) : 0;
  const points = prices.map((p, i) => {
    const x = pad + i * stepX;
    const y = h - pad - ((p - min) / range) * (h - pad * 2);
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
  const up = prices[prices.length - 1] >= prices[0];

  const polyline = existingWrap.querySelector('polyline');
  if (polyline) {
    polyline.setAttribute('points', points);
    polyline.setAttribute('stroke', up ? '#ff6b6b' : '#4d9fff');
  }

  const timeLabelSpans = modalDetail.querySelectorAll('.chartTimeLabels span');
  if (timeLabelSpans.length === 3) {
    pickLabelIndices(times.length).forEach((idx, i) => {
      timeLabelSpans[i].textContent = formatChartTime(times[idx], period);
    });
  }

  const rangeDiv = modalDetail.querySelector('.chartRange');
  if (rangeDiv) {
    const now = new Date().toLocaleTimeString('ko-KR');
    rangeDiv.innerHTML = fmt(min) + '원 ~ ' + fmt(max) + '원 (' + (PERIOD_LABEL[period] || period) +
      (isZoomed ? ' · ' + prices.length + '개 구간 확대중' : '') + ')' +
      ' <span class="liveDot">●</span> 실시간 · ' + now +
      (isZoomed ? ' · <span class="chartResetBtn" id="chartResetBtn">전체보기</span>' : '');
  }
}


function touchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

modalDetail.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#chartWrap')) return;
  chartDragging = true;
  chartDragStartX = e.clientX;
  chartDragStartOffset = chartOffsetFromEnd;
});
modalDetail.addEventListener('pointermove', (e) => {
  if (!chartDragging || !chartFullPrices.length) return;
  const wrap = modalDetail.querySelector('#chartWrap');
  const widthPx = wrap ? wrap.clientWidth : 340;
  const deltaPx = e.clientX - chartDragStartX;
  const indicesPerPx = chartWindowSize / widthPx;
  // 오른쪽으로 드래그(과거를 보고 싶음) -> offset 증가
  chartOffsetFromEnd = chartDragStartOffset + Math.round(deltaPx * indicesPerPx);
  renderCurrentWindow();
});
['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => {
  modalDetail.addEventListener(ev, () => { chartDragging = false; });
});

modalDetail.addEventListener('wheel', (e) => {
  if (!e.target.closest('#chartWrap') || !chartFullPrices.length) return;
  e.preventDefault();
  const zoomFactor = e.deltaY < 0 ? 0.85 : 1 / 0.85; // 위로 스크롤 = 확대(구간 축소)
  chartWindowSize = chartWindowSize * zoomFactor;
  renderCurrentWindow();
}, { passive: false });

modalDetail.addEventListener('touchstart', (e) => {
  if (!e.target.closest('#chartWrap')) return;
  if (e.touches.length === 2) {
    chartPinchStartDist = touchDist(e.touches);
    chartPinchStartWindow = chartWindowSize;
  }
}, { passive: true });
modalDetail.addEventListener('touchmove', (e) => {
  if (!e.target.closest('#chartWrap') || !chartFullPrices.length) return;
  if (e.touches.length === 2) {
    e.preventDefault();
    const dist = touchDist(e.touches);
    if (chartPinchStartDist > 0) {
      // 손가락을 벌릴수록(dist 커짐) 구간을 좁혀서(확대) 세밀하게 보여줌
      chartWindowSize = chartPinchStartWindow / (dist / chartPinchStartDist);
      renderCurrentWindow();
    }
  }
}, { passive: false });

modalDetail.addEventListener('dblclick', (e) => {
  if (!e.target.closest('#chartWrap')) return;
  resetChartZoom();
});

modalDetail.addEventListener('click', (e) => {
  if (e.target.id === 'chartResetBtn') resetChartZoom();
});

function showChart(code, period, silent) {
  if (!silent) modalDetail.innerHTML = '<div class="detailLoading">차트 불러오는 중...</div>';
  fetch('/api/chart?code=' + code + '&period=' + period)
    .then(res => res.json())
    .then(data => {
      if (!data.ok || !data.prices || data.prices.length < 2) {
        if (!silent) {
          modalDetail.innerHTML = '<div class="detailError">차트 데이터 없음' + (data.error ? (': ' + data.error) : '') + '</div>';
        }
        return;
      }
      const wasFullView = chartWindowSize === 0 || chartWindowSize >= chartFullPrices.length;
      chartFullPrices = data.prices;
      chartFullTimes = data.times || [];
      if (!silent || wasFullView) {
        // 새로 열었거나 이전에 확대 안 한 상태였으면 항상 전체 보기 유지
        chartWindowSize = chartFullPrices.length;
        chartOffsetFromEnd = 0;
      }
      renderCurrentWindow();
    })
    .catch(err => {
      if (!silent) {
        modalDetail.innerHTML = '<div class="detailError">차트 요청 오류: ' + err.message + '</div>';
      }
    });
}

function renderSparkline(prices, times, period, isZoomed) {
  const w = 340, h = 120, pad = 6;
  const min = Math.min(...prices), max = Math.max(...prices);
  const range = (max - min) || 1;
  const stepX = prices.length > 1 ? (w - pad * 2) / (prices.length - 1) : 0;
  const points = prices.map((p, i) => {
    const x = pad + i * stepX;
    const y = h - pad - ((p - min) / range) * (h - pad * 2);
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
  const up = prices[prices.length - 1] >= prices[0];
  const color = up ? '#ff6b6b' : '#4d9fff';
  const now = new Date().toLocaleTimeString('ko-KR');
  const labelIdxs = pickLabelIndices(times.length);
  const timeLabelsHtml = '<div class="chartTimeLabels">' +
    labelIdxs.map(idx => '<span>' + formatChartTime(times[idx], period) + '</span>').join('') +
    '</div>';
  return '<div class="chartWrap" id="chartWrap">' +
    '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '">' +
    '<polyline points="' + points + '" fill="none" stroke="' + color + '" stroke-width="1.5" vector-effect="non-scaling-stroke" />' +
    '</svg>' +
    '</div>' +
    timeLabelsHtml +
    '<div class="chartRange">' + fmt(min) + '원 ~ ' + fmt(max) + '원 (' + (PERIOD_LABEL[period] || period) +
    (isZoomed ? ' · ' + prices.length + '개 구간 확대중' : '') + ')' +
    ' <span class="liveDot">●</span> 실시간 · ' + now +
    (isZoomed ? ' · <span class="chartResetBtn" id="chartResetBtn">전체보기</span>' : '') + '</div>';
}

let latestList = [];
let byCodeMap = {};
let currentSort = 'momentum';

function computeMomentumScores(latest, streak3Codes, streak5Codes) {
  if (!latest.length) return;
  const rates = latest.map(r => r.change_rate);
  const cntrs = latest.map(r => r.cntr_str || 0);
  const vols = latest.map(r => Math.log((r.volume || 0) + 1));
  const norm = (v, min, max) => (max > min ? (v - min) / (max - min) : 0.5);
  const rMin = Math.min(...rates), rMax = Math.max(...rates);
  const cMin = Math.min(...cntrs), cMax = Math.max(...cntrs);
  const vMin = Math.min(...vols), vMax = Math.max(...vols);

  latest.forEach(r => {
    let score =
      norm(r.change_rate, rMin, rMax) * 0.25 +
      norm(r.cntr_str || 0, cMin, cMax) * 0.35 +
      norm(Math.log((r.volume || 0) + 1), vMin, vMax) * 0.20;
    if (streak3Codes.has(r.code)) score += 0.10;
    if (streak5Codes.has(r.code)) score += 0.15;
    r.momentumScore = score;
  });
}

// 신호 점수: 4개 조건 체크(검증된 전략 아님, 참고용 필터일 뿐)
// 1) 체결강도 105 이상  2) 매수잔량>매도잔량  3) 거래량 상위 30% 이내  4) 3연속 이상 상승중
// 지금까지 만든 지표(신호점수/종합점수/연속상승) + 저가 동전주 감점(작전주 위험, 나무위키 단타매매 기법)
function computeTopPicks(latest, streak5Codes) {
  return [...latest]
    .map(r => {
      let score = (r.signalScore || 0) * 10 + (r.momentumScore || 0) * 5 + (streak5Codes.has(r.code) ? 3 : 0);
      if ((r.price || 0) < 2000) score -= 3; // 천원대 동전주는 작전주/불안정 위험 높다고 알려짐
      return { ...r, topScore: score };
    })
    .sort((a, b) => b.topScore - a.topScore)
    .slice(0, 10);
}

function computeSignalScores(latest, streak3Codes, streak5Codes) {
  if (!latest.length) return;
  const volSorted = [...latest].map(r => r.volume || 0).sort((a, b) => b - a);
  const top30Cutoff = volSorted[Math.max(0, Math.floor(volSorted.length * 0.3) - 1)] || 0;
  const tradeValSorted = [...latest].map(r => (r.price || 0) * (r.volume || 0)).sort((a, b) => b - a);
  const tradeVal30Cutoff = tradeValSorted[Math.max(0, Math.floor(tradeValSorted.length * 0.3) - 1)] || 0;

  latest.forEach(r => {
    let n = 0;
    const checks = [];
    const tradeValue = (r.price || 0) * (r.volume || 0);
    if ((r.cntr_str || 0) >= 105) { n++; checks.push('체결강도 105+'); }
    if ((r.buy_req || 0) > (r.sel_req || 0)) { n++; checks.push('매수잔량 우위'); }
    if ((r.volume || 0) >= top30Cutoff) { n++; checks.push('거래량 상위30%'); }
    if (streak3Codes.has(r.code) || streak5Codes.has(r.code)) { n++; checks.push('연속상승 중'); }
    if (tradeValue >= tradeVal30Cutoff) { n++; checks.push('거래대금 상위30%'); }
    r.signalScore = n;
    r.signalChecks = checks;
    r.tradeValue = tradeValue;
  });
}

// 테이블을 통째로 갈아엎지 않고, 바뀐 셀만 업데이트 + 신규/삭제 행만 추가/제거
// (기존 DOM 노드를 최대한 재사용해서 화면 깜빡임 없이 데이터만 바뀌게)
function patchTable(tbody, items, renderCells, emptyMessage, onRowClick) {
  onRowClick = onRowClick || (item => { const mapped = byCodeMap[item.code]; if (mapped) openStockModal(mapped); });
  if (!items.length) {
    if (tbody.children.length !== 1 || !tbody.querySelector('.empty')) {
      tbody.innerHTML = '<tr><td class="empty">' + emptyMessage + '</td></tr>';
    }
    return;
  }

  const existing = {};
  tbody.querySelectorAll('tr[data-code]').forEach(tr => { existing[tr.dataset.code] = tr; });
  // 빈 상태 플레이스홀더가 남아있으면 제거
  const placeholder = tbody.querySelector('td.empty');
  if (placeholder) placeholder.closest('tr').remove();

  let prevNode = null;
  items.forEach(item => {
    const cells = renderCells(item);
    let tr = existing[item.code];
    if (tr) {
      const tds = tr.children;
      cells.forEach((html, i) => {
        if (tds[i] && tds[i].innerHTML !== html) tds[i].innerHTML = html;
      });
      delete existing[item.code];
    } else {
      tr = document.createElement('tr');
      tr.className = 'clickable';
      tr.dataset.code = item.code;
      cells.forEach(html => {
        const td = document.createElement('td');
        td.innerHTML = html;
        tr.appendChild(td);
      });
      tr.addEventListener('click', () => onRowClick(item));
    }
    const wantedNext = prevNode ? prevNode.nextSibling : tbody.firstChild;
    if (wantedNext !== tr) tbody.insertBefore(tr, wantedNext);
    prevNode = tr;
  });

  Object.values(existing).forEach(tr => tr.remove());
}

function renderAllTable() {
  const sorted = [...latestList].sort((a, b) =>
    currentSort === 'volumeDesc' ? b.volume - a.volume
    : currentSort === 'volumeAsc' ? a.volume - b.volume
    : currentSort === 'cntrStr' ? (b.cntr_str || 0) - (a.cntr_str || 0)
    : currentSort === 'momentum' ? (b.momentumScore || 0) - (a.momentumScore || 0)
    : currentSort === 'signal' ? (b.signalScore || 0) - (a.signalScore || 0)
    : b.change_rate - a.change_rate
  );
  const allBody = document.querySelector('#all tbody');
  patchTable(allBody, sorted, r => [
    r.name,
    fmt(r.price),
    '<span class="up">+' + r.change_rate.toFixed(2) + '%</span>',
    fmt(r.volume),
    '<span class="' + (r.cntr_str >= 100 ? 'up' : 'down') + '">' + (r.cntr_str || 0).toFixed(1) + '</span>',
    '<span title="' + ((r.signalChecks || []).join(', ') || '조건 없음') + '">' + '🔥'.repeat(r.signalScore || 0) + '</span>',
  ], '데이터 없음');
}

document.getElementById('sortByMomentum').addEventListener('click', (e) => {
  currentSort = 'momentum';
  document.querySelectorAll('.sortBtn').forEach(b => b.classList.remove('active'));
  e.target.classList.add('active');
  renderAllTable();
});
document.getElementById('sortByRate').addEventListener('click', (e) => {
  currentSort = 'rate';
  document.querySelectorAll('.sortBtn').forEach(b => b.classList.remove('active'));
  e.target.classList.add('active');
  renderAllTable();
});
document.getElementById('sortByVolumeDesc').addEventListener('click', (e) => {
  currentSort = 'volumeDesc';
  document.querySelectorAll('.sortBtn').forEach(b => b.classList.remove('active'));
  e.target.classList.add('active');
  renderAllTable();
});
document.getElementById('sortByVolumeAsc').addEventListener('click', (e) => {
  currentSort = 'volumeAsc';
  document.querySelectorAll('.sortBtn').forEach(b => b.classList.remove('active'));
  e.target.classList.add('active');
  renderAllTable();
});
document.getElementById('sortByCntrStr').addEventListener('click', (e) => {
  currentSort = 'cntrStr';
  document.querySelectorAll('.sortBtn').forEach(b => b.classList.remove('active'));
  e.target.classList.add('active');
  renderAllTable();
});
document.getElementById('sortBySignal').addEventListener('click', (e) => {
  currentSort = 'signal';
  document.querySelectorAll('.sortBtn').forEach(b => b.classList.remove('active'));
  e.target.classList.add('active');
  renderAllTable();
});

async function load() {
  const res = await fetch('/api/latest');
  const data = await res.json();

  document.getElementById('ts').textContent = data.capturedAt
    ? '기준 시각: ' + new Date(data.capturedAt).toLocaleString('ko-KR')
    : '아직 저장된 데이터가 없습니다';

  const streak5Body = document.querySelector('#streak5 tbody');
  patchTable(streak5Body, data.streak5, r => [
    r.name,
    fmt(r.price),
    '<span class="up">+' + r.change_rate.toFixed(2) + '%</span>',
    '<span class="delta">5연속<span class="streakBadge">▲' + r.totalGain.toFixed(2) + '%p</span></span>',
  ], '5연속 상승 종목 없음');

  const streak3Body = document.querySelector('#streak3 tbody');
  patchTable(streak3Body, data.streak3, r => [
    r.name,
    fmt(r.price),
    '<span class="up">+' + r.change_rate.toFixed(2) + '%</span>',
    '<span class="delta">3연속<span class="streakBadge">▲' + r.totalGain.toFixed(2) + '%p</span></span>',
  ], '3연속 상승 종목 없음');

  const top5Body = document.querySelector('#top5 tbody');
  patchTable(top5Body, data.risingTop5, r => [
    r.name,
    fmt(r.price),
    '<span class="up">+' + r.change_rate.toFixed(2) + '%</span>',
    '<span class="delta">▲' + r.delta.toFixed(2) + '%p</span>',
  ], '직전 스냅샷 대비 상승 종목 없음');

  latestList = data.latest;
  const streak3Codes = new Set(data.streak3.map(r => r.code));
  const streak5Codes = new Set(data.streak5.map(r => r.code));
  computeMomentumScores(latestList, streak3Codes, streak5Codes);
  computeSignalScores(latestList, streak3Codes, streak5Codes);

  const topPicks = computeTopPicks(latestList, streak5Codes);
  const topPicksBody = document.querySelector('#topPicks tbody');
  patchTable(topPicksBody, topPicks, r => [
    r.name,
    fmt(r.price),
    '<span class="up">+' + r.change_rate.toFixed(2) + '%</span>',
    '🔥'.repeat(Math.max(1, Math.min(5, Math.round(r.topScore / 10)))),
  ], '데이터 없음', item => copyCodeAndLaunchApp(item.code, item.name));

  // 클릭용 종목 정보 매핑 (streak5 + streak3 + top5 + all 합쳐서)
  byCodeMap = {};
  [...data.streak5, ...data.streak3, ...data.risingTop5, ...data.latest].forEach(r => {
    byCodeMap[r.code] = {
      code: r.code, name: r.name, price: r.price, rate: r.change_rate,
      buyReq: r.buy_req || 0, selReq: r.sel_req || 0, cntrStr: r.cntr_str || 0,
      signalChecks: r.signalChecks || [],
    };
  });

  renderAllTable();
}

function copyCodeAndLaunchApp(code, name) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(code).catch(() => {});
  }
  if (IS_MOBILE) launchKiwoomApp();
  else alert(name + ' (' + code + ') 코드가 복사되었습니다.');
}

document.getElementById('reloadBtn').addEventListener('click', (e) => {
  e.target.classList.add('spinning');
  load().finally(() => setTimeout(() => e.target.classList.remove('spinning'), 600));
});

// ---------- 내 매매 기록 ----------
function loadTradeLog() {
  const statsBar = document.getElementById('tradeStatsBar');
  const tbody = document.querySelector('#tradeLog tbody');
  fetch('/api/trade-log')
    .then(res => res.json())
    .then(data => {
      if (!data.ok) {
        statsBar.textContent = '불러오기 실패: ' + (data.error || '알 수 없는 오류');
        return;
      }
      const s = data.stats;
      if (s.count === 0) {
        statsBar.textContent = '기록 없음 — 매매 끝나면 기록해보세요';
      } else {
        statsBar.innerHTML =
          '거래 <b>' + s.count + '건</b> · ' +
          '승률 <b>' + s.winRate.toFixed(1) + '%</b> (' + s.wins + '승 ' + s.losses + '패) · ' +
          '총손익 <b class="' + (s.totalPnl >= 0 ? 'pnlPositive' : 'pnlNegative') + '">' + (s.totalPnl >= 0 ? '+' : '') + fmt(s.totalPnl) + '원</b>';
      }
      tbody.innerHTML = data.trades.length
        ? data.trades.map(t => {
            const pnl = (t.sell_price - t.buy_price) * t.qty;
            return '<tr>' +
              '<td>' + t.name + '</td>' +
              '<td>' + fmt(t.buy_price) + ' → ' + fmt(t.sell_price) + '</td>' +
              '<td>' + fmt(t.qty) + '</td>' +
              '<td class="' + (pnl >= 0 ? 'pnlPositive' : 'pnlNegative') + '">' + (pnl >= 0 ? '+' : '') + fmt(pnl) + '</td>' +
              '<td><span class="tradeDelBtn" data-id="' + t.id + '">🗑️</span></td>' +
            '</tr>';
          }).join('')
        : '<tr><td class="empty">기록이 없습니다</td></tr>';

      tbody.querySelectorAll('.tradeDelBtn').forEach(btn => {
        btn.addEventListener('click', () => {
          if (!confirm('이 기록을 삭제할까요?')) return;
          fetch('/api/trade-log?id=' + btn.dataset.id, { method: 'DELETE' })
            .then(res => res.json())
            .then(() => loadTradeLog());
        });
      });
    })
    .catch(err => { statsBar.textContent = '요청 오류: ' + err.message; });
}

const tradeLogForm = document.getElementById('tradeLogForm');
document.getElementById('tradeLogAddBtn').addEventListener('click', () => {
  tradeLogForm.style.display = tradeLogForm.style.display === 'none' ? 'flex' : 'none';
});
document.getElementById('tradeLogCancelBtn').addEventListener('click', () => {
  tradeLogForm.style.display = 'none';
});
document.getElementById('tradeLogSaveBtn').addEventListener('click', () => {
  const name = document.getElementById('tlName').value.trim();
  const code = document.getElementById('tlCode').value.trim() || '-';
  const buyPrice = Number(document.getElementById('tlBuy').value);
  const sellPrice = Number(document.getElementById('tlSell').value);
  const qty = Number(document.getElementById('tlQty').value);
  const note = document.getElementById('tlNote').value.trim();
  if (!name || !buyPrice || !sellPrice || !qty) {
    alert('종목명, 매수가, 매도가, 수량은 필수예요.');
    return;
  }
  fetch('/api/trade-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, name, buyPrice, sellPrice, qty, note }),
  })
    .then(res => res.json())
    .then(data => {
      if (!data.ok) { alert('저장 실패: ' + (data.error || '알 수 없는 오류')); return; }
      ['tlName', 'tlCode', 'tlBuy', 'tlSell', 'tlQty', 'tlNote'].forEach(id => { document.getElementById(id).value = ''; });
      tradeLogForm.style.display = 'none';
      loadTradeLog();
    })
    .catch(err => alert('요청 오류: ' + err.message));
});

loadTradeLog();

document.getElementById('patternScanBtn').addEventListener('click', (e) => {
  const btn = e.target;
  const tbody = document.querySelector('#patternScan tbody');
  btn.disabled = true;
  btn.textContent = '스캔 중...';
  tbody.innerHTML = '<tr><td class="empty">지난 1주일 데이터와 비교 중... (20~30초 소요)</td></tr>';

  fetch('/api/pattern-scan')
    .then(res => res.json())
    .then(data => {
      if (!data.ok) {
        tbody.innerHTML = '<tr><td class="empty">스캔 실패: ' + (data.error || '알 수 없는 오류') + '</td></tr>';
        return;
      }
      const results = data.results.filter(r => r.score >= 0.5);
      tbody.innerHTML = results.length
        ? results.map(r => {
            const d = r.matchDate;
            const dateLabel = d.slice(4,6) + '/' + d.slice(6,8);
            const pct = (r.score * 100).toFixed(1);
            return '<tr class="clickable" data-code="' + r.code + '">' +
              '<td>' + r.name + '</td>' +
              '<td>' + dateLabel + '</td>' +
              '<td class="' + (r.score >= 0.8 ? 'up' : '') + '">' + pct + '%</td>' +
            '</tr>';
          }).join('')
        : '<tr><td class="empty">유사도 50% 이상인 종목 없음 (' + data.scanned + '종목 스캔)</td></tr>';

      tbody.querySelectorAll('tr.clickable').forEach(tr => {
        tr.addEventListener('click', () => {
          const item = byCodeMap[tr.dataset.code];
          if (item) openStockModal(item);
        });
      });
    })
    .catch(err => {
      tbody.innerHTML = '<tr><td class="empty">스캔 요청 오류: ' + err.message + '</td></tr>';
    })
    .finally(() => {
      btn.disabled = false;
      btn.textContent = '스캔 시작';
    });
});

document.getElementById('collectBtn').addEventListener('click', (e) => {
  const btn = e.target;
  btn.classList.add('spinning');
  btn.disabled = true;
  fetch('/api/run-now')
    .then(res => res.json())
    .then(data => {
      if (data.saved !== undefined) {
        return load().then(() => {
          alert('시세 수집 완료: ' + data.saved + '종목 저장됨');
        });
      } else {
        alert('수집 실패: ' + (data.error || JSON.stringify(data)));
      }
    })
    .catch(err => alert('수집 요청 오류: ' + err.message))
    .finally(() => {
      btn.classList.remove('spinning');
      btn.disabled = false;
    });
});

// 나무위키 단타매매 기법: "장 개장~9시30분이 가장 활발한 시간대"
function updateGoldenWindowBanner() {
  const kst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const minutes = kst.getHours() * 60 + kst.getMinutes();
  const banner = document.getElementById('goldenWindowBanner');
  if (minutes >= 9 * 60 && minutes <= 9 * 60 + 30) {
    banner.style.display = 'block';
    banner.textContent = '⏰ 09:00~09:30 활발 시간대';
  } else {
    banner.style.display = 'none';
  }
}
updateGoldenWindowBanner();
setInterval(updateGoldenWindowBanner, 30000);

load();
let mainRefreshTimer = setInterval(() => {
  if (document.hidden) return; // 백그라운드면 새로고침 스킵
  load();
}, 10000); // 10초마다 화면 갱신 (D1만 읽어오는 거라 키움 제한과 무관, 저장 자체는 cron이 2분마다)

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) load(); // 화면 복귀 시 즉시 최신화
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// 홈 화면에 설치되어 standalone/fullscreen으로 실행 중일 때만 시스템 내비게이션 바 숨김 재시도
const isStandalone = window.matchMedia('(display-mode: standalone)').matches
  || window.matchMedia('(display-mode: fullscreen)').matches
  || window.navigator.standalone === true;

if (isStandalone && document.documentElement.requestFullscreen) {
  const tryFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
    document.removeEventListener('click', tryFullscreen);
  };
  document.addEventListener('click', tryFullscreen, { once: true });
}

// ---------- PWA 설치 배너: 크롬 기본 하단 배너 대신 커스텀 버튼으로 필요할 때만 노출 ----------
let deferredInstallPrompt = null;
const installBtn = document.getElementById('installBtn');

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // 크롬이 자동으로 하단에 띄우는 기본 배너 억제
  deferredInstallPrompt = e;
  if (installBtn) installBtn.style.display = 'block';
});

if (installBtn) {
  installBtn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    installBtn.style.display = 'none';
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
  });
}

window.addEventListener('appinstalled', () => {
  if (installBtn) installBtn.style.display = 'none';
  deferredInstallPrompt = null;
});
</script>
</body>
</html>`;
}

// ---------- 키움 REST API: 원클릭 매수 ----------
function kiwoomHost(env) {
  return env.KIWOOM_MOCK === "false"
    ? "https://api.kiwoom.com"
    : "https://mockapi.kiwoom.com"; // 기본값: 모의투자
}

// 토큰 캐시 (Worker 인스턴스가 살아있는 동안 재사용 -> 5초 자동갱신 차트가 매번 토큰을 새로 받지 않게 함)
let cachedToken = null;
let cachedTokenExpiryMs = 0;
const TOKEN_CACHE_MS = 3 * 60 * 60 * 1000; // 3시간 (실제 유효기간보다 넉넉히 짧게 잡아 안전마진)

async function kiwoomIssueToken(env) {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiryMs) {
    return cachedToken;
  }
  const res = await fetch(`${kiwoomHost(env)}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=UTF-8" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: env.KIWOOM_APP_KEY,
      secretkey: env.KIWOOM_APP_SECRET,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.token) {
    throw new Error(`토큰 발급 실패: ${JSON.stringify(data)}`);
  }
  cachedToken = data.token;
  cachedTokenExpiryMs = now + TOKEN_CACHE_MS;
  return cachedToken;
}

async function kiwoomBuyOrder(env, code) {
  if (!env.KIWOOM_APP_KEY || !env.KIWOOM_APP_SECRET) {
    throw new Error("KIWOOM_APP_KEY / KIWOOM_APP_SECRET 시크릿이 설정되지 않았습니다.");
  }
  const qty = parseInt(env.KIWOOM_BUY_QTY || "1", 10);
  const token = await kiwoomIssueToken(env);

  const res = await fetch(`${kiwoomHost(env)}/api/dostk/ordr`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      authorization: `Bearer ${token}`,
      "cont-yn": "N",
      "next-key": "",
      "api-id": "kt10000", // 주식 매수주문
    },
    body: JSON.stringify({
      dmst_stex_tp: "KRX",
      stk_cd: code,
      ord_qty: String(qty),
      ord_uv: "0", // 시장가는 주문단가 0
      trde_tp: "3", // 3: 시장가
    }),
  });
  const data = await res.json();
  return { ok: res.ok && data.return_code === 0, qty, mock: env.KIWOOM_MOCK !== "false", raw: data };
}

async function kiwoomSellOrder(env, code) {
  if (!env.KIWOOM_APP_KEY || !env.KIWOOM_APP_SECRET) {
    throw new Error("KIWOOM_APP_KEY / KIWOOM_APP_SECRET 시크릿이 설정되지 않았습니다.");
  }
  const qty = parseInt(env.KIWOOM_SELL_QTY || env.KIWOOM_BUY_QTY || "1", 10);
  const token = await kiwoomIssueToken(env);

  const res = await fetch(`${kiwoomHost(env)}/api/dostk/ordr`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      authorization: `Bearer ${token}`,
      "cont-yn": "N",
      "next-key": "",
      "api-id": "kt10001", // 주식 매도주문
    },
    body: JSON.stringify({
      dmst_stex_tp: "KRX",
      stk_cd: code,
      ord_qty: String(qty),
      ord_uv: "0", // 시장가는 주문단가 0
      trde_tp: "3", // 3: 시장가
    }),
  });
  const data = await res.json();
  return { ok: res.ok && data.return_code === 0, qty, mock: env.KIWOOM_MOCK !== "false", raw: data };
}

// ---------- 키움 REST API: 현재가(시세표성정보) ----------
// ---------- 네이버 뉴스 검색 API ----------
function stripHtml(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'");
}

// ---------- DART: corp_code 매핑 동기화 + 공시 조회 ----------
function parseCorpCodeXml(xmlText) {
  const entries = [];
  const re = /<list>\s*<corp_code>([^<]*)<\/corp_code>\s*<corp_name>([^<]*)<\/corp_name>\s*<stock_code>([^<]*)<\/stock_code>/g;
  let m;
  while ((m = re.exec(xmlText)) !== null) {
    const stockCode = m[3].trim();
    if (stockCode.length === 6) {
      entries.push({ corp_code: m[1].trim(), corp_name: m[2].trim(), stock_code: stockCode });
    }
  }
  return entries;
}

async function syncDartCorpCodes(env) {
  if (!env.DART_API_KEY) {
    throw new Error("DART_API_KEY 시크릿이 설정되지 않았습니다.");
  }
  const res = await fetch(`https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${env.DART_API_KEY}`);
  if (!res.ok) {
    throw new Error(`DART corpCode 다운로드 실패: ${res.status}`);
  }
  const zipBytes = new Uint8Array(await res.arrayBuffer());
  const unzipped = unzipSync(zipBytes);
  const xmlBytes = unzipped["CORPCODE.xml"];
  if (!xmlBytes) {
    throw new Error("zip 안에 CORPCODE.xml이 없습니다: " + Object.keys(unzipped).join(", "));
  }
  const xmlText = new TextDecoder("utf-8").decode(xmlBytes);
  const entries = parseCorpCodeXml(xmlText);
  if (entries.length === 0) {
    throw new Error("파싱된 종목이 0개입니다. XML 형식이 예상과 다를 수 있습니다.");
  }

  const stmt = env.DB.prepare(
    `INSERT OR REPLACE INTO dart_corp_codes (stock_code, corp_code, corp_name) VALUES (?, ?, ?)`
  );
  const CHUNK = 50;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK).map((e) => stmt.bind(e.stock_code, e.corp_code, e.corp_name));
    await env.DB.batch(chunk);
  }
  return entries.length;
}

async function getDartCorpCode(env, stockCode) {
  const row = await env.DB.prepare(`SELECT corp_code, corp_name FROM dart_corp_codes WHERE stock_code = ?`)
    .bind(stockCode)
    .first();
  return row || null;
}

async function fetchDartDisclosures(env, corpCode) {
  const end = todayYYYYMMDD();
  const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const start = startDate.toISOString().slice(0, 10).replace(/-/g, "");
  const url =
    `https://opendart.fss.or.kr/api/list.json?crtfc_key=${env.DART_API_KEY}` +
    `&corp_code=${corpCode}&bgn_de=${start}&end_de=${end}&page_count=5`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== "000" && data.status !== "013") {
    // 013 = 조회된 데이터 없음 (정상 케이스)
    throw new Error(`DART 공시 조회 실패: ${JSON.stringify(data)}`);
  }
  return (data.list || []).map((item) => ({
    title: item.report_nm,
    date: item.rcept_dt,
    link: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${item.rcept_no}`,
  }));
}

// ---------- 주식 분석 에이전트 (Claude API) ----------
async function askStockExpert(env, promptText) {
  if (!env.AI) {
    throw new Error("AI 바인딩이 설정되지 않았습니다. wrangler.toml에 [ai] binding=\"AI\" 필요.");
  }
  const systemPrompt =
    "당신은 한국 주식시장 데이터를 해석하는 보조 도구입니다. " +
    "주어진 항목(가격, 등락률, 체결강도, 호가잔량, 뉴스, 공시)을 그대로 다시 나열하지 마세요 — " +
    "이미 사용자가 화면에서 다 보고 있는 정보입니다. 대신 항목들을 서로 연결지어, " +
    "지금 뭐가 특이하거나 앞뒤가 안 맞는지, 어떤 리스크 신호가 있는지를 해석해서 말하세요. " +
    "예: 뉴스/공시 내용이 오늘 상승과 시점상 관련 있어 보이는지, 체결강도와 호가잔량이 같은 " +
    "방향인지 엇갈리는지, 이런 상승 후 보통 어떤 리스크가 따르는지. " +
    "연결점이 실제로 없으면 억지로 만들지 말고 '특별한 연관성 확인 안 됨'이라고 하세요. " +
    "'사세요', '파세요', '지금이 매수 타이밍입니다' 같은 직접적인 매매 추천이나 " +
    "확정적인 가격 전망은 절대 하지 마세요. " +
    "인사말, 서론, '알겠습니다' 같은 도입부나 마무리 멘트 없이 바로 본론만 말하세요. " +
    "불릿 포인트(-) 3~5개로, 각 항목은 한 문장 이내로 짧게. 전체 300자 이내로 답하세요.";

  // Cloudflare Workers AI 무료 티어 (하루 1만 뉴런) - Llama 3.1 8B
  const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: promptText },
    ],
    max_tokens: 300,
  });
  const text = result && (result.response || result.result || result.text);
  if (!text) {
    throw new Error(`Workers AI 응답 이상: ${JSON.stringify(result)}`);
  }
  return text;
}

async function naverNewsSearch(env, query) {
  if (!env.NAVER_CLIENT_ID || !env.NAVER_CLIENT_SECRET) {
    throw new Error("NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 시크릿이 설정되지 않았습니다.");
  }
  const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(query)}&display=5&sort=date`;
  const res = await fetch(url, {
    headers: {
      "X-Naver-Client-Id": env.NAVER_CLIENT_ID,
      "X-Naver-Client-Secret": env.NAVER_CLIENT_SECRET,
    },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`네이버 뉴스 API 실패: ${JSON.stringify(data)}`);
  }
  return (data.items || []).map((item) => ({
    title: stripHtml(item.title),
    description: stripHtml(item.description),
    link: item.originallink || item.link,
    pubDate: item.pubDate,
  }));
}

async function kiwoomQuote(env, token, code) {
  const res = await fetch(`${kiwoomHost(env)}/api/dostk/mrkcond`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      authorization: `Bearer ${token}`,
      "cont-yn": "N",
      "next-key": "",
      "api-id": "ka10007", // 시세표성정보요청
    },
    body: JSON.stringify({ stk_cd: code }),
  });
  const data = await res.json();
  if (!res.ok || data.return_code !== 0) {
    throw new Error(`ka10007 실패(code=${code}): ${JSON.stringify(data)}`);
  }
  return data;
}

function abs(v) {
  return Math.abs(parseInt(String(v ?? "0").replace(/[^\d-]/g, ""), 10)) || 0;
}

function parseKiwoomQuote(json) {
  return {
    price: abs(json.cur_prc),
    rate: parseFloat(json.flu_rt ?? "0") || 0,
    open: abs(json.open_pric),
    high: abs(json.high_pric),
    low: abs(json.low_pric),
    volume: abs(json.trde_qty ?? json.now_trde_qty),
    raw: json,
  };
}

// ---------- 키움 REST API: 차트 (분/일/주/월봉 통합) ----------
function todayYYYYMMDD() {
  const kst = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const y = kst.getFullYear();
  const m = String(kst.getMonth() + 1).padStart(2, "0");
  const d = String(kst.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

// period: "1"|"3"|"5"|"10"|"15"|"30"|"45"|"60" (분봉) 또는 "D"(일봉)|"W"(주봉)|"M"(월봉)
async function kiwoomChart(env, token, code, period) {
  let apiId, body;
  if (period === "T") {
    apiId = "ka10079"; // 주식틱차트조회요청
    body = { stk_cd: code, tic_scope: "1", upd_stkpc_tp: "1" };
  } else if (period === "D") {
    apiId = "ka10081"; // 주식일봉차트조회요청
    body = { stk_cd: code, base_dt: todayYYYYMMDD(), upd_stkpc_tp: "1" };
  } else if (period === "W") {
    apiId = "ka10082"; // 주식주봉차트조회요청
    body = { stk_cd: code, base_dt: todayYYYYMMDD(), upd_stkpc_tp: "1" };
  } else if (period === "M") {
    apiId = "ka10083"; // 주식월봉차트조회요청
    body = { stk_cd: code, base_dt: todayYYYYMMDD(), upd_stkpc_tp: "1" };
  } else {
    apiId = "ka10080"; // 주식분봉차트조회요청
    body = { stk_cd: code, tic_scope: period, upd_stkpc_tp: "1" };
  }

  const res = await fetch(`${kiwoomHost(env)}/api/dostk/chart`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      authorization: `Bearer ${token}`,
      "cont-yn": "N",
      "next-key": "",
      "api-id": apiId,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.return_code !== 0) {
    throw new Error(`${apiId} 실패(code=${code}): ${JSON.stringify(data)}`);
  }
  return data;
}

// ---------- 손절/익절 라인 계산 (ATR 기반) ----------
async function kiwoomDailyOHLC(env, token, code) {
  const raw = await kiwoomChart(env, token, code, "D");
  let rows = [];
  for (const key of Object.keys(raw)) {
    if (Array.isArray(raw[key])) { rows = raw[key]; break; }
  }
  return rows
    .map((r) => ({
      high: abs(r.high_pric),
      low: abs(r.low_pric),
      close: abs(r.cur_prc ?? r.close_pric),
    }))
    .filter((r) => r.high > 0 && r.low > 0)
    .reverse(); // 과거 -> 최신
}

function computeATR(ohlc, period) {
  if (ohlc.length < 2) return null;
  const trs = [];
  for (let i = 1; i < ohlc.length; i++) {
    const cur = ohlc[i], prev = ohlc[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    trs.push(tr);
  }
  const recent = trs.slice(-period);
  return recent.reduce((s, v) => s + v, 0) / recent.length;
}

function parseKiwoomChart(json) {
  let rows = [];
  for (const key of Object.keys(json)) {
    if (Array.isArray(json[key])) {
      rows = json[key];
      break;
    }
  }
  return rows
    .map((row) => ({
      price: abs(row.cur_prc ?? row.close_pric),
      time: row.cntr_tm || row.dt || row.stk_dt || row.trde_dt || row.date || "",
    }))
    .filter((r) => r.price > 0)
    .reverse(); // 응답이 최신순이면 시간순으로 뒤집기
}

// ---------- 오늘 vs 지난 1주일 장중 패턴 유사도 스캔 ----------
function parseKiwoomMinuteHistory(json) {
  let rows = [];
  for (const key of Object.keys(json)) {
    if (Array.isArray(json[key])) { rows = json[key]; break; }
  }
  return rows
    .map((r) => {
      const tm = r.cntr_tm || "";
      return {
        date: tm.slice(0, 8),
        time: tm.slice(8, 14),
        price: abs(r.cur_prc ?? r.close_pric),
      };
    })
    .filter((r) => r.date && r.price > 0)
    .reverse(); // 응답이 최신순 -> 시간순(과거->현재)으로 뒤집기
}

function groupByDate(rows) {
  const map = {};
  for (const r of rows) {
    if (!map[r.date]) map[r.date] = [];
    map[r.date].push(r);
  }
  for (const d in map) map[d].sort((a, b) => a.time.localeCompare(b.time));
  return map;
}

// 첫 값 대비 %변화율로 정규화 (절대가격이 달라도 '모양'만 비교)
function normalizeSeries(prices) {
  if (!prices.length) return [];
  const base = prices[0] || 1;
  return prices.map((p) => ((p - base) / base) * 100);
}

// 피어슨 상관계수 (-1~1, 1에 가까울수록 모양이 비슷)
function pearsonCorrelation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 4) return null;
  a = a.slice(0, n);
  b = b.slice(0, n);
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, denomA = 0, denomB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    num += da * db;
    denomA += da * da;
    denomB += db * db;
  }
  if (denomA === 0 || denomB === 0) return null;
  return num / Math.sqrt(denomA * denomB);
}

async function scanPatternMatches(env, candidates) {
  const token = await kiwoomIssueToken(env);
  const todayStr = todayYYYYMMDD();
  const results = [];
  const debugInfo = [];

  for (const c of candidates) {
    const dbg = { code: c.code, name: c.name, todayStr };
    try {
      const raw = await kiwoomChart(env, token, c.code, "5");
      const rows = parseKiwoomMinuteHistory(raw);
      const byDate = groupByDate(rows);
      dbg.availableDates = Object.keys(byDate);
      const todayRows = byDate[todayStr];
      dbg.todayRowCount = todayRows ? todayRows.length : 0;

      if (todayRows && todayRows.length >= 4) {
        const todaySeries = normalizeSeries(todayRows.map((r) => r.price));
        let best = null;
        let comparedDays = 0;
        for (const d of Object.keys(byDate)) {
          if (d === todayStr) continue;
          const histRows = byDate[d];
          if (histRows.length < todaySeries.length) continue; // 오늘 진행분만큼 데이터 없는 날은 제외
          comparedDays++;
          const histSeries = normalizeSeries(histRows.slice(0, todaySeries.length).map((r) => r.price));
          const score = pearsonCorrelation(todaySeries, histSeries);
          if (score !== null && (!best || score > best.score)) {
            best = { date: d, score };
          }
        }
        dbg.comparedDays = comparedDays;
        if (best) {
          dbg.bestScore = best.score;
          results.push({ code: c.code, name: c.name, matchDate: best.date, score: best.score });
        }
      }
    } catch (e) {
      dbg.error = String(e.message || e);
    }
    debugInfo.push(dbg);
    await sleep(1100); // ka10080 초당 1건 제한
  }

  results.sort((a, b) => b.score - a.score);
  return { results, debugInfo };
}

// ---------- 디버그: 키움 ka10027 응답이 실제로 어떻게 오는지 확인 ----------
async function debugFetch(env) {
  const out = {};
  try {
    const token = await kiwoomIssueToken(env);
    out.tokenIssued = true;
    for (const [mrktTp, market] of [["001", "KOSPI"], ["101", "KOSDAQ"]]) {
      try {
        const json = await kiwoomRankingUp(env, token, mrktTp);
        const rows = parseKiwoomRankingRows(json);
        out[market] = {
          returnCode: json.return_code,
          returnMsg: json.return_msg,
          parsedRowCount: rows.length,
          sampleParsedRows: rows.slice(0, 3),
          rawKeys: Object.keys(json),
          rawSample: JSON.stringify(json).slice(0, 1000),
        };
      } catch (e) {
        out[market] = { error: String(e.message || e) };
      }
      await sleep(1100);
    }
  } catch (e) {
    out.tokenIssued = false;
    out.tokenError = String(e.message || e);
  }
  return out;
}

// ---------- 관리자 키 검증 (매수/매도/DART 동기화 보호) ----------
// ADMIN_KEY 시크릿이 설정 안 돼있으면 무조건 거부 (fail closed)
// 호출 방법: 헤더 X-Admin-Key: <키> 또는 쿼리스트링 ?key=<키>
function checkAdminKey(request, url, env) {
  if (!env.ADMIN_KEY) return false;
  const headerKey = request.headers.get("X-Admin-Key");
  const queryKey = url.searchParams.get("key");
  return headerKey === env.ADMIN_KEY || queryKey === env.ADMIN_KEY;
}

// ---------- 엔트리포인트 ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/manifest.json") {
        return Response.json({
          name: "급등주 스크리너",
          short_name: "급등주",
          description: "5~15% 상승 종목 실시간 스크리너",
          start_url: "/",
          scope: "/",
          display: "fullscreen",
          display_override: ["fullscreen", "standalone"],
          orientation: "portrait",
          background_color: "#111111",
          theme_color: "#111111",
          icons: [
            { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
            { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
          ],
        });
      }

      if (url.pathname === "/icon.svg") {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="20" fill="#111111"/>
  <text x="50" y="66" font-size="58" text-anchor="middle">🔥</text>
</svg>`;
        return new Response(svg, { headers: { "content-type": "image/svg+xml" } });
      }

      if (url.pathname === "/sw.js") {
        const sw = `
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  // 네트워크 우선, 실패 시 그대로 실패 반환 (실시간 데이터라 캐싱 안 함)
  e.respondWith(fetch(e.request).catch(() => new Response('오프라인 상태입니다', { status: 503 })));
});`;
        return new Response(sw, { headers: { "content-type": "application/javascript" } });
      }

      if (url.pathname === "/api/latest") {
        const data = await getLatest(env);
        return Response.json(data);
      }

      if (url.pathname === "/api/buy" && request.method === "POST") {
        if (!checkAdminKey(request, url, env)) {
          return Response.json({ ok: false, error: "인증 필요 (ADMIN_KEY)" }, { status: 401 });
        }
        try {
          const { code } = await request.json();
          if (!code) return Response.json({ ok: false, error: "code 누락" }, { status: 400 });
          const result = await kiwoomBuyOrder(env, code);
          return Response.json(result);
        } catch (e) {
          return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
        }
      }

      if (url.pathname === "/api/sell" && request.method === "POST") {
        if (!checkAdminKey(request, url, env)) {
          return Response.json({ ok: false, error: "인증 필요 (ADMIN_KEY)" }, { status: 401 });
        }
        try {
          const { code } = await request.json();
          if (!code) return Response.json({ ok: false, error: "code 누락" }, { status: 400 });
          const result = await kiwoomSellOrder(env, code);
          return Response.json(result);
        } catch (e) {
          return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
        }
      }

      if (url.pathname === "/api/admin/sync-dart-codes") {
        if (!checkAdminKey(request, url, env)) {
          return Response.json({ ok: false, error: "인증 필요 (ADMIN_KEY)" }, { status: 401 });
        }
        try {
          const count = await syncDartCorpCodes(env);
          return Response.json({ ok: true, synced: count });
        } catch (e) {
          return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
        }
      }

      if (url.pathname === "/api/disclosures") {
        try {
          const code = url.searchParams.get("code");
          if (!code) return Response.json({ ok: false, error: "code 누락" }, { status: 400 });
          const corp = await getDartCorpCode(env, code);
          if (!corp) {
            return Response.json({ ok: false, error: "DART corp_code 매핑이 없습니다. /api/admin/sync-dart-codes를 먼저 실행하세요." });
          }
          const items = await fetchDartDisclosures(env, corp.corp_code);
          return Response.json({ ok: true, corpName: corp.corp_name, items });
        } catch (e) {
          return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
        }
      }

      if (url.pathname === "/api/news") {
        try {
          const q = url.searchParams.get("q");
          if (!q) return Response.json({ ok: false, error: "q 누락" }, { status: 400 });
          const items = await naverNewsSearch(env, q);
          return Response.json({ ok: true, items });
        } catch (e) {
          return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
        }
      }

      if (url.pathname === "/api/quote") {
        try {
          const code = url.searchParams.get("code");
          if (!code) return Response.json({ ok: false, error: "code 누락" }, { status: 400 });
          const token = await kiwoomIssueToken(env);
          const raw = await kiwoomQuote(env, token, code);
          return Response.json({ ok: true, ...parseKiwoomQuote(raw) });
        } catch (e) {
          return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
        }
      }

      if (url.pathname === "/api/trade-log" && request.method === "GET") {
        try {
          const res = await env.DB.prepare(
            `SELECT * FROM trade_log ORDER BY created_at DESC LIMIT 200`
          ).all();
          const trades = res.results;
          const stats = trades.reduce(
            (acc, t) => {
              const pnl = (t.sell_price - t.buy_price) * t.qty;
              acc.totalPnl += pnl;
              acc.count += 1;
              if (pnl > 0) acc.wins += 1;
              else if (pnl < 0) acc.losses += 1;
              return acc;
            },
            { totalPnl: 0, count: 0, wins: 0, losses: 0 }
          );
          stats.winRate = stats.count > 0 ? (stats.wins / stats.count) * 100 : 0;
          return Response.json({ ok: true, trades, stats });
        } catch (e) {
          return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
        }
      }

      if (url.pathname === "/api/trade-log" && request.method === "POST") {
        try {
          const body = await request.json();
          const { code, name, buyPrice, sellPrice, qty, note } = body;
          if (!code || !name || !buyPrice || !sellPrice || !qty) {
            return Response.json({ ok: false, error: "필수 항목 누락 (code, name, buyPrice, sellPrice, qty)" }, { status: 400 });
          }
          await env.DB.prepare(
            `INSERT INTO trade_log (code, name, buy_price, sell_price, qty, note, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(code, name, buyPrice, sellPrice, qty, note || "", new Date().toISOString())
            .run();
          return Response.json({ ok: true });
        } catch (e) {
          return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
        }
      }

      if (url.pathname === "/api/trade-log" && request.method === "DELETE") {
        try {
          const id = url.searchParams.get("id");
          if (!id) return Response.json({ ok: false, error: "id 누락" }, { status: 400 });
          await env.DB.prepare(`DELETE FROM trade_log WHERE id = ?`).bind(id).run();
          return Response.json({ ok: true });
        } catch (e) {
          return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
        }
      }

      if (url.pathname === "/api/ai-analysis" && request.method === "POST") {
        try {
          const body = await request.json();
          const { code, name } = body;
          if (!code || !name) {
            return Response.json({ ok: false, error: "code, name 필요" }, { status: 400 });
          }

          const token = await kiwoomIssueToken(env);
          const [quoteRaw, newsItems, corp] = await Promise.all([
            kiwoomQuote(env, token, code).catch(() => null),
            naverNewsSearch(env, name).catch(() => []),
            getDartCorpCode(env, code).catch(() => null),
          ]);
          const quote = quoteRaw ? parseKiwoomQuote(quoteRaw) : null;
          let disclosures = [];
          if (corp) {
            disclosures = await fetchDartDisclosures(env, corp.corp_code).catch(() => []);
          }

          const lines = [`종목: ${name} (${code})`];
          if (quote) {
            lines.push(`현재가: ${quote.price}원, 등락률: ${quote.rate}%`);
            lines.push(`오늘 시가: ${quote.open}, 고가: ${quote.high}, 저가: ${quote.low}, 거래량: ${quote.volume}`);
            if (quote.high) {
              const gapFromHigh = (((quote.price - quote.high) / quote.high) * 100).toFixed(2);
              lines.push(`오늘 고점 대비: ${gapFromHigh}% (${gapFromHigh < -3 ? "고점에서 꽤 밀림" : gapFromHigh < 0 ? "고점 대비 소폭 하락" : "고점 유지 중"})`);
            }
          }
          if (body.cntrStr) {
            lines.push(`체결강도: ${body.cntrStr} (${body.cntrStr >= 105 ? "매수세 우위" : body.cntrStr < 95 ? "매도세 우위" : "중립"})`);
          }
          if (body.buyReq && body.selReq) {
            lines.push(`매수잔량: ${body.buyReq}, 매도잔량: ${body.selReq} (${body.buyReq > body.selReq ? "매수 우위" : "매도 우위"})`);
          }
          if (body.signalChecks && body.signalChecks.length) {
            lines.push(`충족된 기술적 조건: ${body.signalChecks.join(", ")}`);
          }
          if (newsItems.length) {
            lines.push("최근 뉴스:");
            newsItems.forEach((n) => lines.push(`- ${n.title}: ${n.description}`));
          } else {
            lines.push("최근 뉴스: 검색된 것 없음");
          }
          if (disclosures.length) {
            lines.push("최근 30일 공시:");
            disclosures.forEach((d) => lines.push(`- ${d.date} ${d.title}`));
          } else {
            lines.push("최근 30일 공시: 없음");
          }
          lines.push(
            "위 항목을 단순 나열하지 말고 서로 연결지어 해석하세요. 예: 뉴스/공시 내용이 오늘 등락률과 " +
            "시점상 관련 있어 보이는지, 체결강도와 호가잔량이 같은 방향을 가리키는지 엇갈리는지, " +
            "고점 대비 낙폭이 신호들과 앞뒤가 맞는지. 실제로 확인되는 연결점이 없으면 " +
            "'특별한 연관성 확인 안 됨'이라고 명시하세요."
          );

          const analysis = await askStockExpert(env, lines.join("\n"));
          return Response.json({ ok: true, analysis });
        } catch (e) {
          return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
        }
      }

      if (url.pathname === "/api/risk-levels") {
        try {
          const code = url.searchParams.get("code");
          if (!code) return Response.json({ ok: false, error: "code 누락" }, { status: 400 });
          const token = await kiwoomIssueToken(env);
          const [ohlc, quoteRaw] = await Promise.all([
            kiwoomDailyOHLC(env, token, code),
            kiwoomQuote(env, token, code),
          ]);
          const atr = computeATR(ohlc, 14);
          const quote = parseKiwoomQuote(quoteRaw);
          if (!atr) {
            return Response.json({ ok: false, error: "ATR 계산에 필요한 일봉 데이터가 부족합니다" });
          }
          return Response.json({
            ok: true,
            atr,
            currentPrice: quote.price,
            stopLoss: Math.round(quote.price - atr * 1.5),
            takeProfit: Math.round(quote.price + atr * 2),
          });
        } catch (e) {
          return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
        }
      }

      if (url.pathname === "/api/chart") {
        try {
          const code = url.searchParams.get("code");
          const period = url.searchParams.get("period") || "5";
          if (!code) return Response.json({ ok: false, error: "code 누락" }, { status: 400 });
          const token = await kiwoomIssueToken(env);
          const raw = await kiwoomChart(env, token, code, period);
          const parsed = parseKiwoomChart(raw);
          return Response.json({
            ok: true,
            prices: parsed.map((p) => p.price),
            times: parsed.map((p) => p.time),
          });
        } catch (e) {
          return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
        }
      }

      if (url.pathname === "/api/debug") {
        const result = await debugFetch(env);
        return Response.json(result);
      }

      if (url.pathname === "/api/debug-quote") {
        try {
          const code = url.searchParams.get("code") || "005930";
          const token = await kiwoomIssueToken(env);
          const raw = await kiwoomQuote(env, token, code);
          return Response.json({ ok: true, rawKeys: Object.keys(raw), raw });
        } catch (e) {
          return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
        }
      }

      if (url.pathname === "/api/debug-chart") {
        try {
          const code = url.searchParams.get("code") || "005930";
          const period = url.searchParams.get("period") || "5";
          const token = await kiwoomIssueToken(env);
          const raw = await kiwoomChart(env, token, code, period);
          let rows = [];
          for (const k of Object.keys(raw)) {
            if (Array.isArray(raw[k])) { rows = raw[k]; break; }
          }
          const times = rows.map((r) => r.cntr_tm).filter(Boolean);
          const dates = [...new Set(times.map((t) => t.slice(0, 8)))].sort();
          return Response.json({
            ok: true,
            rawKeys: Object.keys(raw),
            totalRows: rows.length,
            uniqueDates: dates,
            earliestTm: times[times.length - 1],
            latestTm: times[0],
            rawSample: JSON.stringify(raw).slice(0, 800),
          });
        } catch (e) {
          return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
        }
      }

      if (url.pathname === "/api/pattern-scan") {
        try {
          const timesRes = await env.DB.prepare(
            `SELECT DISTINCT captured_at FROM snapshots ORDER BY captured_at DESC LIMIT 1`
          ).all();
          const times = timesRes.results.map((r) => r.captured_at);
          if (times.length === 0) {
            return Response.json({ ok: false, error: "오늘 수집된 데이터가 없습니다" });
          }
          const candRes = await env.DB.prepare(
            `SELECT code, name, volume FROM snapshots WHERE captured_at = ? ORDER BY volume DESC LIMIT 15`
          )
            .bind(times[0])
            .all();
          const candidates = candRes.results;
          const { results, debugInfo } = await scanPatternMatches(env, candidates);
          return Response.json({
            ok: true,
            scanned: candidates.length,
            latestSnapshotAt: times[0],
            results,
            debugInfo,
          });
        } catch (e) {
          return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
        }
      }

      if (url.pathname === "/api/run-now") {
        // 수동 테스트용 (배포 직후 cron 기다리지 않고 바로 확인)
        const result = await collectAndStore(env);
        return Response.json(result);
      }

      return new Response(renderDashboard(), {
        headers: { "content-type": "text/html; charset=UTF-8" },
      });
    } catch (e) {
      // 처리 안 된 예외를 Cloudflare의 1101 에러 페이지 대신 그대로 노출
      return Response.json(
        { ok: false, error: String(e.message || e), stack: String(e.stack || "") },
        { status: 500 }
      );
    }
  },

  async scheduled(event, env, ctx) {
    if (!isMarketHoursKST(new Date())) return;
    ctx.waitUntil(
      collectAndStore(env).catch((e) => {
        console.error("scheduled collectAndStore 실패:", e.message || e);
      })
    );
  },
};
