/**
 * 상승률 5~15%
 * - cron으로 10분마다 KOSPI/KOSDAQ 상승률 페이지를 읽어서 5~15% 구간 종목을 D1에 저장
 * - / 로 접속하면 대시보드 표시 (최상단: 직전 스냅샷보다 더 오른 TOP5)
 *
 * 배포 방법 (Wrangler 없이 대시보드로):
 * 1. Cloudflare 대시보드 > Workers & Pages > Create Worker
 * 2. 코드 편집기에 이 파일 전체 붙여넣기
 * 3. Settings > Bindings > D1 Database 추가, Variable name: DB, 연결할 DB 선택
 *    (schema.sql을 그 DB에 먼저 실행해둘 것)
 * 4. Settings > Trigger > Cron Trigger 추가: 매 10분 (아래 CRON 참고)
 *
 * 추천 Cron 표현식 (UTC 기준, 평일 09:00~15:59 KST 커버):
 *   */10 0-6 * * 1-5
 * (코드 안에서 09:00~15:30 KST가 아니면 스킵하므로 여유 있게 잡아도 됨)
 */

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  Referer: "https://finance.naver.com/",
};

const MIN_RATE = 5;
const MAX_RATE = 15;
const MAX_PAGES = 8; // 안전장치: 페이지당 50종목 기준 최대 400종목까지만 스캔

// ---------- 네이버 상승률 페이지 파싱 ----------
async function fetchRiseList(sosok) {
  // sosok=0: KOSPI, sosok=1: KOSDAQ
  const market = sosok === 0 ? "KOSPI" : "KOSDAQ";
  const results = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
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
  // 종목코드+이름: <a href="/item/main.naver?code=005930" ...>삼성전자</a>
  // 현재가: 그 뒤 첫 번째 <td class="number">숫자</td>
  // 등락률: <span class="tah p11 red02">+12.34%</span> 형태 (색상 클래스는 red/blu/nv 다양)
  // 거래량: 등락률 뒤쪽 <td class="number">숫자</td> (거래량 컬럼)
  const rowRegex =
    /<a href="\/item\/main\.naver\?code=(\d{6})"[^>]*>([^<]+)<\/a>[\s\S]*?<td class="number">([\d,]+)<\/td>[\s\S]*?<span class="tah p11 [a-z0-9]+">\s*([+-]?[\d.]+)%<\/span>[\s\S]*?<td class="number">([\d,]+)<\/td>[\s\S]*?<td class="number">([\d,]+)<\/td>/g;

  const out = [];
  let m;
  while ((m = rowRegex.exec(html)) !== null) {
    const [, code, name, priceStr, rateStr, , volumeStr] = m;
    out.push({
      code,
      name: name.trim(),
      price: parseInt(priceStr.replace(/,/g, ""), 10),
      rate: parseFloat(rateStr),
      volume: parseInt(volumeStr.replace(/,/g, ""), 10),
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
  return minutes >= 9 * 60 && minutes <= 15 * 60 + 30;
}

// ---------- Cron: 저장 ----------
async function collectAndStore(env) {
  const now = new Date();
  const capturedAt = now.toISOString();

  const [kospi, kosdaq] = await Promise.all([
    fetchRiseList(0),
    fetchRiseList(1),
  ]);
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
  return { saved: all.length, capturedAt };
}

// ---------- API: 최신 스냅샷 + 상승 TOP5 ----------
async function getLatest(env) {
  const timesRes = await env.DB.prepare(
    `SELECT DISTINCT captured_at FROM snapshots ORDER BY captured_at DESC LIMIT 2`
  ).all();
  const times = timesRes.results.map((r) => r.captured_at);
  if (times.length === 0) return { latest: [], risingTop5: [], capturedAt: null };

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

  return { latest, risingTop5, capturedAt: times[0] };
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
</style>
</head>
<body>
  <h1>🔥 급등주 스크리너</h1>
  <div class="sub" id="ts">불러오는 중...</div>

  <div class="board">
    <h2>10분 전보다 더 오른 TOP5</h2>
    <table id="top5"><tbody><tr><td class="empty">데이터 없음</td></tr></tbody></table>
  </div>

  <div class="board">
    <h2>전체 목록 (등락률 5~15%)</h2>
    <table id="all">
      <thead><tr><th>종목</th><th>현재가</th><th>등락률</th><th>거래량</th></tr></thead>
      <tbody><tr><td class="empty">데이터 없음</td></tr></tbody>
    </table>
  </div>

<script>
function fmt(n){ return Number(n).toLocaleString(); }

async function load() {
  const res = await fetch('/api/latest');
  const data = await res.json();

  document.getElementById('ts').textContent = data.capturedAt
    ? '기준 시각: ' + new Date(data.capturedAt).toLocaleString('ko-KR')
    : '아직 저장된 데이터가 없습니다';

  const top5Body = document.querySelector('#top5 tbody');
  top5Body.innerHTML = data.risingTop5.length
    ? data.risingTop5.map(r => \`<tr>
        <td>\${r.name}</td>
        <td>\${fmt(r.price)}</td>
        <td class="up">+\${r.change_rate.toFixed(2)}%</td>
        <td class="delta">▲\${r.delta.toFixed(2)}%p</td>
      </tr>\`).join('')
    : '<tr><td class="empty">직전 스냅샷 대비 상승 종목 없음</td></tr>';

  const allBody = document.querySelector('#all tbody');
  allBody.innerHTML = data.latest.length
    ? data.latest.map(r => \`<tr>
        <td>\${r.name}</td>
        <td>\${fmt(r.price)}</td>
        <td class="up">+\${r.change_rate.toFixed(2)}%</td>
        <td>\${fmt(r.volume)}</td>
      </tr>\`).join('')
    : '<tr><td class="empty">데이터 없음</td></tr>';
}

load();
setInterval(load, 60000); // 1분마다 화면 갱신 (저장 자체는 cron이 10분마다)
</script>
</body>
</html>`;
}

// ---------- 엔트리포인트 ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/latest") {
      const data = await getLatest(env);
      return Response.json(data);
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
