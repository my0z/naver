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
 * Cron (UTC 기준, 평일 KST 09:00~15:15 커버):
 *   5분 간격 0-5시(UTC)        -> KST 09:00~14:55
 *   0,5,10,15분 6시(UTC)      -> KST 15:00~15:15, 15:15에서 종료
 * (코드 안에서도 09:01~15:15 KST가 아니면 스킵하므로 이중 안전장치)
 */

const MIN_RATE = 5;
const MAX_RATE = 15;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      return { code, name, price, rate, volume };
    })
    .filter((r) => r.code);
}

async function fetchRiseListKiwoom(env, token, mrktTp, market) {
  const json = await kiwoomRankingUp(env, token, mrktTp);
  const rows = parseKiwoomRankingRows(json);
  return rows
    .filter((r) => r.rate >= MIN_RATE && r.rate <= MAX_RATE)
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
    `INSERT INTO snapshots (code, name, price, change_rate, volume, market, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const batch = all.map((s) =>
    stmt.bind(s.code, s.name, s.price, s.rate, s.volume, s.market, capturedAt)
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
      `SELECT code, name, price, change_rate, volume FROM snapshots WHERE captured_at = ?`
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
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>급등주 스크리너 (5~15%)</title>
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
  #modalDetail { margin-bottom:14px; }
  .detailLoading, .detailError { color:#888; font-size:13px; padding:8px 0; }
  .detailError { color:#ff8787; }
  .detailGrid { display:grid; grid-template-columns:1fr 1fr; gap:8px; background:#151515; border-radius:10px; padding:10px 12px; font-size:12px; color:#999; }
  .detailGrid b { display:block; font-size:14px; color:#eee; margin-top:2px; }
  .detailGrid b.up { color:#ff6b6b; }
  .chartRange { font-size:11px; color:#888; text-align:center; margin-top:4px; }
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
  .modalBtn {
    display:block; width:100%; box-sizing:border-box; text-align:center;
    padding:14px; margin-bottom:10px; border-radius:10px; border:none;
    font-size:15px; font-weight:600; text-decoration:none; cursor:pointer;
  }
  .modalBtn.chart { background:#2a2a2a; color:#eee; }
  .modalBtn.price { background:#2a2a2a; color:#eee; }
  .modalBtn.buy { background:#ff6b6b; color:#111; }
  .modalBtn.sell { background:#4d9fff; color:#111; }
  .modalBtn.cancel { background:transparent; color:#888; margin-bottom:0; padding:10px; }
  .streakBoard h2 { color:#ffd43b; }
  .streakBoard.streak5 h2 { color:#69db7c; }
  .streakBadge { color:#ffd43b; font-size:11px; margin-left:6px; }
  #reloadBtn {
    position:fixed; right:14px; top:50%; transform:translateY(-50%);
    width:50px; height:50px; border-radius:50%; border:none;
    background:#ff6b6b; color:#111; font-size:22px; z-index:90;
    box-shadow:0 2px 8px rgba(0,0,0,0.4); cursor:pointer;
  }
  #reloadBtn.spinning { animation:spin 0.6s linear; }
  @keyframes spin { from{ transform:translateY(-50%) rotate(0deg); } to{ transform:translateY(-50%) rotate(360deg); } }
</style>
</head>
<body>
  <button id="reloadBtn" title="새로고침">🔄</button>
  <h1>🔥 급등주 스크리너</h1>
  <div class="sub" id="ts">불러오는 중...</div>

  <div class="board streakBoard streak5">
    <h2>🚀 5연속 상승 종목</h2>
    <table id="streak5"><tbody><tr><td class="empty">데이터 없음</td></tr></tbody></table>
  </div>

  <div class="board streakBoard">
    <h2>⚡ 3연속 상승 종목</h2>
    <table id="streak3"><tbody><tr><td class="empty">데이터 없음</td></tr></tbody></table>
  </div>

  <div class="board">
    <h2>5분 전보다 더 오른 TOP5</h2>
    <table id="top5"><tbody><tr><td class="empty">데이터 없음</td></tr></tbody></table>
  </div>

  <div class="board">
    <div class="boardHeadRow">
      <h2>전체 목록 (등락률 5~15%)</h2>
      <div class="sortToggle">
        <button class="sortBtn" id="sortByRate">등락률순</button>
        <button class="sortBtn active" id="sortByVolumeDesc">거래량 많은순</button>
        <button class="sortBtn" id="sortByVolumeAsc">거래량 적은순</button>
      </div>
    </div>
    <table id="all">
      <thead><tr><th>종목</th><th>현재가</th><th>등락률</th><th>거래량</th></tr></thead>
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
      <div id="modalDetail"></div>
      <div class="periodRow" id="periodRow">
        <button class="periodBtn" data-period="T">틱</button>
        <button class="periodBtn" data-period="1">1분</button>
        <button class="periodBtn active" data-period="5">5분</button>
        <button class="periodBtn" data-period="15">15분</button>
        <button class="periodBtn" data-period="30">30분</button>
        <button class="periodBtn" data-period="D">일봉</button>
        <button class="periodBtn" data-period="W">주봉</button>
        <button class="periodBtn" data-period="M">월봉</button>
      </div>
      <button class="modalBtn price" id="modalPriceBtn">💰 현재가 새로고침</button>
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
const modalCancelBtn = document.getElementById('modalCancelBtn');
let currentModalCode = null;
let currentModalName = null;
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const KIWOOM_ANDROID_PACKAGE = 'com.kiwoom.heromts';
const KIWOOM_APPSTORE = 'https://apps.apple.com/kr/app/id1570370057';

function launchKiwoomApp() {
  if (/Android/i.test(navigator.userAgent)) {
    window.location.href = 'intent://#Intent;package=' + KIWOOM_ANDROID_PACKAGE + ';end';
  } else {
    window.location.href = KIWOOM_APPSTORE;
  }
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
  modalName.textContent = item.name;
  modalCodeBadge.textContent = '코드: ' + item.code + ' (복사됨)';
  modalPrice.textContent = fmt(item.price) + '원';
  modalRate.textContent = '+' + Number(item.rate).toFixed(2) + '%';
  periodRow.querySelectorAll('.periodBtn').forEach(b => b.classList.toggle('active', b.dataset.period === '5'));
  modalPriceBtn.onclick = () => showQuote(item.code);
  modalOverlay.classList.add('open');
  showChart(item.code, '5');
}

periodRow.addEventListener('click', (e) => {
  const btn = e.target.closest('.periodBtn');
  if (!btn || !currentModalCode) return;
  periodRow.querySelectorAll('.periodBtn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  showChart(currentModalCode, btn.dataset.period);
});

function closeStockModal() {
  modalOverlay.classList.remove('open');
}

modalCancelBtn.addEventListener('click', closeStockModal);
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeStockModal();
});

function showQuote(code) {
  modalDetail.innerHTML = '<div class="detailLoading">불러오는 중...</div>';
  fetch('/api/quote?code=' + code)
    .then(res => res.json())
    .then(data => {
      if (!data.ok) {
        modalDetail.innerHTML = '<div class="detailError">조회 실패: ' + (data.error || '알 수 없는 오류') + '</div>';
        return;
      }
      modalDetail.innerHTML =
        '<div class="detailGrid">' +
        '<div>현재가<b>' + fmt(data.price) + '원</b></div>' +
        '<div>등락률<b class="up">' + data.rate.toFixed(2) + '%</b></div>' +
        '<div>시가<b>' + fmt(data.open) + '원</b></div>' +
        '<div>고가<b>' + fmt(data.high) + '원</b></div>' +
        '<div>저가<b>' + fmt(data.low) + '원</b></div>' +
        '<div>거래량<b>' + fmt(data.volume) + '</b></div>' +
        '</div>';
    })
    .catch(err => {
      modalDetail.innerHTML = '<div class="detailError">조회 요청 오류: ' + err.message + '</div>';
    });
}

const PERIOD_LABEL = { 'T':'틱차트', '1':'1분봉', '5':'5분봉', '15':'15분봉', '30':'30분봉', 'D':'일봉', 'W':'주봉', 'M':'월봉' };

function showChart(code, period) {
  modalDetail.innerHTML = '<div class="detailLoading">차트 불러오는 중...</div>';
  fetch('/api/chart?code=' + code + '&period=' + period)
    .then(res => res.json())
    .then(data => {
      if (!data.ok || !data.prices || data.prices.length < 2) {
        modalDetail.innerHTML = '<div class="detailError">차트 데이터 없음' + (data.error ? (': ' + data.error) : '') + '</div>';
        return;
      }
      modalDetail.innerHTML = renderSparkline(data.prices, period);
    })
    .catch(err => {
      modalDetail.innerHTML = '<div class="detailError">차트 요청 오류: ' + err.message + '</div>';
    });
}

function renderSparkline(prices, period) {
  const w = 340, h = 120, pad = 6;
  const min = Math.min(...prices), max = Math.max(...prices);
  const range = (max - min) || 1;
  const stepX = (w - pad * 2) / (prices.length - 1);
  const points = prices.map((p, i) => {
    const x = pad + i * stepX;
    const y = h - pad - ((p - min) / range) * (h - pad * 2);
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
  const up = prices[prices.length - 1] >= prices[0];
  const color = up ? '#ff6b6b' : '#4d9fff';
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '">' +
    '<polyline points="' + points + '" fill="none" stroke="' + color + '" stroke-width="2" />' +
    '</svg>' +
    '<div class="chartRange">' + fmt(min) + '원 ~ ' + fmt(max) + '원 (' + (PERIOD_LABEL[period] || period) + ')</div>';
}

let latestList = [];
let byCodeMap = {};
let currentSort = 'volumeDesc';

function renderAllTable() {
  const sorted = [...latestList].sort((a, b) =>
    currentSort === 'volumeDesc' ? b.volume - a.volume
    : currentSort === 'volumeAsc' ? a.volume - b.volume
    : b.change_rate - a.change_rate
  );
  const allBody = document.querySelector('#all tbody');
  allBody.innerHTML = sorted.length
    ? sorted.map(r => \`<tr class="clickable" data-code="\${r.code}">
        <td>\${r.name}</td>
        <td>\${fmt(r.price)}</td>
        <td class="up">+\${r.change_rate.toFixed(2)}%</td>
        <td>\${fmt(r.volume)}</td>
      </tr>\`).join('')
    : '<tr><td class="empty">데이터 없음</td></tr>';

  allBody.querySelectorAll('tr.clickable').forEach(tr => {
    tr.addEventListener('click', () => {
      const item = byCodeMap[tr.dataset.code];
      if (item) openStockModal(item);
    });
  });
}

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

async function load() {
  const res = await fetch('/api/latest');
  const data = await res.json();

  document.getElementById('ts').textContent = data.capturedAt
    ? '기준 시각: ' + new Date(data.capturedAt).toLocaleString('ko-KR')
    : '아직 저장된 데이터가 없습니다';

  const streak5Body = document.querySelector('#streak5 tbody');
  streak5Body.innerHTML = data.streak5.length
    ? data.streak5.map(r => \`<tr class="clickable" data-code="\${r.code}">
        <td>\${r.name}</td>
        <td>\${fmt(r.price)}</td>
        <td class="up">+\${r.change_rate.toFixed(2)}%</td>
        <td class="delta">5연속<span class="streakBadge">▲\${r.totalGain.toFixed(2)}%p</span></td>
      </tr>\`).join('')
    : '<tr><td class="empty">5연속 상승 종목 없음</td></tr>';

  const streak3Body = document.querySelector('#streak3 tbody');
  streak3Body.innerHTML = data.streak3.length
    ? data.streak3.map(r => \`<tr class="clickable" data-code="\${r.code}">
        <td>\${r.name}</td>
        <td>\${fmt(r.price)}</td>
        <td class="up">+\${r.change_rate.toFixed(2)}%</td>
        <td class="delta">3연속<span class="streakBadge">▲\${r.totalGain.toFixed(2)}%p</span></td>
      </tr>\`).join('')
    : '<tr><td class="empty">3연속 상승 종목 없음</td></tr>';

  const top5Body = document.querySelector('#top5 tbody');
  top5Body.innerHTML = data.risingTop5.length
    ? data.risingTop5.map(r => \`<tr class="clickable" data-code="\${r.code}">
        <td>\${r.name}</td>
        <td>\${fmt(r.price)}</td>
        <td class="up">+\${r.change_rate.toFixed(2)}%</td>
        <td class="delta">▲\${r.delta.toFixed(2)}%p</td>
      </tr>\`).join('')
    : '<tr><td class="empty">직전 스냅샷 대비 상승 종목 없음</td></tr>';

  latestList = data.latest;

  // 클릭용 종목 정보 매핑 (streak5 + streak3 + top5 + all 합쳐서)
  byCodeMap = {};
  [...data.streak5, ...data.streak3, ...data.risingTop5, ...data.latest].forEach(r => {
    byCodeMap[r.code] = { code: r.code, name: r.name, price: r.price, rate: r.change_rate };
  });

  renderAllTable();

  document.querySelectorAll('#streak5 tr.clickable, #streak3 tr.clickable, #top5 tr.clickable').forEach(tr => {
    tr.addEventListener('click', () => {
      const item = byCodeMap[tr.dataset.code];
      if (item) openStockModal(item);
    });
  });
}

document.getElementById('reloadBtn').addEventListener('click', (e) => {
  e.target.classList.add('spinning');
  load().finally(() => setTimeout(() => e.target.classList.remove('spinning'), 600));
});

load();
setInterval(load, 60000); // 1분마다 화면 갱신 (저장 자체는 cron이 5분마다)
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

async function kiwoomIssueToken(env) {
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
  return data.token;
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

function parseKiwoomChart(json) {
  let rows = [];
  for (const key of Object.keys(json)) {
    if (Array.isArray(json[key])) {
      rows = json[key];
      break;
    }
  }
  return rows
    .map((row) => abs(row.cur_prc ?? row.close_pric))
    .filter((v) => v > 0)
    .reverse(); // 응답이 최신순이면 시간순으로 뒤집기
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

// ---------- 엔트리포인트 ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/latest") {
        const data = await getLatest(env);
        return Response.json(data);
      }

      if (url.pathname === "/api/buy" && request.method === "POST") {
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
        try {
          const { code } = await request.json();
          if (!code) return Response.json({ ok: false, error: "code 누락" }, { status: 400 });
          const result = await kiwoomSellOrder(env, code);
          return Response.json(result);
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

      if (url.pathname === "/api/chart") {
        try {
          const code = url.searchParams.get("code");
          const period = url.searchParams.get("period") || "5";
          if (!code) return Response.json({ ok: false, error: "code 누락" }, { status: 400 });
          const token = await kiwoomIssueToken(env);
          const raw = await kiwoomChart(env, token, code, period);
          const prices = parseKiwoomChart(raw);
          return Response.json({ ok: true, prices });
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
          return Response.json({ ok: true, rawKeys: Object.keys(raw), rawSample: JSON.stringify(raw).slice(0, 1500) });
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
