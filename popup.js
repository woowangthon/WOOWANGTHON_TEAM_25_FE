const SCAN_API_URL = "https://127.0.0.1:8000/api/v1/scan/";

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

async function requestScan(url, businessInfo) {
  const businessNumber = businessInfo.businessNumber.replace(
    /^(\d{3})(\d{2})(\d{5})$/,
    "$1-$2-$3"
  );

  const response = await fetch(SCAN_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      business_info: {
        business_name: businessInfo.companyName,
        representative_name: businessInfo.representativeName,
        business_number: businessNumber
      }
    })
  });

  if (!response.ok) {
    throw new Error(`스캔 요청 실패 (HTTP ${response.status})`);
  }

  return response.json();
}

async function showBusinessInfo() {
  const status = document.getElementById("status");
  status.textContent = "페이지에서 사업자정보를 찾는 중…";

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    if (tab?.id == null) {
      status.textContent = "현재 탭을 찾지 못했어요. 다시 열어주세요.";
      return;
    }

    const [response] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractBusinessInfo
    });

    const result = response?.result;

    if (!result) {
      status.textContent = "사업자정보를 읽지 못했어요. 다시 시도해주세요.";
      return;
    }

    for (const [field, value] of Object.entries(result)) {
      document.getElementById(field).textContent = value || "찾지 못함";
    }

    if (!result.businessNumber) {
      status.textContent = "이 페이지에서 사업자번호를 찾지 못했어요.";
      return;
    }

    if (!tab.url) {
      status.textContent = "현재 페이지 주소를 읽지 못해 확인 요청을 보낼 수 없어요.";
      return;
    }

    try {
      status.textContent = "백엔드에 확인 요청을 보내는 중…";
      const scanResult = await requestScan(tab.url, result);
      console.log("스캔 응답", scanResult);
      status.textContent = "백엔드 응답을 받았어요.";
    } catch (error) {
      status.textContent = "사업자정보는 추출했지만 확인 요청에 실패했어요.";
      console.error("스캔 요청 오류", error);
    }
  } catch (error) {
    status.textContent =
      "페이지에 접근하지 못했어요. 쇼핑몰 탭에서 다시 열어주세요.";
    console.error("사업자정보 추출 오류", error);
  }
}

const sampleChecks = [
  {
    title: "국세청 사업자 상태",
    status: "match",
    label: "계속사업자",
    reason: "예시 업체는 계속사업자로 조회되었습니다."
  },
  {
    title: "공정위 업체 정보 대조",
    status: "mismatch",
    label: "상호 불일치",
    reason: "사이트 표시 상호와 조회된 상호가 다릅니다.",
    siteValue: "예시상점",
    referenceValue: "예시유통 주식회사"
  },
  {
    title: "도메인 비교",
    status: "unknown",
    label: "확인 불가",
    reason: "조회 자료에 등록 도메인 정보가 없습니다."
  }
];

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
    reason.textContent = check.reason;

    card.append(title, label, reason);

    if (check.status === "mismatch") {
      const siteValue = document.createElement("p");
      siteValue.textContent = `사이트 표시값 · ${check.siteValue}`;

      const referenceValue = document.createElement("p");
      referenceValue.textContent = `조회된 값 · ${check.referenceValue}`;

      card.append(siteValue, referenceValue);
    }

    container.append(card);
  }
}

document.getElementById("showSample").addEventListener("click", () => {
  renderCheckResults(sampleChecks);
});

showBusinessInfo();