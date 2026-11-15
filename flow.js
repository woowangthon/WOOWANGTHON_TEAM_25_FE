/* Minimal, session-scoped payment guidance records. No form values are read. */
(() => {
  "use strict";
  const STORAGE_KEY = "woowang.paymentFlow.v1";
  const TTL_MS = 2 * 60 * 60 * 1000;
  const MAX_PAGES = 2;
  const MAX_BYTES = 160 * 1024;
  const TIMEOUT_MS = 3000;
  const revisions = new Map();
  let fallback = { origins: {} };
  let storageQueue = Promise.resolve();
  let scopeEpoch = 0;
  const routeKeys = new Set(["co_id", "bo_table", "wr_id", "board_no", "page", "category", "category_no", "cate_no", "id", "type", "lang"]);
  const paymentTerms = /판매\s*(?:대금|수익)|출금|환급|환불|정산|보증금|예치금|수수료|입금|송금|충전|잔액|수령|인증비|인증금|이체|지급|적립금|포인트|게시물|리뷰|보상|세금|납부|수익금|계정\s*(?:해제|제한|동결)|동결/;
  const guidanceTerms = /[.!?。！？]|하려면|해야|먼저|별도|조건|제한|해제|차감|공제|확인되면|확인\s*후|있습니다|받을\s*수|위해|필요|하세요|주세요|합니다|됩니다|입니다|해요|돼요/;
  const balanceStatement = /(?:잔액|보유\s*(?:포인트|적립금)|누적\s*수익금|적립금|포인트|수익금)\s*[:：]?\s*[\d,.]+(?:\s*[만천억]\s*[\d,.]*)*\s*(?:원|포인트|P|점)/i;
  const unsafeAction = /(?:^|[\/_.-])(?:logout|logoff|delete|remove|action|submit|transfer|confirm|execute|process|update|insert|write|purchase|checkout|order|pay|payment|send|cancel|approve|apply|request)(?:[\/_.-]|$)/i;
  const privatePath = /(?:^|\/)(?:login|signin|sign-in|signup|register|profile|mypage|my-page|member|admin|cart|chat)(?:[\/_.-]|$)/i;

  function isRouteParameter(url, key, value) {
    if (routeKeys.has(key.toLowerCase())) return /^[\w가-힣.-]{1,60}$/.test(value);
    // These synthetic fixtures use enums, never free text or user identifiers.
    if (url.pathname.endsWith("/tests/fixtures/flow-stage.html") && key === "stage") {
      return /^(?:reward|earnings|restricted|tax|deduction|menu)$/.test(value);
    }
    return url.pathname.endsWith("/tests/fixtures/model-cases.html") && key === "case"
      && /^(?:withdrawal-lock|deposit-payout|fee-deduction|purchase-points|menu-only|prevention)$/.test(value);
  }

  function isMenuLabelOnly(value) {
    const labels = new Set("판매자메뉴 메뉴 메뉴만 보상 보상안내 보상적립 적립 적립내역 적립금 포인트 잔액 수익 수익금 정산 정산신청 정산안내 정산내역 충전 충전신청 충전안내 출금 출금신청 출금안내 출금내역 환급 환급신청 환급안내 환불 환불안내 제한 세금 세금조건 세금안내 차감안내 수수료 수수료안내 계정 계정안내".split(" "));
    const parts = String(value ?? "").trim().split(/[\r\n|｜•·/,\t]+/)
      .map((part) => part.trim().replace(/[：:]$/, "").replace(/\s+/g, "")).filter(Boolean);
    return parts.length > 0 && parts.every((part) => {
      const reachable = new Uint8Array(part.length + 1);
      reachable[0] = 1;
      for (let index = 0; index < part.length; index += 1) {
        if (!reachable[index]) continue;
        for (const label of labels) {
          if (part.startsWith(label, index)) reachable[index + label.length] = 1;
        }
      }
      return Boolean(reachable[part.length]);
    });
  }

  function withoutMenuLabels(value) {
    return String(value ?? "").split(/\r?\n/).filter((line) => !isMenuLabelOnly(line)).join("\n").trim();
  }

  function originOf(value) {
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.origin : null;
    } catch { return null; }
  }

  function sanitizeSourceUrl(value) {
    try {
      const url = new URL(value);
      if (!originOf(url.href)) return null;
      url.hash = "";
      for (const key of [...url.searchParams.keys()]) {
        const value = url.searchParams.get(key) ?? "";
        if (!isRouteParameter(url, key, value)) {
          url.searchParams.delete(key);
        }
      }
      return url.href;
    } catch { return null; }
  }

  function isAllowedPolicyUrl(value, currentUrl) {
    try {
      const url = new URL(value, currentUrl);
      const current = new URL(currentUrl);
      if (!originOf(url.href) || url.origin !== current.origin || url.hash && url.pathname === current.pathname && url.search === current.search) return false;
      if (/%25/i.test(url.pathname) || unsafeAction.test(decodeURIComponent(url.pathname)) || privatePath.test(decodeURIComponent(url.pathname))) return false;
      if (/\.(?:pdf|zip|exe|csv|json|xml|png|jpe?g|gif|webp|svg|mp4)$/i.test(url.pathname)) return false;
      for (const [key, queryValue] of url.searchParams) {
        if (!isRouteParameter(url, key, queryValue)
          || unsafeAction.test(queryValue) || privatePath.test(`/${queryValue}`)) return false;
      }
      return sanitizeSourceUrl(url.href) !== sanitizeSourceUrl(current.href);
    } catch { return false; }
  }

  function sanitizeText(value, limit = 2000) {
    return String(value ?? "")
      .replace(/\r/g, "")
      .replace(/[ \t\u00a0]+/g, " ")
      .replace(/((?:계좌(?:번호)?|입금\s*계좌|송금\s*계좌|전화(?:번호)?|연락처|휴대(?:폰|전화)|핸드폰|고객센터|팩스|\bTEL(?:EPHONE)?\b|\bFAX\b)(?:는|은)?\s*[:：]?\s*(?:[가-힣A-Za-z]+(?:은행|증권)\s*)?)(\+?\d(?:[\d \t().-]*\d)?)/gi,
        (match, label, number, offset, full) => /^\s*(?:원|만|천|억)/.test(full.slice(offset + match.length)) ? match : `${label}[번호 제외]`)
      .replace(/\+?\d[\d \t().-]*\d/g, (number, offset, full) => {
        const amount = /^\s*(?:원|만|천|억)/.test(full.slice(offset + number.length)) || /[₩$]\s*$/.test(full.slice(0, offset));
        return !amount && number.replace(/\D/g, "").length >= 8 ? "[번호 제외]" : number;
      })
      .replace(/((?:내|현재|보유|사용\s*가능)?\s*(?:잔액|보유\s*포인트|보유\s*적립금|누적\s*수익금)\s*[:：]?\s*)[\d,.]+(?:\s*[만천억]\s*[\d,.]*)*\s*(?:원|포인트|P|점)/gi, "$1[개인 금액 제외]")
      .replace(/((?:적립금|포인트|수익금)\s*[:：]\s*)[\d,.]+(?:\s*[만천억]\s*[\d,.]*)*\s*(?:원|포인트|P|점)?/gi, "$1[개인 금액 제외]")
      .replace(/(^|\n)((?:보유|내|현재|총)?\s*(?:적립금|포인트|수익금)\s*)[\d,.]+(?:\s*[만천억]\s*[\d,.]*)*\s*(?:원|포인트|P|점)?(?=\s*(?:\n|$))/gi, "$1$2[개인 금액 제외]")
      .replace(/\n{3,}/g, "\n\n")
      .trim().slice(0, limit).replace(/[\uD800-\uDBFF]$/, "").trim();
  }

  function priority(text) {
    const payout = /출금|인출|환급|판매\s*대금|수익금|정산|지급|계정|동결/.test(text);
    const deposit = /입금|송금|충전|납부|보증금|인증금|인증비|수수료|세금/.test(text);
    const condition = /먼저|선입금|선납|해야|하면|하려면|확인되면|확인\s*후|조건|해지|해제/.test(text);
    return payout && deposit && condition ? 4 : /제한|동결|잠금|해제|출금\s*불가/.test(text) ? 3
      : /판매\s*대금|수익금|적립금|보상|리뷰|게시물/.test(text) ? 2 : 1;
  }

  function prioritizeText(text, limit) {
    const clean = sanitizeText(text, 12000);
    if (clean.length <= limit) return clean;
    // Keep whole sentences, with their neighbours, before weaker menu labels.
    const pieces = clean.match(/[^\n.!?。！？]+[.!?。！？]?|\n/g)?.filter((part) => part.trim()) ?? [];
    const selected = new Set();
    let length = 0;
    const order = pieces.map((part, index) => ({ index, score: priority(part) }))
      .sort((a, b) => b.score - a.score || a.index - b.index);
    for (const { index } of order) {
      for (const neighbor of [index, index - 1, index + 1]) {
        if (neighbor < 0 || neighbor >= pieces.length || selected.has(neighbor)) continue;
        if (length + pieces[neighbor].length + 1 > limit) continue;
        selected.add(neighbor);
        length += pieces[neighbor].length + 1;
      }
    }
    if (!selected.size) return sanitizeText(clean, limit);
    return [...selected].sort((a, b) => a - b).map((index) => pieces[index].trim()).join("\n");
  }

  function hash(value) {
    let valueHash = 2166136261;
    for (let index = 0; index < value.length; index += 1) valueHash = Math.imul(valueHash ^ value.charCodeAt(index), 16777619);
    return (valueHash >>> 0).toString(36);
  }

  function observation(source, kind, text, observedAt = new Date().toISOString()) {
    const sourceUrl = sanitizeSourceUrl(source);
    const clean = prioritizeText(withoutMenuLabels(text), 2000);
    // Current-tab extraction has already selected menu-adjacent instructions;
    // a qualifier such as "먼저 보내세요" need not repeat the menu's noun.
    if (!sourceUrl || !clean) return null;
    return { id: `obs_${hash(`${sourceUrl}\n${clean}`)}`, source_url: sourceUrl, kind, text: clean, observed_at: observedAt };
  }

  function extractPolicyContext(html) {
    // Template content is inert: no image requests, script execution or navigation.
    const template = document.createElement("template");
    template.innerHTML = html;
    const root = template.content;
    root.querySelectorAll('input,textarea,select,option,button,script,style,noscript,template,iframe,object,embed,svg,[hidden],[aria-hidden="true"],[class~="hidden"],[class~="hide"],[class~="d-none"],[class~="sr-only"],[class~="visually-hidden"],[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="searchbox"],[role="combobox"],[role="spinbutton"]').forEach((node) => node.remove());
    root.querySelectorAll("[style]").forEach((node) => {
      const style = node.getAttribute("style") ?? "";
      if (/display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*0(?:[;\s]|$)|content-visibility\s*:\s*hidden/i.test(style)) node.remove();
    });
    root.querySelectorAll("details:not([open])").forEach((node) => {
      const summary = [...node.children].find((child) => child.tagName === "SUMMARY");
      for (const child of [...node.childNodes]) if (child !== summary) child.remove();
    });
    const blocks = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent.trim() || !node.parentElement) continue;
      const element = node.parentElement.closest("p,li,dt,dd,h1,h2,h3,h4,h5,h6,blockquote,td,th,div,section,article,aside,main,body") ?? node.parentElement;
      const last = blocks[blocks.length - 1];
      if (last?.element === element) last.text += node.textContent;
      else blocks.push({ element, text: node.textContent });
    }
    blocks.forEach((block) => { block.text = block.text.replace(/\s+/g, " ").trim();
      if (isMenuLabelOnly(block.text)) block.text = "";
    });
    const selected = new Set();
    blocks.forEach((block, index) => {
      if (!paymentTerms.test(block.text) || !guidanceTerms.test(block.text) && !balanceStatement.test(block.text)) return;
      selected.add(index);
      const region = block.element.closest("section,article,aside,[role=region],fieldset") ?? block.element.parentElement;
      // Preserve nearby qualifiers/negations from the same area, without copying
      // all of an unstructured page or unrelated customer information.
      for (let neighbor = Math.max(0, index - 2); neighbor <= Math.min(blocks.length - 1, index + 2); neighbor += 1) {
        if (region && region.contains(blocks[neighbor].element)) selected.add(neighbor);
      }
    });
    return prioritizeText([...selected].sort((a, b) => a - b).map((index) => blocks[index].text).join("\n"), 1800);
  }

  async function fetchPolicy(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, { method: "GET", credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal, headers: { Accept: "text/html" } });
      if (!response.ok) return { status: response.status === 401 || response.status === 403 ? "login_required" : "failed", reason: `http_${response.status}` };
      if (!/\btext\/html\b/i.test(response.headers.get("content-type") ?? "")) return { status: "failed", reason: "not_html" };
      if (Number(response.headers.get("content-length")) > MAX_BYTES) return { status: "failed", reason: "too_large" };
      let html = "";
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let bytes = 0;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > MAX_BYTES) { await reader.cancel(); return { status: "failed", reason: "too_large" }; }
          html += decoder.decode(part.value, { stream: true });
        }
        html += decoder.decode();
      } else {
        html = await response.text();
        if (new TextEncoder().encode(html).byteLength > MAX_BYTES) return { status: "failed", reason: "too_large" };
      }
      const text = extractPolicyContext(html);
      const hasLogin = /(?:로그인|회원\s*가입).{0,25}(?:필요|하세요|후|가능)|(?:로그인|인증)\s*페이지/.test(html.replace(/<[^>]+>/g, " "));
      return { status: hasLogin && !text ? "login_required" : "checked", text };
    } catch (error) {
      return { status: "failed", reason: error?.name === "AbortError" ? "timeout" : "unavailable" };
    } finally { clearTimeout(timeout); }
  }

  function storageCall(method, value) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (result) => { if (!done) { done = true; resolve(result); } };
      try {
        const storage = globalThis.chrome?.storage?.session;
        if (!storage?.[method]) { finish(undefined); return; }
        const returned = storage[method](value, (result) => {
          if (globalThis.chrome?.runtime?.lastError) { finish(undefined); return; }
          finish(result);
        });
        if (returned?.then) returned.then(finish, () => finish(undefined));
      } catch { finish(undefined); }
    });
  }

  async function captureScope() {
    if (!window.WoowangAuth) return { allowed: true, owner: null, epoch: scopeEpoch };
    try {
      const session = await window.WoowangAuth.getSession();
      return session ? { allowed: true, owner: `${session.apiOrigin}/${session.user.id}`,
        token: session.token, epoch: scopeEpoch } : { allowed: false, epoch: scopeEpoch };
    } catch { return { allowed: false, epoch: scopeEpoch }; }
  }

  async function currentScope(scope) {
    if (!scope.allowed || scope.epoch !== scopeEpoch) return false;
    const current = await captureScope();
    return current.allowed && current.epoch === scope.epoch && current.owner === scope.owner
      && current.token === scope.token;
  }

  async function loadState(scope) {
    const stored = await storageCall("get", STORAGE_KEY);
    const candidate = stored?.[STORAGE_KEY] ?? fallback;
    // Older anonymous history has no account ownership and must never be
    // assigned to the first person who logs in on a shared browser.
    const state = (candidate?.owner ?? null) === scope.owner ? candidate : { origins: {} };
    const cutoff = Date.now() - TTL_MS;
    const origins = Object.fromEntries(Object.entries(state.origins ?? {})
      .filter(([origin, session]) => originOf(origin) === origin && Date.parse(session.updated_at) >= cutoff)
      .sort((a, b) => Date.parse(b[1].updated_at) - Date.parse(a[1].updated_at)).slice(0, 20));
    fallback = { origins, ...(scope.owner ? { owner: scope.owner } : {}) };
    return fallback;
  }

  async function persist(state, scope) {
    if (!await currentScope(scope)) return;
    state.origins = Object.fromEntries(Object.entries(state.origins ?? {})
      .sort((a, b) => Date.parse(b[1].updated_at) - Date.parse(a[1].updated_at)).slice(0, 20));
    fallback = state;
    if (scope.owner) state.owner = scope.owner;
    else delete state.owner;
    await storageCall("set", { [STORAGE_KEY]: state });
  }

  function queued(operation) {
    const result = storageQueue.then(operation, operation);
    storageQueue = result.catch(() => {});
    return result;
  }

  function mergeObservations(candidates) {
    const unique = new Map();
    for (const candidate of candidates) {
      if (!candidate?.text || !candidate.source_url) continue;
      const clean = observation(candidate.source_url, candidate.kind, candidate.text, candidate.observed_at);
      if (!clean) continue;
      const previous = unique.get(clean.id);
      if (!previous || previous.kind === "history") unique.set(clean.id, clean);
    }
    const ordered = [...unique.values()].sort((a, b) => priority(b.text) - priority(a.text)
      || (a.kind === "history") - (b.kind === "history")
      || Date.parse(b.observed_at) - Date.parse(a.observed_at));
    const selected = [];
    let remaining = 2000;
    for (const item of ordered) {
      if (selected.length >= 10 || remaining < 30) break;
      const text = prioritizeText(item.text, remaining);
      if (!text) continue;
      selected.push({ ...item, id: `obs_${hash(`${item.source_url}\n${text}`)}`, text });
      remaining -= text.length;
    }
    return selected;
  }

  async function prepare({ url, result = {} }) {
    const scope = await captureScope();
    const origin = originOf(url);
    const revision = revisions.get(origin) ?? 0;
    const coverage = { current_page: true, linked_pages_checked: 0, linked_pages_failed: 0, linked_pages: [], login_or_external_unchecked: true, public_static_only: true };
    if (!origin || !scope.allowed) return { observations: [], coverage, session: { answer: null, observations: [] } };
    const current = observation(url, "current_page", result.pageContext);
    // Save the currently rendered stage before waiting for any public page.
    // Closing a popup aborts its work, so a late policy response cannot be the
    // prerequisite for retaining a stage that was already observed.
    if (current) await queued(async () => {
      if ((revisions.get(origin) ?? 0) !== revision || !await currentScope(scope)) return;
      const state = await loadState(scope);
      const previous = state.origins[origin] ?? {};
      const recent = (previous.observations ?? []).filter((item) => originOf(item.source_url) === origin
        && Date.parse(item.observed_at) >= Date.now() - TTL_MS);
      state.origins[origin] = { ...previous, observations: mergeObservations([current, ...recent]).slice(0, 8), updated_at: new Date().toISOString() };
      state.origins = Object.fromEntries(Object.entries(state.origins).sort((a, b) => Date.parse(b[1].updated_at) - Date.parse(a[1].updated_at)).slice(0, 20));
      await persist(state, scope);
    });
    if (!await currentScope(scope)) return { observations: [], coverage, session: { answer: null, observations: [] } };
    const policyPriority = (link) => {
      const label = String(link.label ?? "").replace(/\s+/g, "");
      if (/출금|환급|환불|정산|인출|지급|수익금/.test(label) && /안내|규정|정책|약관/.test(label)) return 60;
      if (/이용안내|이용약관|정책/.test(label)) return 50;
      if (/내역|이력/.test(label)) return 10;
      if (/출금|환급|환불|정산|인출|지급|수익금/.test(label)) return 40;
      if (/충전/.test(label)) return 20;
      return 0;
    };
    const candidates = (result.paymentLinks ?? []).filter((link) => link?.url && isAllowedPolicyUrl(link.url, url))
      .sort((a, b) => policyPriority(b) - policyPriority(a));
    const links = [...new Map(candidates.map((link) => [sanitizeSourceUrl(link.url), link])).values()].slice(0, MAX_PAGES);
    const fetched = await Promise.all(links.map(async (link) => {
      const sourceUrl = sanitizeSourceUrl(link.url);
      const policy = await fetchPolicy(sourceUrl);
      return { policy, sourceUrl };
    }));
    const observations = current ? [current] : [];
    for (const { policy, sourceUrl } of fetched) {
      coverage.linked_pages.push({ source_url: sourceUrl, status: policy.status, has_context: Boolean(policy.text), ...(policy.reason ? { reason: policy.reason } : {}) });
      if (policy.status === "checked") coverage.linked_pages_checked += 1;
      else coverage.linked_pages_failed += 1;
      if (policy.text) {
        const item = observation(sourceUrl, "linked_policy", policy.text);
        if (item) observations.push(item);
      }
    }
    return queued(async () => {
      if ((revisions.get(origin) ?? 0) !== revision || !await currentScope(scope)) return { observations: [], coverage, session: { answer: null, observations: [] } };
      const state = await loadState(scope);
      const previous = state.origins[origin] ?? {};
      const history = (previous.observations ?? []).filter((item) => originOf(item.source_url) === origin && Date.parse(item.observed_at) >= Date.now() - TTL_MS)
        .map((item) => ({ ...item, kind: "history" }));
      const merged = mergeObservations([...observations, ...history]);
      const session = { answer: previous.answer ?? null, observations: merged, updated_at: new Date().toISOString() };
      if (merged.length || session.answer) {
        state.origins[origin] = { ...session, observations: merged.slice(0, 8) };
        state.origins = Object.fromEntries(Object.entries(state.origins).sort((a, b) => Date.parse(b[1].updated_at) - Date.parse(a[1].updated_at)).slice(0, 20));
        await persist(state, scope);
      } else if (state.origins[origin]) {
        // Earlier builds could store navigation labels as a transaction stage.
        // Remove an empty legacy record after filtering without dropping answers.
        delete state.origins[origin];
        await persist(state, scope);
      }
      return { observations: merged, coverage, session };
    });
  }

  async function saveAnswer(value, answer) {
    const scope = await captureScope();
    const origin = originOf(value);
    if (!origin || !scope.allowed || !["yes", "no", "unsure"].includes(answer)) return;
    return queued(async () => {
      if (!await currentScope(scope)) return;
      const state = await loadState(scope);
      state.origins[origin] = { observations: [], ...(state.origins[origin] ?? {}), answer, updated_at: new Date().toISOString() };
      await persist(state, scope);
    });
  }

  async function clear(value) {
    const scope = await captureScope();
    const origin = originOf(value);
    if (!origin || !scope.allowed) return;
    revisions.set(origin, (revisions.get(origin) ?? 0) + 1);
    return queued(async () => {
      if (!await currentScope(scope)) return;
      const state = await loadState(scope);
      delete state.origins[origin];
      await persist(state, scope);
    });
  }

  async function clearAll() {
    scopeEpoch += 1;
    revisions.clear();
    fallback = { origins: {} };
    return queued(async () => {
      fallback = { origins: {} };
      if (globalThis.chrome?.storage?.session?.remove) await storageCall("remove", STORAGE_KEY);
      else await storageCall("set", { [STORAGE_KEY]: { origins: {} } });
    });
  }

  window.WoowangFlow = Object.freeze({ prepare, saveAnswer, clear, clearAll, sanitizeSourceUrl, isAllowedPolicyUrl, sanitizeText, extractPolicyContext, isMenuLabelOnly });
})();
