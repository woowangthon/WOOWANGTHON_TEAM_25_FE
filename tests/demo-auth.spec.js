// Synthetic demo enrollment only; every HTTP request is intercepted locally.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { AUTH_KEY } = require('./helpers/auth-fixture');

const ROOT = path.resolve(__dirname, '..');
const BASE = 'https://yeong.dev/woowang';
const PREFIX = BASE + '/api/v1/';
const DEVICE_KEY = 'woowang.demo.device.v1';
const IDENTITY_KEY = 'woowang.auth.identity.v1';
const FLOW_KEY = 'woowang.paymentFlow.v1';
const TOKEN = 'synthetic-demo-access-token-only-2468';
const USER = { id: 75, username: 'opaque-demo-identity-not-for-display' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Retry-After' };

function demoSession(overrides = {}) {
  return { token: TOKEN, user: USER, apiOrigin: BASE, mode: 'demo',
    expires_at: new Date(Date.now() + 20 * 60000).toISOString(),
    demo_expires_at: new Date(Date.now() + 60 * 60000).toISOString(), ...overrides };
}

async function demoPopup(browser, options = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const source = await context.newPage();
  const sessionData = structuredClone(options.sessionData ?? {});
  const localData = structuredClone(options.localData ?? {});
  const calls = [], events = [], writes = [], scanRoutes = [], meRoutes = [], enrollmentRoutes = [], delayedTokenEvents = [];
  let meCount = 0;
  let holdIdentity = false;
  const identityWaiters = [];
  const deadline = new Date(Date.now() + 60 * 60000).toISOString();
  const metadata = options.metadata ?? { enabled: true, reason: 'active',
    expires_at: deadline, max_devices: 20, daily_limit: 20 };
  const shop = 'https://synthetic-demo-shop.test/';

  await page.exposeFunction('__storage', async (area, operation, argument) => {
    const data = area === 'session' ? sessionData : localData;
    if (operation === 'get') {
      if (holdIdentity && area === 'session' && argument === IDENTITY_KEY) {
        await new Promise(resolve => identityWaiters.push(resolve));
      }
      const keys = argument == null ? Object.keys(data) : [].concat(argument);
      return Object.fromEntries(keys.filter(key => Object.hasOwn(data, key)).map(key => [key, structuredClone(data[key])]));
    }
    const changes = {};
    if (operation === 'set') {
      writes.push({ area, value: structuredClone(argument) });
      for (const [key, value] of Object.entries(argument)) changes[key] = { oldValue: data[key], newValue: value };
      Object.assign(data, argument);
    }
    if (operation === 'remove') for (const key of [].concat(argument)) {
      changes[key] = { oldValue: data[key] }; delete data[key];
    }
    if (area === 'session' && options.emitStorageEvents && Object.keys(changes).length) {
      if (options.delayTokenEvents && changes[AUTH_KEY]?.newValue) delayedTokenEvents.push(changes);
      else await page.evaluate(changes => { for (const listener of window.__storageListeners ?? []) listener(changes, 'session'); }, changes);
    }
  });
  await page.exposeFunction('__tabEvent', event => { events.push(event); });
  await page.exposeFunction('__extract', async code => {
    events.push('extract');
    return { result: await source.evaluate(`(${code})()`) };
  });
  await page.addInitScript(shopUrl => {
    const area = name => ({ get: argument => window.__storage(name, 'get', argument),
      set: argument => window.__storage(name, 'set', argument),
      remove: argument => window.__storage(name, 'remove', argument),
      setAccessLevel: async value => { window.__trustedAccess = value.accessLevel; } });
    window.chrome = { tabs: { query: async () => { await window.__tabEvent('tabs'); return [{ id: 75, url: shopUrl }]; } },
      scripting: { executeScript: async options => [await window.__extract(options.func.toString())] },
      storage: { session: area('session'), local: area('local'),
        onChanged: { addListener: listener => { (window.__storageListeners ??= []).push(listener); } } } };
  }, shop);

  await context.route('**/*', async route => {
    const request = route.request(), url = request.url();
    if (url.startsWith('https://demo-extension.test/')) {
      const file = new URL(url).pathname.slice(1);
      if (!['popup.html', 'popup.js', 'auth.js', 'flow.js', 'site-checks.js'].includes(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ contentType: file.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8',
        body: await fs.readFile(path.join(ROOT, file), 'utf8') });
    }
    if (url === shop) return route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><button>출금 신청</button>${options.guidance ? `<p>${options.guidance}</p>` : ''}<footer>상호: 모의상점 | 대표자: 홍길동<br>사업자등록번호: 123-45-67890</footer>` });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors,
      'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST' } });
    if (!url.startsWith(PREFIX)) {
      if (url.startsWith('http://127.0.0.1:8000/api/v1/')) calls.push({ url, method: request.method(), endpoint: url.split('/api/v1/')[1] });
      return route.fulfill({ status: 404, headers: cors, body: '' });
    }
    const endpoint = url.slice(PREFIX.length);
    calls.push({ endpoint, method: request.method(), headers: request.headers(), body: request.postDataJSON(), url });
    events.push(`${request.method()} ${endpoint}`);
    let status = 200, body = {};
    if (endpoint === 'auth/demo/' && request.method() === 'GET') {
      status = options.metadataStatus ?? 200; body = metadata;
    } else if (endpoint === 'auth/demo/' && request.method() === 'POST') {
      if (options.holdEnrollment) { enrollmentRoutes.push(route); return; }
      status = options.enrollStatus ?? 200; body = demoSession({ demo_expires_at: deadline });
    } else if (endpoint === 'auth/me/') {
      meCount += 1;
      if (options.holdMe) { meRoutes.push(route); return; }
      status = typeof options.meStatus === 'function' ? options.meStatus(meCount) : options.meStatus ?? 200;
      body = { user: options.user ?? USER };
    } else if (endpoint === 'scan/') {
      if (options.holdScan) { scanRoutes.push(route); return; }
      status = options.scanStatus ?? 200;
      body = { analyses: { nts: { status: 'completed', business_status_description: '계속사업자' },
        ftc: { status: 'not_configured' }, ai: { status: 'skipped', signals: [] } },
        risk_score: 0, risk_factors: [], verdict: 'LOW_RISK' };
      if (options.sourceWarning) {
        const observation = request.postDataJSON().page_observations.find(item => item.text.includes(options.guidance));
        body.analyses.ai = { status: 'completed', signals: [{ type: 'ADVANCE_PAYMENT_REQUIRED',
          evidence: options.guidance, reason: '합성 안내에서 지급 전 입금 조건을 확인했습니다.', source: 'ai',
          source_id: observation.id, source_url: observation.source_url }] };
      }
    } else if (endpoint === 'auth/logout/') status = 204;
    else return route.fulfill({ status: 404, headers: cors, body: '' });
    return route.fulfill({ status, headers: { ...cors, 'Retry-After': '2' },
      contentType: 'application/json', body: status === 204 ? '' : JSON.stringify(body) });
  });
  await source.goto(shop);
  await page.goto('https://demo-extension.test/popup.html');
  return { context, page, sessionData, localData, calls, events, writes, scanRoutes, meRoutes, enrollmentRoutes, deadline, delayedTokenEvents,
    holdIdentityReads() { holdIdentity = true; }, releaseIdentityReads() { holdIdentity = false; identityWaiters.splice(0).forEach(resolve => resolve()); } };
}

const enrollments = app => app.calls.filter(call => call.endpoint === 'auth/demo/' && call.method === 'POST');
const scans = app => app.calls.filter(call => call.endpoint === 'scan/');
async function scanned(app) { await expect(app.page.locator('#status')).toHaveText('백엔드 응답을 받았어요.'); }
async function answerYes(app) { await app.page.getByRole('button', { name: '먼저 보내라고 했어요', exact: true }).click(); }

test('시연: 계정 입력 없이 등록하고 GETme를 확인한 뒤에만 화면을 읽고 검사', async ({ browser }) => {
  const app = await demoPopup(browser, { holdMe: true });
  try {
    await expect.poll(() => app.meRoutes.length).toBe(1);
    expect(app.events).toEqual(['GET auth/demo/', 'POST auth/demo/', 'GET auth/me/']);
    expect(app.events).not.toContain('tabs'); expect(scans(app)).toEqual([]);
    await expect(app.page.locator('#authCredentials')).toBeHidden();
    await app.meRoutes[0].fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify({ user: USER }) });
    await scanned(app);
    expect(app.events).toEqual(['GET auth/demo/', 'POST auth/demo/', 'GET auth/me/', 'tabs', 'extract', 'POST scan/']);
    await expect(app.page.locator('#authUserLabel')).toHaveText('시연모드');
    await expect(app.page.locator('body')).not.toContainText(USER.username);
    for (const call of app.calls) expect(call.url).toBe(PREFIX + call.endpoint);
    expect(scans(app)[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(app.calls[0].headers.authorization).toBeUndefined(); expect(enrollments(app)[0].headers.authorization).toBeUndefined();
  } finally { await app.context.close(); }
});

test('시연: 비밀이 아닌 UUID만 로컬에 보관하고 토큰과 키는 로컬에 쓰지 않음', async ({ browser }) => {
  const app = await demoPopup(browser);
  try {
    await scanned(app);
    expect(Object.keys(app.localData)).toEqual([DEVICE_KEY]); expect(app.localData[DEVICE_KEY]).toMatch(UUID);
    expect(enrollments(app)[0].body).toEqual({ device_id: app.localData[DEVICE_KEY] });
    expect(app.sessionData[AUTH_KEY]).toMatchObject({ mode: 'demo', token: TOKEN, user: USER, apiOrigin: BASE });
    expect(JSON.stringify(app.writes.filter(write => write.area === 'local'))).not.toContain(TOKEN);
    expect(JSON.stringify(enrollments(app))).not.toMatch(/password|OPENAI|fingerprint|hardware/i);
    expect(await app.page.evaluate(() => localStorage.length)).toBe(0);
    expect(await app.page.evaluate(() => window.__trustedAccess)).toBe('TRUSTED_CONTEXTS');
  } finally { await app.context.close(); }
});

test('시연: 30분 토큰이 만료되어도 같은 UUID·사용자로 재등록하고 직접 답변 유지', async ({ browser }) => {
  const app = await demoPopup(browser);
  try {
    await scanned(app); await answerYes(app);
    await expect.poll(() => JSON.stringify(app.sessionData[FLOW_KEY])).toContain('"answer":"yes"');
    const device = app.localData[DEVICE_KEY];
    app.sessionData[AUTH_KEY].expires_at = new Date(Date.now() - 1000).toISOString();
    await app.page.reload(); await scanned(app);
    expect(enrollments(app)).toHaveLength(2); expect(enrollments(app).map(call => call.body.device_id)).toEqual([device, device]);
    expect(app.sessionData[AUTH_KEY].user.id).toBe(USER.id);
    await expect(app.page.locator('#advancePaymentWarning')).toBeVisible();
    await expect(app.page.locator('#advancePaymentFeedback')).toContainText('입금하지 마세요');
  } finally { await app.context.close(); }
});

for (const mode of ['demo', 'regular']) test(`시연: 유효한 ${mode} 세션은 GETme만 확인하고 재등록하지 않음`, async ({ browser }) => {
  const cached = demoSession();
  if (mode === 'regular') { delete cached.mode; delete cached.demo_expires_at; }
  const app = await demoPopup(browser, { sessionData: { [AUTH_KEY]: cached } });
  try {
    await scanned(app);
    expect(app.calls.map(call => call.endpoint)).toEqual(['auth/me/', 'scan/']);
    expect(enrollments(app)).toEqual([]); expect(app.localData).toEqual({});
    await expect(app.page.locator('#authUserLabel')).toHaveText(mode === 'demo' ? '시연모드' : USER.username);
  } finally { await app.context.close(); }
});

for (const metadataStatus of [200, 404]) test(`시연: 비활성화·구 서버${metadataStatus}는 기존 로그인으로 복귀`, async ({ browser }) => {
  const app = await demoPopup(browser, { metadataStatus, metadata: { enabled: false, reason: 'disabled', expires_at: null } });
  try {
    await expect(app.page.locator('#authCredentials')).toBeVisible();
    expect(app.events).toEqual(['GET auth/demo/']); expect(app.localData).toEqual({});
    expect(app.sessionData[AUTH_KEY]).toBeUndefined(); expect(scans(app)).toEqual([]);
  } finally { await app.context.close(); }
});

test('시연: 전체 시연 시간이 끝났으면 등록·화면 읽기 없이 종료 안내', async ({ browser }) => {
  const app = await demoPopup(browser, { metadata: { enabled: false, reason: 'expired', expires_at: new Date(Date.now() - 1000).toISOString() } });
  try {
    await expect(app.page.locator('#authMessage')).toContainText('시연이 종료');
    await expect(app.page.locator('#authCredentials')).toBeHidden();
    expect(app.events).toEqual(['GET auth/demo/']); expect(app.localData).toEqual({}); expect(scans(app)).toEqual([]);
  } finally { await app.context.close(); }
});

test('시연: 등록 한도429는 대기 시간을 표시하고 자동 재등록·검사하지 않음', async ({ browser }) => {
  const app = await demoPopup(browser, { enrollStatus: 429 });
  try {
    await expect(app.page.locator('#demoRetryButton')).toBeDisabled();
    await expect(app.page.locator('#authMessage')).toContainText('요청 횟수 제한');
    await expect(app.page.locator('#demoRetryButton')).toBeEnabled({ timeout: 5000 });
    expect(enrollments(app)).toHaveLength(1); expect(scans(app)).toEqual([]); expect(app.events).not.toContain('tabs');
    await app.page.locator('#demoRetryButton').click();
    await expect.poll(() => enrollments(app).length).toBe(2);
    expect(enrollments(app)[0].body).toEqual(enrollments(app)[1].body); expect(scans(app)).toEqual([]);
  } finally { await app.context.close(); }
});

test('시연: 메타데이터503은 비밀 저장이나 화면 읽기 없이 중단', async ({ browser }) => {
  const app = await demoPopup(browser, { metadataStatus: 503 });
  try {
    await expect(app.page.locator('#authMessage')).toContainText('접근 보호');
    await expect(app.page.locator('#demoRetryButton')).toBeEnabled();
    expect(app.events).toEqual(['GET auth/demo/']); expect(app.localData).toEqual({}); expect(app.sessionData[AUTH_KEY]).toBeUndefined();
  } finally { await app.context.close(); }
});

test('시연: 등록 뒤 GETme503이면 화면을 읽지 않고 명시적 재시도에도 재등록하지 않음', async ({ browser }) => {
  const app = await demoPopup(browser, { meStatus: 503 });
  try {
    await expect(app.page.locator('#demoRetryButton')).toBeVisible(); expect(app.events).not.toContain('tabs');
    await app.page.locator('#demoRetryButton').click();
    await expect.poll(() => app.calls.filter(call => call.endpoint === 'auth/me/').length).toBe(2);
    expect(enrollments(app)).toHaveLength(1); expect(scans(app)).toEqual([]); expect(app.events).not.toContain('extract');
  } finally { await app.context.close(); }
});

for (const status of [429, 503]) test(`시연: 검사${status} 뒤 직접 답변 경고를 유지하고 자동 검사하지 않음`, async ({ browser }) => {
  const app = await demoPopup(browser, { holdScan: true });
  try {
    await expect.poll(() => app.scanRoutes.length).toBe(1); await answerYes(app);
    await app.scanRoutes[0].fulfill({ status, headers: { ...cors, 'Retry-After': '2' }, contentType: 'application/json', body: '{}' });
    await expect(app.page.locator('#retryScanButton')).toBeVisible();
    if (status === 429) await expect(app.page.locator('#retryScanButton')).toBeEnabled({ timeout: 5000 });
    await expect(app.page.locator('#advancePaymentWarning')).toBeVisible();
    await expect(app.page.locator('#advancePaymentFeedback')).toContainText('입금하지 마세요');
    expect(scans(app)).toHaveLength(1); expect(enrollments(app)).toHaveLength(1);
    expect(app.sessionData[AUTH_KEY].mode).toBe('demo');
  } finally { await app.context.close(); }
});

test('시연: 서버가 GETme403으로 시연을 종료하면 재등록 없이 기존 경고 유지', async ({ browser }) => {
  const app = await demoPopup(browser, { scanStatus: 503, meStatus: count => count === 1 ? 200 : 403 });
  try {
    await expect(app.page.locator('#retryScanButton')).toBeVisible(); await answerYes(app);
    await app.page.locator('#retryScanButton').click();
    await expect(app.page.locator('#authMessage')).toContainText('시연이 종료');
    await expect(app.page.locator('#advancePaymentWarning')).toBeVisible();
    await expect(app.page.locator('#authCredentials')).toBeHidden();
    expect(app.sessionData[AUTH_KEY]).toBeUndefined(); expect(enrollments(app)).toHaveLength(1); expect(scans(app)).toHaveLength(1);
  } finally { await app.context.close(); }
});

test('시연: 로그아웃은 이력·토큰을 지우되 다음 시연에 같은 비밀 아닌 UUID 사용', async ({ browser }) => {
  const app = await demoPopup(browser);
  try {
    await scanned(app); await answerYes(app);
    const device = app.localData[DEVICE_KEY];
    await app.page.locator('#logoutButton').click();
    await expect(app.page.locator('#authCredentials')).toBeVisible();
    expect(app.sessionData[AUTH_KEY]).toBeUndefined(); expect(app.sessionData[IDENTITY_KEY]).toBeUndefined();
    expect(app.sessionData[FLOW_KEY]).toBeUndefined(); expect(app.localData[DEVICE_KEY]).toBe(device);
    expect(enrollments(app)).toHaveLength(1);
    await app.page.reload(); await scanned(app);
    expect(enrollments(app)).toHaveLength(2); expect(enrollments(app)[1].body.device_id).toBe(device);
    await expect(app.page.locator('#advancePaymentWarning')).toBeHidden();
  } finally { await app.context.close(); }
});

test('시연: 검사401은 계정 입력 없이 경고를 유지하고 직접 재시도할 때만 같은 UUID로 복구', async ({ browser }) => {
  const app = await demoPopup(browser, { holdScan: true, emitStorageEvents: true });
  try {
    await expect.poll(() => app.scanRoutes.length).toBe(1); await answerYes(app);
    const device = app.localData[DEVICE_KEY];
    await app.scanRoutes[0].fulfill({ status: 401, headers: cors, contentType: 'application/json', body: '{}' });
    await expect(app.page.locator('#demoRetryButton')).toBeVisible();
    await expect(app.page.locator('#authCredentials')).toBeHidden();
    await expect(app.page.locator('#advancePaymentWarning')).toBeVisible();
    expect(app.sessionData[AUTH_KEY]).toBeUndefined(); expect(enrollments(app)).toHaveLength(1); expect(scans(app)).toHaveLength(1);
    await app.page.locator('#demoRetryButton').click();
    await expect.poll(() => app.scanRoutes.length).toBe(2);
    expect(enrollments(app)).toHaveLength(2); expect(enrollments(app)[1].body).toEqual({ device_id: device });
    expect(scans(app)).toHaveLength(2); await expect(app.page.locator('#advancePaymentWarning')).toBeVisible();
    await app.scanRoutes[1].fulfill({ headers: cors, contentType: 'application/json',
      body: JSON.stringify({ analyses: { ai: { status: 'skipped', signals: [] } }, risk_score: 0, risk_factors: [], verdict: 'LOW_RISK' }) });
    await scanned(app); await expect(app.page.locator('#advancePaymentFeedback')).toContainText('입금하지 마세요');
  } finally { await app.context.close(); }
});

test('시연: 검증된 원문 경고는 세션 제거와 시연403 종료 뒤에도 유지', async ({ browser }) => {
  const guidance = '세금 납부가 확인되면 수익금을 받을 수 있습니다.';
  const app = await demoPopup(browser, { guidance, sourceWarning: true, emitStorageEvents: true,
    meStatus: count => count === 1 ? 200 : 403 });
  try {
    await scanned(app); await expect(app.page.locator('#advancePaymentEvidence')).toContainText(guidance);
    await app.page.evaluate(() => WoowangAuth.clear());
    await expect(app.page.locator('#demoRetryButton')).toBeVisible();
    await expect(app.page.locator('#advancePaymentEvidence')).toContainText(guidance);
    await app.page.locator('#demoRetryButton').click();
    await expect(app.page.locator('#authMessage')).toContainText('시연이 종료');
    await expect(app.page.locator('#advancePaymentWarning')).toBeVisible();
    await expect(app.page.locator('#advancePaymentEvidence')).toContainText(guidance);
    await expect(app.page.locator('#authCredentials')).toBeHidden(); expect(scans(app)).toHaveLength(1);
  } finally { await app.context.close(); }
});

test('시연: 등록 응답 대기 중 다른 사용자가 로그인하면 새 토큰을 덮어쓰거나 검사하지 않음', async ({ browser }) => {
  const app = await demoPopup(browser, { holdEnrollment: true });
  try {
    await expect.poll(() => app.enrollmentRoutes.length).toBe(1);
    const replacement = { token: 'synthetic-regular-user-new-token-9999', user: { id: 99, username: 'other-user' },
      apiOrigin: BASE, expires_at: new Date(Date.now() + 20 * 60000).toISOString() };
    app.sessionData[AUTH_KEY] = replacement;
    app.sessionData[IDENTITY_KEY] = { userId: '99', apiOrigin: BASE };
    await app.enrollmentRoutes[0].fulfill({ headers: cors, contentType: 'application/json',
      body: JSON.stringify(demoSession({ demo_expires_at: app.deadline })) });
    await expect(app.page.locator('#authMessage')).toContainText('로그인 상태가 바뀌었어요');
    expect(app.sessionData[AUTH_KEY]).toEqual(replacement); expect(scans(app)).toEqual([]); expect(app.events).not.toContain('tabs');
  } finally { await app.context.close(); }
});

test('시연: 같은 사용자의 갱신 토큰 이벤트가 늦게 도착해도 새 검사를 취소하지 않음', async ({ browser }) => {
  const old = demoSession({ token: 'synthetic-demo-old-token-before-renewal' });
  const device = '12345678-1234-4123-8123-123456789abc';
  const app = await demoPopup(browser, { sessionData: { [AUTH_KEY]: old }, localData: { [DEVICE_KEY]: device },
    holdScan: true, emitStorageEvents: true, delayTokenEvents: true });
  try {
    await expect.poll(() => app.scanRoutes.length).toBe(1); await answerYes(app);
    await app.scanRoutes[0].fulfill({ status: 401, headers: cors, contentType: 'application/json', body: '{}' });
    await expect(app.page.locator('#demoRetryButton')).toBeVisible();
    await app.page.locator('#demoRetryButton').click();
    await expect.poll(() => app.scanRoutes.length).toBe(2);
    expect(app.delayedTokenEvents).toHaveLength(1);
    const event = app.delayedTokenEvents[0];
    await app.page.evaluate(event => { for (const listener of window.__storageListeners) listener(event, 'session'); }, event);
    await app.scanRoutes[1].fulfill({ headers: cors, contentType: 'application/json',
      body: JSON.stringify({ analyses: { ai: { status: 'skipped', signals: [] } }, risk_score: 0, risk_factors: [], verdict: 'LOW_RISK' }) });
    await scanned(app);
    // A still later duplicate delivery must also keep the adopted session view.
    await app.page.evaluate(event => { for (const listener of window.__storageListeners) listener(event, 'session'); }, event);
    await expect(app.page.locator('#authAccount')).toBeVisible();
    await expect(app.page.locator('#authCredentials')).toBeHidden();
    await expect(app.page.locator('#advancePaymentWarning')).toBeVisible();
    expect(enrollments(app)).toHaveLength(1); expect(enrollments(app)[0].body).toEqual({ device_id: device });
    expect(scans(app)).toHaveLength(2);
  } finally { await app.context.close(); }
});

test('시연: 서버 변경의 비동기 확인 중에는 기존 수동 로그인 폼을 즉시 잠금', async ({ browser }) => {
  const app = await demoPopup(browser, { metadata: { enabled: false, reason: 'disabled', expires_at: null } });
  try {
    await expect(app.page.locator('#authCredentials')).toBeVisible();
    await expect(app.page.locator('#authServer')).toBeEnabled();
    await app.page.locator('#authUsername').fill('synthetic-manual-user');
    await app.page.locator('#authPassword').fill('Synthetic-manual-password-2468!');
    // Pause the very first await after the change, before metadata GET begins.
    // This exposes the user-visible overlap even with a fast API connection.
    app.holdIdentityReads();
    await app.page.locator('#authServer').selectOption('http://127.0.0.1:8000');
    await expect(app.page.locator('#authServer')).toBeDisabled();
    await expect(app.page.locator('#authCredentials')).toBeHidden();
    await expect(app.page.locator('#loginButton')).toBeDisabled();
    await app.page.locator('#authForm').dispatchEvent('submit');
    expect(app.calls.filter(call => call.method === 'POST')).toEqual([]);
    app.releaseIdentityReads();
    await expect(app.page.locator('#authServer')).toBeEnabled();
    await expect(app.page.locator('#authCredentials')).toBeVisible();
    expect(app.calls.filter(call => call.method === 'POST')).toEqual([]);
    expect(app.events).not.toContain('tabs');
  } finally { app.releaseIdentityReads(); await app.context.close(); }
});
