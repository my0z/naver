/**
 * 네이버 상승률 5~15% 종목 스크리너
 * - cron으로 KOSPI/KOSDAQ 상승률 페이지를 읽어서 5~15% 구간 종목을 D1에 저장
 * - / 로 접속하면 대시보드 표시 (최상단: 직전 스냅샷보다 더 오른 TOP5)
 *
 * 배포: GitHub 연동 (Cloudflare Workers Builds) 사용
 * - wrangler.toml 에 D1 바인딩 / cron 트리거가 정의되어 있음
 * - D1 스키마(snapshots 테이블)는 별도 schema.sql로 미리 생성해둘 것
 *
 * Cron (UTC 기준, 평일 KST 09:00~15:15 커버):
 *   5분 간격 0-5시(UTC)        -> KST 09:00~14:55
 *   0,5,10,15분 6시(UTC)      -> KST 15:00~15:15, 15:15에서 종료
 * (코드 안에서도 09:00~15:15 KST가 아니면 스킵하므로 이중 안전장치)
 */

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  Referer: "https://finance.naver.com/",
};

const MIN_RATE = 5;
const MAX_RATE = 15;
const MAX_PAGES = 3; // CPU 절약: 페이지당 50종목 기준 시장당 최대 150종목까지만 스캔

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 네이버 상승률 페이지 파싱 ----------
async function fetchRiseList(sosok) {
  // sosok=0: KOSPI, sosok=1: KOSDAQ
  const market = sosok === 0 ? "KOSPI" : "KOSDAQ";
  const results = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    if (page > 1) await sleep(250); // 연속 요청 사이 딜레이

    const url = `https://finance.naver.com/sise/sise_rise.naver?sosok=${sosok}&page=${page}`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) break;
    const html = await res.text();

    const rows = parseRiseRows(html);
    if (rows.length === 0) break;

    let sawBelowMin = false;
    for (const row of rows) {
      if (row.rate > MAX_RATE) continue; // 15% 초과는 건너뛰고 계속 (혹시 순서 섞였을 경우 대비)
      if (row.rate < MIN_RATE) {
        sawBelowMin = true;
        continue;
      }
      results.push({ ...row, market });
    }
    // 등락률 내림차순 정렬 페이지이므로, 이 페이지에서 5% 미만이 나왔으면 다음 페이지는 볼 필요 없음
    if (sawBelowMin) break;
  }
  return results;
}

function parseRiseRows(html) {
  // 1단계: 종목코드+이름 위치만 저렴하게 스캔 (문서 전체 1패스)
  const anchorRe =
    /<a href="\/item\/main\.naver\?code=(\d{6})"[^>]*>([^<]+)<\/a>/g;

  const out = [];
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const code = m[1];
    const name = m[2].trim();

    // 2단계: 해당 종목 뒤 700자만 잘라서 그 안에서만 탐색 (문서 끝까지 안 훑음 → CPU 고정비용)
    const tail = html.slice(anchorRe.lastIndex, anchorRe.lastIndex + 700);

    const nums = [];
    const numRe = /<td class="number">([\d,]+)<\/td>/g;
    let nm;
    while (nums.length < 5 && (nm = numRe.exec(tail)) !== null) {
      nums.push(parseInt(nm[1].replace(/,/g, ""), 10));
    }

    const rateMatch = tail.match(
      /<span class="tah p11 [a-z0-9]+">\s*([+-]?[\d.]+)%<\/span>/
    );

    if (!rateMatch || nums.length < 3) continue; // 구조 매칭 실패한 행은 스킵

    out.push({
      code,
      name,
      price: nums[0],
      rate: parseFloat(rateMatch[1]),
      volume: nums[2],
    });
  }
  return out;
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

  const kospi = await fetchRiseList(0);
  await sleep(250);
  const kosdaq = await fetchRiseList(1);
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

// ---------- 디버그: 네이버 응답이 실제로 어떻게 오는지 확인 ----------
async function debugFetch() {
  const out = {};
  for (const sosok of [0, 1]) {
    const market = sosok === 0 ? "KOSPI" : "KOSDAQ";
    const url = `https://finance.naver.com/sise/sise_rise.naver?sosok=${sosok}&page=1`;
    try {
      const res = await fetch(url, { headers: HEADERS });
      const html = await res.text();
      const rows = parseRiseRows(html);
      out[market] = {
        status: res.status,
        ok: res.ok,
        htmlLength: html.length,
        rowsParsed: rows.length,
        sampleRows: rows.slice(0, 3),
        htmlSample: html.slice(0, 500),
      };
    } catch (e) {
      out[market] = { error: String(e.message || e) };
    }
  }
  return out;
}

// ---------- 엔트리포인트 ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
      const result = await debugFetch();
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
  },

  async scheduled(event, env, ctx) {
    if (!isMarketHoursKST(new Date())) return;
    ctx.waitUntil(collectAndStore(env));
  },
};
