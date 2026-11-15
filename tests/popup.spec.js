const { test, expect } = require("@playwright/test");
const { authenticatedFixture } = require("./helpers/auth-fixture");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const question = "판매대금을 받기 전에 돈을 먼저 보내라고 했나요?";
const description = "상대방이나 고객센터가 ‘수수료를 보내야 돈을 받을 수 있어요’ 또는 ‘본인 확인을 위해 먼저 충전하세요’라고 했는지 떠올려 보세요.";
const answers = [
  ["먼저 보내라고 했어요", "입금하지 마세요. 판매대금을 받기 전에 돈을 보내라는 요구는 사기 의심 신호예요."],
  ["그런 말은 없었어요", "답변에서 먼저 돈을 보내라는 요구는 확인되지 않았어요."],
  ["잘 모르겠어요", "상대방이나 고객센터가 보낸 메시지에서 ‘돈을 받으려면 먼저 보내야 한다’는 말이 있는지 확인해 보세요."]
];
const successfulScan = {
  analyses: {
    nts: { status: "completed", business_status: "ACTIVE", business_status_description: "계속사업자" },
    ftc: { status: "not_configured" }
  },
  verdict: "LOW_RISK",
  risk_score: 0,
  risk_factors: []
};
let server;
let origin;

test.beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const allowed = ["/popup.html", "/popup.js", "/flow.js", "/site-checks.js", "/auth.js", "/tests/fixtures/visible.html", "/tests/fixtures/hidden.html", "/tests/fixtures/no-menu.html", "/tests/fixtures/upfront-no-button.html", "/tests/fixtures/fee-deduction.html", "/tests/fixtures/context-private.html"];
    if (!allowed.includes(pathname)) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("Content-Type", pathname.endsWith(".js") ? "application/javascript; charset=utf-8" : "text/html; charset=utf-8");
    response.end(await fs.readFile(path.join(root, pathname)));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

async function openPopup(browser, { fixture = "visible", html, scan = "success", scanResult = successfulScan, tabOverrides = {}, injectionError = false } = {}) {
  const context = await browser.newContext();
  const source = await context.newPage();
  const sourceURL = `${origin}/tests/fixtures/${fixture}.html`;
  await source.goto(sourceURL);
  if (html !== undefined) await source.setContent(html);

  const requests = [];
  const pendingRoutes = [];
  const extractions = [];
  await context.route("http://127.0.0.1:8000/api/v1/scan/", async route => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type" } });
      return;
    }
    requests.push(route.request());
    if (scan === "pending") {
      pendingRoutes.push(route);
      return;
    }
    if (scan === "network-error") {
      await route.abort("failed");
      return;
    }
    const payload = route.request().postDataJSON();
    const mocked = structuredClone(typeof scanResult === "function" ? scanResult(payload) : scanResult);
    // New requests bind evidence to an individual observation. Keep the old
    // fixtures, but attach the exact source only when their quote really occurs.
    if (Array.isArray(mocked.analyses?.ai?.signals)) {
      mocked.analyses.ai.signals = mocked.analyses.ai.signals.map(signal => {
        const source = payload.page_observations?.find(item => signal.evidence && item.text.includes(signal.evidence));
        return source ? { source_id: source.id, source_url: source.source_url, ...signal } : signal;
      });
    }
    await route.fulfill({
      status: scan === "http-error" ? 503 : 200,
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
      body: JSON.stringify(scan === "http-error" ? { detail: "Unavailable" } : mocked)
    });
  });

  const popup = await context.newPage();
  await popup.exposeFunction("__executeInCurrentTab", async functionSource => {
    if (injectionError) throw new Error("Cannot access this tab");
    // executeScript serializes the function into the current tab's isolated world.
    // Evaluating it in the fixture page catches accidental popup closure dependencies.
    const result = await source.evaluate(`(${functionSource})()`);
    extractions.push(result);
    return { result };
  });
  await popup.addInitScript(({ sourceURL, tabOverrides }) => {
    window.__chromeCalls = { queries: [], executions: [] };
    window.chrome = {
      tabs: {
        query: async options => {
          window.__chromeCalls.queries.push(options);
          return [{ id: 25, url: sourceURL, ...tabOverrides }];
        }
      },
      scripting: {
        executeScript: async options => {
          window.__chromeCalls.executions.push(options.target);
          return [await window.__executeInCurrentTab(options.func.toString())];
        }
      }
    };
  }, { sourceURL, tabOverrides });
  await authenticatedFixture(popup);
  await popup.goto(`${origin}/popup.html`);
  return { context, source, popup, requests, pendingRoutes, sourceURL, extractions };
}

for (const fixture of ["visible", "hidden", "no-menu"]) {
  test(`모의 페이지: ${fixture}`, async ({ browser }) => {
    const { context, popup } = await openPopup(browser, { fixture });
    try {
      await expect(popup.locator("#status")).toHaveText("백엔드 응답을 받았어요.");
      if (fixture === "visible") {
        await expect(popup.locator("#advancePaymentCard")).toBeVisible();
        await expect(popup.locator("#advancePaymentCard")).toContainText(question);
        await expect(popup.locator("#advancePaymentCard")).toContainText(description);
      } else {
        await expect(popup.locator("#advancePaymentCard")).toBeHidden();
      }
    } finally {
      await context.close();
    }
  });
}

const visibleCases = [
  ["공백 포함 충전 버튼", "<button>충전 신청</button>"],
  ["붙여 쓴 충전 버튼", "<button>충전신청</button>"],
  ["공백 포함 출금 링크", '<a href="#withdraw">출금 신청</a>'],
  ["붙여 쓴 출금 링크", '<a href="#withdraw">출금신청</a>'],
  ["정산 메뉴 링크", '<a href="#settle">정산</a>'],
  ["줄바꿈과 공백", '<button>충전\n  신청</button>'],
  ["자식 span", '<button><span>출금</span><span>신청</span></button>'],
  ["display contents 자식", '<button><span style="display:contents">충전 신청</span></button>'],
  ["숨겨진 조상에서 visible 재정의", '<div style="visibility:hidden"><button style="visibility:visible">충전 신청</button></div>'],
  ["입력 버튼", '<input type="button" value="충전신청">'],
  ["제출 버튼", '<input type="submit" value="출금 신청">'],
  ["role button", '<div role="button" tabindex="0">충전 신청</div>'],
  ["role link", '<span role="link" tabindex="0">출금신청</span>'],
  ["role menuitem", '<div role="menuitem" tabindex="0">정산</div>'],
  ["펼친 details 메뉴", '<details open><summary>판매 메뉴</summary><button>정산</button></details>']
];
for (const [label, html] of visibleCases) {
  test(`보이는 컨트롤 감지: ${label}`, async ({ browser }) => {
    const { context, popup } = await openPopup(browser, { html });
    try {
      await expect(popup.locator("#advancePaymentCard")).toBeVisible();
    } finally {
      await context.close();
    }
  });
}

const hiddenCases = [
  ["본문 텍스트", '<p>충전 신청 출금신청 정산</p>'],
  ["단순 span", '<span>정산</span>'],
  ["href 없는 앵커", '<a>충전 신청</a>'],
  ["hidden 속성", '<button hidden>충전신청</button>'],
  ["hidden 조상", '<div hidden><a href="#">출금 신청</a></div>'],
  ["display none", '<button style="display:none">정산</button>'],
  ["display none 조상", '<div style="display:none"><button>충전 신청</button></div>'],
  ["visibility hidden", '<button style="visibility:hidden">출금신청</button>'],
  ["visibility hidden 조상", '<div style="visibility:hidden"><a href="#">정산</a></div>'],
  ["opacity zero", '<button style="opacity:0">충전신청</button>'],
  ["opacity zero 조상", '<div style="opacity:0"><button>출금 신청</button></div>'],
  ["화면 왼쪽 밖", '<button style="position:absolute;left:-10000px">정산</button>'],
  ["화면 아래 밖", '<button style="position:absolute;top:10000px">충전 신청</button>'],
  ["overflow clipping", '<div style="width:0;height:0;overflow:hidden"><button>출금신청</button></div>'],
  ["clip-path로 완전히 숨김", '<button style="clip-path:inset(100%)">정산</button>'],
  ["닫힌 details", '<details><summary>판매 메뉴</summary><button>정산</button></details>'],
  ["숨겨진 자식 글자", '<button>홈<span hidden>정산</span></button>'],
  ["투명한 자식 글자", '<button>홈<span style="opacity:0">충전 신청</span></button>'],
  ["보이지 않는 aria-label만 있음", '<button aria-label="출금 신청">메뉴</button>']
];
for (const [label, html] of hiddenCases) {
  test(`본문 및 숨겨진 메뉴 제외: ${label}`, async ({ browser }) => {
    const { context, popup } = await openPopup(browser, { html });
    try {
      await expect(popup.locator("#status")).toHaveText("백엔드 응답을 받았어요.");
      await expect(popup.locator("#advancePaymentCard")).toBeHidden();
    } finally {
      await context.close();
    }
  });
}

for (const [label, feedback] of answers) {
  test(`조회 응답 전 답변 표시: ${label}`, async ({ browser }, testInfo) => {
    const { context, popup, requests } = await openPopup(browser, { scan: "pending" });
    try {
      await expect.poll(() => requests.length).toBe(1);
      await expect(popup.locator("#status")).toHaveText("백엔드에 확인 요청을 보내는 중…");
      await expect(popup.locator("#advancePaymentCard")).toBeVisible();
      await popup.getByRole("button", { name: label, exact: true }).click();
      await expect(popup.locator("#advancePaymentFeedback")).toHaveText(feedback);
      expect(requests).toHaveLength(1);
      if (label === answers[0][0]) {
        await popup.setViewportSize({ width: 372, height: 680 });
        await popup.screenshot({ path: testInfo.outputPath("advance-payment-card.png"), fullPage: true });
      }
    } finally {
      await context.close();
    }
  });
}

for (const scan of ["http-error", "network-error"]) {
  test(`사업자 조회 실패 후 세 답변 동작: ${scan}`, async ({ browser }) => {
    const { context, popup, requests } = await openPopup(browser, { scan });
    try {
      await expect(popup.locator("#status")).toHaveText(scan === "http-error" ? "서버의 접근 보호 기능을 일시적으로 사용할 수 없어요. 잠시 후 다시 시도해 주세요." : "서버에 연결하지 못했어요. 서버 선택과 연결 상태를 확인해 주세요.");
      await expect(popup.locator("#advancePaymentCard")).toBeVisible();
      for (const [label, feedback] of answers) {
        await popup.getByRole("button", { name: label, exact: true }).click();
        await expect(popup.locator("#advancePaymentFeedback")).toHaveText(feedback);
      }
      expect(requests).toHaveLength(1);
    } finally {
      await context.close();
    }
  });
}

test("기존 탭 검사 한 번 재사용, 사업자 payload와 성공 결과 유지", async ({ browser }) => {
  const { context, popup, requests, sourceURL } = await openPopup(browser);
  try {
    await expect(popup.locator("#status")).toHaveText("백엔드 응답을 받았어요.");
    expect(await popup.evaluate(() => window.__chromeCalls)).toEqual({
      queries: [{ active: true, currentWindow: true }],
      executions: [{ tabId: 25 }]
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].postDataJSON()).toHaveProperty("site_checks");
    const { page_context: pageContext, page_observations: observations, site_checks: siteChecks, ...legacyPayload } = requests[0].postDataJSON();
    expect(legacyPayload).toEqual({
      url: sourceURL,
      business_info: {
        business_name: "모의상점",
        representative_name: "홍길동",
        business_number: "123-45-67890",
        address: "서울시 강남구 테스트로 1"
      }
    });
    expect(pageContext).toContain("이 페이지에서 우왕톤 확장 프로그램을 열어 질문 카드와 세 답변을 확인하세요.");
    expect(pageContext).not.toContain("사업자등록번호");
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ kind: "current_page", source_url: sourceURL, text: pageContext });
    expect(typeof observations[0].id).toBe("string");
    expect(Number.isNaN(Date.parse(observations[0].observed_at))).toBe(false);
    await expect(popup.locator("#businessNumber")).toHaveText("1234567890");
    await expect(popup.locator("#companyName")).toHaveText("모의상점");
    await expect(popup.locator("#representativeName")).toHaveText("홍길동");
    await expect(popup.locator("#checkResults .result")).toHaveCount(3);
    await expect(popup.locator("#checkResults")).toContainText("계속사업자");
    await expect(popup.locator("#checkResults")).toContainText("낮은 위험");
  } finally {
    await context.close();
  }
});

test("메뉴가 있어도 페이지 접근 실패 시 카드 숨김", async ({ browser }) => {
  const { context, popup, requests } = await openPopup(browser, { injectionError: true });
  try {
    await expect(popup.locator("#status")).toHaveText("페이지에 접근하지 못했어요. 쇼핑몰 탭에서 다시 열어주세요.");
    await expect(popup.locator("#advancePaymentCard")).toBeHidden();
    expect(requests).toHaveLength(0);
  } finally {
    await context.close();
  }
});

test("키보드로도 질문에 답변", async ({ browser }) => {
  const { context, popup } = await openPopup(browser, { scan: "pending" });
  try {
    const button = popup.getByRole("button", { name: answers[0][0], exact: true });
    await button.focus();
    await popup.keyboard.press("Enter");
    await expect(popup.locator("#advancePaymentFeedback")).toHaveText(answers[0][1]);
    await expect(popup.locator("#advancePaymentFeedback")).toHaveAttribute("role", "status");
  } finally {
    await context.close();
  }
});

const upfrontEvidence = "출금하려면 5만 원을 먼저 입금하세요";
function withAi(ai) {
  return { ...successfulScan, analyses: { ...successfulScan.analyses, ai } };
}
function aiSignal(evidence = upfrontEvidence) {
  return {
    type: "ADVANCE_PAYMENT_REQUIRED",
    evidence,
    reason: "출금을 받기 위한 조건으로 별도 선입금을 요구합니다."
  };
}

test("충전 버튼만 있으면 질문을 즉시 표시하고 빈 page_context는 생략", async ({ browser }) => {
  const { context, popup, requests } = await openPopup(browser, {
    html: "<button>충전 신청</button>", scan: "pending"
  });
  try {
    await expect(popup.locator("#advancePaymentCard")).toBeVisible();
    await expect(popup.locator("#advancePaymentWarning")).toBeHidden();
    await expect(popup.getByRole("button", { name: answers[0][0], exact: true })).toBeVisible();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].postDataJSON()).not.toHaveProperty("page_context");
    await expect(popup.locator("#status")).toHaveText("백엔드에 확인 요청을 보내는 중…");
  } finally {
    await context.close();
  }
});

test("버튼 없는 출금 안내도 전송하고 검증된 AI 근거와 경고 표시", async ({ browser }, testInfo) => {
  const { context, popup, requests } = await openPopup(browser, {
    fixture: "upfront-no-button",
    scanResult: withAi({ status: "completed", signals: [aiSignal()] })
  });
  try {
    await expect(popup.locator("#status")).toHaveText("백엔드 응답을 받았어요.");
    expect(requests[0].postDataJSON().page_context).toContain(upfrontEvidence);
    await expect(popup.locator("#advancePaymentCard")).toBeVisible();
    await expect(popup.locator("#advancePaymentWarning")).toBeVisible();
    await expect(popup.locator("#advancePaymentWarning")).toContainText("입금하지 마세요");
    await expect(popup.locator("#advancePaymentEvidence")).toContainText(upfrontEvidence);
    await expect(popup.locator("#checkResults .result")).toHaveCount(3);
    await expect(popup.locator("#checkResults")).toContainText("계속사업자");
    await popup.setViewportSize({ width: 372, height: 800 });
    await popup.screenshot({ path: testInfo.outputPath("verified-ai-warning.png"), fullPage: true });
  } finally {
    await context.close();
  }
});

test("수수료 차감 안내는 문맥을 전송하되 선입금 경고 없음", async ({ browser }) => {
  const { context, popup, requests } = await openPopup(browser, {
    fixture: "fee-deduction", scanResult: withAi({ status: "completed", signals: [] })
  });
  try {
    await expect(popup.locator("#status")).toHaveText("백엔드 응답을 받았어요.");
    expect(requests[0].postDataJSON().page_context).toContain("판매대금에서 수수료를 차감한 뒤 지급합니다");
    expect(requests[0].postDataJSON().page_context).toContain("별도의 입금은 필요하지 않습니다.");
    await expect(popup.locator("#advancePaymentWarning")).toBeHidden();
    await expect(popup.locator("#advancePaymentEvidence")).not.toContainText("수수료");
    await expect(popup.locator("#checkResults .result")).toHaveCount(3);
  } finally {
    await context.close();
  }
});

test("AI가 전송하지 않은 원문을 인용하면 그 근거를 표시하지 않음", async ({ browser }) => {
  const hallucination = "출금을 위해 100만 원을 즉시 송금하세요";
  const { context, popup, requests } = await openPopup(browser, {
    fixture: "upfront-no-button",
    scanResult: withAi({ status: "completed", signals: [aiSignal(hallucination)] })
  });
  try {
    await expect(popup.locator("#status")).toHaveText("백엔드 응답을 받았어요.");
    expect(requests[0].postDataJSON().page_context).not.toContain(hallucination);
    await expect(popup.locator("#advancePaymentWarning")).toBeHidden();
    await expect(popup.locator("body")).not.toContainText(hallucination);
    await expect(popup.locator("#checkResults .result")).toHaveCount(3);
  } finally {
    await context.close();
  }
});

for (const [name, ai] of [
  ["skipped", { status: "skipped", signals: [aiSignal()] }],
  ["error", { status: "error", signals: [aiSignal()] }],
  ["unknown type", { status: "completed", signals: [{ ...aiSignal(), type: "SOMETHING_ELSE" }] }],
  ["empty evidence", { status: "completed", signals: [aiSignal("")] }],
  ["invalid signals", { status: "completed", signals: "invalid" }]
]) {
  test(`유효하지 않은 AI 결과는 경고로 사용하지 않음: ${name}`, async ({ browser }) => {
    const { context, popup } = await openPopup(browser, { fixture: "upfront-no-button", scanResult: withAi(ai) });
    try {
      await expect(popup.locator("#status")).toHaveText("백엔드 응답을 받았어요.");
      await expect(popup.locator("#advancePaymentWarning")).toBeHidden();
      await expect(popup.locator("#checkResults .result")).toHaveCount(3);
    } finally {
      await context.close();
    }
  });
}

for (const completion of ["http-error", "network-error", "success-without-signal"]) {
  test(`먼저 보내라고 들었다는 사용자 경고를 늦은 응답이 덮지 않음: ${completion}`, async ({ browser }) => {
    const { context, popup, pendingRoutes } = await openPopup(browser, {
      html: "<button>충전 신청</button>", scan: "pending"
    });
    try {
      await expect.poll(() => pendingRoutes.length).toBe(1);
      await popup.getByRole("button", { name: answers[0][0], exact: true }).click();
      await expect(popup.locator("#advancePaymentFeedback")).toHaveText(answers[0][1]);
      await expect(popup.locator("#advancePaymentWarning")).toBeVisible();
      if (completion === "network-error") {
        await pendingRoutes[0].abort("failed");
      } else {
        await pendingRoutes[0].fulfill({
          status: completion === "http-error" ? 503 : 200,
          headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
          body: JSON.stringify(completion === "http-error" ? { detail: "Unavailable" } : withAi({ status: "completed", signals: [] }))
        });
      }
      await expect(popup.locator("#status")).toHaveText(completion === "success-without-signal" ? "백엔드 응답을 받았어요." : completion === "http-error" ? "서버의 접근 보호 기능을 일시적으로 사용할 수 없어요. 잠시 후 다시 시도해 주세요." : "서버에 연결하지 못했어요. 서버 선택과 연결 상태를 확인해 주세요.");
      await expect(popup.locator("#advancePaymentWarning")).toBeVisible();
      await expect(popup.locator("#advancePaymentWarning")).toContainText("입금하지 마세요");
      await expect(popup.locator("#advancePaymentFeedback")).toHaveText(answers[0][1]);
      await expect(popup.getByRole("button", { name: answers[0][0], exact: true })).toHaveAttribute("aria-pressed", "true");
    } finally {
      await context.close();
    }
  });
}

test("다른 답변을 눌러도 검증된 AI 경고와 원문 근거 유지", async ({ browser }) => {
  const { context, popup } = await openPopup(browser, {
    fixture: "upfront-no-button", scanResult: withAi({ status: "completed", signals: [aiSignal()] })
  });
  try {
    await expect(popup.locator("#advancePaymentWarning")).toBeVisible();
    for (const [label, feedback] of answers) {
      await popup.getByRole("button", { name: label, exact: true }).click();
      await expect(popup.locator("#advancePaymentFeedback")).toHaveText(feedback);
      await expect(popup.locator("#advancePaymentWarning")).toBeVisible();
      await expect(popup.locator("#advancePaymentEvidence")).toContainText(upfrontEvidence);
    }
  } finally {
    await context.close();
  }
});

test("메뉴 주변 안내와 같은 영역의 중립 문장도 함께 수집", async ({ browser }) => {
  const html = `<section><h2>출금 안내</h2><button>출금 신청</button>
    <p>본인 확인은 고객센터에서 진행합니다.</p>
    <p>절차가 끝나면 안내를 받게 됩니다.</p></section>`;
  const { context, popup, requests } = await openPopup(browser, { html });
  try {
    await expect(popup.locator("#status")).toHaveText("백엔드 응답을 받았어요.");
    const text = requests[0].postDataJSON().page_context;
    expect(text).toContain("본인 확인은 고객센터에서 진행합니다.");
    expect(text).toContain("절차가 끝나면 안내를 받게 됩니다.");
  } finally {
    await context.close();
  }
});

test("body 바로 아래 메뉴 주변의 인접 안내문도 함께 수집", async ({ browser }) => {
  const html = `<button>충전 신청</button><p>본인 확인을 위해 먼저 보내세요.</p>
    <p>완료 후 고객센터로 연락해 주세요.</p>`;
  const { context, popup, requests } = await openPopup(browser, { html });
  try {
    await expect(popup.locator("#status")).toHaveText("백엔드 응답을 받았어요.");
    const text = requests[0].postDataJSON().page_context;
    expect(text).toContain("본인 확인을 위해 먼저 보내세요.");
    expect(text).toContain("완료 후 고객센터로 연락해 주세요.");
  } finally {
    await context.close();
  }
});

test("버튼 없는 같은 영역의 지급·보증금 안내와 중립 문맥 수집", async ({ browser }) => {
  const html = `<section><h2>정산 안내</h2><p>판매대금 지급 전 확인할 내용입니다.</p>
    <p>본인 확인은 고객센터에서 진행합니다.</p><p>보증금은 별도로 입금해야 합니다.</p></section>`;
  const { context, popup, requests } = await openPopup(browser, { html });
  try {
    await expect(popup.locator("#status")).toHaveText("백엔드 응답을 받았어요.");
    const text = requests[0].postDataJSON().page_context;
    expect(text).toContain("판매대금 지급 전 확인할 내용입니다.");
    expect(text).toContain("본인 확인은 고객센터에서 진행합니다.");
    expect(text).toContain("보증금은 별도로 입금해야 합니다.");
  } finally {
    await context.close();
  }
});

test("안내문에서 입력값·계좌·전화번호·숨겨진 글자는 제외하고 금액 유지", async ({ browser }) => {
  const { context, popup, requests, extractions } = await openPopup(browser, { fixture: "context-private" });
  try {
    await expect(popup.locator("#status")).toHaveText("백엔드 응답을 받았어요.");
    const text = requests[0].postDataJSON().page_context;
    expect(text).toBe(extractions[0].pageContext);
    expect(text).toContain("5만 원");
    for (const excluded of ["입력한_비밀값", "123-456-789012", "010-1234-5678", "0212345678", "98765432101234", "123-4567", "123456", "숨겨진_별도입금", "화면밖_출금제한"]) {
      expect(text).not.toContain(excluded);
    }
  } finally {
    await context.close();
  }
});

test("입력 영역에만 있는 안내문을 모델 문맥으로 전송하지 않음", async ({ browser }) => {
  const html = `<input value="출금하려면 5만 원을 먼저 입금하세요">
    <textarea>출금 제한 해제에는 보증금이 필요합니다.</textarea>
    <select><option selected>판매대금 지급 전 먼저 입금하세요.</option></select>
    <div contenteditable="true"><p>출금하려면 보증금을 보내세요.</p></div>
    <div role="textbox">출금하려면 돈을 먼저 보내세요.</div>`;
  const { context, popup, requests } = await openPopup(browser, { html });
  try {
    await expect(popup.locator("#status")).toHaveText("백엔드 응답을 받았어요.");
    expect(requests[0].postDataJSON()).not.toHaveProperty("page_context");
  } finally {
    await context.close();
  }
});

test("숨겨진 안내문과 화면 밖 안내문만 있으면 page_context 생략", async ({ browser }) => {
  const html = `<p hidden>출금하려면 5만 원을 먼저 입금하세요</p>
    <p style="visibility:hidden">판매대금을 받으려면 보증금을 입금하세요.</p>
    <p style="position:absolute;top:10000px">출금 제한 해제를 위해 별도 입금하세요.</p>`;
  const { context, popup, requests } = await openPopup(browser, { html });
  try {
    await expect(popup.locator("#status")).toHaveText("백엔드 응답을 받았어요.");
    expect(requests[0].postDataJSON()).not.toHaveProperty("page_context");
  } finally {
    await context.close();
  }
});

test("같은 텍스트 노드의 overflow로 가려진 줄은 전송하지 않음", async ({ browser }) => {
  const html = `<p style="height:20px;overflow:hidden;white-space:pre-line;line-height:20px">출금 안내입니다.
화면에 안 보이는 선입금 요구: ${upfrontEvidence}</p>`;
  const { context, popup, requests } = await openPopup(browser, { html });
  try {
    await expect(popup.locator("#status")).toHaveText("백엔드 응답을 받았어요.");
    const text = requests[0].postDataJSON().page_context || "";
    expect(text).not.toContain("화면에 안 보이는");
    expect(text).not.toContain(upfrontEvidence);
  } finally {
    await context.close();
  }
});

test("줄바꿈 없이 자동 줄바꿈된 문구도 보이는 부분만 전송", async ({ browser }) => {
  const html = `<p style="height:20px;overflow:hidden;width:320px;line-height:20px">${"출금 안내입니다. 이용 절차를 확인하세요. ".repeat(20)}${upfrontEvidence}</p>`;
  const { context, popup, requests } = await openPopup(browser, { html });
  try {
    await expect(popup.locator("#status")).toHaveText("백엔드 응답을 받았어요.");
    const text = requests[0].postDataJSON().page_context || "";
    expect(text).not.toContain(upfrontEvidence);
    expect(text.length).toBeLessThan(200);
  } finally {
    await context.close();
  }
});

test("여러 안내문을 합친 전체 page_context는 최대 2000자", async ({ browser }) => {
  const sentence = "판매대금 지급을 위한 보증금 안내 문장을 확인하세요. ";
  const html = `<section style="font-size:1px;line-height:1px"><p>${sentence.repeat(120)}</p></section>`;
  const { context, popup, requests, extractions } = await openPopup(browser, { html });
  try {
    await expect(popup.locator("#status")).toHaveText("백엔드 응답을 받았어요.");
    const text = requests[0].postDataJSON().page_context;
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(2000);
    // The source-aware collector may retain fewer complete sentences while
    // reserving the combined 2,000-character budget for policy/history sources.
    expect(text.split("\n").every(line => extractions[0].pageContext.includes(line))).toBe(true);
    expect(requests[0].postDataJSON().page_observations.reduce((total, item) => total + item.text.length, 0)).toBeLessThanOrEqual(2000);
  } finally {
    await context.close();
  }
});

test("국세청 미등록 응답의 빈 상태 설명은 등록 정보 없음으로 표시하고 40점 유지", async ({ browser }) => {
  const scanResult = {
    ...successfulScan,
    analyses: {
      ...successfulScan.analyses,
      nts: {
        status: "completed",
        business_status: "UNKNOWN",
        business_status_description: "",
        tax_type: "국세청에 등록되지 않은 사업자등록번호입니다."
      },
      ftc: { status: "completed", match_status: "NO_MATCH", search_method: "BUS_NUMBER" }
    },
    verdict: "CAUTION",
    risk_score: 40,
    risk_factors: [{ message: "입력한 사업자등록번호와 일치하는 업체를 찾지 못했습니다.", points: 40 }]
  };
  const { context, popup } = await openPopup(browser, { scanResult });
  try {
    await expect(popup.locator("#status")).toHaveText("백엔드 응답을 받았어요.");
    const ntsCard = popup.locator("#checkResults .result").filter({ hasText: "국세청 사업자 상태" });
    await expect(ntsCard.locator(".unknown")).toHaveText("등록 정보 없음");
    await expect(ntsCard.locator(".result-reason")).toHaveText("국세청에서 등록되지 않은 사업자번호라고 응답했어요.");
    await expect(popup.locator("#checkResults .result-score")).toHaveText("총 위험 점수 40점");
  } finally {
    await context.close();
  }
});


test("공정위 복수 대표자 일부 일치는 전체 일치나 확인 불가로 표시하지 않음", async ({ browser }) => {
  const scanResult = {
    ...successfulScan,
    analyses: {
      ...successfulScan.analyses,
      ftc: {
        status: "completed", search_method: "BUSINESS_NUMBER", match_status: "SINGLE_CANDIDATE",
        official_info: { representative_names: ["홍길동", "김철수"] },
        verification: { business_number: "MATCH", business_name: "MATCH", representative_name: "PARTIAL_MATCH", business_address: "SKIPPED" }
      }
    }
  };
  const { context, popup } = await openPopup(browser, { scanResult });
  try {
    await expect(popup.locator("#status")).toHaveText("백엔드 응답을 받았어요.");
    const card = popup.locator("#checkResults .result").filter({ has: popup.getByRole("heading", { name: "공정위 업체 정보 대조", exact: true }) });
    await expect(card).toContainText("대표자명 일부 일치");
    await expect(card).not.toContainText("대표자명 확인 불가");
    await expect(card.locator("p.match")).toHaveCount(0);
    await expect(card.locator("p.unknown")).toContainText("일부 일치");
  } finally { await context.close(); }
});
