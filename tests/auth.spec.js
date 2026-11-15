// Authentication invariants with synthetic credentials and intercepted HTTP only.
const {test,expect}=require('@playwright/test');
const fs=require('node:fs/promises');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const KEY='woowang.auth.session.v1';
const TOKEN='synthetic-user-access-token-2468';
const USER={id:25,username:'synthetic-user'};
const API='http://127.0.0.1:8000';
const PRODUCTION_API='https://yeong.dev/woowang';
function session(overrides={}) {return {token:TOKEN,user:USER,apiOrigin:API,
  expires_at:new Date(Date.now()+30*60*1000).toISOString(),...overrides};}
async function harness(browser,{stored=null,response}={}) {
 const context=await browser.newContext();
 const data=stored?{[KEY]:structuredClone(stored)}:{};
 const calls=[],storageCalls=[];
 const page=await context.newPage();
 await page.exposeFunction('__store',async(op,arg)=>{
  storageCalls.push({op,arg:structuredClone(arg)});
  if(op==='get')return Object.hasOwn(data,arg)?{[arg]:structuredClone(data[arg])}:{};
  if(op==='set'){Object.assign(data,arg);return;}
  if(op==='remove'){for(const key of [].concat(arg))delete data[key];return;}
 });
 await page.addInitScript(()=>{window.chrome={storage:{session:{
  get:arg=>window.__store('get',arg),set:arg=>window.__store('set',arg),
  remove:arg=>window.__store('remove',arg),
  setAccessLevel:async arg=>{window.__accessLevel=arg.accessLevel;}
 },local:{set(){throw Error('Token must not be persisted locally');}},sync:{set(){throw Error('Token must not be synced');}}}};});
 await context.route('**/*',async route=>{
  const request=route.request(),url=request.url();
  if(url==='http://auth-unit.test/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body>Auth test</body></html>'});
  if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET, POST'}});
  const call={url,method:request.method(),headers:request.headers(),body:request.postDataJSON()};
  calls.push(call);
  const selected=response?await response(call,route):null;
  if(selected===false)return;
  const pathname=new URL(url).pathname;
  const body=selected?.body??(pathname.endsWith('/login/')?session():pathname.endsWith('/me/')?{user:USER}:pathname.endsWith('/demo/')?{enabled:false}:{ok:true});
  return route.fulfill({status:selected?.status??200,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*','Access-Control-Expose-Headers':'Retry-After',...(selected?.headers??{})},body:JSON.stringify(body)});
 });
 await page.goto('http://auth-unit.test/');
 await page.addScriptTag({content:await fs.readFile(path.join(root,'auth.js'),'utf8')});
 return {context,page,data,calls,storageCalls};
}
async function login(page,apiOrigin=API){return page.evaluate(apiOrigin=>WoowangAuth.login({username:'synthetic-user',password:'Synthetic-password-only-2468!',apiOrigin}),apiOrigin);}
async function failure(page,operation){return page.evaluate(async operation=>{
 try {if(operation==='ready')await WoowangAuth.ready();else if(operation==='logout')await WoowangAuth.logout();else await WoowangAuth.fetch('scan/',{method:'POST',body:'{}'});return {unexpected:true};}
 catch(e){return {status:e.status,code:e.code,retryAfterSeconds:e.retryAfterSeconds,message:WoowangAuth.errorMessage(e)};}
},operation);}

test('인증: 로그인 토큰은 신뢰된 세션에만 저장하고 스캔에 Bearer로 전송',async({browser})=>{
 const app=await harness(browser);
 try{
  await login(app.page);
  expect(app.data[KEY].token).toBe(TOKEN);
  expect(JSON.stringify(app.data)).not.toContain('Synthetic-password-only');
  expect(await app.page.evaluate(()=>window.__accessLevel)).toBe('TRUSTED_CONTEXTS');
  await app.page.evaluate(()=>WoowangAuth.fetch('scan/',{method:'POST',headers:{Authorization:'Bearer caller-injected'},body:'{}'}));
  expect(app.calls.map(call=>new URL(call.url).pathname)).toEqual(['/api/v1/auth/login/','/api/v1/scan/']);
  expect(app.calls[0].headers.authorization).toBeUndefined();
  expect(app.calls[1].headers.authorization).toBe(`Bearer ${TOKEN}`);
  expect(app.calls[1].body).toEqual({});
  expect(await app.page.evaluate(()=>localStorage.length)).toBe(0);
 }finally{await app.context.close();}
});

test('인증: 세션이 없으면 스캔을 전송하지 않음',async({browser})=>{
 const app=await harness(browser);
 try{expect(await failure(app.page,'scan')).toMatchObject({status:401,code:'AUTH_REQUIRED'});expect(app.calls).toEqual([]);}
 finally{await app.context.close();}
});

test('인증: 만료된 세션은 삭제하고 인증 요청도 전송하지 않음',async({browser})=>{
 const app=await harness(browser,{stored:session({expires_at:new Date(Date.now()-1000).toISOString()})});
 try{expect(await app.page.evaluate(()=>WoowangAuth.ready())).toBeNull();expect(app.data[KEY]).toBeUndefined();expect(app.calls).toEqual([]);}
 finally{await app.context.close();}
});

for(const status of [401,403])test(`인증: 서버${status}이면 세션을 삭제하고 자동 재요청하지 않음`,async({browser})=>{
 const app=await harness(browser,{stored:session(),response:()=>({status})});
 try{expect(await failure(app.page,'scan')).toMatchObject({status});expect(app.data[KEY]).toBeUndefined();expect(app.calls).toHaveLength(1);}
 finally{await app.context.close();}
});

test('인증: 429의 Retry-After를 보존하고 토큰·요청 횟수를 유지',async({browser})=>{
 const app=await harness(browser,{stored:session(),response:()=>({status:429,headers:{'Retry-After':'12'}})});
 try{expect(await failure(app.page,'scan')).toMatchObject({status:429,code:'RATE_LIMITED',retryAfterSeconds:12});expect(app.data[KEY].token).toBe(TOKEN);expect(app.calls).toHaveLength(1);}
 finally{await app.context.close();}
});

test('인증: 보안 저장소 장애503을 재시도 없이 표시',async({browser})=>{
 const app=await harness(browser,{stored:session(),response:()=>({status:503})});
 try{expect(await failure(app.page,'scan')).toMatchObject({status:503,code:'SECURITY_UNAVAILABLE'});expect(app.data[KEY].token).toBe(TOKEN);expect(app.calls).toHaveLength(1);}
 finally{await app.context.close();}
});

test('인증: 로그아웃 서버 실패에도 로컬 토큰을 삭제',async({browser})=>{
 const app=await harness(browser,{stored:session(),response:()=>({status:503})});
 try{expect(await failure(app.page,'logout')).toMatchObject({status:503});expect(app.data[KEY]).toBeUndefined();expect(app.calls[0].url).toBe(API+'/api/v1/auth/logout/');expect(app.calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);}
 finally{await app.context.close();}
});

test('인증: 임의 서버에는 비밀번호를 전송하지 않음',async({browser})=>{
 const app=await harness(browser);
 try{const result=await app.page.evaluate(async()=>{try{await WoowangAuth.login({username:'fixture',password:'fixture-only',apiOrigin:'https://untrusted.example.test'});return 'unexpected';}catch(e){return e.code;}});expect(result).toBe('INVALID_SERVER');expect(app.calls).toEqual([]);}
 finally{await app.context.close();}
});

test('인증: 로그인 리디렉션을 따라가 다른 출처로 자격증명을 보내지 않음',async({browser})=>{
 const app=await harness(browser,{response:call=>call.url.endsWith('/login/')?{status:302,headers:{Location:'https://untrusted.example.test/capture'}}:null});
 try{const result=await app.page.evaluate(async()=>{try{await WoowangAuth.login({username:'fixture',password:'fixture-only',apiOrigin:'http://127.0.0.1:8000'});return 'unexpected';}catch(e){return e.code;}});expect(result).toBe('CONNECTION_FAILED');expect(app.calls).toHaveLength(1);expect(app.data[KEY]).toBeUndefined();}
 finally{await app.context.close();}
});

test('인증: 다른 사용자 응답을 현재 사용자 세션으로 받아들이지 않음',async({browser})=>{
 const app=await harness(browser,{stored:session(),response:()=>({body:{user:{id:99,username:'someone-else'}}})});
 try{expect(await failure(app.page,'ready')).toMatchObject({code:'INVALID_RESPONSE'});expect(app.data[KEY]).toBeUndefined();}
 finally{await app.context.close();}
});

test('인증: 다른 팝업이 바꾼 계정으로 이전에 준비한 문구를 전송하지 않음',async({browser})=>{
 const first=session(),app=await harness(browser,{stored:first});
 try{
  app.data[KEY]=session({token:'synthetic-second-user-access-token',user:{id:26,username:'second-user'}});
  const result=await app.page.evaluate(async first=>{try{await WoowangAuth.fetch('scan/',{method:'POST',body:'{}'},first);return 'unexpected';}catch(e){return e.code;}},first);
  expect(result).toBe('AUTH_CHANGED');expect(app.calls).toEqual([]);expect(app.data[KEY].user.id).toBe(26);
 }finally{await app.context.close();}
});

test('인증: 이전 요청의 늦은401이 새 사용자 토큰을 삭제하지 않음',async({browser})=>{
 let release,started;
 const ready=new Promise(resolve=>{started=resolve;});
 const app=await harness(browser,{stored:session(),response:async()=>{started();await new Promise(resolve=>{release=resolve;});return{status:401};}});
 try{
  const pending=failure(app.page,'scan');await ready;
  app.data[KEY]=session({token:'synthetic-second-user-access-token',user:{id:26,username:'second-user'}});
  release();expect(await pending).toMatchObject({status:401});expect(app.data[KEY].user.id).toBe(26);
 }finally{await app.context.close();}
});

async function popupHarness(browser,{stored=null,loginStatus=200,scanStatus=200,scanPending=false,policyPending=false,meStatus=200,logoutPending=false,apiBase=API}={}) {
 const context=await browser.newContext(),page=await context.newPage(),source=await context.newPage();
 const data=stored?{[KEY]:structuredClone(stored)}:{},calls=[],scanRoutes=[],policyRoutes=[],logoutRoutes=[];
 let extractions=0,meCalls=0;
 const shop='https://synthetic-shop.test/';
 const guidance='세금 납부가 확인되면 수익금을 받을 수 있습니다.';
 await page.exposeFunction('__store',async(op,arg)=>{
  if(op==='get') {const keys=arg==null?Object.keys(data):typeof arg==='string'?[arg]:Array.isArray(arg)?arg:Object.keys(arg);return Object.fromEntries(keys.filter(key=>key in data).map(key=>[key,structuredClone(data[key]) ]));}
  if(op==='set'){Object.assign(data,arg);return;}
  if(op==='remove'){for(const key of [].concat(arg))delete data[key];}
 });
 await page.exposeFunction('__extract',async functionSource=>{extractions++;return{result:await source.evaluate(`(${functionSource})()`) };});
 await page.addInitScript(shop=>{
  window.__authFormTrace=[];
  document.addEventListener('submit',event=>window.__authFormTrace.push({event:'submit',form:event.target.id}),true);
  document.addEventListener('invalid',event=>window.__authFormTrace.push({event:'invalid',field:event.target.id}),true);
  document.addEventListener('click',event=>{if(event.target.id==='loginButton')window.__authFormTrace.push({event:'login-click',usernameLength:document.querySelector('#authUsername').value.length,passwordLength:document.querySelector('#authPassword').value.length});},true);
  window.chrome={
  tabs:{query:async()=>[{id:25,url:shop}]},scripting:{executeScript:async options=>[await window.__extract(options.func.toString())]},
  storage:{onChanged:{addListener:listener=>{window.__storageListeners??=[];window.__storageListeners.push(listener);}},session:{get:arg=>window.__store('get',arg),set:arg=>window.__store('set',arg),remove:arg=>window.__store('remove',arg),setAccessLevel:async()=>{}},local:{set(){throw Error('No persistent tokens');}}}
 };},shop);
 await context.route('**/*',async route=>{
  const request=route.request(),url=request.url(),pathname=new URL(url).pathname;
  if(url.startsWith('http://auth-popup.test/')) {
   const name=pathname.slice(1);
   if(['popup.html','popup.js','auth.js','flow.js','site-checks.js'].includes(name))return route.fulfill({contentType:name.endsWith('.js')?'application/javascript':'text/html; charset=utf-8',body:await fs.readFile(path.join(root,name),'utf8')});
   return route.fulfill({status:404,body:''});
  }
  if(url===shop)return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><html><body><button>출금 신청</button>${policyPending?'<a href="/withdraw-policy">출금 안내</a>':''}<footer>상호: 모의상점 | 대표자: 홍길동<br>사업자등록번호: 123-45-67890</footer></body></html>`});
  const headers={'Access-Control-Allow-Origin':'*','Access-Control-Expose-Headers':'Retry-After'};
  if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:{...headers,'Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET, POST'}});
  if(url===shop+'withdraw-policy'&&policyPending){policyRoutes.push(route);return;}
  if([API,PRODUCTION_API].some(base=>url===base+'/api/v1/auth/demo/')){
   const call={url,method:request.method(),headers:request.headers(),body:request.postDataJSON()};
   calls.push(call);
   expect(call.method).toBe('GET');expect(call.headers.authorization).toBeUndefined();expect(call.body).toBeNull();
   return route.fulfill({status:200,headers,contentType:'application/json',body:JSON.stringify({enabled:false})});
  }
  if(url.startsWith(apiBase+'/api/v1/')){
   calls.push({url,method:request.method(),headers:request.headers(),body:request.postDataJSON()});
   if(pathname.endsWith('/scan/')&&scanPending){scanRoutes.push(route);return;}
   if(pathname.endsWith('/logout/')&&logoutPending){logoutRoutes.push(route);return;}
   if(pathname.endsWith('/me/'))meCalls++;
   const status=pathname.endsWith('/login/')?loginStatus:pathname.endsWith('/scan/')?scanStatus:pathname.endsWith('/me/')?(typeof meStatus==='function'?meStatus(meCalls):meStatus):200;
   const body=pathname.endsWith('/login/')?session({apiOrigin:apiBase}):pathname.endsWith('/me/')?{user:USER}:pathname.endsWith('/scan/')?{analyses:{nts:{status:'completed',business_status_description:'계속사업자'},ftc:{status:'not_configured'},ai:{status:'skipped',signals:[]}},risk_score:0,risk_factors:[],verdict:'LOW_RISK'}:{};
   return route.fulfill({status,headers:{...headers,'Retry-After':'2'},contentType:'application/json',body:JSON.stringify(body)});
  }
  return route.fulfill({status:404,headers,body:''});
 });
 await source.goto(shop);await page.goto('http://auth-popup.test/popup.html');
 return{context,page,data,calls,scanRoutes,policyRoutes,logoutRoutes,guidance,extractions:()=>extractions};
}
async function popupLogin(page,apiBase=API){await page.locator('#authServer').selectOption(apiBase);await page.locator('#authUsername').fill(USER.username);await page.locator('#authPassword').fill('Synthetic-password-only-2468!');await page.locator('#loginButton').click();}
const scanCalls=app=>app.calls.filter(call=>call.url.endsWith('/scan/'));

test('팝업 인증: 로그인 전에는 화면을 읽지 않고 성공 후 Bearer 검사, 로그아웃시 기록 삭제',async({browser})=>{
 const app=await popupHarness(browser);
 try{
  await expect.poll(()=>app.calls.map(call=>({url:call.url,method:call.method}))).toEqual([{url:PRODUCTION_API+'/api/v1/auth/demo/',method:'GET'}]);await expect(app.page.locator('#authCredentials')).toBeVisible();expect(app.extractions()).toBe(0);
  await popupLogin(app.page);
  try { await expect(app.page.locator('#status')).toHaveText('백엔드 응답을 받았어요.'); }
  catch(error) {
   const state=await app.page.evaluate(()=>({
    authGeneration,activeScanGeneration,loginBusy,initializing:Boolean(popupInitialization),
    status:document.querySelector('#status').textContent,
    authMessage:document.querySelector('#authMessage').textContent,
    credentialsHidden:document.querySelector('#authCredentials').hidden,
    passwordLength:document.querySelector('#authPassword').value.length,
    usernamePresent:Boolean(document.querySelector('#authUsername').value),
    selectedServer:document.querySelector('#authServer').value,formTrace:window.__authFormTrace
   }));
   console.log('Synthetic auth race diagnostics',JSON.stringify({calls:app.calls.map(({url,method})=>({url,method})),extractions:app.extractions(),hasSession:Boolean(app.data[KEY]),state}));
   throw error;
  }
  expect(app.extractions()).toBe(1);expect(scanCalls(app)).toHaveLength(1);expect(scanCalls(app)[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  await expect(app.page.locator('#authPassword')).toHaveValue('');
  await app.page.getByRole('button',{name:'먼저 보내라고 했어요',exact:true}).click();
  await expect.poll(()=>JSON.stringify(app.data['woowang.paymentFlow.v1'])).toContain('"answer":"yes"');
  expect(JSON.stringify(app.data['woowang.paymentFlow.v1'])).not.toContain(TOKEN);
  expect(await app.page.evaluate(()=>localStorage.length)).toBe(0);
  await app.page.locator('#logoutButton').click();await expect(app.page.locator('#authPanel')).toBeVisible();
  expect(app.data[KEY]).toBeUndefined();expect(app.data['woowang.paymentFlow.v1']).toBeUndefined();await expect(app.page.locator('#scanContent')).toBeHidden();
 }finally{await app.context.close();}
});

test('팝업 인증: 잘못된 로그인은 비밀번호를 비우고 화면검사를 시작하지 않음',async({browser})=>{
 const app=await popupHarness(browser,{loginStatus:401});
 try{await popupLogin(app.page);await expect(app.page.locator('#authMessage')).toContainText('아이디와 비밀번호');await expect(app.page.locator('#authPassword')).toHaveValue('');expect(app.extractions()).toBe(0);expect(scanCalls(app)).toEqual([]);expect(app.data[KEY]).toBeUndefined();}
 finally{await app.context.close();}
});

test('팝업 인증: 사용자가 선입금이라고 답한 뒤 스캔401이어도 경고 유지',async({browser})=>{
 const app=await popupHarness(browser,{stored:session(),scanPending:true});
 try{
  await expect.poll(()=>app.scanRoutes.length).toBe(1);await app.page.getByRole('button',{name:'먼저 보내라고 했어요',exact:true}).click();
  await app.scanRoutes[0].fulfill({status:401,headers:{'Access-Control-Allow-Origin':'*'},contentType:'application/json',body:'{}'});
  await expect(app.page.locator('#authPanel')).toBeVisible();await expect(app.page.locator('#advancePaymentWarning')).toBeVisible();await expect(app.page.locator('#advancePaymentFeedback')).toContainText('입금하지 마세요');
  expect(app.data[KEY]).toBeUndefined();expect(scanCalls(app)).toHaveLength(1);
 }finally{await app.context.close();}
});

test('팝업 인증:429 대기중 경고를 유지하고 타이머가 자동으로 재전송하지 않음',async({browser})=>{
 const app=await popupHarness(browser,{stored:session(),scanPending:true});
 try{
  await expect.poll(()=>app.scanRoutes.length).toBe(1);await app.page.getByRole('button',{name:'먼저 보내라고 했어요',exact:true}).click();
  await app.scanRoutes[0].fulfill({status:429,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Expose-Headers':'Retry-After','Retry-After':'2'},contentType:'application/json',body:'{}'});
  await expect(app.page.locator('#retryScanButton')).toBeVisible();await expect(app.page.locator('#retryScanButton')).toBeDisabled();await expect(app.page.locator('#advancePaymentWarning')).toBeVisible();
  await expect(app.page.locator('#retryScanButton')).toBeEnabled({timeout:5000});expect(scanCalls(app)).toHaveLength(1);expect(app.data[KEY].token).toBe(TOKEN);
 }finally{await app.context.close();}
});

test('팝업 인증: 공개안내를 읽는 중 계정전환해도 이전 문구가 새 계정으로 전송·저장되지 않음',async({browser})=>{
 const app=await popupHarness(browser,{stored:session(),policyPending:true});
 try{
  await expect.poll(()=>app.policyRoutes.length).toBe(1);
  app.data[KEY]=session({token:'synthetic-second-user-access-token',user:{id:26,username:'second-user'}});
  await app.page.evaluate(()=>WoowangFlow.clearAll());
  await app.policyRoutes[0].fulfill({headers:{'Access-Control-Allow-Origin':'*'},contentType:'text/html; charset=utf-8',body:`<p>${app.guidance}</p>`});
  await expect(app.page.locator('#authPanel')).toBeVisible();expect(scanCalls(app)).toEqual([]);expect(app.data[KEY].user.id).toBe(26);expect(app.data['woowang.paymentFlow.v1']).toBeUndefined();
  await expect(app.page.locator('#advancePaymentEvidence')).not.toContainText(app.guidance);
 }finally{await app.context.close();}
});

test('인증: 운영 서버의 로그인·확인·검사·로그아웃 모두 HTTPS 경로 접두사 유지',async({browser})=>{
 const app=await harness(browser);
 try{
  const result=await app.page.evaluate(async()=>{try{await WoowangAuth.login({username:'fixture',password:'fixture-only',apiOrigin:'http://yeong.dev/woowang'});return 'unexpected';}catch(e){return e.code;}});
  expect(result).toBe('INVALID_SERVER');expect(app.calls).toEqual([]);
  // Omission must use the production base, not the site origin or the local API.
  await app.page.evaluate(()=>WoowangAuth.login({username:'synthetic-user',password:'Synthetic-password-only-2468!'}));
  await app.page.evaluate(()=>WoowangAuth.ready());
  await app.page.evaluate(()=>WoowangAuth.fetch('scan/',{method:'POST',body:'{}'}));
  await app.page.evaluate(()=>WoowangAuth.logout({all:true}));
  await login(app.page,PRODUCTION_API);
  expect(app.data[KEY].apiOrigin).toBe(PRODUCTION_API);
  await app.page.evaluate(()=>WoowangAuth.logout());
  expect(app.calls.map(call=>call.url)).toEqual([
   PRODUCTION_API+'/api/v1/auth/login/',PRODUCTION_API+'/api/v1/auth/me/',
   PRODUCTION_API+'/api/v1/scan/',PRODUCTION_API+'/api/v1/auth/logout-all/',
   PRODUCTION_API+'/api/v1/auth/login/',PRODUCTION_API+'/api/v1/auth/logout/'
  ]);
  for(const call of app.calls)expect(call.headers.authorization).toBe(call.url.endsWith('/login/')?undefined:`Bearer ${TOKEN}`);
 }finally{await app.context.close();}
});

test('인증: 다른 출처·누락되거나 비슷한 경로 접두사·상대 주소에는 자격증명 전송 금지',async({browser})=>{
 const app=await harness(browser);
 try{
  const bases=[
   'https://yeong.dev','https://yeong.dev/woowang/','https://yeong.dev/woowang-extra',
   'https://yeong.dev/woowang/other','https://yeong.dev/woowang/../',
   'https://yeong.dev//woowang','https://other.example.test/woowang',
   '//yeong.dev/woowang','/woowang','https://yeong.dev@other.example.test/woowang',
   'https://yeong.dev/woowang?next=elsewhere','https://yeong.dev/woowang#fragment',
   'https://woowang-api.yeong.dev'
  ];
  const results=await app.page.evaluate(async bases=>Promise.all(bases.map(async apiOrigin=>{
   try{await WoowangAuth.login({username:'fixture',password:'fixture-only',apiOrigin});return 'unexpected';}
   catch(error){return error.code;}
  })),bases);
  expect(results).toEqual(bases.map(()=> 'INVALID_SERVER'));
  expect(app.calls).toEqual([]);expect(app.data[KEY]).toBeUndefined();
 }finally{await app.context.close();}
});

test('인증: 알 수 없는 API 경로·절대 주소·상위 경로는 Bearer 전송 전에 거부',async({browser})=>{
 const app=await harness(browser,{stored:session({apiOrigin:PRODUCTION_API})});
 try{
  const paths=['auth/password/','/scan/','../scan/','/../api/v1/scan/',
   '//other.example.test/scan/','https://other.example.test/scan/',
   'scan/?redirect=elsewhere','scan/#fragment','auth/login/../scan/'];
  const results=await app.page.evaluate(async paths=>Promise.all(paths.map(async path=>{
   try{await WoowangAuth.fetch(path,{method:'POST',body:'{}'});return 'unexpected';}
   catch(error){return error.code;}
  })),paths);
  expect(results).toEqual(paths.map(()=> 'INVALID_ENDPOINT'));
  expect(app.calls).toEqual([]);expect(app.data[KEY].token).toBe(TOKEN);
 }finally{await app.context.close();}
});

test('인증: 저장된 서버 주소도 승인된 전체 경로와 정확히 일치해야 함',async({browser})=>{
 const app=await harness(browser,{stored:session({apiOrigin:'https://yeong.dev/woowang-extra'})});
 try{
  expect(await failure(app.page,'scan')).toMatchObject({status:401,code:'AUTH_REQUIRED'});
  expect(app.calls).toEqual([]);expect(app.data[KEY]).toBeUndefined();
 }finally{await app.context.close();}
});

test('팝업 인증: 기본 운영 서버로 로그인하면 yeong.dev/woowang 아래에서만 검사',async({browser})=>{
 const app=await popupHarness(browser,{apiBase:PRODUCTION_API});
 try{
  await expect(app.page.locator('#authServer')).toHaveValue(PRODUCTION_API);
  expect(app.extractions()).toBe(0);
  await popupLogin(app.page,PRODUCTION_API);
  await expect(app.page.locator('#status')).toHaveText('백엔드 응답을 받았어요.');
  expect(app.calls.filter(call=>!call.url.endsWith('/demo/')).map(call=>call.url)).toEqual([
   PRODUCTION_API+'/api/v1/auth/login/',PRODUCTION_API+'/api/v1/scan/'
  ]);
  expect(app.calls.filter(call=>call.url.endsWith('/demo/')).every(call=>call.url===PRODUCTION_API+'/api/v1/auth/demo/')).toBe(true);
  expect(app.data[KEY].apiOrigin).toBe(PRODUCTION_API);
  expect(scanCalls(app)[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
 }finally{await app.context.close();}
});

for(const status of [401,503])test(`팝업 인증: 수동 선입금 경고를 재검사 중 GETme${status} 실패 후에도 유지`,async({browser})=>{
 const app=await popupHarness(browser,{stored:session(),scanStatus:503,meStatus:count=>count===1?200:status});
 try{
  await expect(app.page.locator('#retryScanButton')).toBeVisible();
  await app.page.getByRole('button',{name:'먼저 보내라고 했어요',exact:true}).click();
  await app.page.locator('#retryScanButton').click();
  await expect(app.page.locator('#authPanel')).toBeVisible();await expect(app.page.locator('#advancePaymentWarning')).toBeVisible();
  await expect(app.page.locator('#advancePaymentFeedback')).toContainText('입금하지 마세요');
  expect(scanCalls(app)).toHaveLength(1);expect(app.calls.filter(call=>call.url.endsWith('/me/'))).toHaveLength(2);
  if(status===401)expect(app.data[KEY]).toBeUndefined();else expect(app.data[KEY].token).toBe(TOKEN);
 }finally{await app.context.close();}
});

test('팝업 인증: 서버 로그아웃 응답 대기 중에도 토큰·사용자·이력·화면을 즉시 삭제',async({browser})=>{
 const app=await popupHarness(browser,{stored:session(),logoutPending:true});
 try{
  await expect(app.page.locator('#status')).toHaveText('백엔드 응답을 받았어요.');
  await app.page.getByRole('button',{name:'먼저 보내라고 했어요',exact:true}).click();
  await expect.poll(()=>JSON.stringify(app.data['woowang.paymentFlow.v1'])).toContain('"answer":"yes"');
  await app.page.locator('#logoutButton').click();
  await expect.poll(()=>app.logoutRoutes.length).toBe(1);
  expect(app.data[KEY]).toBeUndefined();expect(app.data['woowang.auth.identity.v1']).toBeUndefined();expect(app.data['woowang.paymentFlow.v1']).toBeUndefined();
  await expect(app.page.locator('#scanContent')).toBeHidden();
  await expect(app.page.locator('#advancePaymentWarning')).toBeHidden();
  await app.logoutRoutes[0].fulfill({status:204,headers:{'Access-Control-Allow-Origin':'*'},body:''});
  await expect(app.page.locator('#authPanel')).toBeVisible();
 }finally{await app.context.close();}
});

test('팝업 인증: 다른 팝업의 계정 변경 이벤트는 이전 사용자 화면을 비우고 자동 검사하지 않음',async({browser})=>{
 const app=await popupHarness(browser,{stored:session()});
 try{
  await expect(app.page.locator('#status')).toHaveText('백엔드 응답을 받았어요.');
  await app.page.getByRole('button',{name:'먼저 보내라고 했어요',exact:true}).click();
  const replacement=session({token:'synthetic-second-user-access-token',user:{id:26,username:'second-user'}});
  app.data[KEY]=replacement;
  await app.page.evaluate(({key,value})=>{for(const listener of window.__storageListeners)listener({[key]:{newValue:value}},'session');},{key:KEY,value:replacement});
  await expect(app.page.locator('#authPanel')).toBeVisible();await expect(app.page.locator('#authMessage')).toContainText('계정이 바뀌었어요');
  await expect(app.page.locator('#scanContent')).toBeHidden();await expect(app.page.locator('#advancePaymentWarning')).toBeHidden();
  expect(scanCalls(app)).toHaveLength(1);expect(app.extractions()).toBe(1);expect(app.data[KEY].user.id).toBe(26);
 }finally{await app.context.close();}
});
