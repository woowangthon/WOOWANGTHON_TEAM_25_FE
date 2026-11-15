/* Short-lived user credentials stay in trusted extension session storage. */
(() => {
  "use strict";

  const STORAGE_KEY = "woowang.auth.session.v1";
  const IDENTITY_KEY = "woowang.auth.identity.v1";
  const DEVICE_KEY = "woowang.demo.device.v1";
  const PRODUCTION_BASE = "https://yeong.dev/woowang";
  const LOCAL_BASE = "http://127.0.0.1:8000";
  const API_BASES = new Set([PRODUCTION_BASE, LOCAL_BASE]);
  const PATHS = new Set(["auth/login/", "auth/logout/", "auth/logout-all/", "auth/me/", "auth/demo/", "scan/"]);
  let storageSetup;
  let demoPending = null;
  let credentialEpoch = 0;

  class AuthError extends Error {
    constructor(code, status = 0, retryAfterSeconds = null) {
      super(code);
      this.name = "WoowangAuthError";
      this.code = code;
      this.status = status;
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }

  function allowedApiBase(value = PRODUCTION_BASE) {
    if (typeof value !== "string" || !API_BASES.has(value)) throw new AuthError("INVALID_SERVER");
    return value;
  }

  function endpoint(apiBase, path) {
    if (!PATHS.has(path)) throw new AuthError("INVALID_ENDPOINT");
    // apiOrigin is the historical storage field name: keep the full approved
    // base, including /woowang. URL.origin or an absolute join loses its prefix.
    return `${allowedApiBase(apiBase)}/api/v1/${path}`;
  }

  function validUser(user) {
    return user && typeof user === "object"
      && (Number.isSafeInteger(user.id) && user.id > 0
        || typeof user.id === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(user.id))
      && typeof user.username === "string" && user.username.trim().length > 0
      && user.username.length <= 150 && !/[\u0000-\u001f\u007f]/.test(user.username);
  }

  function validSession(value) {
    if (!value || typeof value !== "object" || !API_BASES.has(value.apiOrigin)
      || typeof value.token !== "string" || !/^[A-Za-z0-9._~-]{16,512}$/.test(value.token)
      || !validUser(value.user) || typeof value.expires_at !== "string"
      || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value.expires_at)) return false;
    const expires = Date.parse(value.expires_at);
    if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 24 * 60 * 60 * 1000) return false;
    if (value.mode === undefined) return true;
    const demoExpires = isoTime(value.demo_expires_at);
    return value.mode === "demo" && demoExpires > Date.now() && expires <= demoExpires;
  }

  function isoTime(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      ? Date.parse(value) : NaN;
  }

  async function storage() {
    const area = globalThis.chrome?.storage?.session;
    if (!area || typeof area.get !== "function" || typeof area.set !== "function"
      || typeof area.remove !== "function") throw new AuthError("SESSION_STORAGE_UNAVAILABLE");
    if (!storageSetup) {
      storageSetup = Promise.resolve().then(async () => {
        if (typeof area.setAccessLevel === "function") {
          await area.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
        }
      }).catch(() => { storageSetup = null; throw new AuthError("SESSION_STORAGE_UNAVAILABLE"); });
    }
    await storageSetup;
    return area;
  }

  async function clear() {
    credentialEpoch += 1;
    try { await (await storage()).remove(STORAGE_KEY); }
    catch { throw new AuthError("SESSION_STORAGE_UNAVAILABLE"); }
  }

  async function getSession() {
    let stored;
    try { stored = (await (await storage()).get(STORAGE_KEY))?.[STORAGE_KEY]; }
    catch { throw new AuthError("SESSION_STORAGE_UNAVAILABLE"); }
    if (!stored) return null;
    if (validUser(stored.user) && API_BASES.has(stored.apiOrigin)) {
      await (await storage()).set({ [IDENTITY_KEY]: { userId: String(stored.user.id), apiOrigin: stored.apiOrigin } });
    }
    if (!validSession(stored)) { await clear(); return null; }
    // Return only the documented fields, never extra data written by another context.
    return { token: stored.token, expires_at: stored.expires_at,
      user: { id: stored.user.id, username: stored.user.username }, apiOrigin: stored.apiOrigin,
      ...(stored.mode === "demo" ? { mode: "demo", demo_expires_at: stored.demo_expires_at } : {}) };
  }

  async function getLastIdentity() {
    const value = (await (await storage()).get(IDENTITY_KEY))?.[IDENTITY_KEY];
    return value && typeof value.userId === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(value.userId)
      && API_BASES.has(value.apiOrigin) ? { userId: value.userId, apiOrigin: value.apiOrigin } : null;
  }

  async function invalidate(session) {
    // A late 401 from an older popup must not delete a newer login's token.
    const current = await getSession();
    if (current?.token === session.token) await clear();
  }

  function retryAfter(response) {
    const value = response.headers.get("Retry-After");
    const seconds = value && /^\d+(?:\.\d+)?$/.test(value.trim())
      ? Number(value) : value ? (Date.parse(value) - Date.now()) / 1000 : 60;
    return Math.min(86400, Math.max(1, Number.isFinite(seconds) ? Math.ceil(seconds) : 60));
  }

  function responseError(response, session = null) {
    const codes = { 400: "INVALID_REQUEST", 401: "AUTH_REQUIRED", 403: "ACCESS_DENIED",
      409: "SESSION_LIMIT", 429: "RATE_LIMITED", 503: "SECURITY_UNAVAILABLE" };
    const error = new AuthError(session?.mode === "demo" && response.status === 403
      ? "DEMO_ENDED" : codes[response.status] ?? "SERVER_ERROR", response.status,
      response.status === 429 ? retryAfter(response) : null);
    if (session?.mode === "demo") error.mode = "demo";
    return error;
  }

  async function send(origin, path, options = {}, token = null) {
    const headers = new Headers(options.headers ?? {});
    headers.delete("Authorization");
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), path === "scan/" ? 120000 : 15000);
    const externalAbort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener("abort", externalAbort, { once: true });
    let response;
    try {
      response = await globalThis.fetch(endpoint(origin, path), {
        ...options, headers, signal: controller.signal,
        credentials: "omit", redirect: "error", cache: "no-store"
      });
    } catch (error) {
      if (error instanceof AuthError) throw error;
      if (controller.signal.aborted) throw new AuthError("REQUEST_TIMEOUT");
      throw new AuthError("CONNECTION_FAILED");
    } finally { clearTimeout(deadline); options.signal?.removeEventListener("abort", externalAbort); }
    return response;
  }

  async function authenticatedFetch(path, options = {}, expectedSession = null) {
    const session = await getSession();
    if (!session) {
      const error = new AuthError("AUTH_REQUIRED", 401);
      if (expectedSession?.mode === "demo") error.mode = "demo";
      throw error;
    }
    if (expectedSession && (session.token !== expectedSession.token
      || session.apiOrigin !== expectedSession.apiOrigin)) throw new AuthError("AUTH_CHANGED", 401);
    const response = await sendSession(session, path, options);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) await invalidate(session);
      throw responseError(response, session);
    }
    return response;
  }

  async function ready() {
    const session = await getSession();
    if (!session) return null;
    const response = await sendSession(session, "auth/me/", { method: "GET" });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) await invalidate(session);
      if (response.status === 401) return null;
      throw responseError(response, session);
    }
    let data;
    try { data = await response.json(); } catch { throw new AuthError("INVALID_RESPONSE"); }
    if (!validUser(data?.user) || String(data.user.id) !== String(session.user.id)) {
      await invalidate(session);
      throw new AuthError("INVALID_RESPONSE");
    }
    const current = await getSession();
    return current?.token === session.token ? current : null;
  }

  async function sendSession(session, path, options) {
    try { return await send(session.apiOrigin, path, options, session.token); }
    catch (error) { if (session.mode === "demo") error.mode = "demo"; throw error; }
  }

  async function demoDeviceId() {
    const load = async () => {
      const area = globalThis.chrome?.storage?.local;
      if (!area || typeof area.get !== "function" || typeof area.set !== "function"
        || typeof globalThis.crypto?.randomUUID !== "function") throw new AuthError("DEMO_STORAGE_UNAVAILABLE");
      try {
        const stored = (await area.get(DEVICE_KEY))?.[DEVICE_KEY];
        if (typeof stored === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stored)) return stored;
        const value = globalThis.crypto.randomUUID();
        await area.set({ [DEVICE_KEY]: value });
        return value;
      } catch { throw new AuthError("DEMO_STORAGE_UNAVAILABLE"); }
    };
    // Web Locks keep simultaneous popups from generating separate device IDs.
    return globalThis.navigator?.locks?.request
      ? globalThis.navigator.locks.request(DEVICE_KEY, load) : load();
  }

  function tryDemo({ apiOrigin = PRODUCTION_BASE } = {}) {
    const origin = allowedApiBase(apiOrigin);
    if (demoPending) return demoPending;
    const enroll = async () => {
      const existing = await getSession();
      if (existing) throw new AuthError("AUTH_CHANGED", 401);
      const epoch = credentialEpoch;
      const previous = await getLastIdentity();
      try {
        const response = await send(origin, "auth/demo/", { method: "GET" });
        if (response.status === 404) return null;
        if (!response.ok) throw responseError(response);
        let metadata;
        try { metadata = await response.json(); } catch { throw new AuthError("INVALID_RESPONSE"); }
        if (metadata?.enabled === false && metadata.reason !== "expired") return null;
        if (metadata?.enabled === false && metadata.reason === "expired") throw new AuthError("DEMO_ENDED", 403);
        if (metadata?.enabled !== true || metadata.reason !== "active"
          || !(isoTime(metadata.expires_at) > Date.now())) throw new AuthError("INVALID_RESPONSE");
        const deviceId = await demoDeviceId();
        const current = await getSession();
        const identity = await getLastIdentity();
        if (current) throw new AuthError("AUTH_CHANGED", 401);
        if (epoch !== credentialEpoch || JSON.stringify(previous) !== JSON.stringify(identity)) {
          throw new AuthError("AUTH_CHANGED", 401);
        }
        const enrollment = await send(origin, "auth/demo/", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_id: deviceId })
        });
        if (!enrollment.ok) {
          if (enrollment.status === 403) throw new AuthError("DEMO_ENDED", 403);
          throw responseError(enrollment);
        }
        let data;
        try { data = await enrollment.json(); } catch { throw new AuthError("INVALID_RESPONSE"); }
        const session = { token: data?.token, expires_at: data?.expires_at,
          user: validUser(data?.user) ? { id: data.user.id, username: data.user.username } : null,
          apiOrigin: origin, mode: data?.mode, demo_expires_at: data?.demo_expires_at };
        if (session.mode !== "demo" || !validSession(session)
          || isoTime(session.demo_expires_at) > isoTime(metadata.expires_at)) throw new AuthError("INVALID_RESPONSE");
        if (epoch !== credentialEpoch || await getSession()
          || JSON.stringify(previous) !== JSON.stringify(await getLastIdentity())) throw new AuthError("AUTH_CHANGED", 401);
        await (await storage()).set({ [STORAGE_KEY]: session,
          [IDENTITY_KEY]: { userId: String(session.user.id), apiOrigin: session.apiOrigin } });
        const validated = await ready();
        if (!validated) throw new AuthError("AUTH_REQUIRED", 401);
        return validated;
      } catch (error) { error.mode = "demo"; throw error; }
    };
    const task = globalThis.navigator?.locks?.request
      ? globalThis.navigator.locks.request("woowang.demo.enroll.v1", enroll) : enroll();
    demoPending = task.finally(() => { demoPending = null; });
    return demoPending;
  }

  async function login({ username, password, apiOrigin = PRODUCTION_BASE } = {}) {
    const origin = allowedApiBase(apiOrigin);
    if (typeof username !== "string" || !username.trim() || username.length > 150
      || typeof password !== "string" || !password || password.length > 1024) {
      throw new AuthError("INVALID_CREDENTIALS");
    }
    await clear();
    const response = await send(origin, "auth/login/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username.trim(), password })
    });
    if (!response.ok) {
      const error = responseError(response);
      if (response.status === 401) error.code = "INVALID_CREDENTIALS";
      throw error;
    }
    let data;
    try { data = await response.json(); } catch { throw new AuthError("INVALID_RESPONSE"); }
    const session = { token: data?.token, expires_at: data?.expires_at,
      user: validUser(data?.user) ? { id: data.user.id, username: data.user.username } : null,
      apiOrigin: origin };
    if (!validSession(session)) throw new AuthError("INVALID_RESPONSE");
    try { await (await storage()).set({ [STORAGE_KEY]: session,
      [IDENTITY_KEY]: { userId: String(session.user.id), apiOrigin: session.apiOrigin } }); }
    catch { throw new AuthError("SESSION_STORAGE_UNAVAILABLE"); }
    return { ...session, user: { id: session.user.id, username: session.user.username } };
  }

  async function logout({ all = false } = {}) {
    const session = await getSession();
    // Browser credentials disappear before waiting for an unreachable server.
    // The copied token is used only for this one bounded revocation request.
    await clear();
    await (await storage()).remove(IDENTITY_KEY);
    let failure;
    try {
      if (session) {
        const response = await send(session.apiOrigin, all ? "auth/logout-all/" : "auth/logout/",
          { method: "POST" }, session.token);
        if (!response.ok && response.status !== 401) failure = responseError(response);
      }
    } catch (error) { failure = error; }
    if (failure) throw failure;
  }

  function errorMessage(error) {
    if (error?.mode === "demo" && error?.status === 401 && error?.code !== "AUTH_CHANGED") {
      return "시연 이용 상태를 다시 확인해야 해요. 아래에서 직접 다시 확인해 주세요.";
    }
    if (error?.status === 429 || error?.code === "RATE_LIMITED") {
      return `요청 횟수 제한에 도달했어요. ${error.retryAfterSeconds ?? 60}초 후 직접 다시 시도해 주세요.`;
    }
    const messages = {
      AUTH_REQUIRED: "로그인이 필요하거나 로그인 시간이 만료됐어요. 다시 로그인해 주세요.",
      AUTH_CHANGED: "로그인 상태가 바뀌었어요. 확장을 다시 열어 확인해 주세요.",
      INVALID_CREDENTIALS: "아이디와 비밀번호를 확인해 주세요.",
      ACCESS_DENIED: "이 계정에는 검사 권한이 없어요. 관리자에게 문의해 주세요.",
      SESSION_LIMIT: "로그인 가능한 기기 수를 초과했어요. 다른 기기에서 로그아웃한 뒤 다시 시도해 주세요.",
      SECURITY_UNAVAILABLE: "서버의 접근 보호 기능을 일시적으로 사용할 수 없어요. 잠시 후 다시 시도해 주세요.",
      SESSION_STORAGE_UNAVAILABLE: "로그인 정보를 안전하게 보관할 수 없어요. Chrome을 업데이트하고 확장을 다시 열어 주세요.",
      CONNECTION_FAILED: "서버에 연결하지 못했어요. 서버 선택과 연결 상태를 확인해 주세요.",
      REQUEST_TIMEOUT: "서버 응답 시간이 초과됐어요. 자동으로 재요청하지 않으니 잠시 후 직접 다시 시도해 주세요.",
      DEMO_ENDED: "시연이 종료되었거나 현재 이용할 수 없어요. 관리자에게 확인해 주세요.",
      DEMO_STORAGE_UNAVAILABLE: "이 브라우저에서 시연 정보를 준비하지 못했어요. Chrome을 업데이트하고 확장을 다시 열어 주세요.",
      INVALID_SERVER: "허용된 서버를 선택해 주세요.",
      INVALID_REQUEST: "요청 정보를 확인해 주세요.",
      INVALID_RESPONSE: "서버의 로그인 응답을 확인하지 못했어요. 관리자에게 문의해 주세요.",
      SERVER_ERROR: "서버에서 요청을 처리하지 못했어요. 잠시 후 직접 다시 시도해 주세요."
    };
    return messages[error?.code] ?? "요청을 처리하지 못했어요. 잠시 후 직접 다시 시도해 주세요.";
  }

  window.WoowangAuth = Object.freeze({ ready, tryDemo, login, logout, fetch: authenticatedFetch,
    getSession, getLastIdentity, clear, errorMessage, storageKey: STORAGE_KEY, identityKey: IDENTITY_KEY,
    deviceKey: DEVICE_KEY, productionOrigin: PRODUCTION_BASE, localOrigin: LOCAL_BASE });
})();
