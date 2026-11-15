// These are extraction/request preflight checks, not live model classification.
const { test, expect } = require("@playwright/test");
const { authenticatedFixture } = require("./helpers/auth-fixture");
const fs = require("node:fs/promises");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const origin = "http://model-cases.test";
const cases = [
  { name: "withdrawal-lock", text: "출금 제한을 풀려면 5만 원을 먼저 입금하세요.", expectedWarning: true },
  { name: "deposit-payout", text: "보증금 입금이 확인되면 판매대금을 지급합니다.", expectedWarning: true },
  { name: "fee-deduction", text: "판매대금에서 수수료를 차감한 뒤 지급합니다.", expectedWarning: false },
  { name: "purchase-points", text: "상품 구매에 사용할 포인트를 충전하세요.", expectedWarning: false },
  { name: "menu-only", text: "출금 신청", expectedWarning: false, button: true },
  { name: "prevention", text: "출금 전에 수수료를 보내라고 하면 거래를 중단하세요.", expectedWarning: false }
];

for (const scenario of cases) {
  test(`실제 모델 사전점검 추출·전송: ${scenario.name}`, async ({ browser }, testInfo) => {
    // Set expectations before any model result; this suite never calls a model.
    testInfo.annotations.push({ type: "expected_live_warning", description: String(scenario.expectedWarning) });
    const context = await browser.newContext();
    const payloads = [];
    const extractions = [];
    try {
      await context.route(`${origin}/**`, async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (!["/popup.html", "/popup.js", "/flow.js", "/site-checks.js", "/auth.js", "/tests/fixtures/model-cases.html"].includes(pathname)) {
          await route.fulfill({ status: 404, body: "" });
          return;
        }
        await route.fulfill({
          contentType: pathname.endsWith(".js") ? "application/javascript" : "text/html; charset=utf-8",
          body: await fs.readFile(path.join(root, pathname))
        });
      });
      await context.route("http://127.0.0.1:8000/api/v1/scan/", async route => {
        if (route.request().method() === "OPTIONS") {
          await route.fulfill({ status: 204, headers: {
            "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST",
            "Access-Control-Allow-Headers": "Content-Type"
          } });
          return;
        }
        payloads.push(route.request().postDataJSON());
        await route.fulfill({
          status: 200,
          headers: { "Access-Control-Allow-Origin": "*" },
          contentType: "application/json",
          body: JSON.stringify({
            analyses: { ai: { status: "skipped", reason: "LIVE_MODEL_NOT_CALLED", signals: [] } },
            risk_factors: []
          })
        });
      });
      const sourceURL = `${origin}/tests/fixtures/model-cases.html?case=${scenario.name}`;
      const source = await context.newPage();
      await source.goto(sourceURL);
      await expect(source.locator("#caseContent")).toHaveAttribute("data-case", scenario.name);
      await expect(source.locator("#caseContent")).toHaveText(scenario.text);
      // No other synthetic phrase is mounted or accidentally collected.
      await expect(source.locator("#caseContent > *")).toHaveCount(1);

      const popup = await context.newPage();
      await popup.exposeFunction("__executeInCurrentTab", async functionSource => {
        const result = await source.evaluate(`(${functionSource})()`);
        extractions.push(result);
        return { result };
      });
      await popup.addInitScript(({ sourceURL }) => {
        window.chrome = {
          tabs: { query: async () => [{ id: 25, url: sourceURL }] },
          scripting: { executeScript: async options => [await window.__executeInCurrentTab(options.func.toString())] }
        };
      }, { sourceURL });
      await authenticatedFixture(popup);
  await popup.goto(`${origin}/popup.html`);
      await expect(popup.locator("#status")).toHaveText("백엔드 응답을 받았어요.");
      expect(payloads).toHaveLength(1);
      expect(extractions).toHaveLength(1);
      expect(extractions[0].hasAdvancePaymentMenu).toBe(Boolean(scenario.button));
      if (scenario.button) {
        expect(extractions[0].pageContext).toBe("");
        expect(payloads[0]).not.toHaveProperty("page_context");
        await expect(popup.locator("#advancePaymentCard")).toBeVisible();
      } else {
        expect(extractions[0].pageContext).toBe(scenario.text);
        expect(payloads[0].page_context).toBe(scenario.text);
      }
      // This is the skipped mock's result, never a real classification assertion.
      await expect(popup.locator("#advancePaymentWarning")).toBeHidden();
    } finally {
      await context.close();
    }
  });
}
