// Local Chrome walkthrough only. This server does not call a backend or AI model.
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, randomBytes } = require("node:crypto");

const root = path.resolve(__dirname, "..");
const knownFixtures = new Set([
  "/tests/fixtures/visible.html",
  "/tests/fixtures/hidden.html",
  "/tests/fixtures/no-menu.html",
  "/tests/fixtures/upfront-no-button.html",
  "/tests/fixtures/fee-deduction.html",
  "/tests/fixtures/context-private.html",
  "/tests/fixtures/model-cases.html",
  "/tests/fixtures/flow-home.html",
  "/tests/fixtures/flow-policy.html",
  "/tests/fixtures/flow-stage.html",
  "/tests/fixtures/site-rules.html",
  "/tests/fixtures/site-login.html"
]);
const evidence = "출금하려면 5만 원을 먼저 입금하세요";
const maxBodyBytes = 32 * 1024;
// Deliberately synthetic credentials for this loopback-only mock, never a real account.
const mockUser = {id:1,username:"demo"};
const mockPassword = "Local-demo-only-2468!";
const mockSessions = new Map();
// Opt-in walkthrough only: this is synthetic enrollment, not production security.
const mockDemoEnabled = process.env.MOCK_DEMO === "1";
const mockDemoExpires = Date.now() + 60 * 60 * 1000;
const mockDemoIdentities = new Map();
const mockDemoIdentityCap = 20;
const mockDemoDailyLimit = 20;
const mockDemoScanCounts = new Map();
function issueMockSession(user, expires = Date.now() + 30 * 60 * 1000, extra = {}) {
  const token = randomBytes(32).toString("hex");
  const session = {user,expires_at:new Date(expires).toISOString(),...extra};
  mockSessions.set(token,session);
  return {token,...session};
}
function authorizedMock(request) {
  const match = /^Bearer ([A-Fa-f0-9]{64})$/.exec(request.headers.authorization || "");
  const session = match && mockSessions.get(match[1]);
  if (!session || Date.parse(session.expires_at) <= Date.now()) return null;
  return {token:match[1],...session};
}

function port(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`${name} must be a port number (0–65535).`);
  }
  return value;
}

const pagePort = port("PAGE_PORT", 4173);
const apiPort = port("API_PORT", 8000);
const failureDelay = Number(process.env.FAIL_DELAY_MS ?? 6000);
if (!Number.isFinite(failureDelay) || failureDelay < 0 || failureDelay > 60000) {
  throw new Error("FAIL_DELAY_MS must be between 0 and 60000.");
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function readJson(request, response) {
  return new Promise(resolve => {
    const chunks = [];
    let length = 0;
    let tooLarge = false;
    request.on("data", chunk => {
      length += chunk.length;
      if (length > maxBodyBytes) {
        if (!tooLarge) json(response, 413, { detail: "Mock request exceeds 32 KiB." });
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      if (tooLarge) return resolve(null);
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
        resolve(payload);
      } catch {
        json(response, 400, { detail: "A JSON object is required." });
        resolve(null);
      }
    });
    request.on("error", () => resolve(null));
  });
}

const pages = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (request.method !== "GET" || !knownFixtures.has(pathname)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const html = await fs.readFile(path.join(root, pathname));
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    });
    response.end(html);
  } catch {
    response.writeHead(404).end();
  }
});

const api = http.createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Access-Control-Expose-Headers", "Retry-After");
  const pathname = new URL(request.url,"http://localhost").pathname;
  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }
  if (pathname === "/api/v1/auth/demo/") {
    const active = mockDemoEnabled && Date.now() < mockDemoExpires;
    const demo_expires_at = new Date(mockDemoExpires).toISOString();
    if (request.method === "GET") return json(response,200,active
      ? {enabled:true,reason:"active",expires_at:demo_expires_at,max_devices:mockDemoIdentityCap,daily_limit:mockDemoDailyLimit}
      : {enabled:false,reason:mockDemoEnabled ? "expired" : "disabled",expires_at:null,max_devices:0,daily_limit:0});
    if (request.method !== "POST") return json(response,405,{detail:"GET or POST required."});
    if (!active) return json(response,403,{code:mockDemoEnabled ? "DEMO_ENDED" : "DEMO_DISABLED"});
    const enrollment = await readJson(request,response);
    if (!enrollment) return;
    if (typeof enrollment.device_id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(enrollment.device_id)
      || Object.keys(enrollment).some(key => key !== "device_id"))
      return json(response,400,{detail:"A synthetic UUIDv4 device_id is required."});
    let identity = mockDemoIdentities.get(enrollment.device_id);
    if (!identity) {
      if (mockDemoIdentities.size >= mockDemoIdentityCap) {
        response.setHeader("Retry-After","3600");
        return json(response,429,{code:"DEMO_CAPACITY",detail:"Synthetic mock identity cap reached."});
      }
      const id = mockDemoIdentities.size + 2;
      identity = {user:{id,username:`mock-demo-${id}`},session:null};
      mockDemoIdentities.set(enrollment.device_id,identity);
    }
    if (identity.session && mockSessions.has(identity.session.token)
      && Date.parse(identity.session.expires_at) > Date.now())
      return json(response,200,identity.session);
    if (identity.session) mockSessions.delete(identity.session.token);
    identity.session = issueMockSession(identity.user,
      Math.min(Date.now()+30*60*1000,mockDemoExpires),{mode:"demo",demo_expires_at});
    return json(response,200,identity.session);
  }
  if (pathname === "/api/v1/auth/login/") {
    if (request.method !== "POST") return json(response,405,{detail:"POST required."});
    const credentials = await readJson(request,response);
    if (!credentials) return;
    if (credentials.username !== mockUser.username || credentials.password !== mockPassword)
      return json(response,401,{detail:"아이디 또는 비밀번호를 확인하세요."});
    return json(response,200,issueMockSession(mockUser));
  }
  const session = authorizedMock(request);
  if (["/api/v1/auth/me/","/api/v1/auth/logout/","/api/v1/auth/logout-all/","/api/v1/scan/"].includes(pathname) && !session)
    return json(response,401,{detail:"로그인이 필요합니다."});
  if (pathname === "/api/v1/auth/me/") return request.method === "GET"
    ? json(response,200,{user:session.user,expires_at:session.expires_at,
      ...(session.mode ? {mode:session.mode,demo_expires_at:session.demo_expires_at} : {})}) : json(response,405,{detail:"GET required."});
  if (["/api/v1/auth/logout/","/api/v1/auth/logout-all/"].includes(pathname)) {
    if (request.method !== "POST") return json(response,405,{detail:"POST required."});
    if (pathname.endsWith("logout-all/")) {
      for (const [token,entry] of mockSessions) if (entry.user.id === session.user.id) mockSessions.delete(token);
    } else mockSessions.delete(session.token);
    return json(response,200,{detail:"로그아웃했어요."});
  }
  if (pathname !== "/api/v1/scan/") return json(response,404,{detail:"Not found."});
  if (request.method !== "POST") return json(response, 405, { detail: "POST required." });
  if (session.mode === "demo") {
    // Fixed one-hour synthetic window: this counter only approximates the real
    // Redis daily limit so local walkthroughs can display its 429 response.
    const used = mockDemoScanCounts.get(session.user.id) ?? 0;
    if (used >= mockDemoDailyLimit) {
      response.setHeader("Retry-After","3600");
      return json(response,429,{code:"DEMO_DAILY_LIMIT"});
    }
    mockDemoScanCounts.set(session.user.id,used+1);
  }
  const payload = await readJson(request, response);
  if (!payload) return;
  let source;
  try {
    source = new URL(payload.url);
    if (!["http:", "https:"].includes(source.protocol)) throw new Error();
  } catch {
    return json(response, 400, { url: ["HTTP or HTTPS URL required."] });
  }
  const context = Object.hasOwn(payload, "page_context") ? payload.page_context : "";
  if (typeof context !== "string" || Array.from(context).length > 2000) {
    return json(response, 400, { page_context: ["A string of at most 2000 characters is required."] });
  }
  const scenario = source.searchParams.get("mock");
  if (scenario === "fail") {
    setTimeout(() => {
      if (!response.destroyed) json(response, 503, { detail: "Delayed mock failure." });
    }, failureDelay);
    return;
  }
  // Fixed synthetic fixtures only. This is not a classifier or model call.
  const sources = Array.isArray(payload.page_observations) && payload.page_observations.length
    ? payload.page_observations : [{ text: context }];
  const phrases = [
    ["ADVANCE_PAYMENT_REQUIRED", evidence],
    ["ADVANCE_PAYMENT_REQUIRED", "출금 제한을 풀려면 5만 원을 먼저 입금하세요."],
    ["ADVANCE_PAYMENT_REQUIRED", "보증금 입금이 확인되면 판매대금을 지급합니다."],
    ["ADVANCE_PAYMENT_REQUIRED", "세금 납부가 확인되면 수익금을 받을 수 있습니다."],
    ["ADVANCE_PAYMENT_REQUIRED", "계정문제는 출금 동일 금액입금으로 해지 하셔야 됩니다."],
    ["REWARD_OFFER", "리뷰를 작성하면 보상 포인트를 지급합니다."],
    ["EARNINGS_DISPLAY", "수익금 적립이 완료되었습니다."],
    ["WITHDRAWAL_RESTRICTED", "계정 확인 전에는 출금이 제한됩니다."]
  ];
  const signals = [];
  for (const observation of sources) {
    for (const [type, quote] of phrases) {
      if (!observation.text?.includes(quote)) continue;
      signals.push({ type, evidence: quote, reason: "합성 페이지를 위한 고정 모의 응답입니다.",
        ...(observation.id ? { source_id: observation.id, source_url: observation.source_url,
          kind: observation.kind, observed_at: observation.observed_at } : {}) });
    }
  }
  if (scenario === "hallucination") {
    signals.length = 0;
    const observation = sources[0];
    signals.push({ type: "ADVANCE_PAYMENT_REQUIRED", evidence: "전송한 원문에 없는 100만 원 입금 요구입니다.",
      reason: "전송하지 않은 문장 검증용 모의 응답입니다.",
      ...(observation?.id ? { source_id: observation.id, source_url: observation.source_url } : {}) });
  }
  const verifiedSignals = scenario === "hallucination" ? [] : signals;
  const observed = new Set(verifiedSignals.map(signal => signal.type));
  const direct = observed.has("ADVANCE_PAYMENT_REQUIRED");
  const stagesComplete = ["REWARD_OFFER", "EARNINGS_DISPLAY", "WITHDRAWAL_RESTRICTED"].every(type => observed.has(type));
  let aiScore = scenario === "hallucination" ? null : direct ? 50 : stagesComplete ? 10 : context.trim() ? 0 : null;
  let aiScoringStatus = aiScore === null ? "unavailable" : "completed";
  const factors = aiScore ? [{
    code: direct ? "AI_ADVANCE_PAYMENT_REQUIRED" : "AI_STAGED_FLOW", points: aiScore,
    message: direct ? "합성 안내문에서 별도 선입금 조건을 확인했습니다." : "합성 보상·수익·출금 제한 안내를 함께 관찰해 추가 확인이 필요합니다.",
    source: "ai", evidence: verifiedSignals.filter(signal => direct ? signal.type === "ADVANCE_PAYMENT_REQUIRED" : true)
  }] : [];
  // Deterministic mock of the selected site-rule policy. No classifier runs.
  const siteChecks = payload.site_checks && typeof payload.site_checks === "object" ? structuredClone(payload.site_checks) : null;
  let siteChecksStatus;
  if (siteChecks) {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const [year, month, date] = day.split("-").map(Number);
    const previousMonth = month === 1 ? 12 : month - 1;
    const previousYear = month === 1 ? year - 1 : year;
    const cutoff = `${previousYear}-${String(previousMonth).padStart(2, "0")}-${String(Math.min(date, new Date(Date.UTC(previousYear, previousMonth, 0)).getUTCDate())).padStart(2, "0")}`;
    const add = (code, points, record, message) => factors.push({ code, points, message, source: "site_rule", evidence: [{ ...record, source: "site_rule" }] });
    const menu = siteChecks.payment_menus;
    if (menu?.status === "present" && /출금\s*신청|충전\s*신청/.test(menu.evidence || "")) add("AI_PAYMENT_MENU", 40, menu, "현재 화면에서 출금신청·충전신청 메뉴를 확인했습니다.");
    const notices = siteChecks.notices;
    if (notices) {
      const dates = (Array.isArray(notices.dates) ? notices.dates : []).filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value) && notices.evidence?.includes(value) && value <= day).sort();
      notices.cutoff_date = cutoff;
      notices.latest_date = dates.at(-1) || null;
      notices.freshness = notices.status === "present" && notices.latest_date_confirmed && dates.length ? (dates.at(-1) < cutoff ? "stale" : "recent") : "unverified";
      if (["missing", "empty"].includes(notices.status)) add("AI_NOTICE_MISSING", 50, notices, "확인한 공개 범위에서 공지사항을 찾지 못했습니다.");
      else if (notices.freshness === "stale") add("AI_NOTICE_STALE", 50, notices, "최근 한 달 안의 공지사항 작성을 확인하지 못했습니다.");
    }
    const reviews = siteChecks.reviews;
    if (["missing", "empty"].includes(reviews?.status)) add("AI_REVIEW_MISSING", 40, reviews, "확인한 공개 범위에서 구매후기를 찾지 못했습니다.");
    const known = [menu?.status && menu.status !== "unverified", notices && (["missing", "empty"].includes(notices.status) || notices.freshness !== "unverified"), reviews?.status && reviews.status !== "unverified"];
    siteChecksStatus = known.every(Boolean) ? "completed" : known.some(Boolean) ? "partial" : "unavailable";
  }
  const rawAiScore = factors.reduce((sum, factor) => sum + factor.points, 0);
  const aiCapped = rawAiScore > 50;
  if (rawAiScore) {
    aiScore = Math.min(rawAiScore, 50);
    aiScoringStatus = context.trim() && scenario !== "hallucination" ? "completed" : "rule_only";
  }
  if (aiCapped) {
    const raw = factors.map(factor => factor.points);
    const applied = raw.map(points => Math.floor(points * 50 / rawAiScore));
    let remaining = 50 - applied.reduce((sum, points) => sum + points, 0);
    const order = raw.map((points, index) => ({ index, fraction: points * 50 % rawAiScore })).sort((a, b) => b.fraction - a.fraction || a.index - b.index);
    for (const {index} of order) if (remaining-- > 0) applied[index]++;
    factors.forEach((factor, index) => { factor.raw_points = raw[index]; factor.points = applied[index]; });
  }
  const assessment = { state: direct ? "advance_payment_required" : "unverified",
    withdrawal_status: direct ? "risk_detected" : "unverified", observed_stages: [...observed] };
  const aiScoring = { risk_score: aiScore, max_score: 50, scoring_status: aiScoringStatus,
    scoring_policy: "business50_ai50_v3", risk_factors: factors, raw_score: aiScore === null ? null : rawAiScore, capped: aiCapped,
    ...(siteChecks ? { site_checks: siteChecks, site_checks_status: siteChecksStatus } : {}) };
  json(response, 200, {
    scan_id: randomUUID(),
    url: source.href,
    domain: source.hostname,
    status: "received",
    risk_score: aiScore ?? 0,
    verdict: direct || aiScore >= 60 ? "HIGH_RISK" : aiScore >= 20 ? "CAUTION" : "INSUFFICIENT_DATA",
    score_status: "partial",
    scoring_policy: "business50_ai50_v3",
    score_breakdown: {
      business: { score: 0, max_score: 50, raw_score: 0, status: "partial", capped: false },
      ai: { score: aiScore, max_score: 50, status: aiScoringStatus, raw_score: aiScore === null ? null : rawAiScore, capped: aiCapped }
    },
    risk_factors: factors,
    checked_items: ["nts_business_status"],
    analyses: {
      nts: { status: "completed", business_status: "ACTIVE", business_status_description: "계속사업자" },
      ftc: { status: "not_configured" },
      ai: context.trim() || scenario === "hallucination"
        ? { status: "completed", signals, assessment, ...aiScoring }
        : { status: "skipped", reason: "NO_PAGE_CONTEXT", signals: [], assessment, ...aiScoring }
    }
  });
});

const servers = [pages, api];
for (const server of servers) {
  server.on("error", error => {
    console.error(`Mock server could not start: ${error.message}`);
    for (const running of servers) running.close();
    process.exitCode = 1;
  });
}

function listen(server, value) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(value, "127.0.0.1", resolve);
  });
}

Promise.all([listen(pages, pagePort), listen(api, apiPort)]).then(() => {
  console.log("Local mock only: no Django, OpenAI or public API calls are made.");
  console.log(`Chrome fixtures: http://127.0.0.1:${pages.address().port}/tests/fixtures/visible.html`);
  console.log(`Mock scan endpoint: http://127.0.0.1:${api.address().port}/api/v1/scan/`);
  console.log("Mock login user demo; synthetic password is documented in the FE README. No real account is used.");
  console.log(mockDemoEnabled ? "MOCK_DEMO=1: synthetic browser enrollment enabled for one hour, maximum 20 mock identities." : "Demo enrollment disabled; set MOCK_DEMO=1 for the synthetic automatic demo walkthrough.");
  console.log("Use ?mock=hallucination for invented evidence; ?mock=fail for a delayed HTTP 503.");
  console.log(JSON.stringify({ type: "mock-ready", pagePort: pages.address().port, apiPort: api.address().port }));
}).catch(() => {});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const server of servers) server.close();
  });
}
