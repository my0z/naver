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
      const code = row.stk_cd || row.stk_no || "";
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
  await sleep(300); // ka10027 TR 호출 간 간격 (레이트리밋 방지)
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
  #modalBox .modalSub { color:#999; font-size:13px; margin-bottom:16px; }
  #modalBox .modalSub .up { color:#ff6b6b; margin-left:6px; }
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
</style>
</head>
<body>
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
    <h2>전체 목록 (등락률 5~15%)</h2>
    <table id="all">
      <thead><tr><th>종목</th><th>현재가</th><th>등락률</th><th>거래량</th></tr></thead>
      <tbody><tr><td class="empty">데이터 없음</td></tr></tbody>
    </table>
  </div>

  <div id="modalOverlay">
    <div id="modalBox">
      <h3 id="modalName">-</h3>
      <div class="modalSub"><span id="modalPrice">-</span><span class="up" id="modalRate">-</span></div>
      <a class="modalBtn chart" id="modalChartLink" target="_blank" rel="noopener">📊 종목 보기 (차트)</a>
      <a class="modalBtn price" id="modalPriceLink" target="_blank" rel="noopener">💰 현재가·호가 보기</a>
      <button class="modalBtn buy" id="modalBuyBtn">🛒 매수</button>
      <button class="modalBtn sell" id="modalSellBtn">💸 매도</button>
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
const modalChartLink = document.getElementById('modalChartLink');
const modalPriceLink = document.getElementById('modalPriceLink');
const modalBuyBtn = document.getElementById('modalBuyBtn');
const modalSellBtn = document.getElementById('modalSellBtn');
const modalCancelBtn = document.getElementById('modalCancelBtn');

function openStockModal(item) {
  modalName.textContent = item.name;
  modalPrice.textContent = fmt(item.price) + '원';
  modalRate.textContent = '+' + Number(item.rate).toFixed(2) + '%';
  modalChartLink.href = 'https://m.stock.naver.com/domestic/stock/' + item.code + '/total';
  modalPriceLink.href = 'https://finance.naver.com/item/main.naver?code=' + item.code;
  modalBuyBtn.onclick = () => tradeWithKiwoom('buy', item.code, item.name);
  modalSellBtn.onclick = () => tradeWithKiwoom('sell', item.code, item.name);
  modalOverlay.classList.add('open');
}

function closeStockModal() {
  modalOverlay.classList.remove('open');
}

modalCancelBtn.addEventListener('click', closeStockModal);
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeStockModal();
});

function tradeWithKiwoom(side, code, name) {
  const label = side === 'buy' ? '매수' : '매도';
  const btn = side === 'buy' ? modalBuyBtn : modalSellBtn;
  const btnDefaultText = side === 'buy' ? '🛒 매수' : '💸 매도';

  if (!confirm(name + ' (' + code + ') 시장가 ' + label + ' 주문을 넣을까요?\\n(모의투자/실전 여부는 서버 설정값을 따릅니다)')) {
    return;
  }
  btn.disabled = true;
  btn.textContent = '주문 처리 중...';

  fetch('/api/' + side, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code })
  })
    .then(res => res.json())
    .then(data => {
      const env = data.mock ? '[모의투자]' : '[실전]';
      if (data.ok) {
        alert(env + ' ' + name + ' ' + data.qty + '주 ' + label + ' 주문 완료\\n주문번호: ' + (data.raw?.ord_no || '-'));
      } else {
        alert(env + ' 주문 실패: ' + (data.raw?.return_msg || data.error || '알 수 없는 오류'));
      }
    })
    .catch(err => alert('주문 요청 중 오류: ' + err.message))
    .finally(() => {
      btn.disabled = false;
      btn.textContent = btnDefaultText;
    });
}

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

  const allBody = document.querySelector('#all tbody');
  allBody.innerHTML = data.latest.length
    ? data.latest.map(r => \`<tr class="clickable" data-code="\${r.code}">
        <td>\${r.name}</td>
        <td>\${fmt(r.price)}</td>
        <td class="up">+\${r.change_rate.toFixed(2)}%</td>
        <td>\${fmt(r.volume)}</td>
      </tr>\`).join('')
    : '<tr><td class="empty">데이터 없음</td></tr>';

  // 클릭용 종목 정보 매핑 (streak5 + streak3 + top5 + all 합쳐서)
  const byCode = {};
  [...data.streak5, ...data.streak3, ...data.risingTop5, ...data.latest].forEach(r => {
    byCode[r.code] = { code: r.code, name: r.name, price: r.price, rate: r.change_rate };
  });

  document.querySelectorAll('tr.clickable').forEach(tr => {
    tr.addEventListener('click', () => {
      const item = byCode[tr.dataset.code];
      if (item) openStockModal(item);
    });
  });
}

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
      await sleep(300);
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

      if (url.pathname === "/api/debug") {
        const result = await debugFetch(env);
        return Response.json(result);
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
