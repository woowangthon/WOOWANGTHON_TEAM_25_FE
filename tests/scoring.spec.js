// Score display tests use synthetic local responses. No external API is called.
const { test, expect } = require("@playwright/test");
const { authenticatedFixture } = require("./helpers/auth-fixture");
const fs = require("node:fs/promises");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const popupOrigin = "http://scoring-popup.test";
const sourceURL = "https://scoring-shop.example.test/withdraw";
const scanURL = "http://127.0.0.1:8000/api/v1/scan/";
const upfront = "출금하려면 5만 원을 먼저 입금하세요.";
const deduction = "판매대금에서 수수료를 차감한 뒤 지급합니다.";
const cors = { "Access-Control-Allow-Origin": "*" };

function sourceSignal(payload, evidence, type = "ADVANCE_PAYMENT_REQUIRED", source = "ai") {
  const observation = payload.page_observations?.find(item => item.text.includes(evidence));
  return {
    type, evidence, reason: "합성 안내문의 원문으로 확인한 신호입니다.", source,
    source_id: observation?.id || "missing-source", source_url: observation?.source_url,
    kind: observation?.kind, observed_at: observation?.observed_at
  };
}

function scoredResult(payload, options = {}) {
  const businessScore = options.businessScore ?? 40;
  const rawScore = options.rawScore ?? businessScore;
  const [businessMax, aiMax, policy] = options.legacyPolicy === "60/40"
    ? [60, 40, "business60_ai40_v1"]
    : options.legacyPolicy ? [40, 60, "business40_ai60_v1"] : [50, 50, "business50_ai50_v3"];
  const aiScore = Object.hasOwn(options, "aiScore") ? options.aiScore : aiMax;
  const aiScoringStatus = options.aiScoringStatus ?? (aiScore === null ? "unavailable" : "completed");
  const aiStatus = options.aiStatus ?? (aiScore === null ? "skipped" : "completed");
  const businessStatus = options.businessStatus ?? "completed";
  const total = businessScore + (aiScore ?? 0);
  const scoreStatus = options.scoreStatus ?? (businessStatus === "completed" && aiScoringStatus === "completed" ? "completed" : "partial");
  const signals = options.signals ?? (aiScore === aiMax ? [sourceSignal(payload, upfront)] : []);
  return {
    risk_score: total,
    verdict: aiScore === aiMax || total >= 60 ? "HIGH_RISK" : total >= 20 ? "CAUTION" : scoreStatus === "completed" ? "LOW_RISK" : "INSUFFICIENT_DATA",
    score_status: scoreStatus,
    scoring_policy: policy,
    score_breakdown: {
      business: { score: businessScore, max_score: businessMax, raw_score: rawScore, status: businessStatus, capped: rawScore > businessMax },
      ai: { score: aiScore, max_score: aiMax, status: aiScoringStatus }
    },
    risk_factors: options.riskFactors ?? [],
    checked_items: [],
    analyses: {
      nts: businessStatus === "unavailable" ? { status: "skipped" } : { status: "completed", business_status: "ACTIVE", business_status_description: "계속사업자" },
      ftc: businessStatus === "unavailable" ? { status: "skipped" } : { status: "completed", search_method: "BUSINESS_NUMBER", match_status: "NO_MATCH" },
      ai: {
        status: aiStatus, signals, risk_score: aiScore, max_score: aiMax,
        scoring_status: aiScoringStatus, scoring_policy: policy,
        risk_factors: [],
        ...(options.aiReason ? { reason: options.aiReason } : {}),
        ...(options.aiError ? { error: options.aiError } : {}),
        assessment: {
          state: signals.some(signal => signal.type === "ADVANCE_PAYMENT_REQUIRED") ? "advance_payment_required" : "unverified",
          withdrawal_status: signals.some(signal => signal.type === "ADVANCE_PAYMENT_REQUIRED") ? "risk_detected" : "unverified",
          observed_stages: [...new Set(signals.map(signal => signal.type))]
        }
      }
    }
  };
}

async function openScoredPopup(browser, { html = `<p>${upfront}</p>`, response, pending = false } = {}) {
  const context = await browser.newContext();
  const payloads = [], pendingRoutes = [];
  await context.route("**/*", async route => {
    const target = route.request().url();
    if (target.startsWith(`${popupOrigin}/`)) {
      const pathname = new URL(target).pathname;
      if (["/popup.html", "/popup.js", "/flow.js", "/site-checks.js", "/auth.js"].includes(pathname)) {
        await route.fulfill({ contentType: pathname.endsWith(".js") ? "application/javascript" : "text/html; charset=utf-8", body: await fs.readFile(path.join(root, pathname)) });
      } else await route.fulfill({ status: 404, body: "" });
      return;
    }
    if (target === sourceURL) {
      await route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html lang="ko"><body>${html}<footer><p>상호: 모의상점 | 대표자: 홍길동</p><p>사업자등록번호: 123-45-67890</p></footer></body></html>` });
      return;
    }
    if (target === scanURL) {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type" } });
        return;
      }
      const payload = route.request().postDataJSON();
      payloads.push(payload);
      if (pending) { pendingRoutes.push(route); return; }
      await route.fulfill({ contentType: "application/json", headers: cors, body: JSON.stringify(response ? response(payload) : scoredResult(payload)) });
      return;
    }
    // The synthetic fixture has no public-policy links or other resources.
    await route.abort();
  });
  const source = await context.newPage(); await source.goto(sourceURL);
  const popup = await context.newPage();
  await popup.exposeFunction("__extract", code => source.evaluate(`(${code})()`));
  await popup.addInitScript(({ sourceURL }) => {
    window.chrome = {
      tabs: { query: async () => [{ id: 25, url: sourceURL }] },
      scripting: { executeScript: async options => [{ result: await window.__extract(options.func.toString()) }] }
    };
  }, { sourceURL });
  await authenticatedFixture(popup);
  await popup.goto(`${popupOrigin}/popup.html`);
  return { context, popup, payloads, pendingRoutes };
}

async function finished(popup) {
  await expect(popup.locator("#status")).toHaveText("백엔드 응답을 받았어요.");
}

test("점수 표시: 사업자50·검증된 선입금50을 총100으로 표시", async ({ browser }) => {
  const app = await openScoredPopup(browser, { response: payload => scoredResult(payload, {
    businessScore: 50, rawScore: 70,
    riskFactors: [
      { code: "ABNORMAL_BUSINESS_STATUS", message: "사업자 상태가 정상적이지 않습니다.", raw_points: 30, points: 21 },
      { code: "FTC_NO_MATCH", message: "사업자번호로 업체를 찾지 못했습니다.", raw_points: 40, points: 29 },
      { code: "AI_ADVANCE_PAYMENT_REQUIRED", message: "검증된 원문에서 선입금 조건을 확인했습니다.", points: 50 }
    ]
  }) });
  try {
    await finished(app.popup);
    await expect(app.popup.locator("#scoreBreakdown")).toBeVisible();
    await expect(app.popup.locator("#businessRiskScore")).toHaveText("50 / 50점");
    await expect(app.popup.locator("#aiRiskScore")).toHaveText("50 / 50점");
    await expect(app.popup.locator("#totalRiskScore")).toHaveText("100 / 100점");
    await expect(app.popup.locator("#scorePolicyNotice")).toBeHidden();
    await expect(app.popup.locator("#checkResults")).toContainText("높은 위험");
    await expect(app.popup.locator("#checkResults")).toContainText("총 위험 점수 100점");
    await expect(app.popup.locator("#advancePaymentWarning")).toBeVisible();
    await expect(app.popup.locator("#advancePaymentEvidence blockquote")).toHaveText(upfront);
  } finally { await app.context.close(); }
});

test("점수 표시: 분석하지 못한 AI점수는 0 대신 미확인", async ({ browser }) => {
  const app = await openScoredPopup(browser, {
    html: "<button>출금 신청</button>",
    response: payload => scoredResult(payload, { aiScore: null, aiReason: "NO_PAGE_CONTEXT" })
  });
  try {
    await finished(app.popup);
    await expect(app.popup.locator("#businessRiskScore")).toHaveText("40 / 50점");
    await expect(app.popup.locator("#aiRiskScore")).toHaveText("미확인 / 50점");
    await expect(app.popup.locator("#totalRiskScore")).toHaveText("40 / 100점");
    await expect(app.popup.locator("#scoreCompleteness")).toContainText("일부 항목 미확인");
    await expect(app.popup.locator("#advancePaymentWarning")).toBeHidden();
    await expect(app.popup.locator("#flowAssessment")).toHaveText("출금 조건 미확인");
  } finally { await app.context.close(); }
});

test("점수 표시: 분석 완료 무신호 0점과 출금 조건 미확인을 함께 표시", async ({ browser }) => {
  const app = await openScoredPopup(browser, {
    html: `<p>${deduction}</p>`,
    response: payload => scoredResult(payload, { businessScore: 0, aiScore: 0 })
  });
  try {
    await finished(app.popup);
    await expect(app.popup.locator("#aiRiskScore")).toHaveText("0 / 50점");
    await expect(app.popup.locator("#totalRiskScore")).toHaveText("0 / 100점");
    await expect(app.popup.locator("#flowAssessment")).toHaveText("출금 조건 미확인");
    await expect(app.popup.locator("#advancePaymentWarning")).toBeHidden();
    await expect(app.popup.locator("#checkResults")).toContainText("확인된 위험 점수 낮음");
  } finally { await app.context.close(); }
});

test("점수 표시: 원점수70을 사업자상한50으로 제한한 이유를 표시", async ({ browser }) => {
  const app = await openScoredPopup(browser, {
    html: `<p>${deduction}</p>`,
    response: payload => scoredResult(payload, {
      businessScore: 50, rawScore: 70, aiScore: 0,
      riskFactors: [
        { code: "ABNORMAL_BUSINESS_STATUS", message: "사업자 상태가 정상적이지 않습니다.", raw_points: 30, points: 21 },
        { code: "FTC_NO_MATCH", message: "사업자번호로 업체를 찾지 못했습니다.", raw_points: 40, points: 29 }
      ]
    })
  });
  try {
    await finished(app.popup);
    await expect(app.popup.locator("#businessRiskScore")).toHaveText("50 / 50점");
    await expect(app.popup.locator("#businessScoreCapNote")).toContainText("사업자 원점수 70점 중 상한 50점을 반영했어요.");
    await expect(app.popup.locator("#totalRiskScore")).toHaveText("50 / 100점");
    await expect(app.popup.locator("#checkResults")).toContainText("21점");
    await expect(app.popup.locator("#checkResults")).toContainText("29점");
  } finally { await app.context.close(); }
});

test("점수 표시: 모델 시간 초과에도 검증된 규칙50과 높은 위험 경고를 유지", async ({ browser }) => {
  const app = await openScoredPopup(browser, {
    response: payload => scoredResult(payload, {
      businessScore: 0, businessStatus: "unavailable", aiScore: 50,
      aiStatus: "error", aiError: "OPENAI_TIMEOUT", aiScoringStatus: "rule_only",
      signals: [sourceSignal(payload, upfront, "ADVANCE_PAYMENT_REQUIRED", "rule")]
    })
  });
  try {
    await finished(app.popup);
    await expect(app.popup.locator("#aiRiskScore")).toHaveText("50 / 50점");
    await expect(app.popup.locator("#totalRiskScore")).toHaveText("50 / 100점");
    await expect(app.popup.locator("#checkResults")).toContainText("높은 위험");
    await expect(app.popup.locator("#aiScoreStatus")).toContainText("검증된 규칙 근거");
    await expect(app.popup.locator("#scoreCompleteness")).toContainText("일부 항목 미확인");
    await expect(app.popup.locator("#advancePaymentWarning")).toBeVisible();
    await expect(app.popup.locator("#advancePaymentEvidence blockquote")).toHaveText(upfront);
  } finally { await app.context.close(); }
});

test("점수 표시: 단계조합10만으로 직접 선입금 경고를 만들지 않음", async ({ browser }) => {
  const stages = [
    ["리뷰를 작성하면 보상 포인트를 지급합니다.", "REWARD_OFFER"],
    ["수익금 적립이 완료되었습니다.", "EARNINGS_DISPLAY"],
    ["계정 확인 전에는 출금이 제한됩니다.", "WITHDRAWAL_RESTRICTED"]
  ];
  const app = await openScoredPopup(browser, {
    html: `<section>${stages.map(([text]) => `<p>${text}</p>`).join("")}</section>`,
    response: payload => scoredResult(payload, {
      aiScore: 10, signals: stages.map(([text, type]) => sourceSignal(payload, text, type))
    })
  });
  try {
    await finished(app.popup);
    await expect(app.popup.locator("#aiRiskScore")).toHaveText("10 / 50점");
    await expect(app.popup.locator("#totalRiskScore")).toHaveText("50 / 100점");
    await expect(app.popup.locator("#advancePaymentWarning")).toBeHidden();
    await expect(app.popup.locator("#flowAssessment")).toHaveText("출금 조건 미확인");
    await expect(app.popup.locator("#flowStages")).toContainText("보상 안내 · 수익·적립 표시 · 출금 제한");
  } finally { await app.context.close(); }
});

test("점수 표시: 높은 숫자 점수와 원문에 없는 인용은 입금 경고의 근거가 아님", async ({ browser }) => {
  const app = await openScoredPopup(browser, {
    html: `<p>${deduction}</p>`,
    response: payload => scoredResult(payload, {
      signals: [{ ...sourceSignal(payload, deduction), evidence: "전송하지 않은 별도 입금 요구 문장입니다." }]
    })
  });
  try {
    await finished(app.popup);
    await expect(app.popup.locator("#advancePaymentWarning")).toBeHidden();
    await expect(app.popup.locator("#advancePaymentEvidence blockquote")).toHaveCount(0);
    await expect(app.popup.locator("#flowAssessment")).toHaveText("출금 조건 미확인");
  } finally { await app.context.close(); }
});

test("점수 표시: 사용자의 답변 경고를 API실패 후 유지하고 AI점수를 만들지 않음", async ({ browser }) => {
  const app = await openScoredPopup(browser, { html: "<button>출금 신청</button>", pending: true });
  try {
    await expect(app.popup.locator("#advancePaymentCard")).toBeVisible();
    await app.popup.getByRole("button", { name: "먼저 보내라고 했어요", exact: true }).click();
    await expect.poll(() => app.pendingRoutes.length).toBe(1);
    await app.pendingRoutes[0].abort("failed");
    await expect(app.popup.locator("#status")).toHaveText("서버에 연결하지 못했어요. 서버 선택과 연결 상태를 확인해 주세요.");
    await expect(app.popup.locator("#advancePaymentWarning")).toBeVisible();
    await expect(app.popup.locator("#advancePaymentAnswerSource")).toBeVisible();
    await expect(app.popup.locator("#advancePaymentEvidence blockquote")).toHaveCount(0);
    await expect(app.popup.locator("#scoreBreakdown")).toBeHidden();
  } finally { await app.context.close(); }
});

test("점수 표시: 점수 구성 없는 이전 API응답도 기존 결과를 표시", async ({ browser }) => {
  const app = await openScoredPopup(browser, { html: `<p>${deduction}</p>`, response: () => ({
    risk_score: 40, verdict: "CAUTION", risk_factors: [],
    analyses: { nts: { status: "completed", business_status: "ACTIVE" }, ftc: { status: "not_configured" }, ai: { status: "completed", signals: [] } }
  }) });
  try {
    await finished(app.popup);
    await expect(app.popup.locator("#scoreBreakdown")).toBeHidden();
    await expect(app.popup.locator("#checkResults .result")).toHaveCount(3);
    await expect(app.popup.locator("#checkResults")).toContainText("총 위험 점수 40점");
    await expect(app.popup.locator("#advancePaymentWarning")).toBeHidden();
  } finally { await app.context.close(); }
});

// Mixed deployments must display the server policy honestly, without client rescaling.
test("점수 표시: 이전 40+60 API는 그대로 표시하고 정책 갱신을 안내", async ({ browser }) => {
  const app = await openScoredPopup(browser, { response: payload => scoredResult(payload, { legacyPolicy: true }) });
  try {
    await finished(app.popup);
    await expect(app.popup.locator("#businessRiskScore")).toHaveText("40 / 40점");
    await expect(app.popup.locator("#aiRiskScore")).toHaveText("60 / 60점");
    await expect(app.popup.locator("#totalRiskScore")).toHaveText("100 / 100점");
    await expect(app.popup.locator("#scorePolicyNotice")).toBeVisible();
    await expect(app.popup.locator("#scorePolicyNotice")).toContainText("이전");
    await expect(app.popup.locator("#scorePolicyNotice")).toContainText("백엔드");
    await expect(app.popup.locator("#advancePaymentWarning")).toBeVisible();
  } finally { await app.context.close(); }
});


test("점수 표시: 이전 60+40 API도 원래 상한과 점수를 표시하고 갱신 안내", async ({ browser }) => {
  const app = await openScoredPopup(browser, { response: payload => scoredResult(payload, {
    legacyPolicy: "60/40", businessScore: 60, rawScore: 70
  }) });
  try {
    await finished(app.popup);
    await expect(app.popup.locator("#businessRiskScore")).toHaveText("60 / 60점");
    await expect(app.popup.locator("#aiRiskScore")).toHaveText("40 / 40점");
    await expect(app.popup.locator("#totalRiskScore")).toHaveText("100 / 100점");
    await expect(app.popup.locator("#businessScoreCapNote")).toContainText("사업자 원점수 70점 중 상한 60점을 반영했어요.");
    await expect(app.popup.locator("#scorePolicyNotice")).toBeVisible();
    await expect(app.popup.locator("#scorePolicyNotice")).toContainText("백엔드");
    await expect(app.popup.locator("#advancePaymentWarning")).toBeVisible();
  } finally { await app.context.close(); }
});

// Identical 50/50 caps do not prove the running backend has the new pair rule.
test("점수 표시: 이전 50+50 v1의 45점은 보존하고 조합 규칙 갱신 안내", async ({ browser }) => {
  const app = await openScoredPopup(browser, { html: `<p>${deduction}</p>`, response: payload => {
    const result = scoredResult(payload, {
      businessScore: 45, rawScore: 45, businessStatus: "partial", aiScore: 0, signals: []
    });
    result.scoring_policy = "business50_ai50_v1";
    result.analyses.ai.scoring_policy = "business50_ai50_v1";
    return result;
  } });
  try {
    await finished(app.popup);
    await expect(app.popup.locator("#businessRiskScore")).toHaveText("45 / 50점");
    await expect(app.popup.locator("#aiRiskScore")).toHaveText("0 / 50점");
    await expect(app.popup.locator("#totalRiskScore")).toHaveText("45 / 100점");
    await expect(app.popup.locator("#scorePolicyNotice")).toBeVisible();
    await expect(app.popup.locator("#scorePolicyNotice")).toContainText("이전 50+50 점수 규칙");
    await expect(app.popup.locator("#scorePolicyNotice")).toContainText("조합 가산점");
    await expect(app.popup.locator("#scorePolicyNotice")).toContainText("백엔드");
    await expect(app.popup.locator("#advancePaymentWarning")).toBeHidden();
  } finally { await app.context.close(); }
});


test("점수 표시: 이전 50+50 v2 응답은 그대로 표시하고 사이트 관찰 규칙 갱신 안내", async ({ browser }) => {
  const app = await openScoredPopup(browser, { html: `<p>${deduction}</p>`, response: payload => {
    const result=scoredResult(payload,{businessScore:50,aiScore:0,signals:[]});
    result.scoring_policy="business50_ai50_v2";
    result.analyses.ai.scoring_policy="business50_ai50_v2";
    return result;
  }});
  try {
    await finished(app.popup);
    await expect(app.popup.locator("#businessRiskScore")).toHaveText("50 / 50점");
    await expect(app.popup.locator("#aiRiskScore")).toHaveText("0 / 50점");
    await expect(app.popup.locator("#scorePolicyNotice")).toContainText("공지");
    await expect(app.popup.locator("#scorePolicyNotice")).toContainText("구매후기");
    await expect(app.popup.locator("#scorePolicyNotice")).toContainText("백엔드");
    await expect(app.popup.locator("#advancePaymentWarning")).toBeHidden();
  } finally { await app.context.close(); }
});

test("점수 표시: 공지50·후기40 원점수90은 AI50으로 제한하고 입금 경고를 만들지 않음", async ({ browser }) => {
  const app=await openScoredPopup(browser,{html:`<p>${deduction}</p>`,response:payload=>{
    const factors=[{code:"AI_NOTICE_MISSING",message:"공개 범위에서 공지사항을 찾지 못했습니다.",source:"site_rule",raw_points:50,points:28},{code:"AI_REVIEW_MISSING",message:"공개 범위에서 구매후기를 찾지 못했습니다.",source:"site_rule",raw_points:40,points:22}];
    const result=scoredResult(payload,{businessScore:0,aiScore:50,signals:[],aiScoringStatus:"rule_only",aiStatus:"skipped",riskFactors:factors});
    result.verdict="CAUTION";
    result.score_status="partial";
    result.score_breakdown.ai={...result.score_breakdown.ai,raw_score:90,capped:true};
    result.analyses.ai={...result.analyses.ai,raw_score:90,capped:true,risk_factors:factors,site_checks_status:"completed",site_checks:{
      payment_menus:{status:"absent",evidence:"보이는 출금신청·충전신청 메뉴 없음",scope:"current_page",source_url:sourceURL,observed_at:"2026-11-15T00:00:00Z"},
      notices:{status:"missing",evidence:"공개 범위에서 공지사항을 찾지 못했습니다.",scope:"current_page",source_url:sourceURL,observed_at:"2026-11-15T00:00:00Z"},
      reviews:{status:"missing",evidence:"공개 범위에서 구매후기를 찾지 못했습니다.",scope:"current_page",source_url:sourceURL,observed_at:"2026-11-15T00:00:00Z"}}};
    return result;
  }});
  try {
    await finished(app.popup);
    await expect(app.popup.locator("#aiRiskScore")).toHaveText("50 / 50점");
    await expect(app.popup.locator("#aiScoreCapNote")).toContainText("90");
    await expect(app.popup.locator("#aiScoreCapNote")).toContainText("50");
    await expect(app.popup.locator("#siteChecksPanel")).toBeVisible();
    await expect(app.popup.locator("#siteCheckResults")).toContainText("공지");
    await expect(app.popup.locator("#siteCheckResults")).toContainText("구매후기");
    await expect(app.popup.locator("#checkResults")).toContainText("주의");
    await expect(app.popup.locator("#advancePaymentWarning")).toBeHidden();
    await expect(app.popup.locator("#flowAssessment")).toHaveText("출금 조건 미확인");
  } finally {await app.context.close();}
});
