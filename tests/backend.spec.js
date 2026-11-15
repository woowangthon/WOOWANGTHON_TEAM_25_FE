const { test, expect } = require("@playwright/test");
const { authenticatedFixture } = require("./helpers/auth-fixture");
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");

const frontendRoot = path.resolve(__dirname, "..");
const backendRoot = process.env.BACKEND_ROOT
  || path.resolve(frontendRoot, "../WOOWANGTHON_TEAM_25_BE");
const backendPython = process.env.BACKEND_PYTHON
  || path.join(backendRoot, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
const backendAvailable = existsSync(backendPython)
  && existsSync(path.join(backendRoot, "app/ai/services.py"));
const evidence = "출금하려면 5만 원을 먼저 입금하세요";
let backend;
let backendURL;
let backendSession;

test.describe("로컬 Django 작업본 HTTP 통합 (외부 API는 모의)", () => {
  test.skip(!backendAvailable, "BACKEND_ROOT와 설치된 .venv가 있어야 Django HTTP 통합 테스트를 실행할 수 있습니다.");

  test.beforeAll(async () => {
    backend = spawn(backendPython, [path.join(__dirname, "helpers/mock-backend.py"), backendRoot], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let diagnostic = "";
    backend.stderr.on("data", chunk => { diagnostic += chunk.toString(); });
    backendURL = await new Promise((resolve, reject) => {
      const lines = readline.createInterface({ input: backend.stdout });
      const timer = setTimeout(() => {
        lines.close();
        reject(new Error(`Django test server did not become ready: ${diagnostic}`));
      }, 15000);
      lines.once("line", line => {
        clearTimeout(timer);
        lines.close();
        try { resolve(`http://127.0.0.1:${JSON.parse(line).port}/api/v1/scan/`); }
        catch (error) { reject(error); }
      });
      backend.once("exit", code => {
        clearTimeout(timer);
        reject(new Error(`Django test server exited (${code}): ${diagnostic}`));
      });
    });
    const loginReply = await fetch(backendURL.replace('/scan/', '/auth/login/'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'integration-scanner', password: 'Synthetic-login-only-2468!' })
    });
    expect(loginReply.status).toBe(200);
    backendSession = await loginReply.json();
  });

  test.afterAll(async () => {
    if (backend && backend.exitCode === null) {
      const exited = new Promise(resolve => backend.once("exit", resolve));
      backend.kill("SIGTERM");
      await exited;
    }
  });

  function healthySiteMarkup() {
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date());
    return `<section aria-label="공지사항"><h2>공지사항</h2><table><tbody><tr>
      <td><a href="/notice/current">서비스 안내</a></td><td><time datetime="${today}">${today}</time></td>
      </tr></tbody></table></section>
      <section aria-label="구매후기"><h2>구매후기</h2><ul class="review-list"><li class="review-item">만족합니다.</li></ul></section>`;
  }

  async function openAgainstDjango(browser, guidance, { policies = {}, url = "https://shop.example.com/payout", businessNumber = "123-45-67890", siteBaseline = true, siteMarkup = "", policyStatuses = {} } = {}) {
    const context = await browser.newContext();
    await context.route("http://popup.test/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (!["/popup.html", "/popup.js", "/flow.js", "/site-checks.js", "/auth.js"].includes(pathname)) {
        await route.fulfill({ status: 404, body: "" });
        return;
      }
      await route.fulfill({
        contentType: pathname.endsWith(".js") ? "application/javascript" : "text/html; charset=utf-8",
        body: await fs.readFile(path.join(frontendRoot, pathname))
      });
    });
    let currentGuidance = guidance;
    let currentURL = url;
    const policyRequests = [];
    await context.route("https://shop.example.com/**", async route => {
      const request = route.request();
      if (request.isNavigationRequest() && request.url() === currentURL) {
        await route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html lang="ko"><body>
          <section>${currentGuidance}</section>
          ${siteBaseline ? healthySiteMarkup() : siteMarkup}
          <footer><p>상호: 모의상점 | 대표자: 홍길동</p>
          <p>사업자등록번호: ${businessNumber}</p></footer></body></html>` });
        return;
      }
      policyRequests.push(request.url());
      await route.fulfill({ status: policyStatuses[request.url()] ?? (policies[request.url()] ? 200 : 404),
        contentType: "text/html; charset=utf-8", headers: { "Access-Control-Allow-Origin": "*" },
        body: policies[request.url()] || "" });
    });
    const source = await context.newPage();
    await source.goto(currentURL);
    const payloads = [];
    const replies = [];
    const externalCalls = [];
    await context.route("http://127.0.0.1:8000/api/v1/scan/", async route => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "Content-Type"
        } });
        return;
      }
      expect(route.request().headers().authorization).toBe(`Bearer ${backendSession.token}`);
      payloads.push(route.request().postDataJSON());
      // Only change the destination port. Django receives the frontend's actual
      // POST payload and executes its real serializer, view and service stack.
      const reply = await route.fetch({ url: backendURL, headers: {
        "Content-Type": "application/json",
        "Authorization": route.request().headers().authorization
      } });
      expect(reply.status()).toBe(200);
      expect(reply.headers()["x-test-backend"]).toBe("django-working-copy");
      const ntsCalls = Number(reply.headers()["x-test-nts-calls"]);
      expect(Number.isInteger(ntsCalls)).toBe(true);
      replies.push(await reply.json());
      externalCalls.push({ nts: ntsCalls, ftc: Number(reply.headers()["x-test-ftc-calls"]),
        ai: Number(reply.headers()["x-test-ai-calls"]) });
      await route.fulfill({ response: reply, headers: {
        ...reply.headers(), "Access-Control-Allow-Origin": "*"
      } });
    });
    await context.route("http://127.0.0.1:8000/api/v1/auth/**", async route => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({status:204,headers:{"Access-Control-Allow-Origin":"*",
          "Access-Control-Allow-Methods":"GET, POST","Access-Control-Allow-Headers":"Content-Type, Authorization"}});
        return;
      }
      const pathname = new URL(route.request().url()).pathname;
      const actual = new URL(backendURL); actual.pathname = pathname;
      const response = await route.fetch({url: actual.href});
      await route.fulfill({response,headers:{...response.headers(),"Access-Control-Allow-Origin":"*"}});
    });
    const storage = {};
    async function openPopup() {
      const popup = await context.newPage();
      await popup.exposeFunction("__executeInCurrentTab", async functionSource => ({
        result: await source.evaluate(`(${functionSource})()`)
      }));
      await popup.exposeFunction("__storage", (operation, value) => {
        if (operation === "get") return value in storage ? { [value]: structuredClone(storage[value]) } : {};
        if (operation === "set") Object.assign(storage, value);
      });
      await popup.addInitScript(({ sourceURL }) => {
        window.chrome = {
          tabs: { query: async () => [{ id: 25, url: sourceURL }] },
          scripting: { executeScript: async options => [await window.__executeInCurrentTab(options.func.toString())] },
          storage: { session: {
            get: value => window.__storage("get", value), set: value => window.__storage("set", value)
          } }
        };
      }, { sourceURL: currentURL });
      await authenticatedFixture(popup, {token:backendSession.token, user:backendSession.user, mockMe:false});
      await popup.goto("http://popup.test/popup.html");
      await expect(popup.locator("#status")).toHaveText("백엔드 응답을 받았어요.");
      return popup;
    }
    const popup = await openPopup();
    async function nextPopup(nextGuidance, nextURL) {
      currentGuidance = nextGuidance;
      currentURL = nextURL;
      await source.goto(currentURL);
      return openPopup();
    }
    return { context, popup, payloads, replies, externalCalls, policyRequests, nextPopup };
  }

  function expectScoredReply(reply, { aiScore, total, scoringStatus = aiScore === null ? "unavailable" : "completed" }) {
    expect(reply.score_breakdown.business).toMatchObject({
      score: 50, max_score: 50, raw_score: 55, capped: true
    });
    expect(reply.score_breakdown.ai).toMatchObject({
      score: aiScore, max_score: 50, status: scoringStatus
    });
    expect(reply.analyses.ai).toMatchObject({
      risk_score: aiScore, max_score: 50,
      scoring_status: scoringStatus, scoring_policy: "business50_ai50_v3"
    });
    expect(reply.risk_score).toBe(total);
    expect(reply.risk_factors.reduce((sum, factor) => sum + factor.points, 0)).toBe(total);
    const businessFactors = reply.risk_factors.filter(factor => !String(factor.code).startsWith("AI_"));
    expect(businessFactors.reduce((sum, factor) => sum + factor.points, 0)).toBe(50);
    expect(businessFactors.reduce((sum, factor) => sum + (factor.raw_points ?? factor.points), 0)).toBe(55);
  }

  for (const scenario of [
    { name: "버튼 없는 선입금 요구와 근거 표시", html: `<p>${evidence}</p>`, status: "completed", warning: true, aiScore: 50, total: 100 },
    { name: "수수료 차감 안내는 경고 없음", html: "<p>판매대금에서 수수료를 차감한 뒤 지급합니다.</p>", status: "completed", warning: false, aiScore: 0, total: 50 },
    { name: "버튼만 있어도 메뉴40점을 반영하고 모델 분석은 skipped", html: "<button>충전 신청</button>", status: "skipped", warning: false, aiScore: 40, total: 90, scoringStatus: "rule_only" },
    { name: "OpenAI 시간 초과에도 사업자 결과와 점수 유지", html: "<p>출금 제한 해제를 안내합니다. 시간 초과 테스트입니다.</p>", status: "error", warning: false, aiScore: null, total: 50 }
  ]) {
    test(scenario.name, async ({ browser }) => {
      const { context, popup, payloads, replies } = await openAgainstDjango(browser, scenario.html);
      try {
        expect(payloads).toHaveLength(1);
        expect(replies).toHaveLength(1);
        expect(replies[0].analyses.ai.status).toBe(scenario.status);
        expectScoredReply(replies[0], scenario);
        expect(replies[0].verdict).toBe(scenario.total >= 60 ? "HIGH_RISK" : "CAUTION");
        await expect(popup.locator("#checkResults .result")).toHaveCount(3);
        await expect(popup.locator("#checkResults")).toContainText(`총 위험 점수 ${scenario.total}점`);
        if (scenario.warning) {
          expect(payloads[0].page_context).toContain(evidence);
          expect(replies[0].analyses.ai.signals[0].evidence).toBe(evidence);
          await expect(popup.locator("#advancePaymentWarning")).toBeVisible();
          await expect(popup.locator("#advancePaymentEvidence")).toContainText(evidence);
        } else {
          await expect(popup.locator("#advancePaymentWarning")).toBeHidden();
        }
        if (scenario.status === "skipped") {
          expect(payloads[0]).not.toHaveProperty("page_context");
          expect(replies[0].analyses.ai.reason).toBe("NO_PAGE_CONTEXT");
          await expect(popup.locator("#advancePaymentCard")).toBeVisible();
        }
        if (scenario.status === "error") {
          expect(replies[0].analyses.ai.error).toBe("OPENAI_TIMEOUT");
        }
      } finally {
        await context.close();
      }
    });
  }

  test("실제 Django HTTP에서 공개 안내 출처 검증과 단계 기록을 연결", async ({ browser }) => {
    const reward = "후기를 작성하면 보상 적립금을 드립니다.";
    const earnings = "적립된 수익금을 확인하고 출금을 신청하세요.";
    const restriction = "계정 인증 전에는 출금이 제한됩니다.";
    const policyURL = "https://shop.example.com/help/withdraw";
    const app = await openAgainstDjango(browser, `<p>${reward}</p>`);
    try {
      expectScoredReply(app.replies[0], { aiScore: 0, total: 50 });
      await app.popup.close();
      let popup = await app.nextPopup(`<p>${earnings}</p><p>${restriction}</p>`, "https://shop.example.com/account-summary");
      expect(app.replies.at(-1).analyses.ai.status).toBe("completed");
      expectScoredReply(app.replies.at(-1), { aiScore: 10, total: 60 });
      expect(app.replies.at(-1).verdict).toBe("HIGH_RISK");
      await expect(popup.locator("#checkResults")).toContainText("총 위험 점수 60점");
      expect(app.payloads.at(-1).page_observations.some(item => item.kind === "history" && item.text.includes(reward))).toBe(true);
      expect(app.replies.at(-1).analyses.ai.assessment.observed_stages).toEqual(expect.arrayContaining(["REWARD_OFFER", "EARNINGS_DISPLAY", "WITHDRAWAL_RESTRICTED"]));
      await expect(popup.locator("#advancePaymentWarning")).toBeHidden();
      await expect(popup.locator("#flowAssessment")).toContainText("출금 조건 미확인");
      await popup.close();
      popup = await app.nextPopup(`<p>${evidence}</p>`, policyURL);
      const latest = app.replies.at(-1);
      expect(latest.analyses.ai.status).toBe("completed");
      expectScoredReply(latest, { aiScore: 50, total: 100 });
      expect(latest.analyses.ai.risk_factors).toHaveLength(1);
      expect(latest.analyses.ai.assessment.state).toBe("advance_payment_required");
      const signal = latest.analyses.ai.signals.find(item => item.type === "ADVANCE_PAYMENT_REQUIRED");
      expect(signal.source_url).toBe(policyURL);
      expect(app.payloads.at(-1).page_observations.find(item => item.id === signal.source_id).text).toContain(signal.evidence);
      await expect(popup.locator("#advancePaymentWarning")).toBeVisible();
      await expect(popup.locator("#advancePaymentEvidence a")).toHaveAttribute("href", policyURL);
      await expect(popup.locator("#checkResults")).toContainText("총 위험 점수 100점");
    } finally { await app.context.close(); }
  });

  test("실제 Django HTTP에 공개 링크에서 읽은 원문과 주소를 전달", async ({ browser }) => {
    const policyURL = "https://shop.example.com/help/withdraw";
    const app = await openAgainstDjango(browser, '<a href="/help/withdraw">출금·환급 안내</a>', {
      policies: { [policyURL]: `<section><h2>출금 안내</h2><p>${evidence}</p></section>` }
    });
    try {
      expect(app.policyRequests).toEqual([policyURL]);
      expectScoredReply(app.replies[0], { aiScore: 50, total: 100 });
      const signal = app.replies[0].analyses.ai.signals.find(item => item.type === "ADVANCE_PAYMENT_REQUIRED");
      expect(signal.source_url).toBe(policyURL);
      expect(signal.kind).toBe("linked_policy");
      expect(app.payloads[0].page_observations.find(item => item.id === signal.source_id).text).toContain(signal.evidence);
      await expect(app.popup.locator("#advancePaymentWarning")).toBeVisible();
      await expect(app.popup.locator("#advancePaymentEvidence a")).toHaveAttribute("href", policyURL);
    } finally { await app.context.close(); }
  });
  for (const scenario of [
    { name: "AI0이면 합계50", guidance: "<p>판매대금에서 수수료를 차감한 뒤 지급합니다.</p>",
      path: "malformed-no-upfront", aiScore: 0, total: 50, warning: false },
    { name: "AI50이면 합계100", guidance: `<p>${evidence}</p>`,
      path: "malformed-upfront", aiScore: 50, total: 100, warning: true }
  ]) {
    test(`실제 Django HTTP에서 번호 형식 오류20·상호명 검색 실패25·복합 근거5로 사업자50 (${scenario.name})`, async ({ browser }) => {
      const displayed = "125-86-112516";
      const app = await openAgainstDjango(browser, scenario.guidance,
        { url: `https://shop.example.com/${scenario.path}`, businessNumber: displayed });
      try {
        expect(app.payloads).toHaveLength(1);
        expect(app.payloads[0].business_info.business_number).toBe("");
        expect(app.payloads[0].business_info.displayed_business_number).toBe(displayed);
        expect(app.externalCalls[0]).toEqual({ nts: 0, ftc: 1, ai: 1 });
        const reply = app.replies[0];
        expect(reply.business_info.displayed_business_number).toBe(displayed);
        expect(reply.analyses.business_input).toMatchObject({
          status: "malformed", displayed_value: displayed, digit_count: 11
        });
        expect(reply.analyses.ftc).toMatchObject({
          status: "completed", search_method: "BUSINESS_NAME", match_status: "NO_MATCH"
        });
        expect(reply.scoring_policy).toBe("business50_ai50_v3");
        expect(reply.score_breakdown.business).toMatchObject({
          score: 50, max_score: 50, raw_score: 50, status: "partial", capped: false
        });
        expect(reply.score_breakdown.ai).toMatchObject({ score: scenario.aiScore, max_score: 50, status: "completed" });
        expect(reply.analyses.ai).toMatchObject({ risk_score: scenario.aiScore, scoring_status: "completed" });
        expect(reply.risk_score).toBe(scenario.total);
        expect(reply.score_status).toBe("partial");
        expect(reply.verdict).toBe(scenario.warning ? "HIGH_RISK" : "CAUTION");
        expect(reply.risk_factors).toEqual(expect.arrayContaining([
          expect.objectContaining({ code: "MALFORMED_BUSINESS_NUMBER", points: 20, evidence: displayed }),
          expect.objectContaining({ code: "FTC_BUSINESS_NAME_NOT_FOUND", points: 25 }),
          expect.objectContaining({ code: "MALFORMED_NUMBER_AND_FTC_NAME_NOT_FOUND", points: 5 })
        ]));
        const businessFactors = reply.risk_factors.filter(factor => !factor.code.startsWith("AI_"));
        expect(businessFactors.reduce((total, factor) => total + factor.points, 0)).toBe(50);
        expect(reply.risk_factors.reduce((total, factor) => total + factor.points, 0)).toBe(scenario.total);
        await expect(app.popup.locator("#businessNumberIssueDetail")).toContainText(displayed);
        await expect(app.popup.locator("#businessNumberIssueDetail")).toContainText("11자리");
        await expect(app.popup.locator("#businessRiskScore")).toHaveText("50 / 50점");
        await expect(app.popup.locator("#aiRiskScore")).toHaveText(`${scenario.aiScore} / 50점`);
        await expect(app.popup.locator("#checkResults")).toContainText(`총 위험 점수 ${scenario.total}점`);
        if (scenario.warning) {
          const signal = reply.analyses.ai.signals.find(item => item.type === "ADVANCE_PAYMENT_REQUIRED");
          expect(signal.evidence).toBe(evidence);
          expect(app.payloads[0].page_observations.find(item => item.id === signal.source_id).text).toContain(evidence);
          await expect(app.popup.locator("#advancePaymentWarning")).toBeVisible();
          await expect(app.popup.locator("#advancePaymentEvidence")).toContainText(evidence);
        } else {
          await expect(app.popup.locator("#advancePaymentWarning")).toBeHidden();
          await expect(app.popup.locator("#flowAssessment")).toHaveText("출금 조건 미확인");
        }
      } finally { await app.context.close(); }
    });
  }

  test("실제 Django HTTP에서 공개 조회 캐시를 재사용해도 새 선입금 문구와 AI 점수는 다시 분석", async ({ browser }) => {
    const url = "https://shop.example.com/cache-freshness-regression";
    const app = await openAgainstDjango(browser,
      "<p>판매대금에서 수수료를 차감한 뒤 지급합니다.</p>",
      { url, businessNumber: "321-54-09876" });
    try {
      const first = app.replies[0];
      expect(first.public_api_cache).toMatchObject({ status: "miss", ttl_hours: 24 });
      expect(app.externalCalls[0]).toEqual({ nts: 1, ftc: 1, ai: 1 });
      expectScoredReply(first, { aiScore: 0, total: 50 });
      await expect(app.popup.locator("#advancePaymentWarning")).toBeHidden();
      await app.popup.close();
      const popup = await app.nextPopup(`<p>${evidence}</p>`, url);
      const latest = app.replies.at(-1);
      expect(app.payloads.at(-1).url).toBe(app.payloads[0].url);
      expect(app.payloads.at(-1).business_info).toEqual(app.payloads[0].business_info);
      expect(latest.public_api_cache).toMatchObject({ status: "hit", ttl_hours: 24 });
      expect(app.externalCalls.at(-1)).toEqual({ nts: 0, ftc: 0, ai: 1 });
      expect(latest.scan_id).not.toBe(first.scan_id);
      expect(latest.analyses.nts).toEqual(first.analyses.nts);
      expect(latest.analyses.ftc).toEqual(first.analyses.ftc);
      expect(latest.analyses.ai.status).toBe("completed");
      expectScoredReply(latest, { aiScore: 50, total: 100 });
      const signal = latest.analyses.ai.signals.find(item => item.type === "ADVANCE_PAYMENT_REQUIRED");
      expect(signal.evidence).toBe(evidence);
      expect(app.payloads.at(-1).page_observations.find(item => item.id === signal.source_id).text).toContain(evidence);
      await expect(popup.locator("#advancePaymentWarning")).toBeVisible();
      await expect(popup.locator("#advancePaymentEvidence")).toContainText(evidence);
      await expect(popup.locator("#checkResults")).toContainText("총 위험 점수 100점");
      await expect(popup.locator("#publicApiCacheNote")).toContainText("사업자 조회 캐시");
      await expect(popup.locator("#publicApiCacheNote")).toContainText("현재 문구는 매번 새로 분석");
    } finally { await app.context.close(); }
  });

  function expectSiteArea(reply, { rawScore, score, total, codes, businessScore = 0 }) {
    expect(reply.scoring_policy).toBe("business50_ai50_v3");
    expect(reply.score_breakdown.business).toMatchObject({ score: businessScore, max_score: 50 });
    expect(reply.score_breakdown.ai).toMatchObject({ score, max_score: 50, raw_score: rawScore, capped: rawScore > 50 });
    expect(reply.analyses.ai).toMatchObject({ risk_score: score, max_score: 50,
      raw_score: rawScore, capped: rawScore > 50, scoring_policy: "business50_ai50_v3" });
    const factors = reply.analyses.ai.risk_factors;
    expect(factors.map(factor => factor.code)).toEqual(expect.arrayContaining(codes));
    expect(factors.reduce((sum, factor) => sum + factor.points, 0)).toBe(score);
    expect(factors.reduce((sum, factor) => sum + (factor.raw_points ?? factor.points), 0)).toBe(rawScore);
    expect(reply.risk_factors.reduce((sum, factor) => sum + factor.points, 0)).toBe(total);
    expect(reply.risk_score).toBe(total);
  }

  test("실제 Django HTTP에서 로그인 전 메인에 보이는 출금·충전 메뉴는 한 번만40점", async ({ browser }) => {
    const urls = {
      withdraw: "https://shop.example.com/withdraw-login",
      charge: "https://shop.example.com/charge-login",
      notices: "https://shop.example.com/bbs/board.php?bo_table=notice",
      reviews: "https://shop.example.com/shop/itemuselist.php"
    };
    const login = "<html><body><p>로그인 후 확인할 수 있습니다.</p></body></html>";
    const app = await openAgainstDjango(browser, `<a href="${urls.withdraw}">출금 신청</a>
      <a href="${urls.charge}">충전신청</a>
      <a href="${urls.notices}">공지사항</a><a href="${urls.reviews}">구매후기</a>`, {
      url: "https://shop.example.com/main-with-login-boards", businessNumber: "555-55-55555", siteBaseline: false,
      policies: Object.fromEntries(Object.values(urls).map(url => [url, login]))
    });
    try {
      expect(app.payloads[0].site_checks.payment_menus.status).toBe("present");
      expect(app.payloads[0].site_checks.payment_menus.evidence).toContain("출금");
      expect(app.payloads[0].site_checks.notices.status).toBe("unverified");
      expect(app.payloads[0].site_checks.reviews.status).toBe("unverified");
      expectSiteArea(app.replies[0], { rawScore: 40, score: 40, total: 40, codes: ["AI_PAYMENT_MENU"] });
      expect(app.replies[0].analyses.ai.scoring_status).toBe("rule_only");
      expect(app.replies[0].score_status).toBe("partial");
      expect(app.replies[0].verdict).toBe("CAUTION");
      await expect(app.popup.locator("#aiRiskScore")).toHaveText("40 / 50점");
      await expect(app.popup.locator("#advancePaymentCard")).toBeVisible();
      await expect(app.popup.locator("#advancePaymentWarning")).toBeHidden();
    } finally { await app.context.close(); }
  });

  for (const scenario of [
    { name: "공지·후기 없음의 원점수90은50으로 제한", path: "site-missing-both", menus: "", rawScore: 90,
      businessNumber: "555-55-55555", businessScore: 0, total: 50,
      codes: ["AI_NOTICE_MISSING", "AI_REVIEW_MISSING"] },
    { name: "메뉴·공지·후기 세 조건의 원점수130도50으로 제한", path: "site-missing-all", menus: "<button>출금신청</button><button>충전 신청</button>", rawScore: 130,
      businessNumber: "555-55-55555", businessScore: 0, total: 50,
      codes: ["AI_PAYMENT_MENU", "AI_NOTICE_MISSING", "AI_REVIEW_MISSING"] },
    { name: "번호오류·상호명 검색 실패 사업자50과 사이트AI50은100점", path: "site-malformed-and-missing", menus: "", rawScore: 90,
      businessNumber: "125-86-112516", businessScore: 50, total: 100,
      codes: ["AI_NOTICE_MISSING", "AI_REVIEW_MISSING"] }
  ]) {
    test(`실제 Django HTTP에서 ${scenario.name}`, async ({ browser }) => {
      const app = await openAgainstDjango(browser, `${scenario.menus}<p>다양한 생활용품과 판매 상품의 상세 정보를 화면에서 확인하세요.</p>`, {
        url: `https://shop.example.com/${scenario.path}`, businessNumber: scenario.businessNumber, siteBaseline: false
      });
      try {
        expect(app.payloads[0].site_checks.notices.status).toBe("missing");
        expect(app.payloads[0].site_checks.reviews.status).toBe("missing");
        expectSiteArea(app.replies[0], { rawScore: scenario.rawScore, score: 50, total: scenario.total,
          businessScore: scenario.businessScore, codes: scenario.codes });
        expect(app.replies[0].verdict).toBe(scenario.total >= 60 ? "HIGH_RISK" : "CAUTION");
        expect(app.replies[0].analyses.ai.signals.some(signal => signal.type === "ADVANCE_PAYMENT_REQUIRED")).toBe(false);
        await expect(app.popup.locator("#aiRiskScore")).toHaveText("50 / 50점");
        await expect(app.popup.locator("#advancePaymentWarning")).toBeHidden();
        if (scenario.businessScore) {
          expect(app.replies[0].risk_factors).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: "MALFORMED_NUMBER_AND_FTC_NAME_NOT_FOUND", points: 5 })
          ]));
        }
      } finally { await app.context.close(); }
    });
  }

  test("실제 Django HTTP에서 공개 게시판 조회 실패는 공지·후기 없음으로 가점하지 않음", async ({ browser }) => {
    const noticeURL = "https://shop.example.com/bbs/board.php?bo_table=notice";
    const reviewURL = "https://shop.example.com/shop/itemuselist.php";
    const app = await openAgainstDjango(browser, `<p>판매대금에서 수수료를 차감한 뒤 지급합니다.</p>
      <a href="${noticeURL}">공지사항</a><a href="${reviewURL}">구매후기</a>`, {
      url: "https://shop.example.com/site-board-failures", businessNumber: "555-55-55555", siteBaseline: false,
      policyStatuses: { [noticeURL]: 503, [reviewURL]: 503 }
    });
    try {
      expect(app.payloads[0].site_checks.notices.status).toBe("unverified");
      expect(app.payloads[0].site_checks.reviews.status).toBe("unverified");
      expectSiteArea(app.replies[0], { rawScore: 0, score: 0, total: 0, codes: [] });
      expect(app.replies[0].score_status).toBe("partial");
      expect(app.replies[0].verdict).toBe("INSUFFICIENT_DATA");
      await expect(app.popup.locator("#advancePaymentWarning")).toBeHidden();
    } finally { await app.context.close(); }
  });

  test("실제 Django HTTP에서 오래된 공지만 있으면 AI50, 최근 구매후기는 유지", async ({ browser }) => {
    const app = await openAgainstDjango(browser, "<p>다양한 생활용품과 판매 상품의 상세 정보를 화면에서 확인하세요.</p>", {
      url: "https://shop.example.com/site-old-notice", businessNumber: "555-55-55555", siteBaseline: false,
      siteMarkup: `<section aria-label="공지사항"><h2>공지사항</h2><table><tbody><tr>
        <td><a href="/notice/old">서비스 안내</a></td><td><time datetime="2020-01-01">2020-01-01</time></td>
        </tr></tbody></table></section>
        <section aria-label="구매후기"><h2>구매후기</h2><ul class="review-list"><li class="review-item">만족합니다.</li></ul></section>`
    });
    try {
      expect(app.payloads[0].site_checks.notices.status).toBe("present");
      expect(app.payloads[0].site_checks.notices.dates).toContain("2020-01-01");
      expect(app.replies[0].analyses.ai.site_checks.notices.freshness).toBe("stale");
      expectSiteArea(app.replies[0], { rawScore: 50, score: 50, total: 50, codes: ["AI_NOTICE_STALE"] });
      expect(app.replies[0].verdict).toBe("CAUTION");
      await expect(app.popup.locator("#advancePaymentWarning")).toBeHidden();
    } finally { await app.context.close(); }
  });

  test("실제 Django HTTP에서 최근 공지가 있고 구매후기가 없으면 AI40", async ({ browser }) => {
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date());
    const app = await openAgainstDjango(browser, "<p>다양한 생활용품과 판매 상품의 상세 정보를 화면에서 확인하세요.</p>", {
      url: "https://shop.example.com/site-reviews-missing", businessNumber: "555-55-55555", siteBaseline: false,
      siteMarkup: `<section aria-label="공지사항"><h2>공지사항</h2><table><tbody><tr>
        <td><a href="/notice/new">서비스 안내</a></td><td><time datetime="${today}">${today}</time></td>
        </tr></tbody></table></section>`
    });
    try {
      expect(app.payloads[0].site_checks.notices.status).toBe("present");
      expect(app.payloads[0].site_checks.reviews.status).toBe("missing");
      expect(app.replies[0].analyses.ai.site_checks.notices.freshness).toBe("recent");
      expectSiteArea(app.replies[0], { rawScore: 40, score: 40, total: 40, codes: ["AI_REVIEW_MISSING"] });
      await expect(app.popup.locator("#advancePaymentWarning")).toBeHidden();
    } finally { await app.context.close(); }
  });

});
