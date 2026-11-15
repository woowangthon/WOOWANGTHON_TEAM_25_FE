// Site observations are DOM facts, not a live model or public-API test.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const origin = 'https://site-checks.example.test';
const currentURL = `${origin}/home`;
const frozenTime = '2026-11-15T03:00:00+09:00';
const notices = dates => `<section id="notice"><h2>공지사항</h2><table><thead><tr><th>제목</th><th>작성일</th></tr></thead><tbody>${dates.map((value,index) => `<tr${index===0?' class="pinned"':''}><td><a href="#post-${index}">서비스 안내 ${index+1}</a></td><td class="td_datetime"><time datetime="${value}">${value}</time></td></tr>`).join('')}</tbody></table></section>`;
const reviews = '<section id="reviews"><h2>구매후기</h2><ul class="review-list"><li class="review-item"><a href="#review">배송 후기</a></li></ul></section>';

async function observe(browser, html, { policies = {}, url = currentURL } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const fetched = [];
  await page.clock.install({ time: new Date(frozenTime) });
  await context.route('**/*', async route => {
    const target=route.request().url();
    if (route.request().isNavigationRequest() && target===url) {
      await route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><html lang="ko"><body><h1>합성 쇼핑몰 안내</h1>${html}</body></html>`}); return;
    }
    fetched.push({url:target,method:route.request().method()});
    const policy=policies[target];
    if (policy!==undefined) {
      await route.fulfill({contentType:'text/html; charset=utf-8',headers:{'Access-Control-Allow-Origin':'*'},...(typeof policy==='string'?{body:policy}:policy)}); return;
    }
    await route.fulfill({status:404,body:''});
  });
  await page.goto(url);
  const popupSource=await fs.readFile(path.join(root,'popup.js'),'utf8');
  await page.addScriptTag({content:popupSource.slice(0,popupSource.indexOf('\nconst advancePaymentState ='))});
  await page.addScriptTag({content:await fs.readFile(path.join(root,'flow.js'),'utf8')});
  await page.addScriptTag({content:await fs.readFile(path.join(root,'site-checks.js'),'utf8')});
  const result=await page.evaluate(()=>extractBusinessInfo());
  const prepared=await page.evaluate(async ({url,result})=>window.WoowangSiteChecks.prepare({url,result}),{url,result});
  const checks=prepared.site_checks || prepared;
  return {context,page,result,checks,fetched};
}

for (const [name,html,expected] of [
  ['출금 버튼','<button>출금 신청</button>','present'],
  ['충전 링크','<a href="/login">충전신청</a>','present'],
  ['두 메뉴','<button>출금신청</button><button>충전 신청</button>','present'],
  ['본문 단어','<p>출금 신청과 충전 신청에 관한 본문 설명입니다.</p>','absent'],
  ['숨김 버튼','<button hidden>출금신청</button>','absent'],
  ['투명한 조상','<div style="opacity:0"><button>충전신청</button></div>','absent'],
  ['화면 밖 메뉴','<button style="position:absolute;left:-9999px">출금신청</button>','absent'],
  ['정산만 있음','<button>정산</button>','absent']
]) test(`사이트 관찰: ${name} 메뉴 사실 ${expected}`,async({browser})=>{
  const app=await observe(browser,html+notices(['2026-11-15','2026-11-14'])+reviews);
  try {
    expect(app.checks.payment_menus.status).toBe(expected);
    expect(app.checks.payment_menus.scope).toBe('current_page');
    if(expected==='present')expect(app.checks.payment_menus.evidence.replace(/\s/g,'')).toMatch(/출금신청|충전신청/);
  }finally{await app.context.close();}
});

test('사이트 관찰: 의미 있는 공개 화면에 공지·구매후기 영역이 없으면 공개 범위의 missing',async({browser})=>{
  const app=await observe(browser,'<p>상품 안내와 배송 정보를 제공하는 합성 상점입니다.</p>');
  try {
    expect(app.checks.notices).toMatchObject({status:'missing',scope:'current_page',source_url:currentURL});
    expect(app.checks.reviews).toMatchObject({status:'missing',scope:'current_page',source_url:currentURL});
    expect(app.fetched).toEqual([]);
  }finally{await app.context.close();}
});

test('사이트 관찰: 공지·후기의 명시적인 0건은 empty',async({browser})=>{
  const app=await observe(browser,'<section id="notice"><h2>공지사항</h2><p>등록된 공지사항이 없습니다.</p></section><section id="reviews"><h2>구매후기</h2><p>구매후기 0건</p></section>');
  try {
    expect(app.checks.notices.status).toBe('empty');
    expect(app.checks.reviews.status).toBe('empty');
  }finally{await app.context.close();}
});

test('사이트 관찰: 공지 날짜와 실제 구매후기 게시물만 수집',async({browser})=>{
  const app=await observe(browser,notices(['2026-11-15','2026-10-01'])+reviews);
  try {
    expect(app.checks.notices.status).toBe('present');
    expect(app.checks.notices.dates).toEqual(expect.arrayContaining(['2026-11-15','2026-10-01']));
    expect(app.checks.notices.latest_date_confirmed).toBe(true);
    for(const stamp of app.checks.notices.dates)expect(app.checks.notices.evidence).toContain(stamp);
    expect(app.checks.reviews.status).toBe('present');
  }finally{await app.context.close();}
});

test('사이트 관찰: 오래된 고정 공지 하나만으로 최신 공지 날짜를 확정하지 않음',async({browser})=>{
  const app=await observe(browser,notices(['2026-08-01'])+reviews);
  try {
    expect(app.checks.notices.status).toBe('present');
    expect(app.checks.notices.latest_date_confirmed).toBe(false);
  }finally{await app.context.close();}
});

test('사이트 관찰: 공지 날짜가 없으면 미확인이고 푸터 날짜를 가져오지 않음',async({browser})=>{
  const app=await observe(browser,'<section id="notice"><h2>공지사항</h2><table><tbody><tr><td><a href="#notice">공지 제목</a></td></tr></tbody></table></section>'+reviews+'<footer>최종 갱신일 2026-11-15</footer>');
  try {
    expect(app.checks.notices.status).not.toBe('missing');
    expect(app.checks.notices.dates || []).toEqual([]);
    expect(app.checks.notices.latest_date_confirmed).toBe(false);
    expect(app.checks.notices.evidence).not.toContain('2026-11-15');
  }finally{await app.context.close();}
});

test('사이트 관찰: 후기 보상 홍보 문구만으로 구매후기 존재를 판정하지 않음',async({browser})=>{
  const app=await observe(browser,notices(['2026-11-15','2026-11-14'])+'<section id="reviews"><h2>구매후기</h2><p>리뷰를 작성하면 보상 포인트를 지급합니다.</p></section>');
  try{expect(app.checks.reviews.status).toBe('unverified');}finally{await app.context.close();}
});

for(const [name,policy] of [
  ['로그인 안내','<html><body>로그인이 필요합니다. 로그인 후 확인하세요.</body></html>'],
  ['HTTP 오류',{status:503,body:'서비스 점검 중'}]
]) test(`사이트 관찰: ${name}로 게시판을 읽지 못해도 메인 출금 메뉴는 유지`,async({browser})=>{
  const target=`${origin}/board-notices`;
  const app=await observe(browser,`<button>출금 신청</button><a href="${target}">공지사항</a>`+reviews,{policies:{[target]:policy}});
  try {
    expect(app.checks.payment_menus.status).toBe('present');
    expect(app.checks.notices.status).toBe('unverified');
    expect(app.checks.reviews.status).toBe('present');
    expect(app.fetched).toEqual([{url:target,method:'GET'}]);
  }finally{await app.context.close();}
});

test('사이트 관찰: 공지·후기 각각 공개 페이지 하나만 읽고 외부·로그인·행동 링크는 읽지 않음',async({browser})=>{
  const notice=`${origin}/board-notices`,review=`${origin}/board-reviews`;
  const app=await observe(browser,`<a href="${notice}">공지사항</a><a href="${notice}?page=2">공지사항</a><a href="${review}">구매후기</a><a href="https://outside.example.test/review">상품리뷰</a><a hidden href="/hidden">공지사항</a>`,{policies:{[notice]:`<html><body>${notices(['2026-11-15','2026-11-14'])}</body></html>`,[review]:`<html><body>${reviews}</body></html>`}});
  try {
    expect(app.fetched.map(item=>item.url).sort()).toEqual([notice,review].sort());
    expect(app.fetched.every(item=>item.method==='GET')).toBe(true);
    expect(app.checks.notices.status).toBe('present');
    expect(app.checks.notices.scope).toBe('linked_board');
    expect(app.checks.reviews.status).toBe('present');
  }finally{await app.context.close();}
});

test('사이트 관찰: 계좌·전화번호·입력값·숨김 날짜는 요청 사실에 포함하지 않음',async({browser})=>{
  const app=await observe(browser,notices(['2026-11-15','2026-11-14'])+reviews+'<section><p>계좌번호 123-456-789012 전화번호 010-1234-5678</p><input value="PRIVATE_INPUT_VALUE"><textarea>PRIVATE_TEXTAREA</textarea><p hidden>2026-09-01 공지사항</p></section>');
  try {
    const serialized=JSON.stringify(app.checks);
    expect(serialized).not.toMatch(/123-456-789012|010-1234-5678|PRIVATE_INPUT_VALUE|PRIVATE_TEXTAREA|2026-09-01/);
    expect(app.checks.notices.evidence).toContain('2026-11-15');
  }finally{await app.context.close();}
});

test('사이트 관찰: 로그인 차단 화면의 빈 게시판 자리표시는 없음으로 가점하지 않음',async({browser})=>{
  const app=await observe(browser,'<button>출금 신청</button><p>로그인이 필요합니다. 로그인 후 게시판을 확인하세요.</p><section id="notice"><h2>공지사항</h2><p>등록된 게시물이 없습니다.</p></section><section id="reviews"><h2>구매후기</h2><p>구매후기 0건</p></section>');
  try {
    expect(app.checks.payment_menus.status).toBe('present');
    expect(app.checks.notices.status).toBe('unverified');
    expect(app.checks.reviews.status).toBe('unverified');
  }finally{await app.context.close();}
});

for(const linked of [false,true])test(`사이트 관찰: ${linked?'공개 연결':'현재'} 공지의 수정일을 작성일로 사용하지 않음`,async({browser})=>{
  const board='<section id="notice"><h2>공지사항</h2><table><thead><tr><th>제목</th><th>작성일</th><th>수정일</th></tr></thead><tbody><tr><td><a href="#post">서비스 공지</a></td><td><time>2026-08-01</time></td><td><time>2026-11-15</time></td></tr></tbody></table></section>';
  const target=`${origin}/board-notices`;
  const app=await observe(browser,(linked?`<a href="${target}">공지사항</a>`:board)+reviews,{policies:linked?{[target]:`<html><body>${board}</body></html>`}:{}});
  try {
    expect(app.checks.notices.status).toBe('present');
    expect(app.checks.notices.dates).toEqual(['2026-08-01']);
    expect(app.checks.notices.latest_date_confirmed).toBe(true);
  }finally{await app.context.close();}
});

test('사이트 관찰: 공개 공지에 수정일 열만 있으면 오래된 작성일로 가점하지 않음',async({browser})=>{
  const target=`${origin}/board-notices`;
  const board='<section id="notice"><h2>공지사항</h2><table><thead><tr><th>제목</th><th>수정일</th></tr></thead><tbody><tr><td><a href="#post">서비스 공지</a></td><td class="td_datetime"><time>2026-08-01</time></td></tr></tbody></table></section>';
  const app=await observe(browser,`<a href="${target}">공지사항</a>`+reviews,{policies:{[target]:`<html><body>${board}</body></html>`}});
  try {
    expect(app.checks.notices.status).not.toBe('missing');
    expect(app.checks.notices.dates || []).toEqual([]);
    expect(app.checks.notices.latest_date_confirmed).toBe(false);
  }finally{await app.context.close();}
});
