const SCAN_API_URL = "http://127.0.0.1:8000/api/v1/scan/";

function extractBusinessInfo() {
  const text = (document.body?.innerText ?? "")
    .replace(/\r/g, "")
    .replace(/[ \t\u00a0]+/g, " ");

  const numberCandidates = Array.from(
    text.matchAll(
      /사업자\s*(?:등록\s*)?번호\s*[:：]?\s*(\d+(?: *- *\d+)*)/g
    ),
    (match) => match[1]
  );

  const validNumber = numberCandidates.find((candidate) =>
    /^(?:\d{10}|\d{3} *- *\d{2} *- *\d{5})$/.test(candidate)
  );

  const businessNumber = validNumber?.replace(/\D/g, "") ?? null;
  const invalidBusinessNumber = !businessNumber && numberCandidates.length > 0;

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

  return {
    businessNumber,
    companyName,
    representativeName,
    invalidBusinessNumber
  };
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

function buildScanChecks(scanResult) {
  const nts = scanResult.analyses?.nts;
  const ftc = scanResult.analyses?.ftc;
  const businessStatus =
    nts?.status === "completed" ? nts.business_status : null;
  const isActive = businessStatus === "ACTIVE";

  return [
    {
      title: "국세청 사업자 상태",
      status: isActive ? "match" : "unknown",
      label: isActive ? "계속사업자" : (businessStatus ?? "확인 불가"),
      reason: businessStatus
        ? "국세청에서 반환한 사업자 상태예요."
        : "국세청 조회 결과를 확인할 수 없어요."
    },
    {
      title: "공정위 업체 정보 대조",
      status: "unknown",
      label: "확인 불가",
      reason: ftc?.status === "not_configured"
        ? "공정위 조회가 아직 설정되지 않았어요."
        : "공정위 대조 결과를 이 화면에서 확인할 수 없어요."
    },
    {
      title: "종합 판정",
      status: "unknown",
      label: scanResult.verdict === "UNDETERMINED"
        ? "미정"
        : (scanResult.verdict ?? "확인 불가"),
      reason: scanResult.verdict === "UNDETERMINED"
        ? "백엔드에서 아직 종합 판정을 내리지 않았어요."
        : scanResult.verdict
          ? "백엔드에서 반환한 판정이에요."
          : "종합 판정 결과를 확인할 수 없어요."
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
    reason.textContent = check.reason;

    card.append(title, label, reason);
    container.append(card);
  }
}

async function showBusinessInfo() {
  const status = document.getElementById("status");
  status.textContent = "페이지에서 사업자정보를 찾는 중…";

  let tab;
  let result;

  try {
    [tab] = await chrome.tabs.query({
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

    result = response?.result;
    console.log("[우왕톤] 추출 결과", result);
  } catch (error) {
    status.textContent =
      "페이지에 접근하지 못했어요. 쇼핑몰 탭에서 다시 열어주세요.";
    console.error("[우왕톤] 사업자정보 추출 오류", error);
    return;
  }

  if (!result) {
    status.textContent = "사업자정보를 읽지 못했어요. 다시 시도해주세요.";
    return;
  }

  for (const field of ["businessNumber", "companyName", "representativeName"]) {
    document.getElementById(field).textContent = result[field] || "찾지 못함";
  }

  if (!result.businessNumber) {
    if (result.invalidBusinessNumber) {
      document.getElementById("businessNumber").textContent = "형식 오류";
      status.textContent = "페이지에 표시된 사업자번호 형식이 올바르지 않아요.";
    } else {
      status.textContent = "이 페이지에서 사업자번호를 찾지 못했어요.";
    }
    return;
  }

  if (!tab.url) {
    status.textContent = "현재 페이지 주소를 읽지 못해 확인 요청을 보낼 수 없어요.";
    return;
  }

  let scanResult;

  try {
    status.textContent = "백엔드에 확인 요청을 보내는 중…";
    scanResult = await requestScan(tab.url, result);
    console.log("[우왕톤] 스캔 응답", scanResult);
  } catch (error) {
    status.textContent = "사업자정보는 추출했지만 확인 요청에 실패했어요.";
    console.error("[우왕톤] 스캔 요청 오류", error);
    return;
  }

  try {
    renderCheckResults(buildScanChecks(scanResult));
    status.textContent = "백엔드 응답을 받았어요.";
  } catch (error) {
    status.textContent = "백엔드 응답을 받았지만 결과를 표시하지 못했어요.";
    console.error("[우왕톤] 스캔 결과 표시 오류", error);
  }
}

showBusinessInfo();