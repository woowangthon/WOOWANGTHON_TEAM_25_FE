const SCAN_API_URL = "http://127.0.0.1:8000/api/v1/scan/";

function extractBusinessInfo() {
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

  const representativeName =
    text.match(
      /(?:대표(?:이사|자|명)?|\bCEO\b)[ \t]*[:：=＝][ \t]*([^\n|ㅣ]+?)(?=[ \t]*(?:개인정보|(?:사업장\s*(?:주소|소재지)|주소|사업자\s*(?:등록\s*)?번호|통신판매업|전화번호|이메일|Business[ \t]+License)[ \t]*[:：=＝]|\(\d{5}\))|[\n|ㅣ]|$)/i
    )?.[1]?.trim() || footerCeo || null;

  const addressEnd =
    /[ \t]*(?:(?:사업자\s*(?:등록\s*)?번호|통신판매업(?:\s*신고(?:\s*번호)?)?|전화번호|대표번호|이메일|개인정보담당자|대표이사|대표자|상호명|상호|법인명|회사명)\s*[:：=]|\||\n)/;

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
    address
  };
}

async function requestScan(url, businessInfo) {
  const businessNumber = (businessInfo.businessNumber ?? "").replace(
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
        business_number: businessNumber,
        address: businessInfo.address
      }
    })
  });

  if (!response.ok) {
    throw new Error(`스캔 요청 실패 (HTTP ${response.status})`);
  }

  return response.json();
}

function buildScanChecks(scanResult, businessInfo) {
  const nts = scanResult.analyses?.nts;
  const ftc = scanResult.analyses?.ftc;
  const businessStatus =
    nts?.status === "completed" ? nts.business_status : null;
  const isActive = businessStatus === "ACTIVE";

  let ntsReason = "국세청 조회 결과를 확인할 수 없어요.";
  if (businessStatus) {
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

    const submittedName =
      scanResult.business_info?.representative_name
      || businessInfo.representativeName;
    const officialNames = ftc.official_info?.representative_names;

    const fieldResults = fields.map(([key, name]) => {
      const result = verification[key];

      if (result === "MATCH") return `${name} 일치`;
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
    } else if (matchCount > 0) {
      ftcCheck.label = `${matchCount}개 항목 일치`;
      if (matchCount === fields.length) {
        ftcCheck.status = "match";
      }
    }

    ftcCheck.reason = fieldResults.join("\n");
  }

  const verdict = scanResult.verdict;
  const riskScore = scanResult.risk_score;

  let verdictLabel = verdict ?? "확인 불가";
  let verdictReason = "종합 판정 결과를 확인할 수 없어요.";

  if (verdict === "LOW_RISK") {
    verdictLabel = "낮은 위험";
    verdictReason = "백엔드 검사 결과 위험도가 낮게 나왔어요.";
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
        ? `${message} (${factor.points}점)`
        : message
    ];
  });

  return [
    {
      title: "국세청 사업자 상태",
      status: isActive ? "match" : "unknown",
      label: nts?.business_status_description
        ?? (isActive ? "계속사업자" : (businessStatus ?? "확인 불가")),
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

  document.getElementById("businessNumber").textContent =
    result.businessNumber
    ?? (result.invalidBusinessNumber ? "형식 오류" : "찾지 못함");

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
    status.textContent = "백엔드에 확인 요청을 보내는 중…";
    scanResult = await requestScan(tab.url, result);
    console.log("[우왕톤] 스캔 응답", scanResult);
  } catch (error) {
    status.textContent = "백엔드 확인 요청에 실패했어요.";
    console.error("[우왕톤] 스캔 요청 오류", error);
    return;
  }

  try {
    renderCheckResults(buildScanChecks(scanResult, result));
    status.textContent = "백엔드 응답을 받았어요.";
  } catch (error) {
    status.textContent = "백엔드 응답을 받았지만 결과를 표시하지 못했어요.";
    console.error("[우왕톤] 스캔 결과 표시 오류", error);
  }
}

showBusinessInfo();