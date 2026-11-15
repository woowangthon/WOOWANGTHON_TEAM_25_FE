function extractBusinessInfo() {
  // executeScript serializes this function, so the menu helpers live inside it.
  function isVisibleMenuElement(element, textRects = null, allowOutsideViewport = false) {
    const elementStyle = getComputedStyle(element);
    if (elementStyle.visibility === "hidden" || elementStyle.visibility === "collapse") {
      return false;
    }
    // display:contents has visible text but no box of its own.
    if (elementStyle.display !== "contents" && element.checkVisibility && !element.checkVisibility({
      checkOpacity: true,
      checkVisibilityCSS: true,
      contentVisibilityAuto: true
    })) {
      return false;
    }

    const clippingAncestors = [];
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.display === "none" || Number(style.opacity) === 0
        || style.contentVisibility === "hidden") {
        return false;
      }

      // A fully collapsed inset has a layout box but paints no menu.
      const inset = style.clipPath.match(/^inset\(([^)]+)\)$/)?.[1]
        .split(" round ")[0].trim().split(/\s+/);
      if (inset && inset.length <= 4
        && inset.every((value) => /^-?[\d.]+(?:px|%)$/.test(value))) {
        const [top, right = top, bottom = top, left = right] = inset;
        const rect = ancestor.getBoundingClientRect();
        const pixels = (value, size) => parseFloat(value)
          * (value.endsWith("%") ? size / 100 : 1);
        if (pixels(top, rect.height) + pixels(bottom, rect.height) >= rect.height
          || pixels(left, rect.width) + pixels(right, rect.width) >= rect.width) {
          return false;
        }
      }

      if (ancestor.tagName === "DETAILS" && !ancestor.open) {
        const summary = Array.from(ancestor.children)
          .find((child) => child.tagName === "SUMMARY");
        if (!summary?.contains(element)) return false;
      }

      if ((ancestor !== element || textRects)
        && /(hidden|clip|auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) {
        clippingAncestors.push({
          rect: ancestor.getBoundingClientRect(),
          clipX: style.overflowX !== "visible",
          clipY: style.overflowY !== "visible"
        });
      }
    }

    const range = document.createRange();
    range.selectNodeContents(element);
    const rects = textRects ?? (elementStyle.display === "contents"
      ? range.getClientRects()
      : element.getClientRects());
    return Array.from(rects).some((rect) => {
      // Footer discovery may extend vertically through the document. Keep
      // horizontal clipping and exclude negative document coordinates used by
      // visually hidden/off-canvas links.
      let left = Math.max(0, rect.left);
      let top = Math.max(allowOutsideViewport ? -window.scrollY : 0, rect.top);
      let right = Math.min(window.innerWidth, rect.right);
      let bottom = allowOutsideViewport ? rect.bottom : Math.min(window.innerHeight, rect.bottom);

      for (const clip of clippingAncestors) {
        if (clip.clipX) {
          left = Math.max(left, clip.rect.left);
          right = Math.min(right, clip.rect.right);
        }
        if (clip.clipY) {
          top = Math.max(top, clip.rect.top);
          bottom = Math.min(bottom, clip.rect.bottom);
        }
      }

      return right > left && bottom > top;
    });
  }

  function getVisibleMenuLabel(element, allowOutsideViewport = false) {
    if (element.tagName === "INPUT") return element.value;

    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let label = "";
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.textContent.trim() && isVisibleMenuElement(node.parentElement, null, allowOutsideViewport)) {
        label += node.textContent;
      }
    }
    return label;
  }

  const menuElements = document.querySelectorAll(
    'button, a[href], input[type="button"], input[type="submit"], input[type="reset"], '
    + '[role="button"], [role="link"], [role="menuitem"]'
  );
  const hasAdvancePaymentMenu = Array.from(menuElements).some((element) =>
    isVisibleMenuElement(element)
    && /충전신청|출금신청|정산/.test(getVisibleMenuLabel(element).replace(/\s+/g, ""))
  );
  // Public policy links may be in a rendered footer below the viewport. Hidden
  // elements remain excluded; menu questions still use viewport visibility.
  // The popup data layer applies read-only URL checks and the two-page budget.
  const paymentLinks = [];
  for (const element of menuElements) {
    if (!element.matches("a[href]") || !isVisibleMenuElement(element, null, true)) continue;
    const label = getVisibleMenuLabel(element, true).replace(/\s+/g, " ").trim();
    if (!/충전|출금|환급|환불|정산|인출|지급|수익금|적립금|이용\s*(?:안내|약관)|정책/.test(label)) continue;
    try {
      const url = new URL(element.getAttribute("href"), location.href);
      if (!/^https?:$/.test(url.protocol) || url.origin !== location.origin
        || url.username || url.password
        || url.href.split("#")[0] === location.href.split("#")[0]) continue;
      if (!paymentLinks.some((link) => link.url === url.href)) {
        paymentLinks.push({ url: url.href, label: label.slice(0, 80) });
      }
      if (paymentLinks.length >= 24) break;
    } catch { /* Invalid hrefs are never navigation targets. */ }
  }

  function collectSiteSnapshot() {
    const privateContent = 'input,textarea,select,option,script,style,noscript,template,iframe,object,embed,svg,'
      + '[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="searchbox"],[role="combobox"],[role="spinbutton"]';
    function renderedText(element) {
      if (!element) return "";
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const pieces = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        if (!parent || parent.closest(privateContent) || !node.textContent.trim()
          || !isVisibleMenuElement(parent, null, true)) continue;
        pieces.push(node.textContent.replace(/\s+/g, " ").trim());
        if (pieces.join(" ").length > 12000) break;
      }
      return pieces.join(" ").trim();
    }
    const paymentMenus = [...new Set([...menuElements].filter((element) => isVisibleMenuElement(element))
      .flatMap((element) => getVisibleMenuLabel(element).match(/충전\s*신청|출금\s*신청/g) ?? [])
      .map((label) => label.replace(/\s+/g, " ").trim()))].slice(0, 2);
    const boardTerms = { notices: /공지(?:\s*사항|\s*게시판|\s*안내)?|notice/i,
      reviews: /구매\s*후기|상품\s*후기|사용\s*후기|이용\s*후기|구매\s*리뷰|상품\s*리뷰|리뷰|review/i };
    const boardLinks = { notices: [], reviews: [] };
    for (const element of menuElements) {
      if (!element.matches("a[href]") || !isVisibleMenuElement(element, null, true)) continue;
      const label = getVisibleMenuLabel(element, true).replace(/\s+/g, " ").trim().slice(0, 80);
      for (const kind of ["notices", "reviews"]) {
        if (!boardTerms[kind].test(label) || boardLinks[kind].length >= 8) continue;
        try {
          const target = new URL(element.getAttribute("href"), location.href);
          // Keep the existence of an unreadable link; the popup will report
          // unverified instead of mistaking a private/external board for absent.
          if (!/^https?:$/.test(target.protocol) || target.username || target.password) continue;
          if (!boardLinks[kind].some((item) => item.url === target.href)) {
            boardLinks[kind].push({ url: target.href.slice(0, 2048), label });
          }
        } catch { /* Invalid hrefs do not identify a readable board. */ }
      }
    }
    function boardRegion(kind) {
      const selectors = kind === "notices"
        ? '[data-notice-board],.notice-board,.notice-list,#notice,#notices,[aria-label]'
        : '[data-review-board],.review-board,.review-list,#review,#reviews,[aria-label]';
      const markers = [...document.querySelectorAll(selectors)].filter((element) => {
        if (element.closest("nav,header,footer") || element.matches("a,button,input")
          || !isVisibleMenuElement(element, null, true)) return false;
        return !element.hasAttribute("aria-label") || boardTerms[kind].test(element.getAttribute("aria-label") ?? "");
      });
      const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,legend,caption,[role="heading"]')]
        .filter((element) => !element.closest("nav,header,footer") && isVisibleMenuElement(element, null, true)
          && boardTerms[kind].test(renderedText(element)));
      const marker = markers[0];
      if (marker) return marker.closest('section,aside,[role="region"],fieldset') ?? marker;
      const heading = headings[0];
      if (!heading) return null;
      const enclosing = heading.closest('section,aside,[role="region"],fieldset');
      if (enclosing) return enclosing;
      const parent = heading.parentElement;
      if (parent && !parent.matches("body,main")) return parent;
      const following = heading.nextElementSibling;
      return following && following.matches("table,ul,ol,div,section,article") ? following : heading;
    }
    function inspectBoard(kind) {
      const region = boardRegion(kind);
      if (!region) return null;
      const label = kind === "notices" ? "공지사항" : "구매후기";
      const regionText = renderedText(region);
      const specificEmpty = kind === "notices"
        ? /공지(?:사항)?\s*(?:이|가|은|는)?\s*(?:등록되어\s*있지\s*않|없)|등록된\s*공지(?:사항)?\s*(?:이|가)?\s*없/
        : /(?:구매|상품|사용|이용)?\s*(?:후기|리뷰)\s*(?:이|가|은|는)?\s*(?:등록되어\s*있지\s*않|없)|등록된\s*(?:구매|상품)?\s*(?:후기|리뷰)\s*(?:이|가)?\s*없/;
      const count = regionText.match(/(?:총|전체|공지사항|구매후기|상품후기|리뷰)\s*[:：([]?\s*([\d,]+)\s*(?:건|개|\))/);
      const empty = specificEmpty.test(regionText) || /(?:게시물|게시글|글)\s*(?:이|가)?\s*없|등록된\s*(?:게시물|게시글|글)\s*(?:이|가)?\s*없/.test(regionText)
        || count && Number(count[1].replace(/,/g, "")) === 0;
      const rows = [...region.querySelectorAll(kind === "notices"
        ? 'tbody tr,table tr,li,.notice-item,.board-item,article'
        : '.review-item,.review-list > li,.review-list > article,tbody tr,table tr,li,.board-item,article')]
        .filter((element) => !element.closest("nav,header,footer") && isVisibleMenuElement(element, null, true)
          && !element.matches("tr:has(th):not(:has(td))") && renderedText(element));
      const itemRows = [...new Set(rows)].filter((element) => {
        if (element.matches(".review-item,.notice-item,.board-item,.review-list > li,.review-list > article")) return true;
        return [...element.querySelectorAll("a[href]")].some((link) => {
          if (!isVisibleMenuElement(link, null, true)) return false;
          const linkLabel = renderedText(link).replace(/\s+/g, "");
          const href = link.getAttribute("href") ?? "";
          return linkLabel && !/^(?:공지사항|구매후기|상품후기|더보기|목록|이전|다음|글쓰기|후기작성)$/.test(linkLabel)
            && !/write|delete|logout|login|action|submit|(?:^|[?&])page=/.test(href);
        });
      });
      if (empty && !itemRows.length && !(count && Number(count[1].replace(/,/g, "")) > 0)) {
        return { status: "empty", evidence: `${label} 게시판: 등록된 게시물 0건`, reason: "empty_board", ...(kind === "notices" ? { dates: [], latest_date_confirmed: false } : {}) };
      }
      if (kind === "reviews") {
        return itemRows.length || count && Number(count[1].replace(/,/g, "")) > 0
          ? { status: "present", evidence: `구매후기 게시물 ${count ? count[1].replace(/,/g, "") : itemRows.length}건 확인`, reason: "entries_present" }
          : { status: "unverified", evidence: "구매후기 영역은 있으나 게시물 유무를 확인하지 못했습니다.", reason: "entries_unverified" };
      }
      const dates = [];
      const datePattern = /(?<!\d)(?:(?:19|20)\d{2}\s*[-./]\s*\d{1,2}\s*[-./]\s*\d{1,2}|\d{1,2}-\d{1,2})(?!\d)/g;
      let datedRows = 0;
      for (const row of itemRows) {
        const table = row.closest("table");
        const headers = table ? [...table.querySelectorAll("thead th,tr:first-child th")] : [];
        const publicationColumn = headers.findIndex((header) => /작성일|등록일|게시일|날짜|\bdate\b/i.test(renderedText(header))
          && !/수정|변경|업데이트|updated|modified/i.test(renderedText(header)));
        const cells = [...row.querySelectorAll(":scope > td,:scope > th")];
        const dateNodes = [...row.querySelectorAll('time,.td_datetime,.date,.post-date,[data-date]')]
          .filter((element) => isVisibleMenuElement(element, null, true)
            && !/수정|변경|업데이트|updated|modified/i.test(`${element.className ?? ""} ${element.getAttribute("aria-label") ?? ""}`));
        let sources;
        if (publicationColumn >= 0) {
          const cell = cells[publicationColumn];
          sources = cell ? [renderedText(cell), ...[...cell.querySelectorAll("time[datetime]")]
            .filter((element) => isVisibleMenuElement(element, null, true)).map((element) => element.getAttribute("datetime") ?? "")] : [];
        } else if (headers.some((header) => /수정|변경|업데이트|updated|modified/i.test(renderedText(header)))) sources = [];
        else sources = dateNodes.length ? dateNodes.flatMap((element) => [renderedText(element), element.tagName === "TIME" ? element.getAttribute("datetime") ?? "" : ""])
          : [renderedText(row)];
        const found = [...new Set(sources.flatMap((value) => [...value.matchAll(datePattern)].map((match) => match[0].trim())))];
        if (found.length) datedRows += 1;
        for (const raw of found) if (!dates.includes(raw) && raw.length <= 32 && dates.length < 50) dates.push(raw);
      }
      const singlePinned = itemRows.length === 1 && (itemRows[0].matches('.notice,.bo_notice,.pinned,.sticky,.notice-fixed,[data-pinned="true"]')
        || /^(?:공지|고정)\s/.test(renderedText(itemRows[0])));
      const firstPage = !new URL(location.href).searchParams.has("page") || new URL(location.href).searchParams.get("page") === "1";
      const previewLinks = [...region.querySelectorAll("a[href]")].some((link) => /^(?:더\s*보기|전체\s*보기|목록\s*보기)$/.test(renderedText(link)));
      const fullListing = !previewLinks && Boolean(region.matches("table,[data-notice-board],.notice-board,#notice,#notices")
        || region.querySelector("table") || /(?:최신|최근)\s*공지/.test(regionText));
      return { status: itemRows.length ? "present" : "unverified", evidence: dates.length ? `공지사항 작성일\n${dates.join("\n")}` : "공지사항 영역은 있으나 작성일을 확인하지 못했습니다.",
        dates, latest_date_confirmed: Boolean(firstPage && fullListing && itemRows.length && datedRows === itemRows.length && dates.length && !singlePinned),
        reason: dates.length ? "dated_entries" : "dates_unverified" };
    }
    const meaningfulWalker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
    let meaningfulText = "";
    while (meaningfulWalker.nextNode() && meaningfulText.length < 400) {
      const node = meaningfulWalker.currentNode;
      const parent = node.parentElement;
      if (!parent || parent.closest(`${privateContent},nav,header,footer,button,a,[role="button"],[role="link"],[role="menuitem"]`)
        || !node.textContent.trim() || !isVisibleMenuElement(parent, null, true)) continue;
      meaningfulText += ` ${node.textContent.trim()}`;
    }
    const boards = { notices: inspectBoard("notices"), reviews: inspectBoard("reviews") };
    const blocked = meaningfulText.trim().length < 250 && /먼저\s*로그인|로그인(?:이|을)?\s*(?:해야|필요|하세요)|로그인\s*후.{0,20}(?:이용|접근|확인|열람)/.test(meaningfulText)
      || Boolean(document.querySelector('input[type="password"]') && meaningfulText.trim().length < 150 && /로그인|sign\s*in/i.test(meaningfulText));
    return { meaningful: meaningfulText.replace(/\s/g, "").length >= 20 || Boolean(boards.notices || boards.reviews), blocked,
      paymentMenus, boardLinks, boards };
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

  function collectPaymentContext() {
    if (!document.body) return "";

    // Read rendered text nodes, never form values or editable user content.
    const privateContent = 'input, textarea, select, option, script, style, noscript, template, '
      + '[contenteditable]:not([contenteditable="false"]), [role="textbox"], '
      + '[role="searchbox"], [role="combobox"], [role="spinbutton"]';
    const blockSelector = 'p, li, dt, dd, h1, h2, h3, h4, h5, h6, blockquote, '
      + 'td, th, figcaption, div, section, article, aside, form, fieldset, dialog, '
      + 'main, nav, header, footer, body';
    const regionSelector = 'section, article, aside, form, fieldset, dialog, '
      + '[role="dialog"], [role="region"]';
    const blocks = [];

    function visibleText(node) {
      const parent = node.parentElement;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects()).filter((rect) => rect.width && rect.height);
      if (!isVisibleMenuElement(parent, rects)) return "";

      // A text node can span several lines while only its first line is visible.
      let left = 0;
      let top = 0;
      let right = window.innerWidth;
      let bottom = window.innerHeight;
      for (let ancestor = parent; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const rect = ancestor.getBoundingClientRect();
        if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) {
          left = Math.max(left, rect.left);
          right = Math.min(right, rect.right);
        }
        if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) {
          top = Math.max(top, rect.top);
          bottom = Math.min(bottom, rect.bottom);
        }
      }
      const fullyVisible = (rect) => rect.left >= left && rect.right <= right
        && rect.top >= top && rect.bottom <= bottom;
      const intersects = (rect) => rect.right > left && rect.left < right
        && rect.bottom > top && rect.top < bottom;
      if (rects.length && rects.every(fullyVisible)) return node.textContent;

      let result = "";
      // Most chunks need only one layout query. Inspect individual characters only
      // for a chunk crossing a viewport or overflow boundary, including auto-wrap.
      for (const match of node.textContent.matchAll(/[^\n]{1,128}|\n/gu)) {
        const chunk = match[0];
        range.setStart(node, match.index);
        range.setEnd(node, match.index + chunk.length);
        const chunkRects = Array.from(range.getClientRects())
          .filter((rect) => rect.width && rect.height);
        if (chunkRects.length && chunkRects.every(fullyVisible)) {
          result += chunk;
        } else if (chunkRects.some(intersects)) {
          let offset = match.index;
          for (const character of chunk) {
            range.setStart(node, offset);
            range.setEnd(node, offset + character.length);
            result += Array.from(range.getClientRects()).some(intersects) ? character : " ";
            offset += character.length;
          }
        } else {
          result += " ";
        }
      }
      return result;
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent || parent.closest(privateContent)) continue;
      const rendered = visibleText(node);
      if (!rendered) continue;

      const element = parent.closest(blockSelector) ?? parent;
      const last = blocks[blocks.length - 1];
      if (last?.element === element) {
        last.text += rendered;
      } else {
        blocks.push({ element, text: rendered });
      }
    }
    for (const block of blocks) {
      block.text = block.text.replace(/\s+/g, " ").trim();
      if (isMenuLabelOnly(block.text)) block.text = "";
    }

    const paymentTerms = /판매\s*(?:대금|수익)|출금|환급|환불|정산|보증금|예치금|수수료|입금|송금|충전|잔액|수령|인증비|인증금|이체|지급|적립금|포인트|게시물|리뷰|보상|세금|납부|수익금|계정\s*(?:해제|제한|동결)|동결/;
    const balanceStatement = /(?:잔액|보유\s*(?:포인트|적립금)|누적\s*수익금|적립금|포인트|수익금)\s*[:：]?\s*[\d,.]+(?:\s*[만천억]\s*[\d,.]*)*\s*(?:원|포인트|P|점)/i;
    const guidanceTerms = /[.!?。！？]|(?:하려면|해야|먼저|별도|조건|제한|해제|차감|공제|확인되면|확인\s*후|있습니다|받을\s*수|위해|필요|하세요|주세요|합니다|됩니다|입니다|해요|돼요)/;
    const selected = new Set();

    function includeRegion(element) {
      const semanticRegion = element.closest(regionSelector);
      const parent = element.parentElement;
      const region = semanticRegion ?? (
        parent && !["BODY", "MAIN", "HTML"].includes(parent.tagName)
          ? parent
          : element
      );
      for (let index = 0; index < blocks.length; index += 1) {
        if (["BODY", "MAIN", "HTML"].includes(region.tagName)
          ? blocks[index].element === element
          : region.contains(blocks[index].element)) selected.add(index);
      }
    }

    function includeRootNeighbors(menu, root) {
      let anchor = menu;
      while (anchor.parentElement && anchor.parentElement !== root) anchor = anchor.parentElement;
      const neighbors = [anchor];
      let previous = anchor;
      let next = anchor;
      const boundary = `${regionSelector}, header, footer, nav, main`;
      for (let step = 0; step < 2; step += 1) {
        previous = previous?.previousElementSibling;
        next = next?.nextElementSibling;
        if (previous?.matches(boundary)) previous = null;
        if (next?.matches(boundary)) next = null;
        if (previous) neighbors.push(previous);
        if (next) neighbors.push(next);
      }
      const indices = blocks.map((block, index) => ({ block, index }))
        .filter(({ block }) => neighbors.some((neighbor) => neighbor.contains(block.element)));
      if (indices.some(({ block }) => guidanceTerms.test(block.text))) {
        for (const { index } of indices) selected.add(index);
      }
    }

    for (const block of blocks) {
      if (paymentTerms.test(block.text) && (guidanceTerms.test(block.text) || balanceStatement.test(block.text))) {
        includeRegion(block.element);
      }
    }

    // A menu can introduce a nearby instruction that has no payment noun of its own.
    for (const menu of menuElements) {
      if (!isVisibleMenuElement(menu)
        || !/충전|출금|환급|정산|수익금|적립금/.test(getVisibleMenuLabel(menu).replace(/\s+/g, ""))) {
        continue;
      }
      let region = menu.closest(regionSelector) ?? menu.parentElement;
      for (let depth = 0; region && depth < 3; depth += 1) {
        if (["BODY", "MAIN", "HTML"].includes(region.tagName)) {
          includeRootNeighbors(menu, region);
          break;
        }
        const nearby = blocks.filter((block) => region.contains(block.element));
        if (nearby.some((block) => !menu.contains(block.element)
          && guidanceTerms.test(block.text))) {
          for (let index = 0; index < blocks.length; index += 1) {
            if (region.contains(blocks[index].element)) selected.add(index);
          }
          break;
        }
        if (region.matches(regionSelector)) break;
        region = region.parentElement;
      }
    }

    let context = blocks
      .filter((_, index) => selected.has(index))
      .map((block) => block.text)
      .filter(Boolean)
      .join("\n")
      .replace(
        /((?:계좌(?:번호)?|입금\s*계좌|송금\s*계좌|전화(?:번호)?|연락처|휴대(?:폰|전화)|핸드폰|고객센터|팩스|\bTEL(?:EPHONE)?\b|\bFAX\b)(?:는|은)?\s*[:：]?\s*(?:[가-힣A-Za-z]+(?:은행|증권)\s*)?)(\+?\d(?:[\d \t().-]*\d)?)/gi,
        (match, label, number, offset, fullText) =>
          /^\s*(?:원|만|천|억)/.test(fullText.slice(offset + match.length))
            ? match
            : `${label}[번호 제외]`
      )
      // This also covers numbers split across inline spans or separated with spaces.
      .replace(/\+?\d[\d \t().-]*\d/g, (number, offset, fullText) => {
        const isAmount = /^\s*(?:원|만|천|억)/.test(fullText.slice(offset + number.length))
          || /[₩$]\s*$/.test(fullText.slice(0, offset));
        return !isAmount && number.replace(/\D/g, "").length >= 8 ? "[번호 제외]" : number;
      })
      // Keep guidance amounts (e.g. an upfront fee), but omit a user's balance.
      .replace(/((?:내|현재|보유|사용\s*가능)?\s*(?:잔액|보유\s*포인트|보유\s*적립금|누적\s*수익금)\s*[:：]?\s*)[\d,.]+(?:\s*[만천억]\s*[\d,.]*)*\s*(?:원|포인트|P|점)/gi, "$1[개인 금액 제외]")
      .replace(/((?:적립금|포인트|수익금)\s*[:：]\s*)[\d,.]+(?:\s*[만천억]\s*[\d,.]*)*\s*(?:원|포인트|P|점)?/gi, "$1[개인 금액 제외]")
      .replace(/(^|\n)((?:보유|내|현재|총)?\s*(?:적립금|포인트|수익금)\s*)[\d,.]+(?:\s*[만천억]\s*[\d,.]*)*\s*(?:원|포인트|P|점)?(?=\s*(?:\n|$))/gi, "$1$2[개인 금액 제외]");
    if (context.length > 2000) {
      const sentences = context.match(/[^\n.!?。！？]+[.!?。！？]?/g) ?? [context];
      const scored = sentences.map((sentence, index) => ({ sentence, index,
        score: /출금|지급|수익금|판매\s*대금|계정|동결/.test(sentence)
          && /입금|송금|충전|납부|보증금|세금|수수료/.test(sentence)
          && /먼저|해야|하려면|확인되면|조건|해제|해지/.test(sentence) ? 2 : 1
      })).sort((a, b) => b.score - a.score || a.index - b.index);
      const included = new Set();
      let length = 0;
      for (const { index } of scored) {
        for (const neighbor of [index, index - 1, index + 1]) {
          if (neighbor < 0 || neighbor >= sentences.length || included.has(neighbor)
            || length + sentences[neighbor].length + 1 > 2000) continue;
          included.add(neighbor);
          length += sentences[neighbor].length + 1;
        }
      }
      if (included.size) context = [...included].sort((a, b) => a - b)
        .map((index) => sentences[index].trim()).join("\n");
    }
    return context.slice(0, 2000).replace(/[\uD800-\uDBFF]$/, "").trim();
  }

  const pageContext = collectPaymentContext();

  const text = (document.body?.innerText ?? "")
    .replace(/\r/g, "")
    .replace(/[ \t\u00a0]+/g, " ");

  const footerItems = Array.from(
    document.querySelectorAll("footer li, .footer_pc li"),
    (item) => item.textContent.trim()
  );

  const numberCandidates = Array.from(
    text.matchAll(
      /사업자\s*(?:등록\s*)?번호\s*[:：]?\s*(\d+(?: *- *\d+)*)/g
    )
  );

  numberCandidates.push(
    ...text.matchAll(
      /\bBusiness[ \t]+License[ \t]*[:：=＝][ \t]*(?:\[[ \t]*)?(\d+(?:[ \t]*-[ \t]*\d+)*)(?![\d-])/gi
    )
  );

  const validNumber = numberCandidates.find((match) =>
    /^(?:\d{10}|\d{3} *- *\d{2} *- *\d{5})$/.test(match[1])
  );

  const businessNumber = validNumber?.[1].replace(/\D/g, "") ?? null;
  const invalidBusinessNumber = !businessNumber && numberCandidates.length > 0;
  const displayedBusinessNumber = invalidBusinessNumber
    ? (numberCandidates[0]?.[1] ?? "").trim().slice(0, 40) : "";

  const englishCompanyName = footerItems
    .map((item) =>
      item.match(/^Company[ \t]*[:：=＝][ \t]*(.+)$/i)?.[1]?.trim()
    )
    .find(Boolean);

  const companyName =
    text.match(
      /(?:상호명\s*및\s*호스팅\s*서비스\s*제공|법인명\s*\(상호\)|법인명|상호명|상호|회사명)\s*[:：]?\s*([^\n|]+?)(?=\s*(?:대표이사|대표자|대표명|대표|사업자\s*(?:등록\s*)?번호|주소)\s*[:：]|[\n|]|$)/
    )?.[1]?.trim()
    ?? text.match(
      /^([^\n|]+?)\s*\|\s*대표(?:이사|자|명)?\s*[:：]/m
    )?.[1]?.trim()
    ?? text.match(
      /(?:^|\n)[ \t]*((?:\(주\)|주식회사)[^\n|]+)\n[ \t]*사업자\s*(?:등록\s*)?번호/
    )?.[1]?.trim()
    ?? englishCompanyName
    ?? text.match(
      /\bCompany[ \t]*<?[ \t]*[:：=＝][ \t]*([^\n|ㅣ]+?)(?=[ \t]*(?:(?:CEO|Business[ \t]+License)[ \t]*[:：=＝]|[\n|ㅣ]|$))/i
    )?.[1]?.trim()
    ?? null;

  const footerCeo = footerItems
    .map((item) => item.match(/^CEO\s*[:：=＝]\s*(.+)$/i)?.[1]?.trim())
    .find(Boolean);

  const multilineRepresentative = text.match(
    /^[ \t]*(?:대표(?:이사|자|명)?|CEO)[ \t]*[:：=＝]?[ \t]*\n[ \t]*([^\n|ㅣ]+)/im
  )?.[1]?.trim();

  const representativeName =
    text.match(
      /(?:대표(?:이사|자|명)?|\bCEO\b)[ \t]*[:：=＝][ \t]*([^\n|ㅣ]+?)(?=[ \t]*(?:개인정보|(?:사업장\s*(?:주소|소재지)|본사(?:[ \t]*주소)?|주소|사업자\s*(?:등록\s*)?번호|통신판매업|전화번호|이메일|Business[ \t]+License)[ \t]*[:：=＝]|\(\d{5}\))|[\n|ㅣ]|$)/i
    )?.[1]?.trim() || footerCeo || multilineRepresentative || null;

  const addressEnd =
    /[ \t]*(?:(?:사업자\s*(?:등록\s*)?번호|통신판매업(?:\s*신고(?:\s*번호)?)?|전화번호|연락처|대표번호|이메일|개인정보담당자|대표이사|대표자|상호명|상호|법인명|회사명)\s*[:：=]|\||\n)/;

  const businessNumberIndex =
    validNumber?.index ?? numberCandidates[0]?.index;

  const businessInfoText = businessNumberIndex === undefined
    ? ""
    : text.slice(
        Math.max(0, businessNumberIndex - 400),
        businessNumberIndex + 400
      );

  const postalAddress = businessInfoText.match(
    /\(\d{5}\)\s*((?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|충청|전북|전남|전라|경북|경남|경상|제주)[^\n|]*)/
  )?.[1]?.split(addressEnd)[0].trim();

  const address =
    text.match(
      /(?:사업장\s*(?:주소|소재지)|사업소\s*소재지|본사\s*주소)\s*[:：=]\s*([^\n|]+)/
    )?.[1]?.split(addressEnd)[0].trim()
    || text.match(
      /(?:소재지|주소)\s*[:：=]\s*([^\n|]+)/
    )?.[1]?.split(addressEnd)[0].trim()
    || postalAddress
    || "";

  return {
    businessNumber,
    companyName,
    representativeName,
    invalidBusinessNumber,
    displayedBusinessNumber,
    address,
    hasAdvancePaymentMenu,
    pageContext,
    paymentLinks,
    siteSnapshot: collectSiteSnapshot()
  };
}

const advancePaymentState = {
  hasMenu: false, answer: null, evidence: [], url: null,
  observations: [], coverage: null, stages: [], analysisStatus: null, analysisReason: null
};
let answerRevision = 0;
let analysisGeneration = 0;
const FLOW_STAGES = {
  REWARD_OFFER: "보상 안내",
  EARNINGS_DISPLAY: "수익·적립 표시",
  WITHDRAWAL_RESTRICTED: "출금 제한",
  ADVANCE_PAYMENT_REQUIRED: "추가 입금 요구"
};

function sourceLink(url, label = url) {
  try {
    const source = new URL(url);
    const current = new URL(advancePaymentState.url);
    if (!/^https?:$/.test(source.protocol) || source.origin !== current.origin
      || source.username || source.password) return null;
    const link = document.createElement("a");
    link.href = source.href;
    link.textContent = label;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  } catch { return null; }
}

function renderFlowHistory() {
  const warning = advancePaymentState.answer === "yes" || advancePaymentState.evidence.length;
  document.getElementById("flowAssessment").textContent = warning
    ? "별도 입금 요구 주의" : "출금 조건 미확인";
  const stages = advancePaymentState.stages.filter((stage) => Object.hasOwn(FLOW_STAGES, stage));
  document.getElementById("flowStages").textContent = stages.length
    ? `관찰한 단계: ${stages.map((stage) => FLOW_STAGES[stage]).join(" · ")} (관찰 순서와 무관)`
    : "거래 단계 안내 미확인";
  const coverage = advancePaymentState.coverage;
  const coverageText = coverage
    ? `공개 안내 ${coverage.linked_pages_checked}개 확인${coverage.linked_pages_failed ? `, ${coverage.linked_pages_failed}개 자동 확인 제한` : ""}. ` : "";
  const reasonMessages = {
    NO_PAGE_CONTEXT: "분석할 안내문을 수집하지 못해 AI 분석을 생략했어요. ",
    NO_RELEVANT_CONTEXT: "분석 대상 안내문이 없어 AI 분석을 생략했어요. ",
    MISSING_API_KEY: "서버의 AI 인증 설정이 없어 분석을 생략했어요. ",
    OPENAI_TIMEOUT: "AI 응답 시간이 초과되어 분석을 완료하지 못했어요. ",
    OPENAI_API_ERROR: "AI 요청 오류로 분석을 완료하지 못했어요. ",
    INVALID_AI_RESPONSE: "분석 결과의 형식이나 원문 근거를 검증하지 못했어요. ",
    BACKEND_REQUEST_FAILED: "백엔드 요청을 완료하지 못했어요. "
  };
  const analysisText = reasonMessages[advancePaymentState.analysisReason]
    ?? (advancePaymentState.analysisStatus === "error" ? "분석을 완료하지 못했어요. "
      : advancePaymentState.analysisStatus === "skipped" ? "AI 분석을 생략했어요. " : "");
  document.getElementById("flowCoverage").textContent = coverageText + analysisText
    + "로그인 뒤 다른 화면과 외부 고객센터 대화는 확인하지 못했어요. 관찰한 문구만으로 출금이 안전하다고 판단할 수 없어요.";
  const policies = document.getElementById("flowPolicyChecks");
  policies.replaceChildren();
  for (const page of coverage?.linked_pages ?? []) {
    const link = sourceLink(page.source_url, `안내 페이지 열기: ${page.source_url}`);
    if (!link) continue;
    let message = "요청을 완료하지 못했어요. 네트워크·브라우저 제한·주소 이동 등이 원인일 수 있어요.";
    if (page.status === "login_required") message = "로그인 없이 읽을 수 없는 페이지 · 출금 조건 미확인";
    else if (page.status === "checked") message = page.has_context === false
      ? "공개 페이지 확인 · 분석할 안내문을 찾지 못했어요." : "공개 안내 확인";
    else if (page.reason === "timeout") message = "응답 시간 초과 · 출금 조건 미확인";
    else if (page.reason === "too_large") message = "읽기 크기 제한 초과 · 출금 조건 미확인";
    else if (page.reason === "not_html") message = "HTML 안내 페이지가 아니어서 읽지 못했어요.";
    else if (/^http_[0-9]{3}$/.test(page.reason ?? "")) message = `서버 응답 HTTP ${page.reason.slice(5)} · 출금 조건 미확인`;
    const row = document.createElement("li");
    const label = document.createElement("p");
    label.textContent = message;
    row.append(label, link);
    policies.append(row);
  }
  const history = document.getElementById("flowHistory");
  history.replaceChildren();
  for (const item of advancePaymentState.observations) {
    const row = document.createElement("li");
    const label = item.kind === "linked_policy" ? "공개 안내" : item.kind === "history" ? "이전 관찰" : "현재 화면";
    const link = sourceLink(item.source_url, `${label}: ${item.source_url}`);
    if (!link) continue;
    const excerpt = document.createElement("p");
    excerpt.textContent = item.text;
    row.append(link, excerpt);
    const date = new Date(item.observed_at);
    if (Number.isFinite(date.getTime())) {
      const time = document.createElement("time");
      time.dateTime = item.observed_at;
      time.textContent = `확인 시각: ${date.toLocaleString("ko-KR")}`;
      row.append(time);
    }
    history.append(row);
  }
  document.getElementById("clearFlowHistory").disabled = !advancePaymentState.url;
}

function renderAdvancePaymentCard() {
  const card = document.getElementById("advancePaymentCard");
  const hasEvidence = advancePaymentState.evidence.length > 0;
  card.hidden = !(advancePaymentState.hasMenu || hasEvidence || advancePaymentState.answer);
  document.getElementById("advancePaymentWarning").hidden =
    advancePaymentState.answer !== "yes" && !hasEvidence;
  document.getElementById("advancePaymentAIMessage").hidden = !hasEvidence;
  document.getElementById("advancePaymentAnswerSource").hidden = advancePaymentState.answer !== "yes";
  const evidence = document.getElementById("advancePaymentEvidence");
  evidence.replaceChildren();
  for (const item of advancePaymentState.evidence) {
    const quote = document.createElement("blockquote");
    quote.textContent = item.evidence;
    evidence.append(quote);
    const link = item.source_url && sourceLink(item.source_url);
    if (link) evidence.append(link);
  }
  const messages = {
    yes: "입금하지 마세요. 판매대금을 받기 전에 돈을 보내라는 요구는 사기 의심 신호예요.",
    no: "답변에서 먼저 돈을 보내라는 요구는 확인되지 않았어요.",
    unsure: "상대방이나 고객센터가 보낸 메시지에서 ‘돈을 받으려면 먼저 보내야 한다’는 말이 있는지 확인해 보세요."
  };
  document.getElementById("advancePaymentFeedback").textContent = messages[advancePaymentState.answer] ?? "";
  for (const button of card.querySelectorAll("[data-advance-payment-answer]")) {
    button.setAttribute("aria-pressed", String(button.dataset.advancePaymentAnswer === advancePaymentState.answer));
  }
  renderFlowHistory();
}

function showAdvancePaymentCard(hasAdvancePaymentMenu) {
  advancePaymentState.hasMenu = Boolean(hasAdvancePaymentMenu);
  for (const button of document.querySelectorAll("[data-advance-payment-answer]")) {
    button.onclick = () => {
      answerRevision += 1;
      advancePaymentState.answer = button.dataset.advancePaymentAnswer;
      renderAdvancePaymentCard();
      window.WoowangFlow?.saveAnswer(advancePaymentState.url, advancePaymentState.answer).catch(() => {});
    };
  }
  document.getElementById("clearFlowHistory").onclick = async () => {
    analysisGeneration += 1;
    answerRevision += 1;
    advancePaymentState.answer = null;
    advancePaymentState.observations = [];
    advancePaymentState.evidence = [];
    advancePaymentState.stages = [];
    advancePaymentState.analysisStatus = null;
    advancePaymentState.analysisReason = null;
    renderAdvancePaymentCard();
    await window.WoowangFlow?.clear(advancePaymentState.url);
  };
  renderAdvancePaymentCard();
}

function getScanPageContext(businessInfo) {
  const context = businessInfo.pageContext;
  return typeof context === "string" && context.trim()
    ? Array.from(context).slice(0, 2000).join("") : "";
}

function applyAdvancePaymentAnalysis(ai, submittedContext, observations = []) {
  const signals = Array.isArray(ai?.signals) ? ai.signals : [];
  const sources = new Map(observations.map((item) => [item.id, item]));
  const valid = signals.filter((signal) => {
    if (!(ai.status === "completed" || (["skipped", "error"].includes(ai.status) && signal?.source === "rule"))
      || !(Object.hasOwn(FLOW_STAGES, signal?.type))
      || typeof signal.evidence !== "string" || !signal.evidence.trim()
      || typeof signal.reason !== "string" || !signal.reason.trim()
      || window.WoowangFlow?.isMenuLabelOnly(signal.evidence)) return false;
    if (!sources.size) return ai.status === "completed" && submittedContext.includes(signal.evidence);
    const source = sources.get(signal.source_id);
    return source && source.text.includes(signal.evidence)
      && signal.source_url === source.source_url && sourceLink(source.source_url)
      && (!signal.kind || signal.kind === source.kind)
      && (!signal.observed_at || signal.observed_at === source.observed_at);
  });
  const comparableQuote = (text) => text
    .replace(/^[\s()（）"'‘’“”「」『』]+|[\s()（）"'‘’“”「」『』]+$/g, "")
    .replace(/\s+/g, " ");
  const unique = new Map();
  for (const signal of valid) {
    if (signal.type !== "ADVANCE_PAYMENT_REQUIRED") continue;
    const key = JSON.stringify([signal.source_id ?? "", signal.source_url ?? "", signal.type, comparableQuote(signal.evidence)]);
    if (!unique.has(key)) unique.set(key, signal);
  }
  advancePaymentState.evidence = [...unique.values()].slice(0, 5);
  // Only evidence validated against the individual submitted source can warn.
  advancePaymentState.stages = Object.keys(FLOW_STAGES).filter((stage) =>
    valid.some((signal) => signal.type === stage));
  advancePaymentState.analysisStatus = ai?.status ?? "error";
  advancePaymentState.analysisReason = ai?.reason ?? ai?.error ?? null;
  renderAdvancePaymentCard();
}

async function requestScan(url, businessInfo, authSession = null) {
  const businessNumber = (businessInfo.businessNumber ?? "").replace(/^(\d{3})(\d{2})(\d{5})$/, "$1-$2-$3");
  const pageContext = getScanPageContext(businessInfo);
  const observations = businessInfo.pageObservations;
  const response = await window.WoowangAuth.fetch("scan/", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      business_info: { business_name: businessInfo.companyName,
        representative_name: businessInfo.representativeName,
        business_number: businessNumber, address: businessInfo.address,
        ...(businessInfo.invalidBusinessNumber && businessInfo.displayedBusinessNumber
          ? { displayed_business_number: businessInfo.displayedBusinessNumber } : {}) },
      ...(pageContext ? { page_context: pageContext } : {}),
      ...(observations?.length ? { page_observations: observations } : {}),
      ...(businessInfo.siteChecks ? { site_checks: businessInfo.siteChecks } : {})
    })
  }, authSession);
  if (!response.ok) throw new Error(`스캔 요청 실패 (HTTP ${response.status})`);
  return response.json();
}

function validScoreBreakdown(scanResult) {
  const business = scanResult?.score_breakdown?.business;
  const ai = scanResult?.score_breakdown?.ai;
  const bounded = (value, maximum) => Number.isInteger(value) && value >= 0 && value <= maximum;
  const recognized = business && ai && ((business.max_score === 50 && ai.max_score === 50)
    || (business.max_score === 60 && ai.max_score === 40)
    || (business.max_score === 40 && ai.max_score === 60));
  if (!recognized || !bounded(business.score, business.max_score)
    || !(ai.score === null || bounded(ai.score, ai.max_score))
    || !Number.isFinite(business.raw_score) || business.raw_score < business.score
    || !bounded(scanResult.risk_score, 100)
    || scanResult.risk_score !== business.score + (ai.score ?? 0)) return null;
  return { business, ai };
}

function renderScoreBreakdown(scanResult) {
  const panel = document.getElementById("scoreBreakdown");
  const cacheNote = document.getElementById("publicApiCacheNote");
  const cacheStatus = scanResult?.public_api_cache?.status;
  cacheNote.hidden = !["hit", "miss", "unavailable"].includes(cacheStatus);
  cacheNote.textContent = cacheStatus === "hit"
    ? "사업자 조회 캐시를 재사용했어요(최대 24시간). 현재 문구는 매번 새로 분석하며, 분석 여부는 위 안내에서 확인하세요."
    : cacheStatus === "unavailable" ? "사업자 조회 캐시를 사용할 수 없어 캐시 없이 검사했어요. DB 상태를 확인하세요."
      : cacheStatus === "miss" ? "사업자 조회 캐시가 없어 이번 요청을 기준으로 검사했어요. AI 점수에는 현재 요청의 문구를 사용해요." : "";
  const notice = document.getElementById("scorePolicyNotice");
  const breakdown = validScoreBreakdown(scanResult);
  panel.hidden = !breakdown;
  notice.hidden = true;
  if (!breakdown) {
    document.getElementById("riskScopeNote").textContent =
      "아래 점수는 기존 백엔드의 사업자정보 검사 결과예요. AI 점수 구성이 없는 응답이므로 출금 조건은 위 안내에서 별도로 확인하세요.";
    return;
  }
  const { business, ai } = breakdown;
  if (business.max_score !== 50 || ai.max_score !== 50) {
    notice.hidden = false;
    notice.textContent = `이전 ${business.max_score}+${ai.max_score} 점수 정책 응답입니다. 50+50 정책을 적용하려면 백엔드를 갱신하고 다시 실행하세요.`;
  } else if (scanResult.scoring_policy === "business50_ai50_v1") {
    notice.hidden = false;
    notice.textContent = "이전 50+50 점수 규칙 응답입니다. 번호 형식 오류와 상호명 검색 실패의 조합 가산점을 반영하려면 백엔드를 갱신하고 다시 실행하세요.";
  } else if (scanResult.scoring_policy === "business50_ai50_v2") {
    notice.hidden = false;
    notice.textContent = "이전 50+50 점수 규칙 응답입니다. 공지·구매후기·출금신청/충전신청 가점과 AI 상한을 반영하려면 백엔드를 갱신하고 다시 실행하세요.";
  }
  document.getElementById("riskScopeNote").textContent =
    `사업자정보 최대 ${business.max_score}점과 AI 분석·사이트 관찰 최대 ${ai.max_score}점을 합산해요. 점수는 사기 확률이 아니며, 읽지 못한 출금 조건은 계속 미확인으로 남아요.`;
  document.getElementById("businessRiskScore").textContent = business.status === "unavailable"
    ? `미확인 / ${business.max_score}점` : `${business.score} / ${business.max_score}점`;
  document.getElementById("businessScoreCapNote").textContent = business.raw_score > business.score
    ? `사업자 원점수 ${business.raw_score}점 중 상한 ${business.max_score}점을 반영했어요.`
    : business.status === "completed" ? "국세청·공정위 확인 결과를 반영했어요."
      : "일부 사업자정보를 확인하지 못했어요.";
  document.getElementById("aiRiskScore").textContent = ai.score === null
    ? `미확인 / ${ai.max_score}점` : `${ai.score} / ${ai.max_score}점`;
  const hasSiteChecks = Boolean(scanResult.analyses?.ai?.site_checks);
  document.getElementById("aiScoreStatus").textContent = ai.status === "rule_only"
    ? hasSiteChecks ? "관찰한 사이트 신호와 검증된 규칙 근거로 계산했어요. 모델 분석 완료와는 별개예요."
      : "검증된 규칙 근거로 계산한 점수예요. 모델 분석은 완료되지 않았어요."
    : ai.status === "completed" ? hasSiteChecks ? "원문 분석과 공지·구매후기·메뉴 관찰 가점을 함께 반영했어요."
      : "원문 근거를 검증한 문구 분석 점수예요."
      : "안내문이 없거나 분석에 실패해 AI 점수를 확인하지 못했어요.";
  const rawAI = ai.raw_score ?? scanResult.analyses?.ai?.raw_score;
  const aiCap = document.getElementById("aiScoreCapNote");
  aiCap.hidden = !(Number.isFinite(rawAI) && ai.score !== null && rawAI > ai.score);
  aiCap.textContent = aiCap.hidden ? "" : `AI·사이트 관찰 원점수 ${rawAI}점 중 상한 ${ai.max_score}점을 반영했어요.`;
  document.getElementById("totalRiskScore").textContent = `${scanResult.risk_score} / 100점`;
  document.getElementById("scoreCompleteness").textContent = scanResult.score_status === "completed"
    ? "확보한 자료의 두 점수 영역을 계산했어요. 확인하지 못한 출금 조건의 안전 여부는 알 수 없어요."
    : "일부 항목 미확인 · 합계는 현재 확인된 근거의 점수예요. 미확인 항목을 안전한 0점으로 판단하지 마세요.";
}

function renderSiteChecks(analysis, submitted = null) {
  const panel = document.getElementById("siteChecksPanel");
  const list = document.getElementById("siteCheckResults");
  const checks = analysis?.site_checks ?? submitted;
  panel.hidden = !checks;
  list.replaceChildren();
  if (!checks) return;
  const labels = { payment_menus: "출금신청·충전신청 메뉴", notices: "공지사항", reviews: "구매후기" };
  for (const key of Object.keys(labels)) {
    const record = checks[key];
    const row = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = `${labels[key]}: `;
    const message = document.createElement("span");
    let value = "확인하지 못했어요.";
    if (key === "payment_menus") {
      if (record?.status === "present") value = "현재 화면의 보이는 메뉴 확인 · 연결 페이지의 로그인 여부와 관계없이 관찰해요.";
      else if (record?.status === "absent") value = "현재 화면에 보이는 신청 메뉴를 찾지 못했어요.";
    } else if (record?.status === "missing") value = "확인한 공개 화면에서 게시판·목록을 찾지 못했어요.";
    else if (record?.status === "empty") value = "게시판의 등록된 게시물이 없음을 확인했어요.";
    else if (key === "reviews" && record?.status === "present") value = "구매후기 게시물을 확인했어요.";
    else if (key === "notices" && record?.status === "present") {
      if (record.freshness === "recent") value = "최근 1개월 내 공지 작성일을 확인했어요.";
      else if (record.freshness === "stale") value = "확인한 최신 공지의 작성일이 1개월 이전이에요.";
      else value = "공지사항은 있으나 최근 1개월 내 작성 여부를 확인하지 못했어요.";
      if (/^\d{4}-\d{2}-\d{2}$/.test(record.latest_date ?? "")) value += ` 최신 작성일: ${record.latest_date}`;
    }
    if (record?.status === "unverified") {
      const reason = record.reason ?? "";
      value = /login/.test(reason) ? "로그인 없이 읽을 수 없어 유무를 확인하지 못했어요."
        : /timeout/.test(reason) ? "응답 시간이 초과되어 확인하지 못했어요."
          : "공개 화면에서 유무·작성일을 확인하지 못했어요.";
    }
    message.textContent = value;
    row.append(title, message);
    const link = record?.source_url && sourceLink(record.source_url, "확인한 페이지");
    if (link) { row.append(document.createTextNode(" "), link); }
    list.append(row);
  }
  document.getElementById("siteChecksScopeNote").textContent = analysis?.site_checks
    ? "현재 화면과 최대 2개의 공개 게시판에서 관찰한 결과예요. 로그인·조회 실패는 ‘없음’으로 계산하지 않으며, 사이트 전체나 출금의 안전을 확인한 결과는 아니에요."
    : "사이트 관찰 결과를 수집했지만 서버의 반영 여부는 확인하지 못했어요. 백엔드 버전을 확인하세요.";
}

function fallbackSiteChecks(url, result) {
  if (!result.siteSnapshot) return null;
  let sourceUrl;
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return null;
    sourceUrl = window.WoowangFlow?.sanitizeSourceUrl(url) ?? `${parsed.origin}${parsed.pathname}`;
  } catch { return null; }
  const common = { source_url: sourceUrl, observed_at: new Date().toISOString(), scope: "current_page" };
  const menus = result.siteSnapshot.paymentMenus ?? [];
  return {
    payment_menus: { ...common, status: menus.length ? "present" : "unverified", evidence: menus.join(" · ") || "현재 화면의 신청 메뉴를 확인하지 못했습니다.", reason: "site_check_unavailable" },
    notices: { ...common, status: "unverified", evidence: "공지사항을 확인하지 못했습니다.", reason: "site_check_unavailable", dates: [], latest_date_confirmed: false },
    reviews: { ...common, status: "unverified", evidence: "구매후기를 확인하지 못했습니다.", reason: "site_check_unavailable" }
  };
}

function buildScanChecks(scanResult, businessInfo) {
  const nts = scanResult.analyses?.nts;
  const ftc = scanResult.analyses?.ftc;
  const businessStatus =
    nts?.status === "completed" ? nts.business_status : null;
  const isActive = businessStatus === "ACTIVE";

  const ntsDescription = typeof nts?.business_status_description === "string"
    ? nts.business_status_description.trim() : "";
  const isUnregistered = nts?.status === "completed" && businessStatus === "UNKNOWN"
    && typeof nts.tax_type === "string" && /등록되지\s*않은\s*사업자등록번호/.test(nts.tax_type);
  const ntsLabel = ntsDescription || (isUnregistered ? "등록 정보 없음"
    : isActive ? "계속사업자" : (!businessStatus || businessStatus === "UNKNOWN" ? "확인 불가" : businessStatus));
  let ntsReason = "국세청 조회 결과를 확인할 수 없어요.";
  if (isUnregistered) {
    ntsReason = "국세청에서 등록되지 않은 사업자번호라고 응답했어요.";
  } else if (businessStatus && businessStatus !== "UNKNOWN") {
    ntsReason = "국세청에서 반환한 사업자 상태예요.";
  } else if (businessInfo.invalidBusinessNumber) {
    ntsReason = "페이지에 표시된 사업자번호의 형식이 올바르지 않아요.";
  } else if (!businessInfo.businessNumber) {
    ntsReason = "페이지에서 사업자번호를 찾지 못했어요.";
  }

  const ftcCheck = {
    title: "공정위 업체 정보 대조",
    status: "unknown",
    label: "확인 불가",
    reason: "공정위 대조 결과를 확인할 수 없어요."
  };

  if (ftc?.status === "not_configured") {
    ftcCheck.reason = "공정위 조회가 아직 설정되지 않았어요.";
  } else if (ftc?.status === "completed" && ftc.match_status === "NO_MATCH") {
    ftcCheck.label = "검색 결과 없음";
    ftcCheck.reason = ftc.search_method === "BUSINESS_NAME"
      ? "공정위에서 페이지에 표시된 상호명으로 업체를 찾지 못했어요."
      : "공정위에서 일치하는 업체를 찾지 못했어요.";
  } else if (ftc?.status === "completed" && ftc.verification) {
    const verification = ftc.verification;
    const fields = [
      ["business_number", "사업자번호"],
      ["business_name", "상호"],
      ["representative_name", "대표자명"],
      ["business_address", "주소"]
    ];

    const matchCount = fields.filter(
      ([key]) => verification[key] === "MATCH"
    ).length;

    const mismatchCount = fields.filter(
      ([key]) => verification[key] === "MISMATCH"
    ).length;
    const partialCount = fields.filter(
      ([key]) => verification[key] === "PARTIAL_MATCH"
    ).length;

    const submittedName =
      scanResult.business_info?.representative_name
      || businessInfo.representativeName;
    const officialNames = ftc.official_info?.representative_names;

    const fieldResults = fields.map(([key, name]) => {
      const result = verification[key];

      if (result === "MATCH") return `${name} 일치`;
      if (result === "PARTIAL_MATCH") return `${name} 일부 일치`;
      if (result === "SKIPPED") return `${name} 대조 생략`;

      if (result === "MISMATCH") {
        if (
          key === "representative_name"
          && submittedName
          && Array.isArray(officialNames)
          && officialNames.length > 0
        ) {
          return `${name} 불일치 (페이지 표시: ${submittedName}, 공정위 등록: ${officialNames.join(", ")})`;
        }

        return `${name} 불일치`;
      }

      return `${name} 확인 불가`;
    });

    if (mismatchCount > 0) {
      ftcCheck.label = `${mismatchCount}개 항목 불일치`;
    } else if (partialCount > 0) {
      ftcCheck.label = `${matchCount ? `${matchCount}개 일치 · ` : ""}${partialCount}개 일부 일치`;
    } else if (matchCount > 0) {
      ftcCheck.label = `${matchCount}개 항목 일치`;
      if (matchCount === fields.length) {
        ftcCheck.status = "match";
      }
    }

    ftcCheck.reason = fieldResults.join("\n");
  }

  const combinedScoring = Boolean(validScoreBreakdown(scanResult));
  const verdict = scanResult.verdict;
  const riskScore = scanResult.risk_score;

  let verdictLabel = verdict ?? "확인 불가";
  let verdictReason = "종합 판정 결과를 확인할 수 없어요.";

  if (verdict === "LOW_RISK") {
    verdictLabel = combinedScoring ? "확인된 위험 점수 낮음" : "낮은 위험";
    verdictReason = combinedScoring
      ? "현재 확보한 자료에서 계산한 점수예요. 미확인 출금 조건은 위 안내에서 별도로 확인하세요."
      : "사업자정보 검사 점수예요. 출금 조건의 안전 여부는 별도로 확인해야 해요.";
  } else if (combinedScoring && verdict === "HIGH_RISK") {
    verdictLabel = "높은 위험";
    verdictReason = advancePaymentState.evidence.length
      ? "직접적인 선입금 요구가 확인돼 총점과 별도로 높은 위험으로 표시해요. 원문과 출처를 확인하세요."
      : "확인된 위험 근거의 합산 점수가 높아요. 아래 점수 구성과 원문 근거를 확인하세요.";
  } else if (combinedScoring && verdict === "CAUTION") {
    verdictLabel = "주의";
    verdictReason = "확인된 위험 근거가 있어 추가 확인이 필요해요. 사업자정보와 문구 분석 점수를 함께 확인하세요.";
  } else if (verdict === "INSUFFICIENT_DATA") {
    verdictLabel = "정보 부족";
    verdictReason = "종합 판정에 필요한 검사 정보가 부족해요.";
  } else if (verdict === "UNDETERMINED") {
    verdictLabel = "미정";
    verdictReason = "백엔드에서 아직 종합 판정을 내리지 않았어요.";
  } else if (verdict) {
    verdictReason = "백엔드에서 반환한 판정이에요.";
  }

  const riskFactors = Array.isArray(scanResult.risk_factors)
    ? scanResult.risk_factors
    : [];

  const riskMessages = riskFactors.flatMap((factor) => {
    const message = [factor?.message, factor?.reason]
      .find((value) => typeof value === "string" && value.trim())
      ?.trim();

    if (!message) return [];

    return [
      Number.isFinite(factor.points)
        ? Number.isFinite(factor.raw_points) && factor.raw_points !== factor.points
          ? `${message} (반영 ${factor.points}점, 원점수 ${factor.raw_points}점)`
          : `${message} (${factor.points}점)`
        : message
    ];
  });

  return [
    {
      title: "국세청 사업자 상태",
      status: isActive ? "match" : "unknown",
      label: ntsLabel,
      reason: ntsReason
    },
    ftcCheck,
    {
      title: "종합 판정",
      status: "unknown",
      label: verdictLabel,
      reason: verdictReason,
      score: riskScore,
      details: riskMessages
    }
  ];
}

function renderCheckResults(checks) {
  const container = document.getElementById("checkResults");
  container.replaceChildren();

  for (const check of checks) {
    const card = document.createElement("section");
    card.className = "result";

    const title = document.createElement("h3");
    title.textContent = check.title;

    const label = document.createElement("p");
    label.className = check.status;
    label.textContent = check.label;

    const reason = document.createElement("p");
    reason.className = "result-reason";
    reason.textContent = check.reason;

    card.append(title, label, reason);

    if (Number.isFinite(check.score)) {
      const score = document.createElement("p");
      score.className = "result-score";
      score.textContent = `총 위험 점수 ${check.score}점`;
      card.append(score);
    }

    if (check.details?.length) {
      const heading = document.createElement("h4");
      heading.className = "result-details-title";
      heading.textContent = "위험 근거";

      const list = document.createElement("ul");
      list.className = "result-details";

      for (const detail of check.details) {
        const item = document.createElement("li");
        item.textContent = detail;
        list.append(item);
      }

      card.append(heading, list);
    }

    container.append(card);
  }
}

let authGeneration = 0;
let activeScanGeneration = null;
let loginBusy = false;
let logoutBusy = false;
let retryTimer = null;
let displayIdentity = null;
let displayToken = null;
let displayMode = null;
let popupInitialization = null;

function authenticationMessage(error) {
  return window.WoowangAuth?.errorMessage(error)
    ?? "로그인 기능을 불러오지 못했어요. 확장 파일을 함께 갱신하고 다시 열어 주세요.";
}

function hasVisiblePaymentWarning() {
  return advancePaymentState.answer === "yes" || advancePaymentState.evidence.length > 0;
}

function cancelRetry() {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
  for (const id of ["retryScanButton", "demoRetryButton"]) {
    const button = document.getElementById(id);
    button.hidden = true;
    button.disabled = false;
    button.textContent = id === "demoRetryButton" ? "다시 확인" : "다시 검사";
  }
}

function showLogin(message = "관리자에게 발급받은 계정으로 로그인해 주세요.", keepScan = false) {
  displayMode = null;
  document.getElementById("authPanel").hidden = false;
  document.getElementById("authAccount").hidden = true;
  document.getElementById("scanContent").hidden = !keepScan;
  document.getElementById("authMessage").textContent = message;
  document.getElementById("authHeading").textContent = "우왕톤 로그인";
  document.getElementById("authIntro").textContent = "관리자에게 발급받은 계정으로 로그인해 주세요.";
  document.getElementById("authCredentials").hidden = false;
  cancelRetry();
}

function showDemoNotice(message, error = null) {
  displayMode = "demo";
  document.getElementById("authPanel").hidden = false;
  document.getElementById("authAccount").hidden = true;
  document.getElementById("scanContent").hidden = !hasVisiblePaymentWarning();
  document.getElementById("authHeading").textContent = "우왕톤 시연";
  document.getElementById("authIntro").textContent = "별도의 계정 입력 없이 시연에 참여해요.";
  document.getElementById("authCredentials").hidden = true;
  document.getElementById("authMessage").textContent = message;
  cancelRetry();
  if (error && error.code !== "DEMO_ENDED" && error.status !== 403) showRetry(error, true);
}

function showAccount(session) {
  document.getElementById("authPanel").hidden = true;
  document.getElementById("authAccount").hidden = false;
  document.getElementById("scanContent").hidden = false;
  document.getElementById("authUserLabel").textContent = session.mode === "demo" ? "시연모드" : session.user.username;
  document.getElementById("authServer").value = session.apiOrigin;
  displayIdentity = `${session.apiOrigin}/${session.user.id}`;
  displayToken = session.token;
  displayMode = session.mode ?? null;
}

function showRetry(error, demo = false) {
  cancelRetry();
  const button = document.getElementById(demo ? "demoRetryButton" : "retryScanButton");
  button.hidden = false;
  const until = Date.now() + (error?.status === 429 ? (error.retryAfterSeconds ?? 60) * 1000 : 0);
  const update = () => {
    const seconds = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    button.disabled = seconds > 0;
    const action = demo ? "다시 확인" : "다시 검사";
    button.textContent = seconds > 0 ? `${seconds}초 후 ${action}` : action;
    if (seconds > 0) retryTimer = setTimeout(update, 1000);
    else retryTimer = null;
  };
  update();
}

function eraseVisibleAnalysis() {
  displayToken = null;
  answerRevision += 1;
  analysisGeneration += 1;
  Object.assign(advancePaymentState, {
    hasMenu: false, answer: null, evidence: [], url: null,
    observations: [], coverage: null, stages: [], analysisStatus: null, analysisReason: null
  });
  renderAdvancePaymentCard();
  document.getElementById("checkResults").replaceChildren();
  document.getElementById("scoreBreakdown").hidden = true;
  document.getElementById("siteChecksPanel").hidden = true;
  document.getElementById("siteCheckResults").replaceChildren();
  for (const id of ["businessNumber", "companyName", "representativeName"]) {
    document.getElementById(id).textContent = "—";
  }
  document.getElementById("businessNumberIssueDetail").textContent = "";
  document.getElementById("businessNumberIssueDetail").hidden = true;
  document.getElementById("publicApiCacheNote").textContent = "";
  document.getElementById("publicApiCacheNote").hidden = true;
}

async function eraseFlowHistory() {
  if (window.WoowangFlow?.clearAll) await window.WoowangFlow.clearAll();
  else if (chrome.storage?.session?.remove) await chrome.storage.session.remove("woowang.paymentFlow.v1");
  eraseVisibleAnalysis();
}

async function showBusinessInfo(expectedSession = null) {
  const revision = authGeneration;
  if (activeScanGeneration === revision) return;
  activeScanGeneration = revision;
  cancelRetry();
  try {
    const session = await window.WoowangAuth?.getSession();
    if (revision !== authGeneration) return;
    if (!session) {
      if (expectedSession?.mode === "demo") {
        const error = { code: "AUTH_REQUIRED", status: 401, mode: "demo" };
        showDemoNotice(authenticationMessage(error), error);
      } else showLogin(undefined, hasVisiblePaymentWarning());
      return;
    }
    if (expectedSession && (session.token !== expectedSession.token || session.apiOrigin !== expectedSession.apiOrigin)) {
      eraseVisibleAnalysis();
      showLogin(authenticationMessage({ code: "AUTH_CHANGED" }));
      return;
    }
    showAccount(session);
    await inspectCurrentTab(revision, session);
  } catch (error) {
    if (revision !== authGeneration) return;
    showLogin(authenticationMessage(error), hasVisiblePaymentWarning());
  } finally {
    if (activeScanGeneration === revision) activeScanGeneration = null;
  }
}

async function inspectCurrentTab(authRevision, authSession) {
  const status = document.getElementById("status");
  status.textContent = "페이지에서 사업자정보를 찾는 중…";

  let tab;
  let result;

  try {
    [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });
    if (authRevision !== authGeneration) return;

    if (tab?.id == null) {
      status.textContent = "현재 탭을 찾지 못했어요. 다시 열어주세요.";
      return;
    }

    const [response] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractBusinessInfo
    });
    if (authRevision !== authGeneration) return;

    result = response?.result;
  } catch (error) {
    status.textContent =
      "페이지에 접근하지 못했어요. 쇼핑몰 탭에서 다시 열어주세요.";
    console.error("[우왕톤] 사업자정보 추출 오류");
    return;
  }

  if (!result) {
    status.textContent = "사업자정보를 읽지 못했어요. 다시 시도해주세요.";
    return;
  }

  advancePaymentState.url = tab.url;
  const generation = analysisGeneration;
  const initialAnswerRevision = answerRevision;
  showAdvancePaymentCard(result.hasAdvancePaymentMenu);

  document.getElementById("businessNumber").textContent =
    result.businessNumber
    ?? (result.invalidBusinessNumber ? "형식 오류" : "찾지 못함");

  const numberDetail = document.getElementById("businessNumberIssueDetail");
  numberDetail.hidden = !result.invalidBusinessNumber || !result.displayedBusinessNumber;
  numberDetail.textContent = numberDetail.hidden ? "" :
    `표시 번호 ${result.displayedBusinessNumber} · 숫자 ${result.displayedBusinessNumber.replace(/\D/g, "").length}자리`;

  document.getElementById("companyName").textContent =
    result.companyName || "찾지 못함";

  document.getElementById("representativeName").textContent =
    result.representativeName || "찾지 못함";

  if (!tab.url) {
    status.textContent = "현재 페이지 주소를 읽지 못해 확인 요청을 보낼 수 없어요.";
    return;
  }

  let scanResult;

  try {
    status.textContent = "같은 사이트의 공개 안내와 게시판을 확인하는 중…";
    const [prepared, siteChecks] = await Promise.all([
      window.WoowangFlow?.prepare({ url: tab.url, result }) ?? Promise.resolve(null),
      window.WoowangSiteChecks?.prepare({ url: tab.url, result }).catch(() => fallbackSiteChecks(tab.url, result))
        ?? Promise.resolve(fallbackSiteChecks(tab.url, result))
    ]);
    if (authRevision !== authGeneration) return;
    result.siteChecks = siteChecks;
    if (prepared) {
      if (generation !== analysisGeneration) {
        result.pageContext = "";
        result.pageObservations = [];
      } else {
        advancePaymentState.observations = prepared.observations;
        advancePaymentState.coverage = prepared.coverage;
        if (initialAnswerRevision === answerRevision && advancePaymentState.answer === null) {
          advancePaymentState.answer = prepared.session.answer;
        }
        result.pageObservations = prepared.observations;
        result.pageContext = prepared.observations.map((item) => item.text).join("\n");
        renderAdvancePaymentCard();
      }
    }
    status.textContent = "백엔드에 확인 요청을 보내는 중…";
    scanResult = await requestScan(tab.url, result, authSession);
  } catch (error) {
    if (authRevision !== authGeneration) {
      // Removing this same session can fire storage.onChanged before its 401/403
      // reaches this catch. A different account must never revive the old view.
      const current = await window.WoowangAuth.getSession().catch(() => null);
      const identity = await window.WoowangAuth.getLastIdentity().catch(() => null);
      if (![401, 403].includes(error?.status) || current || !identity
        || identity.apiOrigin !== authSession.apiOrigin || identity.userId !== String(authSession.user.id)
        || displayIdentity !== `${authSession.apiOrigin}/${authSession.user.id}`) return;
    }
    if (error?.code === "AUTH_CHANGED") {
      eraseVisibleAnalysis();
      showLogin(authenticationMessage(error));
      return;
    }
    status.textContent = authenticationMessage(error);
    advancePaymentState.analysisStatus = "error";
    advancePaymentState.analysisReason = "BACKEND_REQUEST_FAILED";
    renderAdvancePaymentCard();
    if ((error?.mode === "demo" || authSession.mode === "demo") && [401, 403].includes(error?.status)) {
      showDemoNotice(authenticationMessage({ ...error, mode: "demo" }), error);
    }
    else if (error?.status === 401 || error?.status === 403) showLogin(authenticationMessage(error), true);
    else showRetry(error);
    console.error("[우왕톤] 스캔 요청 오류", Number.isInteger(error?.status) ? error.status : "연결 실패");
    return;
  }

  try {
    if (authRevision !== authGeneration) return;
    if (generation === analysisGeneration) {
      applyAdvancePaymentAnalysis(scanResult?.analyses?.ai, getScanPageContext(result), result.pageObservations);
    }
    renderScoreBreakdown(scanResult);
    renderSiteChecks(scanResult?.analyses?.ai, result.siteChecks);
    renderCheckResults(buildScanChecks(scanResult, result));
    status.textContent = "백엔드 응답을 받았어요.";
  } catch (error) {
    status.textContent = "백엔드 응답을 받았지만 결과를 표시하지 못했어요.";
    console.error("[우왕톤] 스캔 결과 표시 오류");
  }
}

function initializeAuthenticatedPopup({ apiOrigin = null } = {}) {
  if (popupInitialization) return popupInitialization;
  if (loginBusy || logoutBusy) return Promise.resolve();
  const initialize = async () => {
    if (!window.WoowangAuth) { showLogin(authenticationMessage(null)); return; }
    const selector = document.getElementById("authServer");
    const controls = document.getElementById("authForm").querySelectorAll("input,select,button");
    // Lock the previous login form before the first await. A server change must
    // not race a password submission while session/metadata checks are pending.
    controls.forEach((element) => { element.disabled = true; });
    document.getElementById("authCredentials").hidden = true;
    document.getElementById("authMessage").textContent = "이용 상태를 확인하는 중…";
    let demoAttempt = false;
    try {
      const previous = await window.WoowangAuth.getLastIdentity();
      const cached = await window.WoowangAuth.getSession();
      if (cached?.mode === "demo") displayMode = "demo";
      let session = await window.WoowangAuth.ready();
      if (!session) {
        demoAttempt = true;
        showDemoNotice("시연 이용 가능 여부를 확인하는 중…");
        const base = apiOrigin ?? previous?.apiOrigin ?? selector.value;
        session = await window.WoowangAuth.tryDemo({ apiOrigin: base });
        if (!session) { showLogin(undefined, hasVisiblePaymentWarning()); return; }
        authGeneration += 1;
        if (previous && (previous.userId !== String(session.user.id) || previous.apiOrigin !== session.apiOrigin)) {
          await eraseFlowHistory();
        }
      }
      showAccount(session);
      await showBusinessInfo(session);
    } catch (error) {
      if (error?.code === "AUTH_CHANGED") {
        eraseVisibleAnalysis();
        showLogin(authenticationMessage(error));
      } else if (demoAttempt || error?.mode === "demo" || displayMode === "demo") showDemoNotice(authenticationMessage(error), error);
      else showLogin(authenticationMessage(error), hasVisiblePaymentWarning());
    } finally { controls.forEach((element) => { element.disabled = false; }); }
  };
  popupInitialization = initialize().finally(() => { popupInitialization = null; });
  return popupInitialization;
}

document.getElementById("authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (loginBusy || popupInitialization || !window.WoowangAuth) return;
  loginBusy = true;
  const form = event.currentTarget;
  const password = document.getElementById("authPassword");
  const username = document.getElementById("authUsername").value;
  const apiOrigin = document.getElementById("authServer").value;
  form.querySelectorAll("input,select,button").forEach((element) => { element.disabled = true; });
  document.getElementById("authMessage").textContent = "로그인하는 중…";
  const previous = await window.WoowangAuth.getLastIdentity().catch(() => null);
  try {
    const session = await window.WoowangAuth.login({ username, password: password.value, apiOrigin });
    authGeneration += 1;
    if (previous && (previous.userId !== String(session.user.id) || previous.apiOrigin !== session.apiOrigin)) {
      await eraseFlowHistory();
    }
    password.value = "";
    showAccount(session);
    await showBusinessInfo(session);
  } catch (error) {
    showLogin(authenticationMessage(error), hasVisiblePaymentWarning());
  } finally {
    password.value = "";
    form.querySelectorAll("input,select,button").forEach((element) => { element.disabled = false; });
    loginBusy = false;
  }
});

document.getElementById("logoutButton").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  logoutBusy = true;
  authGeneration += 1;
  cancelRetry();
  eraseVisibleAnalysis();
  document.getElementById("scanContent").hidden = true;
  let message = "로그아웃했어요.";
  // Local history cleanup must not wait for an unreachable revocation endpoint.
  const revocation = window.WoowangAuth.logout().then(() => null, (error) => error);
  let historyFailed = false;
  try { await eraseFlowHistory(); }
  catch { historyFailed = true; }
  const revokeError = await revocation;
  if (revokeError) message = `이 기기의 로그인 정보를 지웠어요. ${authenticationMessage(revokeError)}`;
  if (historyFailed) message = "로그인 정보를 지웠지만 관찰 기록 정리를 확인하지 못했어요. 확장을 다시 열어 주세요.";
  showLogin(message);
  button.disabled = false;
  logoutBusy = false;
});

document.getElementById("retryScanButton").addEventListener("click", async () => {
  // This is an explicit user action. Rate-limit timers never resend a scan.
  await initializeAuthenticatedPopup();
});

document.getElementById("demoRetryButton").addEventListener("click", async () => {
  await initializeAuthenticatedPopup({ apiOrigin: document.getElementById("authServer").value });
});

document.getElementById("authServer").addEventListener("change", async (event) => {
  if (loginBusy || logoutBusy) return;
  await initializeAuthenticatedPopup({ apiOrigin: event.currentTarget.value });
});

if (globalThis.chrome?.storage?.onChanged?.addListener) {
  globalThis.chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "session" || loginBusy || logoutBusy || !displayIdentity) return;
    const identityChange = changes[window.WoowangAuth?.identityKey];
    if (identityChange && !identityChange.newValue) {
      authGeneration += 1;
      eraseVisibleAnalysis();
      showLogin("다른 창에서 로그아웃했어요. 다시 로그인해 주세요.");
      return;
    }
    if (!changes[window.WoowangAuth?.storageKey]) return;
    const next = changes[window.WoowangAuth.storageKey].newValue;
    const sameOwner = next && `${next.apiOrigin}/${next.user?.id}` === displayIdentity;
    // Enrollment writes may be delivered after this popup adopted its token or
    // started the new scan. Same-owner renewal must not cancel its own work.
    // A different owner always reaches the clearing branch below.
    if (sameOwner && (next.token === displayToken || popupInitialization)) return;
    authGeneration += 1;
    if (next && `${next.apiOrigin}/${next.user?.id}` !== displayIdentity) {
      // A second popup may change accounts while this one still shows results.
      // Clear only this view; its old owner-scoped history cannot be loaded by
      // the new account, and clearing shared storage here could erase new work.
      eraseVisibleAnalysis();
      showLogin("다른 창에서 로그인 계정이 바뀌었어요. 확장을 다시 열어 검사해 주세요.");
    } else {
      document.getElementById("status").textContent = "로그인 상태가 바뀌었어요. 다시 로그인해 주세요.";
      if (displayMode === "demo") {
        showDemoNotice("시연 이용 시간이 만료되었거나 현재 이용할 수 없어요. 확장을 다시 열어 확인해 주세요.",
          { code: "AUTH_REQUIRED", status: 401, mode: "demo" });
      } else showLogin("로그인이 만료되거나 다른 창에서 변경됐어요. 확장을 다시 열어 확인해 주세요.", true);
    }
  });
}

initializeAuthenticatedPopup();
