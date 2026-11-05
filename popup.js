function extractBusinessInfo() {
  
  const text = document.body.innerText
    .replace(/\r/g, "")
    .replace(/[ \t\u00a0]+/g, " ");

  const businessNumber =
    text.match(
      /사업자\s*(?:등록\s*)?번호\s*[:：]?\s*(\d{3}\s*-\s*\d{2}\s*-\s*\d{5}|\d{10})(?!\d)/
    )?.[1]?.replace(/\D/g, "") ?? null;

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
    ?? null;

  const representativeName =
    text.match(
      /대표(?:이사|자|명)?\s*[:：]\s*([^\n|]+?)(?=\s*(?:개인정보|(?:주소|사업자\s*(?:등록\s*)?번호|통신판매업|전화번호|이메일)\s*[:：])|[\n|]|$)/
    )?.[1]?.trim() ?? null;

  return { businessNumber, companyName, representativeName };
}

async function showBusinessInfo() {
  const status = document.getElementById("status");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractBusinessInfo
    });

    for (const [field, value] of Object.entries(result)) {
      document.getElementById(field).textContent = value || "찾지 못함";
    }

    status.textContent = "현재 페이지에 표시된 정보예요.";
  } catch (error) {
    status.textContent = "이 탭을 읽을 수 없어요. 쇼핑몰 탭에서 다시 열어주세요.";
    console.error(error);
  }
}

showBusinessInfo();