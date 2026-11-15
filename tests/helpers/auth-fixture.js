// Synthetic auth only. Used by pre-existing UI regressions to isolate scanning.
const AUTH_KEY = 'woowang.auth.session.v1';
const TEST_TOKEN = 'synthetic-regression-access-token-not-a-live-secret';
const TEST_USER = { id: 25, username: 'source-regression' };

async function authenticatedFixture(page, { token = TEST_TOKEN, user = TEST_USER,
  apiOrigin = 'http://127.0.0.1:8000', mockMe = true } = {}) {
  const session = { token, user, apiOrigin, expires_at: new Date(Date.now() + 3600000).toISOString() };
  if (mockMe) await page.route(`${apiOrigin}/api/v1/auth/me/`, async route => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: {
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      } });
      return;
    }
    await route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ user }) });
  });
  await page.addInitScript(({ key, initial }) => {
    const privateValues = { [key]: structuredClone(initial) };
    const privateKeys = new Set([key, "woowang.auth.identity.v1"]);
    const decorated = new WeakSet();
    function wrapChrome(value) {
      if (!value || decorated.has(value)) return value;
      decorated.add(value);
      value.storage ??= {};
      const previous = value.storage.session ?? {};
      const read = previous.get?.bind(previous);
      const write = previous.set?.bind(previous);
      const remove = previous.remove?.bind(previous);
      const sessionStorage = {
        async get(argument, callback) {
          const result = read ? await read(argument) ?? {} : {};
          const requested = argument == null || argument === key
            || Array.isArray(argument) && argument.includes(key)
            || typeof argument === 'object' && Object.hasOwn(argument, key);
          for (const privateKey of privateKeys) {
            const wants = privateKey === key ? requested : argument == null || argument === privateKey
              || Array.isArray(argument) && argument.includes(privateKey)
              || typeof argument === "object" && Object.hasOwn(argument, privateKey);
            if (wants && privateValues[privateKey]) result[privateKey] = structuredClone(privateValues[privateKey]);
          }
          if (callback) callback(result);
          return result;
        },
        async set(argument, callback) {
          const rest = { ...argument };
          for (const privateKey of privateKeys) if (Object.hasOwn(rest, privateKey)) {
            privateValues[privateKey] = structuredClone(rest[privateKey]); delete rest[privateKey];
          }
          if (write && Object.keys(rest).length) await write(rest);
          if (callback) callback();
        },
        async remove(argument, callback) {
          const keys = [].concat(argument);
          for (const privateKey of privateKeys) if (keys.includes(privateKey)) delete privateValues[privateKey];
          const rest = keys.filter(item => !privateKeys.has(item));
          if (remove && rest.length) await remove(rest);
          if (callback) callback();
        },
        async setAccessLevel(argument) { window.__authStorageAccessLevel = argument.accessLevel; }
      };
      value.storage.session = sessionStorage;
      return value;
    }
    let current = wrapChrome(window.chrome);
    Object.defineProperty(window, 'chrome', { configurable: true,
      get() { return current; }, set(value) { current = wrapChrome(value); } });
  }, { key: AUTH_KEY, initial: session });
}
module.exports = { authenticatedFixture, AUTH_KEY, TEST_TOKEN, TEST_USER };
