// Synthetic browser checks only: every HTTP request is intercepted locally.
const { test, expect } = require("@playwright/test");
const { authenticatedFixture } = require("./helpers/auth-fixture");
const fs = require("node:fs/promises");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const popupOrigin = "http://extension.test";
const scanURL = "http://127.0.0.1:8000/api/v1/scan/";
const upfront = "출금 제한을 풀려면 5만 원을 먼저 입금하세요.";
const tax = "세금 납부가 확인되면 수익금을 받을 수 있습니다.";
const cors = { "Access-Control-Allow-Origin": "*" };
const business = `<footer><p>상호: 모의상점 | 대표자: 홍길동</p><p>사업자등록번호: 123-45-67890</p></footer>`;

function resultWithSignals(payload, evidence, overrides = {}) {
  const observation = payload.page_observations?.find(item => item.text.includes(evidence));
  const signals = evidence ? [{
    type: "ADVANCE_PAYMENT_REQUIRED", evidence, reason: "별도 입금을 지급 조건으로 요구합니다.",
    source_id: observation?.id || "unknown-source", source_url: observation?.source_url,
    ...overrides
  }] : [];
  return {
    analyses: {
      nts: { status: "completed", business_status_description: "계속사업자" },
      ftc: { status: "not_configured" },
      ai: { status: "completed", signals, assessment: {
        state: signals.length ? "advance_payment_required" : "unverified",
        withdrawal_status: signals.length ? "risk_detected" : "unverified",
        observed_stages: []
      } }
    }, verdict: "LOW_RISK", risk_score: 0, risk_factors: []
  };
}

async function setup(browser, { html = "<button>출금 신청</button>", url = "https://shop.example.test/home", policies = {}, response, storage = {} } = {}) {
  const context = await browser.newContext();
  const requests = [], fetches = [], unexpected = [], pending = [], policyPending = [];
  let currentHTML = html;
  let currentURL = url;
  await context.route("**/*", async route => {
    const request = route.request();
    const target = request.url();
    if (target.startsWith(`${popupOrigin}/`)) {
      const pathname = new URL(target).pathname;
      if (["/popup.html", "/popup.js", "/flow.js", "/site-checks.js", "/auth.js"].includes(pathname)) {
        await route.fulfill({ contentType: pathname.endsWith("js") ? "application/javascript" : "text/html; charset=utf-8", body: await fs.readFile(path.join(root, pathname)) });
      } else await route.fulfill({ status: 404, body: "" });
      return;
    }
    if (target === scanURL) {
      if (request.method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type" } });
        return;
      }
      const payload = request.postDataJSON();
      requests.push(payload);
      if (response === "pending") { pending.push(route); return; }
      if (response === "failure") { await route.abort("failed"); return; }
      await route.fulfill({ contentType: "application/json", headers: cors, body: JSON.stringify(typeof response === "function" ? response(payload) : resultWithSignals(payload)) });
      return;
    }
    if (request.isNavigationRequest() && request.frame().parentFrame() === null && target === currentURL) {
      await route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html lang="ko"><body>${currentHTML}${business}</body></html>` });
      return;
    }
    fetches.push({ url: target, method: request.method() });
    const policy = policies[target];
    if (policy === "pending") { policyPending.push(route); return; }
    if (policy !== undefined) {
      const options = typeof policy === "string" ? { body: policy } : policy;
      await route.fulfill({ contentType: "text/html; charset=utf-8", headers: cors, ...options });
      return;
    }
    unexpected.push(target);
    await route.fulfill({ status: 404, headers: cors, body: "" });
  });
  const source = await context.newPage();
  await source.goto(currentURL);

  async function openPopup() {
    const popup = await context.newPage();
    await popup.exposeFunction("__executeInCurrentTab", async functionSource => ({ result: await source.evaluate(`(${functionSource})()`) }));
    await popup.exposeFunction("__storageCall", (operation, argument) => {
      if (operation === "set") { Object.assign(storage, argument); return; }
      if (operation === "remove") { for (const key of [].concat(argument)) delete storage[key]; return; }
      if (operation === "get") {
        if (argument == null) return structuredClone(storage);
        const keys = typeof argument === "string" ? [argument] : Array.isArray(argument) ? argument : Object.keys(argument);
        return Object.fromEntries(keys.filter(key => key in storage).map(key => [key, structuredClone(storage[key])]));
      }
      throw new Error(`Unsupported storage operation: ${operation}`);
    });
    await popup.addInitScript(({ url }) => {
      window.__policyOptions = [];
      const originalFetch = window.fetch.bind(window);
      window.fetch = (resource, options) => {
        if (!String(resource).includes("/api/v1/")) window.__policyOptions.push({ url: String(resource), ...options, signal: Boolean(options?.signal) });
        return originalFetch(resource, options);
      };
      window.chrome = {
        tabs: { query: async () => [{ id: 25, url }] },
        scripting: { executeScript: async options => [await window.__executeInCurrentTab(options.func.toString())] },
        storage: { session: {
          get: argument => window.__storageCall("get", argument),
          set: argument => window.__storageCall("set", argument),
          remove: argument => window.__storageCall("remove", argument)
        } }
      };
    }, { url: currentURL });
    await authenticatedFixture(popup);
    await popup.goto(`${popupOrigin}/popup.html`);
    return popup;
  }
  async function visit(nextHTML, nextURL = currentURL) {
    currentHTML = nextHTML; currentURL = nextURL;
    await source.goto(currentURL);
  }
  return { context, source, openPopup, visit, requests, fetches, unexpected, pending, policyPending, storage };
}

async function finished(popup) {
  await expect(popup.locator("#status")).toHaveText("백엔드 응답을 받았어요.");
}

test("메뉴 질문은 공개 안내와 API를 기다리는 동안 바로 표시", async ({ browser }) => {
  const app = await setup(browser, { html: '<a href="/withdraw-policy">출금 신청</a>', policies: { "https://shop.example.test/withdraw-policy": "pending" }, response: "pending" });
  try {
    const popup = await app.openPopup();
    await expect(popup.locator("#advancePaymentCard")).toBeVisible();
    await expect(popup.getByRole("button", { name: "먼저 보내라고 했어요", exact: true })).toBeVisible();
    await expect(popup.locator("#flowAssessment")).toContainText("출금 조건 미확인");
    await expect.poll(() => app.policyPending.length).toBe(1);
    await app.policyPending[0].fulfill({ headers: cors, contentType: "text/html", body: `<p>${upfront}</p>` });
    await expect.poll(() => app.pending.length).toBe(1);
  } finally { await app.context.close(); }
});

test("버튼 없는 직접 세금 조건을 수집하고 검증된 원문으로 경고", async ({ browser }) => {
  const app = await setup(browser, { html: `<section><p>수익금 지급 안내</p><p>${tax}</p></section>`, response: payload => resultWithSignals(payload, tax) });
  try {
    const popup = await app.openPopup(); await finished(popup);
    expect(app.requests[0].page_context).toContain(tax);
    expect(app.requests[0].page_observations.some(item => item.text.includes(tax))).toBe(true);
    await expect(popup.locator("#advancePaymentWarning")).toBeVisible();
    await expect(popup.locator("#advancePaymentEvidence")).toContainText(tax);
    await expect(popup.locator("#advancePaymentEvidence a")).toHaveAttribute("href", "https://shop.example.test/home");
  } finally { await app.context.close(); }
});

test("공개 출금 안내의 근거와 출처 주소를 함께 표시하고 inert HTML로 읽음", async ({ browser }) => {
  const policyURL = "https://shop.example.test/help/withdraw";
  const policy = `<html><body><section><h2>출금 안내</h2><p>${upfront}</p><p>계좌번호 123-456-789012 전화번호 010-1234-5678</p></section><input value="USER_SECRET_VALUE"><script>fetch('/script-executed');window.policyScriptExecuted=true</script><img src="/image-request"><iframe src="/frame-request"></iframe><form action="/transfer" method="post"><input name="amount" value="999999"></form></body></html>`;
  const app = await setup(browser, { html: '<a href="/help/withdraw">출금·환급 안내</a>', policies: { [policyURL]: policy }, response: payload => resultWithSignals(payload, upfront) });
  try {
    const popup = await app.openPopup(); await finished(popup);
    expect(app.fetches).toEqual([{ url: policyURL, method: "GET" }]);
    expect(app.unexpected).toEqual([]);
    expect(app.requests[0].page_observations.find(item => item.kind === "linked_policy")?.source_url).toBe(policyURL);
    expect(JSON.stringify(app.requests[0])).not.toMatch(/USER_SECRET_VALUE|123-456-789012|010-1234-5678|999999/);
    const options = await popup.evaluate(() => window.__policyOptions);
    expect(options[0]).toMatchObject({ credentials: "omit", redirect: "error" });
    await expect(popup.locator("#advancePaymentEvidence")).toContainText(upfront);
    await expect(popup.locator("#advancePaymentEvidence a")).toHaveAttribute("href", policyURL);
    expect(await popup.evaluate(() => Boolean(window.policyScriptExecuted))).toBe(false);
  } finally { await app.context.close(); }
});

test("외부·로그인·변경 동작·숨김·자바스크립트 링크는 따라가지 않음", async ({ browser }) => {
  const html = `<nav><a href="https://other.example.test/refund">환급 안내</a><a href="/login?next=/withdraw">출금 안내</a><a href="/logout">출금 안내</a><a href="/withdraw?amount=50000&action=transfer">출금 신청</a><a href="javascript:alert('x')">출금 안내</a><a href="/refund" hidden>환급 안내</a><form action="/withdraw" method="post"><button>출금 신청</button></form></nav>`;
  const app = await setup(browser, { html });
  try {
    const popup = await app.openPopup(); await finished(popup);
    expect(app.fetches).toEqual([]);
    expect(app.unexpected).toEqual([]);
    await expect(popup.locator("#advancePaymentWarning")).toBeHidden();
    await expect(popup.locator("#flowAssessment")).toContainText("출금 조건 미확인");
  } finally { await app.context.close(); }
});

test("리디렉션 공개 안내는 목적지를 읽지 않고 출금 조건 미확인 유지", async ({ browser }) => {
  const app = await setup(browser, { html: '<a href="/withdraw-policy">출금 안내</a>', policies: { "https://shop.example.test/withdraw-policy": { status: 302, headers: { ...cors, Location: "https://other.example.test/private" }, body: "" } } });
  try {
    const popup = await app.openPopup(); await finished(popup);
    expect(app.fetches.map(item => item.url)).toEqual(["https://shop.example.test/withdraw-policy"]);
    expect(app.requests[0].page_context || "").not.toContain(upfront);
    await expect(popup.locator("#flowAssessment")).toContainText("출금 조건 미확인");
    await expect(popup.locator("#advancePaymentWarning")).toBeHidden();
  } finally { await app.context.close(); }
});

test("공개 안내 실패를 안전 또는 선입금 요구 없음으로 표시하지 않음", async ({ browser }) => {
  const app = await setup(browser, { html: '<a href="/refund-guide">환급 안내</a>', policies: { "https://shop.example.test/refund-guide": { status: 403, body: "로그인이 필요합니다." } } });
  try {
    const popup = await app.openPopup(); await finished(popup);
    await expect(popup.locator("#flowAssessment")).toContainText("출금 조건 미확인");
    await expect(popup.locator("#advancePaymentCard")).not.toContainText("선입금 요구 없음");
    await expect(popup.locator("#advancePaymentWarning")).toBeHidden();
  } finally { await app.context.close(); }
});

for (const [name, overrides] of [
  ["다른 출처 주소", { source_url: "https://other.example.test/evidence" }],
  ["없는 출처 ID", { source_id: "made-up-source" }]
]) test(`원문이 있어도 ${name}를 위조한 AI 근거는 표시하지 않음`, async ({ browser }) => {
  const app = await setup(browser, { html: `<p>${upfront}</p>`, response: payload => resultWithSignals(payload, upfront, overrides) });
  try {
    const popup = await app.openPopup(); await finished(popup);
    await expect(popup.locator("#advancePaymentWarning")).toBeHidden();
    await expect(popup.locator("#advancePaymentEvidence")).not.toContainText(upfront);
  } finally { await app.context.close(); }
});

test("보상→수익 표시→출금 제한 기록을 같은 사이트의 다음 팝업에 연결", async ({ browser }) => {
  const stages = ["후기를 작성하면 보상 적립금을 드립니다.", "적립된 수익금을 확인하고 출금을 신청하세요.", "계정 인증 전에는 출금이 제한됩니다."];
  const app = await setup(browser, { html: `<p>${stages[0]}</p>` });
  try {
    for (let index = 0; index < stages.length; index += 1) {
      if (index) await app.visit(`<p>${stages[index]}</p>`, `https://shop.example.test/stage-${index}`);
      const popup = await app.openPopup(); await finished(popup);
      for (const text of stages.slice(0, index + 1)) await expect(popup.locator("#flowHistory")).toContainText(text);
      await popup.close();
    }
    const sent = app.requests.at(-1).page_observations;
    for (const text of stages) expect(sent.some(item => item.text.includes(text))).toBe(true);
    expect(sent.some(item => item.kind === "history")).toBe(true);
    expect(sent.every(item => new URL(item.source_url).origin === "https://shop.example.test")).toBe(true);
    expect(Object.keys(app.storage).length).toBeGreaterThan(0);
    await app.visit("<p>일반 상품 안내입니다.</p>", "https://different.example.test/home");
    const popup = await app.openPopup(); await finished(popup);
    expect(app.requests.at(-1).page_observations || []).toHaveLength(0);
    await expect(popup.locator("#advancePaymentWarning")).toBeHidden();
  } finally { await app.context.close(); }
});

test("먼저 보내라는 답변은 팝업 재오픈 뒤 API 실패에도 유지하고 지울 수 있음", async ({ browser }) => {
  const app = await setup(browser, { response: "failure" });
  try {
    let popup = await app.openPopup();
    await popup.getByRole("button", { name: "먼저 보내라고 했어요", exact: true }).click();
    await expect(popup.locator("#advancePaymentCard")).toContainText("입금하지 마세요");
    await expect.poll(() => JSON.stringify(app.storage)).toContain('"answer":"yes"');
    await popup.close();
    popup = await app.openPopup();
    await expect(popup.locator("#advancePaymentCard")).toContainText("입금하지 마세요");
    await expect(popup.locator("#status")).toContainText("서버에 연결하지 못했어요.");
    await popup.locator("#clearFlowHistory").click();
    await popup.close();
    popup = await app.openPopup();
    await expect(popup.locator("#advancePaymentWarning")).toBeHidden();
    await expect(popup.locator("#flowAssessment")).toContainText("출금 조건 미확인");
  } finally { await app.context.close(); }
});

test("기록 삭제 후 도착한 이전 서버 응답은 경고를 되살리지 않음", async ({ browser }) => {
  const app = await setup(browser, { html: `<p>${upfront}</p>`, response: "pending" });
  try {
    const popup = await app.openPopup();
    await expect.poll(() => app.pending.length).toBe(1);
    await popup.locator("#clearFlowHistory").click();
    await app.pending[0].fulfill({ headers: cors, contentType: "application/json", body: JSON.stringify(resultWithSignals(app.requests[0], upfront)) });
    await finished(popup);
    await expect(popup.locator("#advancePaymentWarning")).toBeHidden();
    await expect(popup.locator("#checkResults")).toContainText("총 위험 점수 0점");
  } finally { await app.context.close(); }
});

test("수수료 차감과 보상 안내만으로 선입금 자동 경고를 만들지 않음", async ({ browser }) => {
  const app = await setup(browser, { html: "<section><p>후기를 작성하면 보상 적립금을 드립니다.</p><p>판매대금에서 수수료를 차감한 뒤 지급합니다.</p></section>" });
  try {
    const popup = await app.openPopup(); await finished(popup);
    await expect(popup.locator("#advancePaymentWarning")).toBeHidden();
    await expect(popup.locator("#flowAssessment")).toContainText("출금 조건 미확인");
  } finally { await app.context.close(); }
});

test("여러 공개 안내와 이력의 합계는 2,000자·10건 이하이고 현재 근거를 보존", async ({ browser }) => {
  const policies = {};
  const links = Array.from({ length: 5 }, (_, index) => {
    policies[`https://shop.example.test/withdraw-guide-${index}`] = `<p>출금 안내 ${index}: ${"지급 조건을 확인하세요. ".repeat(180)}</p>`;
    return `<a href="/withdraw-guide-${index}">출금 안내 ${index}</a>`;
  }).join("");
  const app = await setup(browser, { html: `<p>${tax}</p>${links}`, policies });
  try {
    const popup = await app.openPopup(); await finished(popup);
    const payload = app.requests[0];
    expect(app.fetches.length).toBeLessThanOrEqual(3);
    expect(payload.page_observations.length).toBeLessThanOrEqual(10);
    expect(payload.page_observations.reduce((total, item) => total + item.text.length, 0)).toBeLessThanOrEqual(2000);
    expect(payload.page_context.length).toBeLessThanOrEqual(2000);
    expect(payload.page_context).toContain(tax);
    expect(app.unexpected).toEqual([]);
  } finally { await app.context.close(); }
});

test("세션 보관 2시간이 지나면 이전 답변과 단계 근거를 사용하지 않음", async ({ browser }) => {
  const app = await setup(browser, { html: "<button>출금 신청</button><p>후기를 작성하면 보상 적립금을 드립니다.</p>" });
  try {
    let popup = await app.openPopup(); await finished(popup);
    await popup.getByRole("button", { name: "먼저 보내라고 했어요", exact: true }).click();
    await expect.poll(() => JSON.stringify(app.storage)).toContain('"answer":"yes"');
    await popup.close();
    const expired = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    for (const state of Object.values(app.storage)) {
      for (const session of Object.values(state.origins || {})) {
        session.updated_at = expired;
        for (const observation of session.observations || []) observation.observed_at = expired;
      }
    }
    await app.visit("<button>출금 신청</button>", "https://shop.example.test/after-expiry");
    popup = await app.openPopup(); await finished(popup);
    expect(app.requests.at(-1).page_observations || []).toHaveLength(0);
    await expect(popup.locator("#advancePaymentWarning")).toBeHidden();
    await expect(popup.locator("#advancePaymentFeedback")).not.toContainText("입금하지 마세요");
  } finally { await app.context.close(); }
});

for (const [name, policy] of [
  ["HTML 아닌 응답", { contentType: "application/json", body: JSON.stringify({ text: upfront }) }],
  ["과도한 본문", { body: `<p>${upfront}</p>${"x".repeat(170 * 1024)}` }]
]) test(`${name}을 공개 안내 근거로 사용하지 않음`, async ({ browser }) => {
  const app = await setup(browser, { html: '<a href="/withdraw-guide">출금 안내</a>', policies: { "https://shop.example.test/withdraw-guide": policy } });
  try {
    const popup = await app.openPopup(); await finished(popup);
    expect(app.requests[0].page_context || "").not.toContain(upfront);
    await expect(popup.locator("#advancePaymentWarning")).toBeHidden();
    await expect(popup.locator("#flowAssessment")).toContainText("출금 조건 미확인");
  } finally { await app.context.close(); }
});

test("출처 URL에서 사용자 쿼리·비밀값을 제거하고 공개 경로 선택을 보존", async ({ browser }) => {
  const app = await setup(browser);
  try {
    const popup = await app.openPopup(); await finished(popup);
    const results = await popup.evaluate(() => {
      const flow = window.WoowangFlow;
      return {
        clean: flow.sanitizeSourceUrl("https://shop.example.test/bbs/content.php?co_id=refund&token=SECRET_TOKEN&phone=01012345678#account"),
        allowed: flow.isAllowedPolicyUrl("https://shop.example.test/bbs/content.php?co_id=refund", "https://shop.example.test/home"),
        private: flow.isAllowedPolicyUrl("https://shop.example.test/bbs/content.php?token=SECRET_TOKEN", "https://shop.example.test/home"),
        credentials: flow.isAllowedPolicyUrl("https://name:password@shop.example.test/refund", "https://shop.example.test/home")
      };
    });
    expect(results).toEqual({ clean: "https://shop.example.test/bbs/content.php?co_id=refund", allowed: true, private: false, credentials: false });
  } finally { await app.context.close(); }
});

test("마침표 없는 세금 납부 조건도 원문 그대로 수집·검증", async ({ browser }) => {
  const text = "세금 납부가 확인되면 수익금을 받을 수 있습니다";
  const app = await setup(browser, { html: `<p>${text}</p>`, response: payload => resultWithSignals(payload, text) });
  try {
    const popup = await app.openPopup(); await finished(popup);
    expect(app.requests[0].page_context).toContain(text);
    await expect(popup.locator("#advancePaymentWarning")).toBeVisible();
    await expect(popup.locator("#advancePaymentEvidence")).toContainText(text);
  } finally { await app.context.close(); }
});

test("독립된 잔액 표시를 단계 문맥으로 보관하되 개인 금액은 제외", async ({ browser }) => {
  for (const [text, label, privateAmount] of [
    ["현재 잔액: 50,000원", "현재 잔액", "50,000"],
    ["현재 잔액: 5만 원", "현재 잔액", "5만"],
    ["누적 수익금 3천 원", "누적 수익금", "3천"],
    ["현재 잔액: 5만 3천 원", "현재 잔액", "5만 3천"]
  ]) {
    const app = await setup(browser, { html: `<p>${text}</p>`, response: payload => {
      const result = resultWithSignals(payload);
      const observation = payload.page_observations?.[0];
      if (observation) {
        result.analyses.ai.signals = [{ type: "EARNINGS_DISPLAY", source_id: observation.id, source_url: observation.source_url, evidence: observation.text, reason: "현재 적립금 표시만 관찰했습니다." }];
        result.analyses.ai.assessment.observed_stages = ["EARNINGS_DISPLAY"];
        result.analyses.ai.assessment.state = "reward_flow";
      }
      return result;
    } });
    try {
      const popup = await app.openPopup(); await finished(popup);
      expect(app.requests[0].page_context).toContain(label);
      expect(JSON.stringify(app.requests[0])).not.toContain(privateAmount);
      expect(JSON.stringify(app.storage)).not.toContain(privateAmount);
      await expect(popup.locator("#flowHistory")).toContainText(label);
      await expect(popup.locator("#advancePaymentWarning")).toBeHidden();
      await expect(popup.locator("#flowAssessment")).toContainText("출금 조건 미확인");
    } finally { await app.context.close(); }
  }
  // A demanded deposit amount is public evidence, unlike the user's balance.
  const requirement = "출금하려면 5만 원을 먼저 입금하세요.";
  const app = await setup(browser, { html: `<p>${requirement}</p>`, response: payload => resultWithSignals(payload, requirement) });
  try {
    const popup = await app.openPopup(); await finished(popup);
    expect(app.requests[0].page_context).toContain(requirement);
    await expect(popup.locator("#advancePaymentEvidence")).toContainText(requirement);
    await expect(popup.locator("#advancePaymentWarning")).toBeVisible();
  } finally { await app.context.close(); }
});

test("공개 안내 대기 중 팝업을 닫아도 현재 단계는 다음 팝업으로 이어짐", async ({ browser }) => {
  const text = "후기를 작성하면 보상 적립금을 드립니다.";
  const app = await setup(browser, { html: `<p>${text}</p><a href="/withdraw-policy">출금 안내</a>`, policies: { "https://shop.example.test/withdraw-policy": "pending" } });
  try {
    let popup = await app.openPopup();
    await expect.poll(() => app.policyPending.length).toBe(1);
    await expect.poll(() => JSON.stringify(app.storage)).toContain(text);
    await popup.close();
    await app.visit("<p>일반 상품 안내입니다.</p>", "https://shop.example.test/next");
    popup = await app.openPopup(); await finished(popup);
    expect(app.requests.at(-1).page_observations.some(item => item.kind === "history" && item.text.includes(text))).toBe(true);
    await expect(popup.locator("#flowHistory")).toContainText(text);
  } finally { await app.context.close(); }
});

test("공개 안내 대기 중 지운 기록을 늦은 수집 완료가 복구하지 않음", async ({ browser }) => {
  const text = "후기를 작성하면 보상 적립금을 드립니다.";
  const app = await setup(browser, { html: `<p>${text}</p><a href="/withdraw-policy">출금 안내</a>`, policies: { "https://shop.example.test/withdraw-policy": "pending" } });
  try {
    const popup = await app.openPopup();
    await expect.poll(() => app.policyPending.length).toBe(1);
    await expect.poll(() => JSON.stringify(app.storage)).toContain(text);
    await popup.locator("#clearFlowHistory").click();
    await app.policyPending[0].fulfill({ headers: cors, contentType: "text/html", body: `<p>${upfront}</p>` });
    await finished(popup);
    expect(app.requests[0].page_context || "").toBe("");
    expect(app.requests[0].page_observations || []).toHaveLength(0);
    expect(JSON.stringify(app.storage)).not.toContain(text);
    expect(JSON.stringify(app.storage)).not.toContain(upfront);
    await expect(popup.locator("#advancePaymentWarning")).toBeHidden();
  } finally { await app.context.close(); }
});

async function stagedFixtureBody() {
  const html = await fs.readFile(path.join(root, "tests/fixtures/flow-stage.html"), "utf8");
  const body = html.match(/<body>([\s\S]*)<\/body>/i);
  if (!body) throw new Error("The staged fixture must include its actual body and script.");
  return body[1];
}

function expectOnlyGuidanceNotNavigation(payload) {
  const text = payload.page_context || "";
  expect(text).not.toContain("보상 | 적립 | 제한");
  expect(text).not.toContain("세금 조건 | 차감 안내");
  expect(text).not.toContain("메뉴만");
  expect(JSON.stringify(payload.page_observations || [])).not.toContain("차감 안내");
}

test("실제 단계 모의 페이지의 메뉴 이름은 보상 단계나 분석 문구가 아님", async ({ browser }) => {
  const app = await setup(browser, {
    html: await stagedFixtureBody(),
    url: "https://shop.example.test/tests/fixtures/flow-stage.html?stage=menu"
  });
  try {
    await expect(app.source.locator("#stage")).toHaveText("출금 신청");
    const popup = await app.openPopup(); await finished(popup);
    expect(app.requests).toHaveLength(1);
    expect(app.requests[0]).not.toHaveProperty("page_context");
    expect(app.requests[0].page_observations || []).toHaveLength(0);
    expect(app.fetches).toEqual([]);
    await expect(popup.locator("#advancePaymentCard")).toBeVisible();
    await expect(popup.locator("#advancePaymentWarning")).toBeHidden();
    await expect(popup.locator("#flowStages")).not.toContainText("관찰한 단계:");
    await expect(popup.locator("#flowAssessment")).toHaveText("출금 조건 미확인");
    await expect(popup.locator("#flowHistory li")).toHaveCount(0);
    // A reported demand remains the user's answer, independent of menu stages.
    await popup.getByRole("button", { name: "먼저 보내라고 했어요", exact: true }).click();
    await expect(popup.locator("#advancePaymentWarning")).toBeVisible();
    await expect(popup.locator("#advancePaymentEvidence blockquote")).toHaveCount(0);
    await expect(popup.locator("#advancePaymentAnswerSource")).toBeVisible();
    await expect(popup.locator("#advancePaymentAnswerSource")).toHaveText("직접 선택한 답변에 따른 경고예요.");
    await expect(popup.locator("#flowStages")).not.toContainText("관찰한 단계:");
  } finally { await app.context.close(); }
});

test("실제 단계 모의 페이지의 세금 조건은 보존하고 단계 이동 메뉴는 제외", async ({ browser }) => {
  const app = await setup(browser, {
    html: await stagedFixtureBody(),
    url: "https://shop.example.test/tests/fixtures/flow-stage.html?stage=tax",
    response: payload => resultWithSignals(payload, tax)
  });
  try {
    await expect(app.source.locator("#stage")).toHaveText(tax);
    const popup = await app.openPopup(); await finished(popup);
    expect(app.requests[0].page_context).toContain(tax);
    expectOnlyGuidanceNotNavigation(app.requests[0]);
    await expect(popup.locator("#advancePaymentWarning")).toBeVisible();
    await expect(popup.locator("#advancePaymentEvidence")).toContainText(tax);
  } finally { await app.context.close(); }
});

test("실제 보상 문장만 단계 근거로 전송하고 보상 메뉴 이름은 제외", async ({ browser }) => {
  const reward = "리뷰를 작성하면 보상 포인트를 지급합니다.";
  const app = await setup(browser, {
    html: await stagedFixtureBody(),
    url: "https://shop.example.test/tests/fixtures/flow-stage.html?stage=reward",
    response: payload => {
      const result = resultWithSignals(payload, reward, { type: "REWARD_OFFER" });
      result.analyses.ai.assessment = { state: "reward_flow", withdrawal_status: "unverified", observed_stages: ["REWARD_OFFER"] };
      return result;
    }
  });
  try {
    const popup = await app.openPopup(); await finished(popup);
    expect(app.requests[0].page_context).toContain(reward);
    expectOnlyGuidanceNotNavigation(app.requests[0]);
    await expect(popup.locator("#flowStages")).toContainText("관찰한 단계: 보상 안내");
    await expect(popup.locator("#advancePaymentWarning")).toBeHidden();
    await expect(popup.locator("#flowAssessment")).toHaveText("출금 조건 미확인");
  } finally { await app.context.close(); }
});

test("출금 안내 링크의 메뉴명은 문맥에서 빼도 공개 안내 원문은 따라가서 검사", async ({ browser }) => {
  const policyURL = "https://shop.example.test/help/withdraw";
  const app = await setup(browser, {
    html: '<nav><a href="/help/withdraw">출금 안내</a></nav>',
    policies: { [policyURL]: `<section><p>${tax}</p></section>` },
    response: payload => resultWithSignals(payload, tax)
  });
  try {
    const popup = await app.openPopup(); await finished(popup);
    expect(app.fetches).toEqual([{ url: policyURL, method: "GET" }]);
    const observations = app.requests[0].page_observations;
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ kind: "linked_policy", source_url: policyURL });
    expect(observations[0].text).toContain(tax);
    expect(app.requests[0].page_context).not.toContain("출금 안내");
    await expect(popup.locator("#advancePaymentEvidence a")).toHaveAttribute("href", policyURL);
  } finally { await app.context.close(); }
});

test("nav 안이라도 실제 입금 조건을 설명하는 문장은 제외하지 않음", async ({ browser }) => {
  const app = await setup(browser, {
    html: `<nav><p>${tax}</p><a href="#reward">보상</a> | <a href="#tax">세금 조건</a> | <a href="#deduction">차감 안내</a></nav>`,
    response: payload => resultWithSignals(payload, tax)
  });
  try {
    const popup = await app.openPopup(); await finished(popup);
    expect(app.requests[0].page_context).toContain(tax);
    expectOnlyGuidanceNotNavigation(app.requests[0]);
    expect(app.requests[0].page_context).not.toContain("세금 조건");
    await expect(popup.locator("#advancePaymentEvidence")).toContainText(tax);
  } finally { await app.context.close(); }
});

test("연결된 공개 안내에도 메뉴 이름만 있으면 관찰 문구를 만들지 않음", async ({ browser }) => {
  const policyURL = "https://shop.example.test/help/withdraw";
  const app = await setup(browser, {
    html: '<nav><a href="/help/withdraw">출금 안내</a></nav>',
    policies: { [policyURL]: '<nav><a href="#reward">보상</a> | <a href="#earnings">적립</a> | <a href="#lock">제한</a> | <a href="#tax">세금 조건</a> | <a href="#deduction">차감 안내</a> | <a href="#menu">메뉴만</a></nav>' }
  });
  try {
    const popup = await app.openPopup(); await finished(popup);
    expect(app.fetches).toEqual([{ url: policyURL, method: "GET" }]);
    expect(app.requests[0]).not.toHaveProperty("page_context");
    expect(app.requests[0].page_observations || []).toHaveLength(0);
    await expect(popup.locator("#flowHistory li")).toHaveCount(0);
    await expect(popup.locator("#flowStages")).not.toContainText("관찰한 단계:");
    await expect(popup.locator("#advancePaymentWarning")).toBeHidden();
    await expect(popup.locator("#flowAssessment")).toHaveText("출금 조건 미확인");
  } finally { await app.context.close(); }
});

test("이전 메뉴 기록을 정리해도 과거 세금 조건은 출처와 함께 보존하며 관찰 순서를 단정하지 않음", async ({ browser }) => {
  const site = "https://shop.example.test";
  const labels = "보상 | 적립 | 제한 | 세금 조건 | 차감 안내 | 메뉴만";
  const taxURL = `${site}/tests/fixtures/flow-stage.html?stage=tax`;
  const menuURL = `${site}/tests/fixtures/flow-stage.html?stage=menu`;
  const restriction = "계정 확인 전에는 출금이 제한됩니다.";
  const observedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const storage = {
    "woowang.paymentFlow.v1": { owner: "http://127.0.0.1:8000/25", origins: { [site]: {
      answer: null,
      updated_at: observedAt,
      observations: [
        { id: "old_menu_labels", source_url: menuURL, kind: "current_page", text: labels, observed_at: observedAt },
        { id: "old_tax_with_navigation", source_url: taxURL, kind: "current_page", text: `${tax}\n${labels}`, observed_at: observedAt }
      ]
    } } }
  };
  const app = await setup(browser, {
    html: `<p>${restriction}</p>`,
    url: `${site}/restriction`,
    storage,
    response: payload => {
      const result = resultWithSignals(payload, tax);
      const source = payload.page_observations?.find(item => item.text.includes(restriction));
      if (source) result.analyses.ai.signals.push({
        type: "WITHDRAWAL_RESTRICTED", source_id: source.id, source_url: source.source_url,
        evidence: restriction, reason: "현재 화면에서 출금 제한 안내를 관찰했습니다."
      });
      result.analyses.ai.assessment.observed_stages = ["ADVANCE_PAYMENT_REQUIRED", "WITHDRAWAL_RESTRICTED"];
      return result;
    }
  });
  try {
    const popup = await app.openPopup(); await finished(popup);
    const payload = app.requests[0];
    expectOnlyGuidanceNotNavigation(payload);
    expect(payload.page_observations.some(item => item.source_url === menuURL)).toBe(false);
    expect(payload.page_observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "history", source_url: taxURL, text: tax, observed_at: observedAt }),
      expect.objectContaining({ kind: "current_page", text: restriction })
    ]));
    expect(JSON.stringify(app.storage)).not.toContain(labels);
    expect(JSON.stringify(app.storage)).not.toContain("메뉴만");
    await expect(popup.locator("#flowHistory")).toContainText(tax);
    await expect(popup.locator("#flowHistory")).toContainText(restriction);
    await expect(popup.locator("#flowHistory")).not.toContainText("메뉴만");
    await expect(popup.locator("#advancePaymentWarning")).toBeVisible();
    await expect(popup.locator("#advancePaymentEvidence blockquote")).toHaveText(tax);
    await expect(popup.locator("#advancePaymentEvidence a")).toHaveAttribute("href", taxURL);
    // The old tax quote predates the current restriction: category order is not
    // a claim that these stages happened in that order in the actual trade.
    await expect(popup.locator("#flowStages")).toContainText("출금 제한 · 추가 입금 요구");
    await expect(popup.locator("#flowStages")).toContainText("(관찰 순서와 무관)");
    await expect(popup.locator("#flowStages")).not.toContainText("→");
    await expect(popup.locator("#advancePaymentAnswerSource")).toBeHidden();
  } finally { await app.context.close(); }
});

const loginOnlyPolicy = `<script>window.__gateExecuted = true; alert('먼저 로그인 하세요');</script><meta http-equiv='refresh' content='0; url=./''>`;

for (const syntheticDomain of ["first-shop.example.test", "second-shop.example.test", "third-shop.example.test"]) {
  test(`공개 안내 진단: HTTP200 로그인 전용 안내를 구분 (${syntheticDomain})`, async ({ browser }) => {
    const site = `https://${syntheticDomain}`;
    const withdrawURL = `${site}/my_qk_l.php`;
    const chargeURL = `${site}/my_hk_l.php`;
    const app = await setup(browser, {
      url: `${site}/`,
      html: '<nav><a href="/my_qk_l.php">출금신청</a><a href="/my_hk_l.php">충전신청</a></nav>',
      policies: { [withdrawURL]: loginOnlyPolicy, [chargeURL]: loginOnlyPolicy },
      response: payload => {
        const result = resultWithSignals(payload);
        result.analyses.ai = { status: "skipped", reason: "NO_PAGE_CONTEXT", signals: [], risk_score: null, max_score: 50, scoring_status: "unavailable", scoring_policy: "business50_ai50_v3" };
        result.analyses.nts = { status: "error", error: "INVALID_BUSINESS_NUMBER", business_status: null };
        result.analyses.ftc = { status: "completed", search_method: "BUSINESS_NAME", match_status: "NO_MATCH" };
        result.risk_score = 50;
        result.verdict = "CAUTION";
        result.score_status = "partial";
        result.scoring_policy = "business50_ai50_v3";
        result.score_breakdown = {
          business: { score: 50, max_score: 50, raw_score: 50, status: "partial", capped: false },
          ai: { score: null, max_score: 50, status: "unavailable" }
        };
        result.risk_factors = [
          { code: "MALFORMED_BUSINESS_NUMBER", message: "표시된 사업자번호는 11자리여서 형식이 올바르지 않습니다.", points: 20 },
          { code: "FTC_BUSINESS_NAME_NOT_FOUND", message: "공정거래위원회에서 해당 상호명을 찾을 수 없습니다.", points: 25 },
          { code: "MALFORMED_NUMBER_AND_FTC_NAME_NOT_FOUND", message: "번호 형식 오류와 공정위 상호명 검색 실패가 함께 확인되어 추가 확인이 필요합니다.", points: 5 }
        ];
        return result;
      }
    });
    try {
      // Keep exactly the observed malformed 11-digit number; the helper's
      // default valid footer would otherwise hide this extraction boundary.
      await app.source.locator("footer").evaluate(footer => {
        footer.innerHTML = '<p>상호: 합성상점 | 대표자: 홍길동</p><p>사업자등록번호: 125-86-112516</p>';
      });
      const popup = await app.openPopup(); await finished(popup);
      expect(app.requests[0].business_info.business_number).toBe("");
      expect(app.requests[0].business_info.displayed_business_number).toBe("125-86-112516");
      expect(app.requests[0]).not.toHaveProperty("page_context");
      expect(app.requests[0].page_observations || []).toHaveLength(0);
      await expect(popup.locator("#businessNumber")).toHaveText("형식 오류");
      await expect(popup.locator("#businessNumberIssueDetail")).toContainText("125-86-112516");
      await expect(popup.locator("#businessNumberIssueDetail")).toContainText("11");
      await expect(popup.locator("#checkResults")).toContainText("총 위험 점수 50점");
      await expect(popup.locator("#checkResults")).toContainText("주의");
      await expect(popup.locator("#businessRiskScore")).toHaveText("50 / 50점");
      await expect(popup.locator("#checkResults")).toContainText("번호 형식 오류와 공정위 상호명 검색 실패가 함께 확인");
      await expect(popup.locator("#aiRiskScore")).toHaveText("미확인 / 50점");
      await expect(popup.locator("#flowAssessment")).toContainText("출금 조건 미확인");
      await expect(popup.locator("#flowCoverage")).toContainText("분석할 안내문을 수집하지 못해");
      await expect(popup.locator("#flowPolicyChecks li")).toHaveCount(2);
      await expect(popup.locator("#flowPolicyChecks")).toContainText("로그인 없이 읽을 수 없는 페이지");
      const policyLinks = await popup.locator("#flowPolicyChecks a").evaluateAll(links => links.map(link => link.href).sort());
      expect(policyLinks).toEqual([withdrawURL, chargeURL].sort());
      expect(app.fetches.map(item => item.url).sort()).toEqual([withdrawURL, chargeURL].sort());
      expect(app.fetches.every(item => item.method === "GET")).toBe(true);
      expect(app.unexpected).toEqual([]);
      const options = await popup.evaluate(() => window.__policyOptions);
      expect(options).toHaveLength(2);
      expect(options.every(item => item.credentials === "omit" && item.redirect === "error")).toBe(true);
      expect(await popup.evaluate(() => Boolean(window.__gateExecuted))).toBe(false);
      await expect(popup.locator("#flowHistory li")).toHaveCount(0);
      await expect(popup.locator("#advancePaymentWarning")).toBeHidden();
      await popup.getByRole("button", { name: "먼저 보내라고 했어요", exact: true }).click();
      await expect(popup.locator("#advancePaymentWarning")).toBeVisible();
      await expect(popup.locator("#advancePaymentAnswerSource")).toHaveText("직접 선택한 답변에 따른 경고예요.");
      await expect(popup.locator("#advancePaymentEvidence blockquote")).toHaveCount(0);
    } finally { await app.context.close(); }
  });
}

test("공개 안내 진단: 화면 밖 공개 약관은 우선 읽고 숨김 링크와 화면 밖 메뉴 질문은 제외", async ({ browser }) => {
  const site = "https://shop.example.test";
  const termsURL = `${site}/sub_1.php`;
  const withdrawURL = `${site}/my_qk_l.php`;
  const app = await setup(browser, {
    html: '<nav><a href="/my_hk_l.php">충전신청</a><a href="/withdraw-history">출금 내역</a><a href="/my_qk_l.php">출금신청</a></nav><footer style="margin-top:2000px"><a href="/hidden-guide" style="display:none">출금 안내</a><a href="/hidden-left-guide" style="position:absolute;left:-9999px;top:0">환급 안내</a><a href="/hidden-top-guide" style="position:absolute;left:0;top:-9999px">출금 안내</a><a href="/outside-right-guide" style="position:absolute;left:9999px;top:0">출금 안내</a><a href="/sub_1.php">이용약관</a></footer>',
    policies: { [termsURL]: `<section><p>${tax}</p></section>`, [withdrawURL]: loginOnlyPolicy },
    response: payload => resultWithSignals(payload, tax)
  });
  try {
    expect(await app.source.locator('a[href="/sub_1.php"]').evaluate(link => link.getBoundingClientRect().top > window.innerHeight)).toBe(true);
    const popup = await app.openPopup(); await finished(popup);
    await expect(popup.locator("#advancePaymentCard")).toBeVisible();
    expect(app.fetches.map(item => item.url).sort()).toEqual([termsURL, withdrawURL].sort());
    expect(app.fetches).toHaveLength(2);
    expect(app.unexpected).toEqual([]);
    expect(app.requests[0].page_observations).toEqual([
      expect.objectContaining({ kind: "linked_policy", source_url: termsURL, text: expect.stringContaining(tax) })
    ]);
    await expect(popup.locator("#advancePaymentWarning")).toBeVisible();
    await expect(popup.locator("#advancePaymentEvidence blockquote")).toHaveText(tax);
    await expect(popup.locator("#advancePaymentEvidence a")).toHaveAttribute("href", termsURL);
    await expect(popup.locator("#flowPolicyChecks")).toContainText("로그인 없이 읽을 수 없는 페이지");
    await popup.close();
    // Policy link discovery may inspect a rendered footer outside the viewport;
    // menu questions and current-screen text must retain viewport visibility.
    await app.visit('<div style="margin-top:2000px"><button>출금 신청</button></div>', "https://offscreen.example.test/home");
    const offscreenPopup = await app.openPopup(); await finished(offscreenPopup);
    expect(app.requests.at(-1)).not.toHaveProperty("page_context");
    expect(app.requests.at(-1).page_observations || []).toHaveLength(0);
    await expect(offscreenPopup.locator("#advancePaymentCard")).toBeHidden();
    await expect(offscreenPopup.locator("#advancePaymentWarning")).toBeHidden();
  } finally { await app.context.close(); }
});

test("공개 안내 진단: 같은 출처의 괄호만 다른 검증된 근거를 한 번 표시", async ({ browser }) => {
  const app = await setup(browser, {
    html: `<section><p>(${upfront})</p></section>`,
    response: payload => {
      const result = resultWithSignals(payload, upfront);
      result.analyses.ai.signals.push({ ...result.analyses.ai.signals[0], evidence: `(${upfront}` });
      return result;
    }
  });
  try {
    const popup = await app.openPopup(); await finished(popup);
    const sent = app.requests[0].page_observations[0].text;
    expect(sent).toContain(upfront);
    expect(sent).toContain(`(${upfront}`);
    await expect(popup.locator("#advancePaymentEvidence blockquote")).toHaveCount(1);
    await expect(popup.locator("#advancePaymentEvidence blockquote")).toHaveText(upfront);
    await expect(popup.locator("#advancePaymentEvidence a")).toHaveCount(1);
  } finally { await app.context.close(); }
});

test("공개 안내 진단: 다른 입금액의 원문 근거는 중복으로 합치지 않음", async ({ browser }) => {
  const other = "출금 제한을 풀려면 10만 원을 먼저 입금하세요.";
  const app = await setup(browser, {
    html: `<section><p>${upfront}</p><p>${other}</p></section>`,
    response: payload => {
      const result = resultWithSignals(payload, upfront);
      const source = payload.page_observations.find(item => item.text.includes(other));
      result.analyses.ai.signals.push({ type: "ADVANCE_PAYMENT_REQUIRED", source_id: source.id,
        source_url: source.source_url, evidence: other, reason: "다른 입금액을 요구하는 별도의 안내입니다." });
      return result;
    }
  });
  try {
    const popup = await app.openPopup(); await finished(popup);
    await expect(popup.locator("#advancePaymentEvidence blockquote")).toHaveCount(2);
    expect(await popup.locator("#advancePaymentEvidence blockquote").allTextContents()).toEqual([upfront, other]);
  } finally { await app.context.close(); }
});

for (const scenario of [
  { reason: "NO_PAGE_CONTEXT", html: "<button>출금 신청</button>", expected: "분석할 안내문을 수집하지 못해" },
  { reason: "MISSING_API_KEY", html: "<p>판매대금에서 수수료를 차감한 뒤 지급합니다.</p>", expected: "서버의 AI 인증 설정이 없어" }
]) {
  test(`공개 안내 진단: 분석 생략 원인을 구분 (${scenario.reason})`, async ({ browser }) => {
    const app = await setup(browser, { html: scenario.html, response: payload => {
      const result = resultWithSignals(payload);
      result.analyses.ai = { status: "skipped", reason: scenario.reason, signals: [] };
      return result;
    } });
    try {
      const popup = await app.openPopup(); await finished(popup);
      await expect(popup.locator("#flowCoverage")).toContainText(scenario.expected);
      await expect(popup.locator("#flowAssessment")).toContainText("출금 조건 미확인");
      await expect(popup.locator("#advancePaymentWarning")).toBeHidden();
    } finally { await app.context.close(); }
  });
}
