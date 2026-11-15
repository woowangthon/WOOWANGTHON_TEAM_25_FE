/* Public, bounded site observations. Numeric weights are assigned by Django. */
(() => {
  "use strict";

  const MAX_BYTES = 160 * 1024;
  const TIMEOUT_MS = 3000;
  const NAMES = { notices: "공지사항", reviews: "구매후기" };
  const BOARD_TERM = {
    notices: /공지\s*(?:사항|게시판)?|알림\s*마당|\bnotices?\b/i,
    reviews: /(?:구매|상품|사용|고객)\s*(?:사용\s*)?후기|상품\s*리뷰|\breviews?\b/i
  };
  const DATE = /\b(?:19|20)\d{2}\s*[-./]\s*\d{1,2}\s*[-./]\s*\d{1,2}\b|\b\d{1,2}\s*[-./]\s*\d{1,2}\b/g;
  const EMPTY = /(?:등록된|작성된|게시된)\s*(?:공지(?:사항)?|게시물|구매\s*후기|상품\s*후기|후기|리뷰|글)(?:이|가|은|는)?\s*(?:아직\s*)?없|(?:공지(?:사항)?|게시물|구매\s*후기|상품\s*후기|후기|리뷰)(?:이|가|은|는)?\s*(?:아직\s*)?없습니다|아직\s*(?:등록|작성)된\s*(?:글|후기|리뷰|공지(?:사항)?)가?\s*없|no\s+(?:posts?|notices?|reviews?)\s*(?:yet|available|found)?/i;
  const LOGIN = /(?:먼저|우선)\s*로그인|로그인.{0,25}(?:필요|해야|하세요|하시기|후에?만.{0,12}(?:열람|조회|이용|접근))|(?:로그인|인증)\s*페이지|접근\s*권한이\s*없|회원만\s*(?:열람|조회|접근)/i;

  const text = (node) => String(node?.textContent ?? "").replace(/\s+/g, " ").trim();
  const unique = (values) => [...new Set(values)];

  function origin(value) {
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.origin : null;
    } catch { return null; }
  }

  function sourceUrl(value) {
    const flow = window.WoowangFlow;
    if (flow?.sanitizeSourceUrl) return flow.sanitizeSourceUrl(value);
    try {
      const url = new URL(value);
      if (!origin(url.href)) return null;
      url.search = "";
      url.hash = "";
      return url.href;
    } catch { return null; }
  }

  function firstListing(value) {
    try {
      const url = new URL(value);
      for (const [key, item] of url.searchParams) {
        if (/^(?:page|p)$/i.test(key) && Number(item) > 1) return false;
        if (/^(?:category|category_no|cate_no|sca|stx|sfl|search|keyword|q)$/i.test(key) && item) return false;
      }
      return true;
    } catch { return false; }
  }

  function datesIn(node) {
    const attr = node?.getAttribute?.("datetime") ?? node?.getAttribute?.("data-date") ?? "";
    return unique([...`${text(node)} ${attr}`.matchAll(DATE)].map((match) => match[0].trim()).filter((value) => value.length <= 32));
  }

  function isPinned(row) {
    const classes = typeof row.className === "string" ? row.className : "";
    const first = row.querySelector("td,th,.number,.num");
    return /(?:^|\s)(?:bo_notice|pinned|sticky|notice-fixed)(?:\s|$)/i.test(classes)
      || row.getAttribute("data-pinned") === "true" || /^(?:공지|고정|필독)$/.test(text(first));
  }

  function rowDates(row, container) {
    const table = row.closest("table");
    if (table) {
      const headers = [...table.querySelectorAll("thead th, tr:first-child th")];
      const dateIndex = headers.findIndex((header) => /작성일|등록일|게시일|날짜|\bdate\b/i.test(text(header)) && !/수정|변경|업데이트|updated|modified/i.test(text(header)));
      if (dateIndex >= 0) {
        const cells = [...row.querySelectorAll(":scope > td, :scope > th")];
        return cells[dateIndex] ? datesIn(cells[dateIndex]) : [];
      }
      // A date-looking cell under an explicit modification header is not a
      // publication date, even when its CSS class is the generic `.date`.
      if (headers.some((header) => /수정|변경|업데이트|updated|modified/i.test(text(header)))) return [];
    }
    const dated = [...row.querySelectorAll("time,[datetime],.td_datetime,.posted-at,.posted_at,.created-at,.created_at,.date,[data-date]")]
      .filter((node) => !/수정|변경|updated|modified/i.test(`${node.className ?? ""} ${node.getAttribute("aria-label") ?? ""}`));
    if (dated.length) return unique(dated.flatMap(datesIn));
    // A stand-alone date cell is useful even on a board without CSS classes.
    return unique([...row.querySelectorAll("td,span")].filter((node) => {
      if (node.closest("footer,nav,header") && !container.matches?.("header")) return false;
      const value = text(node);
      const matches = datesIn(node);
      return matches.length === 1 && value === matches[0];
    }).flatMap(datesIn));
  }

  function boardContainer(root, kind, linked) {
    const selectors = kind === "notices"
      ? '[data-board="notices"],[data-board="notice"],#notice,#notices,.notice-list,.notice_list,.notices,#bo_list'
      : '[data-board="reviews"],[data-board="review"],#reviews,#review,#sit_use,.review-list,.review_list,.reviews,.itemuse-list';
    const identified = [...root.querySelectorAll(selectors)].filter((node) => !node.closest("footer,nav"));
    if (identified.length) return identified[0];
    const heading = [...root.querySelectorAll("h1,h2,h3,h4,h5,h6,caption,[role=heading]")]
      .find((node) => BOARD_TERM[kind].test(text(node)) && !node.closest("footer,nav"));
    if (heading) {
      const region = heading.closest("section,article,[role=region],.board,.board-list,main");
      if (region) return region;
      if (heading.parentElement) return heading.parentElement;
      return root;
    }
    if (linked) {
      const table = root.querySelector("main table,#container table,.board table,table");
      if (table) return table;
      const list = root.querySelector("main ol,main ul,.board-list,ol,ul");
      if (list && [...list.querySelectorAll("li")].some((row) => row.querySelector("time,.date,[datetime]"))) return list;
    }
    return null;
  }

  function boardRows(container, kind) {
    const selector = kind === "notices"
      ? "tbody tr,.notice-item,[data-post],.board-item,ol > li,ul > li"
      : "tbody tr,.review-item,[data-review],.itemuse-item,.sit_use_li,ol > li,ul > li";
    return [...container.querySelectorAll(selector)].filter((row) => {
      if (!text(row) || row.closest("nav,footer,thead")) return false;
      if (row.matches("tr") && !row.querySelector("td")) return false;
      if (row.querySelector("li") && row.matches("li")) return false;
      const label = text(row);
      if (EMPTY.test(label)) return false;
      return !/^(?:글쓰기|후기\s*작성|리뷰\s*작성|이전|다음|처음|마지막|목록|더보기|공지사항|구매후기|상품후기)$/.test(label);
    });
  }

  function inspectBoard(root, kind, { linked = false, sourceUrl: value = "" } = {}) {
    if (!NAMES[kind]) throw new Error("Unknown board type");
    const container = boardContainer(root, kind, linked);
    if (!container) return { status: "unverified", evidence: `${NAMES[kind]} 목록의 내용을 확인하지 못했습니다.`, reason: "no_board_context", ...(kind === "notices" ? { dates: [], latest_date_confirmed: false } : {}) };
    const bodyText = text(container);
    const initial = !value || firstListing(value);
    const rows = boardRows(container, kind);
    const emptyCount = /(?:총\s*(?:게시물|글|공지(?:사항)?|후기|리뷰)?\s*[:：]?\s*0\s*(?:건|개)|(?:공지(?:사항)?|구매\s*후기|상품\s*(?:사용\s*)?후기|후기|리뷰)\s*[\[(（]\s*0\s*(?:건|개)?\s*[\])）])/i.test(bodyText);
    if ((EMPTY.test(bodyText) || emptyCount) && !rows.length && initial) {
      return { status: "empty", evidence: `${NAMES[kind]}: 등록된 게시물이 없습니다.`, reason: "explicit_empty", ...(kind === "notices" ? { dates: [], latest_date_confirmed: false } : {}) };
    }
    const positiveCount = /(?:총\s*(?:게시물|글|공지(?:사항)?|후기|리뷰)?\s*[:：]?\s*[1-9]\d*\s*(?:건|개)|(?:공지(?:사항)?|구매\s*후기|상품\s*(?:사용\s*)?후기|후기|리뷰)\s*[\[(（]\s*[1-9]\d*\s*(?:건|개)?\s*[\])）])/i.test(bodyText);
    if (kind === "reviews") {
      if (rows.length || positiveCount) return { status: "present", evidence: "구매후기 목록에서 게시물을 확인했습니다.", reason: "entries_present" };
      return { status: "unverified", evidence: "구매후기 제목은 있지만 게시물 유무를 확인하지 못했습니다.", reason: LOGIN.test(bodyText) ? "login_required" : "entries_unverified" };
    }
    const rowsWithDates = rows.map((row) => ({ row, dates: rowDates(row, container) }));
    const dates = unique(rowsWithDates.flatMap((item) => item.dates)).slice(0, 50);
    const normal = rowsWithDates.filter((item) => !isPinned(item.row));
    const allDated = rowsWithDates.length > 0 && rowsWithDates.every((item) => item.dates.length > 0);
    const onlyPinned = rowsWithDates.length > 0 && normal.length === 0;
    const pageMarker = container.querySelector('[aria-current="page"],.pg_current,.page-current');
    const firstPageMarker = !pageMarker || !/^\d+$/.test(text(pageMarker)) || Number(text(pageMarker)) <= 1;
    const standardList = Boolean(container.matches?.("table,#bo_list,.notice-list,.notice_list,.board-list") || container.querySelector("table,ol,ul"));
    const explicitlyComplete = container.getAttribute?.("data-latest-date-confirmed") === "true" || container.getAttribute?.("data-board-complete") === "true";
    const latest = Boolean(dates.length && allDated && !onlyPinned && initial && firstPageMarker
      && (explicitlyComplete || linked && standardList));
    return {
      status: rows.length || dates.length || positiveCount ? "present" : "unverified",
      evidence: dates.length ? `공지사항 게시일: ${dates.join(" · ")}`.slice(0, 1000) : "공지사항 게시물의 작성일을 확인하지 못했습니다.",
      dates,
      latest_date_confirmed: latest,
      reason: latest ? "dated_first_listing" : LOGIN.test(bodyText) && !rows.length ? "login_required" : "latest_date_unverified"
    };
  }

  function parseHtml(html, kind, options = {}) {
    const template = document.createElement("template");
    template.innerHTML = html;
    const root = template.content;
    const originalText = text(root);
    const refresh = root.querySelector('meta[http-equiv="refresh" i]');
    root.querySelectorAll('input,textarea,select,option,button,script,style,noscript,template,iframe,object,embed,svg,[hidden],[aria-hidden="true"],[class~="hidden"],[class~="hide"],[class~="d-none"],[class~="sr-only"],[class~="visually-hidden"],[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="searchbox"],[role="combobox"],[role="spinbutton"]').forEach((node) => node.remove());
    root.querySelectorAll("[style]").forEach((node) => {
      if (/display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*0(?:[;\s]|$)|content-visibility\s*:\s*hidden/i.test(node.getAttribute("style") ?? "")) node.remove();
    });
    root.querySelectorAll("details:not([open])").forEach((node) => {
      const summary = [...node.children].find((child) => child.tagName === "SUMMARY");
      for (const child of [...node.childNodes]) if (child !== summary) child.remove();
    });
    const result = inspectBoard(root, kind, { ...options, linked: true });
    const noPublicData = result.status === "unverified" || result.status === "empty"
      || kind === "notices" && !result.latest_date_confirmed;
    if (refresh || noPublicData && LOGIN.test(originalText)) return {
      status: "unverified", evidence: `${NAMES[kind]} 내용을 공개 상태에서 읽지 못했습니다.`, reason: LOGIN.test(originalText) ? "login_required" : "redirect_required",
      ...(kind === "notices" ? { dates: [], latest_date_confirmed: false } : {})
    };
    return result;
  }

  async function fetchBoard(url, kind) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, { method: "GET", credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal, headers: { Accept: "text/html" } });
      if (!response.ok) return { status: "unverified", reason: response.status === 401 || response.status === 403 ? "login_required" : `http_${response.status}` };
      if (!/\btext\/html\b/i.test(response.headers.get("content-type") ?? "")) return { status: "unverified", reason: "not_html" };
      if (Number(response.headers.get("content-length")) > MAX_BYTES) return { status: "unverified", reason: "too_large" };
      let html = "";
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let bytes = 0;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > MAX_BYTES) { await reader.cancel(); return { status: "unverified", reason: "too_large" }; }
          html += decoder.decode(part.value, { stream: true });
        }
        html += decoder.decode();
      } else {
        html = await response.text();
        if (new TextEncoder().encode(html).byteLength > MAX_BYTES) return { status: "unverified", reason: "too_large" };
      }
      return parseHtml(html, kind, { sourceUrl: url });
    } catch (error) {
      return { status: "unverified", reason: error?.name === "AbortError" ? "timeout" : "unavailable" };
    } finally { clearTimeout(timeout); }
  }

  function record(kind, data, url, scope, observedAt) {
    const defaults = { status: "unverified", evidence: `${NAMES[kind] ?? "출금·충전 메뉴"} 확인 범위가 제한됐습니다.`, reason: "unverified" };
    const input = { ...defaults, ...data };
    const result = {
      status: input.status,
      source_url: url,
      observed_at: observedAt,
      evidence: (String(input.evidence ?? "").trim() || defaults.evidence).slice(0, 1000),
      scope,
      reason: String(input.reason ?? "unverified").slice(0, 80)
    };
    if (kind === "notices") {
      const dates = unique((input.dates ?? []).filter((item) => typeof item === "string" && item.trim() && item.length <= 32));
      // Keep every claimed date in the submitted evidence. Do not truncate a
      // timestamp mid-token when a board contains many rows.
      result.dates = [];
      for (const date of dates.slice(0, 50)) {
        if (result.evidence.includes(date)) result.dates.push(date);
      }
      result.latest_date_confirmed = Boolean(input.latest_date_confirmed && result.dates.length === dates.length && result.dates.length);
    }
    return result;
  }

  async function prepare({ url, result = {} }) {
    const snapshot = result.siteSnapshot;
    const currentUrl = sourceUrl(url);
    if (!snapshot || typeof snapshot !== "object" || !currentUrl || !origin(currentUrl)) return null;
    const observedAt = new Date().toISOString();
    const labels = unique((snapshot.paymentMenus ?? []).filter((label) => typeof label === "string")
      .map((label) => label.replace(/\s+/g, "")).filter((label) => /충전신청|출금신청/.test(label)).map((label) => /충전신청/.test(label) ? "충전신청" : "출금신청"));
    const menuStatus = labels.length ? "present" : snapshot.meaningful && !snapshot.blocked ? "absent" : "unverified";
    const checks = {
      payment_menus: record("payment_menus", { status: menuStatus, evidence: labels.length ? labels.join(" · ") : "현재 화면의 보이는 출금신청·충전신청 메뉴를 확인했습니다.", reason: labels.length ? "visible_menu" : menuStatus === "absent" ? "no_visible_menu" : "page_unverified" }, currentUrl, "current_page", observedAt)
    };
    await Promise.all(["notices", "reviews"].map(async (kind) => {
      if (snapshot.blocked) {
        checks[kind] = record(kind, { status: "unverified", reason: "login_required", evidence: `${NAMES[kind]} 내용을 로그인 없이 확인하지 못했습니다.` }, currentUrl, "current_page", observedAt);
        return;
      }
      const current = snapshot.boards?.[kind];
      const links = Array.isArray(snapshot.boardLinks?.[kind]) ? snapshot.boardLinks[kind].slice(0, 24) : [];
      if (current && (current.status === "empty" || current.status === "present" && (kind === "reviews" || current.latest_date_confirmed))) {
        checks[kind] = record(kind, current, currentUrl, "current_page", observedAt);
        return;
      }
      const candidate = links.find((link) => link?.url && window.WoowangFlow?.isAllowedPolicyUrl(link.url, url));
      if (candidate) {
        const linkedUrl = sourceUrl(candidate.url);
        if (linkedUrl && origin(linkedUrl) === origin(currentUrl)) {
          const observation = await fetchBoard(linkedUrl, kind);
          checks[kind] = record(kind, observation, linkedUrl, "linked_board", new Date().toISOString());
          return;
        }
      }
      if (current) checks[kind] = record(kind, current, currentUrl, "current_page", observedAt);
      else if (links.length) checks[kind] = record(kind, { status: "unverified", reason: "unsafe_link", evidence: `${NAMES[kind]} 링크가 있지만 허용된 공개 페이지로 읽지 못했습니다.` }, currentUrl, "current_page", observedAt);
      else if (snapshot.meaningful && !snapshot.blocked) checks[kind] = record(kind, { status: "missing", reason: "not_found_in_public_scope", evidence: `확인한 공개 화면에서 ${NAMES[kind]} 링크나 목록을 찾지 못했습니다.` }, currentUrl, "current_page", observedAt);
      else checks[kind] = record(kind, { status: "unverified", reason: snapshot.blocked ? "login_required" : "page_unverified" }, currentUrl, "current_page", observedAt);
    }));
    return checks;
  }

  window.WoowangSiteChecks = Object.freeze({ prepare, inspectBoard, parseHtml });
})();
