chrome.webNavigation.onCommitted.addListener(({ frameId, url }) => {
  if (frameId !== 0) return;

  const pageUrl = new URL(url);
  if (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:") return;

  console.log("[우왕톤] 사이트 방문 감지", pageUrl.hostname);
});