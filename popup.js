function extractBusinessInfo() {
  const text = document.body.innerText;

  const businessNumber = text.match(
    /사업자\s*(?:등록\s*)?번호\s*[:：]?\s*(\d{3}\s*-\s*\d{2}\s*-\s*\d{5}|\d{10})(?!\d)/
  )?.[1]?.replace(/\D/g, "") ?? null;

  const companyName =
    text.match(/상호명 및 호스팅 서비스 제공\s*[:：]\s*([^\n|]+)/)?.[1]?.trim()
    ?? text.match(/법인명\s*\(상호\)\s*[:：]\s*(.*?)\s*사업자등록번호/)?.[1]?.trim()
    ?? text.match(/\(주\)\s*무신사(?=\s*\|)/)?.[0]?.trim()
    ?? null;

  const representativeName =
    text.match(/(?:대표이사|대표자)\s*[:：]\s*([^\n|]+)/)?.[1]?.trim()
    ?? null;

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