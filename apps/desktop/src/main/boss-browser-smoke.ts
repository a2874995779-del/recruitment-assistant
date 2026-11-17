import { session, WebContentsView, BrowserWindow } from "electron";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { BossBrowser } from "./boss-browser.js";
import { BOSS_READ_SCRIPT, browserJobInput } from "./boss-reader.js";
import { salaryFontFixture } from "../../../../scripts/salary-font-fixture.js";
import type { RecruitmentService } from "../../../../packages/application/src/service.js";
import { defaultSearchConfig as actualDefaultSearchConfig } from "../../../../packages/contracts/src/boss-search.js";

const defaultSearchConfig={...actualDefaultSearchConfig,skip_saved:false,skip_processed:false};
// Legacy regression scenarios explicitly rescan saved fixtures; new tests below
// exercise the production default of skipping saved jobs.
// Only called in the existing isolated desktop smoke process. All HTTPS traffic
// in this partition is served by this fixture; no BOSS servers are contacted.
export async function runBossBrowserSmoke(window: BrowserWindow, browser: BossBrowser, service: RecruitmentService, directory: string) {
  const rendererErrors:string[]=[];
  let stage='baseline';
  const consoleListener=(event:Electron.Event<Electron.WebContentsConsoleMessageEventParams>)=>{if(event.level==='error')rendererErrors.push(event.message);};
  window.webContents.on('console-message',consoleListener);
  const localExecute=window.webContents.executeJavaScript.bind(window.webContents);
  window.webContents.executeJavaScript=async(script,userGesture)=>{
    try{return await localExecute(script,userGesture);}
    catch(error){throw new Error(`UI script ${script.slice(0,350)}: ${String(error)}`);}
  };
  const fixture = `<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px sans-serif;padding:24px;background:#f3f8f7}li{list-style:none;padding:24px;background:white;margin:16px;border-radius:8px}.salary{color:#d16d38}.company-name{color:#667}.tag-list{display:flex;gap:8px}.tag-list li{margin:0;padding:4px}.hidden{display:none}</style></head><body><h1>BOSS 网页 · 离线测试页面</h1><p>这是本地测试数据，未访问 BOSS 服务。</p><ul>
    <li class="job-card-wrapper"><a class="job-card-box" href="/job_detail/ABCDEF123456.html?securityId=do-not-store"><span class="job-name"></span><span class="job-title-text">Java 开发 双休</span></a><span class="salary">140-280元/天</span><p class="company-name"></p><div class="company-info"><a href="/gongsi/fixture-a.html">离线测试企业甲</a></div><span class="job-city">武汉市</span><span class="area-district">江夏区</span><ul class="tag-list"><li>本科及以上</li><li>应届生</li></ul></li>
    <li><div class="sub-li"><a class="job-info" href="/job_detail/ZYXWVU123456.html?ka=test"><div class="sub-li-info"><p class="name">前端开发</p><p class="salary">7-12K</p><p class="job-text"><span>武汉</span><span>经验不限</span><span>大专</span></p></div></a><div class="sub-li-bottom"><a class="user-info" href="/gongsi/fixture.html"><span class="name">离线测试企业乙</span></a></div></div></li>
    <li class="job-card-wrapper hidden"><a href="/job_detail/HIDDEN123456.html"><span class="job-name">隐藏岗位</span></a><p class="company-name">不能读取</p></li>
    <li class="job-card-wrapper"><a href="/job_detail/ABCDEF123456.html"><span class="job-name">重复链接</span></a><p class="company-name">离线测试企业甲</p></li>
    <li><a href="/job_detail/UNKNOWN123456.html"><span class="job-name">无法识别的结构</span></a></li></ul></body></html>`;
  const partition = session.fromPartition("persist:boss-helper");
  const detailFixture=`<main><div class="job-banner"><div class="name"><h1>Java 开发 双休</h1></div><span class="salary">140-280元/天</span><span class="job-area">武汉市·江夏区</span><span class="job-education">本科及以上</span><span class="job-experience">应届生</span><span class="company-name">离线测试企业甲</span></div><div class="job-detail"><section class="job-sec"><h3>职位描述</h3><div class="text">岗位职责：开发 Java 服务，熟悉 SQL。<span style="display:none">销售隐藏字段</span></div></section><section class="job-sec"><h3>公司介绍</h3><div class="text">销售公司介绍不应当作为职位描述</div></section><span class="location-address">武汉市江夏区测试路</span></div></main>`;
  const secondPageFixture=fixture.replaceAll("ZYXWVU123456","APPEND123456").replace("前端开发","上海前端开发").replace("<span>武汉</span>","<span>上海</span>");
  const longListFixture=`<ul>${Array.from({length:120},(_,i)=>`<li class="job-card-wrapper"><a href="/job_detail/LONGJOB${String(i).padStart(6,'0')}.html"><span class="job-name">长列表测试岗位 ${i}</span></a><span class="company-name">虚构测试企业</span><span class="job-area">武汉</span><ul class="tag-list"><li>本科</li></ul></li>`).join('')}</ul>`;
  const salaryFont=salaryFontFixture();
  const salaryFixture=`<style>@font-face{font-family:LocalSalaryFixture;src:url(data:font/otf;base64,${salaryFont.base64})}.salary{font-family:LocalSalaryFixture,Arial}</style><li class="job-card-wrapper"><a href="/job_detail/OCRTEST123456.html"><span class="job-name">Java 薪资验收岗位</span></a><span class="salary">${salaryFont.raw}</span><p class="company-name">薪资测试虚构企业</p></li>`;
  let requests = 0,searchPageRequests=0;
  let savedRefreshChanged=false,savedRefreshBlocked=false,savedRefreshDelay=false,incrementalAdded=false;
  const responseJson=JSON.stringify({code:0,zpData:{jobInfo:{encryptId:"RESPONSE123456",jobName:"Java 详情补全岗位",salaryDesc:"12.5-18K·13薪",locationName:"武汉·江夏区",degreeName:"本科",experienceName:"应届生",postDescription:"Java SQL",address:"武汉市测试路"},brandComInfo:{brandName:"详情测试企业"}}});
  const batchFixture=`<style>.rec-job-list{height:240px;overflow-y:auto}.job-card-wrapper{height:180px}</style><ul class="rec-job-list"><li class="job-card-wrapper"><a href="/job_detail/RESPONSE123456.html"><span class="job-name">Java 详情补全岗位</span></a><span class="company-name">详情测试企业</span><span class="salary">&#xE001;K</span></li><li style="height:800px">本地滚动测试区域</li></ul><script>let count=0;document.querySelector('.rec-job-list').addEventListener('scroll',()=>{if(count>=2)return;count++;const li=document.createElement('li');li.className='job-card-wrapper';li.innerHTML='<a href="/job_detail/BATCHJOB12345'+count+'.html"><span class="job-name">Java 批量岗位 '+count+'</span></a><span class="company-name">批量测试企业</span><span class="job-area">武汉</span>';document.querySelector('.rec-job-list').append(li);});</script>`;
  const delayedSearchFixture=`<html><body>本地异步列表加载测试<script>setTimeout(()=>{document.body.innerHTML=${JSON.stringify(fixture)};history.replaceState({},'',location.href+'&ka=normal-search');},350);</script></body></html>`;
  const salarySearchFixture=`<ul>${[['SALARYMONTH123456','Java月薪岗位'],['SALARYDAY123456','Java日薪岗位']].map(([id,title])=>`<li class="job-card-wrapper"><a href="/job_detail/${id}.html"><span class="job-name">${title}</span></a><span class="company-name">薪资补全测试企业</span><span class="salary">&#xE001;-&#xE002;${id!.includes('MONTH')?'K':'元/天'}</span><ul class="tag-list"><li>薪资验证</li><li>补全验证</li></ul></li>`).join('')}</ul>`;
  const salaryDetailFixture=(daily:boolean)=>`<div class="job-banner"><div class="name"><h1>Java${daily?'日薪':'月薪'}岗位</h1></div><span class="salary">${daily?'200-220元/天':'5k-6k'}</span>${daily?'<a href="/beijing/">错误城市名</a><a href="https://example.com/wuhan/">武汉</a><a href="/wuhan/">武汉</a>':''}<div class="info-primary"><div class="text">${daily?'':'<a href="/wuhan/">武汉</a><em></em>'}经验不限<em></em>本科</div></div><span class="company-name">薪资补全测试企业</span></div><a href="/shanghai/">上海</a>`;
  const guardedSalaryList=(id:string)=>`<li class="job-card-wrapper"><a href="/job_detail/${id}.html"><span class="job-name">Java月薪岗位</span></a><span class="company-name">薪资补全测试企业</span><span class="salary">&#xE001;-&#xE002;K</span></li>`;
  const breadthCards=(start:number,count:number)=>Array.from({length:count},(_,i)=>`<li class="job-card-wrapper"><a href="/job_detail/BREADTHJOB${String(start+i).padStart(8,'0')}.html"><span class="job-name">Java广度验证岗位 ${start+i}</span></a><span class="company-name">广度测试企业</span><span class="salary">5K-6K</span><span class="job-area">武汉</span><span class="job-education">本科</span></li>`).join('');
  const breadthFixture=`<style>body{margin:0}.scroll-shell{height:230px;overflow-y:auto}.job-card-wrapper{height:55px;list-style:none}ul{padding:0;margin:0}</style><nav><ul><li>无岗位的导航列表</li></ul></nav><div class="scroll-shell">${'<div>'.repeat(8)}<ul class="actual-list">${breadthCards(1,15)}</ul>${'</div>'.repeat(8)}</div><script>let queued=false;document.querySelector('.scroll-shell').addEventListener('scroll',()=>{const el=document.querySelector('.scroll-shell');if(queued||el.scrollTop<el.scrollHeight-el.clientHeight-3)return;queued=true;setTimeout(()=>document.querySelector('.actual-list').insertAdjacentHTML('beforeend',${JSON.stringify(breadthCards(16,15))}),850);});</script>`;
  const paginationFixture=(last:boolean)=>`<style>body{margin:0}.job-card-wrapper{height:55px}</style><ul>${breadthCards(last?2:1,1)}</ul><button onclick="window.talked=true">立即沟通</button><div class="pagination">${last?'<button disabled>下一页</button>':'<a class="disabled" href="https://example.com/web/geek/jobs">下一页</a><a href="/web/geek/jobs?city=101200100&query=%E7%BF%BB%E9%A1%B5%E9%AA%8C%E8%AF%81&page=2">下一页</a>'}</div>`;
  await partition.protocol.handle("https", async request => { requests++; const path=new URL(request.url).pathname;
    const query=new URL(request.url).searchParams.get('query');
    if(path==='/web/geek/jobs')searchPageRequests++;
    if(path==='/web/geek/jobs' && query==='Java实习')return new Response(`<ul>${[['INTERNONE123456','Java 实习生','在校/应届','200-220元/天'],['INTERNTWO123456','Java后端实习','经验不限','5-6K'],['INTERNNO123456','Java开发工程师','3-5年','10-15K'],['INTERNJS123456','JavaScript实习生','在校/应届','150-200元/天'],['INTERNUNK123456','Java开发','经验不限','5-8K'],['INTERNNEG123456','Java非实习岗位','应届','6-9K']].map(([id,title,experience,salary])=>`<li class="job-card-wrapper"><a href="/job_detail/${id}.html"><span class="job-name">${title}</span></a><span class="company-name">筛选测试企业</span><span class="salary">${salary}</span><span class="job-area">武汉</span><ul class="tag-list"><li>本科</li><li>${experience}</li></ul></li>`).join('')}</ul>`,{headers:{'content-type':'text/html; charset=utf-8'}});
    if(path==='/web/geek/jobs' && query==='增量验证')return new Response(`<ul>${Array.from({length:incrementalAdded?3:2},(_,i)=>`<li class="job-card-wrapper"><a href="/job_detail/INCREMENTUI${i}123456.html"><span class="job-name">Java增量验证岗位${i}</span></a><span class="company-name">增量测试企业</span><span class="salary">5-6K</span><span class="job-area">武汉</span><ul class="tag-list"><li>本科</li><li>应届生</li></ul></li>`).join('')}</ul>`,{headers:{'content-type':'text/html; charset=utf-8'}});
    if(path==='/web/geek/jobs' && query==='补全验证')return new Response(salarySearchFixture.replaceAll('SALARYMONTH','VERIFYMONTH').replaceAll('SALARYDAY','VERIFYDAY').replaceAll('薪资补全测试企业','独立补全测试企业'),{headers:{'content-type':'text/html; charset=utf-8'}});
    if(path==='/job_detail/VERIFYMONTH123456.html' || path==='/job_detail/VERIFYDAY123456.html'){
      if(savedRefreshBlocked)return new Response('',{status:302,headers:{location:'https://www.zhipin.com/web/passport/zp/security.html'}});
      if(savedRefreshDelay)await new Promise(resolve=>setTimeout(resolve,1800));
      const content=salaryDetailFixture(path.includes('DAY')).replaceAll('薪资补全测试企业','独立补全测试企业');
      return new Response(savedRefreshChanged?content.replace('200-220元/天','230-260元/天'):content,{headers:{'content-type':'text/html; charset=utf-8'}});
    }
    if(path==='/web/geek/jobs' && query==='广度验证')return new Response(breadthFixture,{headers:{'content-type':'text/html; charset=utf-8'}});
    if(path==='/web/geek/jobs' && query==='翻页验证')return new Response(paginationFixture(new URL(request.url).searchParams.get('page')==='2').replaceAll('广度验证','翻页验证'),{headers:{'content-type':'text/html; charset=utf-8'}});
    if(path==='/web/geek/jobs' && (query==='薪资停止' || query==='薪资验证页'))return new Response(guardedSalaryList(query==='薪资停止'?'SALARYSLOW123456':'SALARYGUARD123456'),{headers:{'content-type':'text/html; charset=utf-8'}});
    if(path==='/job_detail/SALARYSLOW123456.html'){await new Promise(resolve=>setTimeout(resolve,2200));return new Response(salaryDetailFixture(false),{headers:{'content-type':'text/html; charset=utf-8'}});}
    if(path==='/job_detail/SALARYGUARD123456.html')return new Response(`<script>location.href='/web/passport/zp/security.html';</script>`,{headers:{'content-type':'text/html; charset=utf-8'}});
    if(path==='/web/geek/jobs' && new URL(request.url).searchParams.get('query')==='薪资验证')return new Response(salarySearchFixture,{headers:{'content-type':'text/html; charset=utf-8'}});
    if(path==='/job_detail/SALARYMONTH123456.html' || path==='/job_detail/SALARYDAY123456.html')return new Response(salaryDetailFixture(path.includes('DAY')),{headers:{'content-type':'text/html; charset=utf-8'}});
    if(path==="/wapi/zpgeek/job/detail.json")return new Response(responseJson,{headers:{"content-type":"application/json"}});
    const body = path==='/web/geek/jobs' && new URL(request.url).searchParams.get('query')==='java'?delayedSearchFixture:path==="/hangzhou/"?batchFixture : path === "/job_detail/ABCDEF123456.html" ? detailFixture : path === "/shenzhen/" ? longListFixture : path === "/shanghai/" ? secondPageFixture : path === "/wuhan/" ? salaryFixture : path === "/web/geek/job" ? '<li class="job-card-wrapper"><a href="/job_detail/UNKNOWN123456.html"><span class="job-name">缺企业字段的测试岗位</span></a></li>' : fixture;
    return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } }); });
  const check = (condition: unknown, message: string) => { if (!condition) throw new Error(`BOSS_BROWSER_SMOKE: ${message}`); };
  const request = async (operation: string, payload: unknown = {}) => {
    const result = await browser.request({ operation, payload });
    if (!result.ok) throw new Error(result.error);
    return result;
  };
  const settle = async () => {
    const end = Date.now() + 6000;
    while (Date.now() < end) {
      const state = browser.state();
      if (state.opened && !state.loading && state.url && !state.error) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error("Offline page did not settle");
  };
  const runSavedManagement=async()=>{
    stage='saved-management';
    const savedDaily=service.listJobs({mode:'IMPORT',platform:'boss',limit:200}).items.find(job=>job.source_url.includes('VERIFYDAY'))!;
    check(!!savedDaily,'saved daily fixture exists');
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.app-topbar button')).find(b=>b.textContent==='已保存岗位').click()`);
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.saved-filter button')).find(b=>b.textContent==='刷新本地记录').click()`);
    for(let i=0;i<80;i++){if(await window.webContents.executeJavaScript(`document.querySelector('.saved-table')?.innerText.includes('Java日薪岗位')`))break;await new Promise(resolve=>setTimeout(resolve,50));}
    const setInput=async(label:string,value:string)=>window.webContents.executeJavaScript(`(()=>{const input=document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const setSelect=async(label:string,value:string)=>window.webContents.executeJavaScript(`(()=>{const input=document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    for(let i=0;i<80;i++){if(await window.webContents.executeJavaScript(`document.querySelectorAll('.saved-table tbody tr').length>=2`))break;await new Promise(resolve=>setTimeout(resolve,50));}
    check(await window.webContents.executeJavaScript(`document.querySelectorAll('.saved-table input[type=checkbox]').length>=2`),'comparison seed rows: '+await window.webContents.executeJavaScript(`document.querySelector('.saved-jobs').innerText`));
    await window.webContents.executeJavaScript(`document.querySelectorAll('.saved-table input[type=checkbox]')[0].click()`);
    await new Promise(resolve=>setTimeout(resolve,60));
    await window.webContents.executeJavaScript(`document.querySelectorAll('.saved-table input[type=checkbox]')[1].click()`);
    await new Promise(resolve=>setTimeout(resolve,60));
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.saved-actions button')).find(b=>b.textContent.startsWith('对比所选')).click()`);
    await new Promise(resolve=>setTimeout(resolve,80));
    check(await window.webContents.executeJavaScript(`document.querySelector('.job-comparison').open && document.querySelector('.job-comparison').innerText.includes('薪资原文')`),'saved jobs support side-by-side comparison');
    await window.webContents.executeJavaScript(`document.querySelector('.comparison-heading button').click()`);
    await setInput('筛选公司','独立补全测试企业');await setInput('筛选地点','武汉');await setSelect('保存岗位薪资周期','DAY');await setInput('保存岗位最低薪资','210');await setInput('保存岗位最高薪资','215');await setSelect('保存岗位排序','SALARY_DESC');
    await window.webContents.executeJavaScript(`document.querySelector('.saved-filter').requestSubmit()`);
    for(let i=0;i<80;i++){if(await window.webContents.executeJavaScript(`document.querySelectorAll('.saved-table tbody tr').length===1 && document.querySelector('.saved-table').innerText.includes('Java日薪岗位')`))break;await new Promise(resolve=>setTimeout(resolve,50));}
    check((await window.webContents.executeJavaScript(`document.querySelectorAll('.saved-table tbody tr').length`))===1,'local daily range and city/company filters show only the matching daily job: '+JSON.stringify(await window.webContents.executeJavaScript(`({form:Array.from(document.querySelectorAll('.saved-filter input,.saved-filter select')).map(x=>({label:x.getAttribute('aria-label'),value:x.value,disabled:x.disabled})),text:document.querySelector('.saved-jobs').innerText})`)));
    await setSelect('Java日薪岗位的个人标记','INTERESTED');
    for(let i=0;i<60 && service.jobMark(savedDaily.id)!=='INTERESTED';i++)await new Promise(resolve=>setTimeout(resolve,50));
    await window.webContents.executeJavaScript(`document.querySelector('.saved-note summary').click()`);
    await window.webContents.executeJavaScript(`(()=>{const input=document.querySelector('.saved-note textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'优先查看：交通便利');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await new Promise(resolve=>setTimeout(resolve,100));await window.webContents.executeJavaScript(`document.querySelector('.saved-note button').click()`);
    for(let i=0;i<60;i++){if(service.listJobs({mode:'IMPORT',platform:'boss',limit:200}).items.find(j=>j.id===savedDaily.id) && service.managedJob(service.get('jobs',savedDaily.id)).personal_note==='优先查看：交通便利')break;await new Promise(resolve=>setTimeout(resolve,50));}
    check(service.managedJob(service.get('jobs',savedDaily.id)).personal_note==='优先查看：交通便利','note is saved by the visible editor');
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.saved-filter button')).find(b=>b.textContent==='重置').click()`);await new Promise(resolve=>setTimeout(resolve,300));
    await setInput('搜索已保存岗位','优先查看：交通便利');await window.webContents.executeJavaScript(`document.querySelector('.saved-filter').requestSubmit()`);
    for(let i=0;i<80;i++){if(await window.webContents.executeJavaScript(`document.querySelectorAll('.saved-table tbody tr').length===1`))break;await new Promise(resolve=>setTimeout(resolve,50));}
    check((await window.webContents.executeJavaScript(`document.querySelector('.saved-table').innerText`)).includes('Java日薪岗位'),'note keyword search returns the saved job');
    savedRefreshChanged=true;
    await window.webContents.executeJavaScript(`document.querySelector('.saved-table input[type=checkbox]').click()`);await new Promise(resolve=>setTimeout(resolve,100));
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.saved-actions button')).find(b=>b.textContent.startsWith('更新选中原帖')).click()`);
    for(let i=0;i<100;i++){if(browser.state().saved_refresh?.updated===1 && !browser.state().saved_refresh?.running)break;await new Promise(resolve=>setTimeout(resolve,50));}
    check(browser.state().saved_refresh?.updated===1,'saved refresh completes through visible UI');
    const refreshed=service.managedJob(service.get('jobs',savedDaily.id));check(refreshed.salary_raw==='230-260元/天' && refreshed.personal_mark==='INTERESTED' && refreshed.personal_note==='优先查看：交通便利' && !!refreshed.refresh?.last_success_at,'refresh adopts current salary and preserves notes and classification');
    for(let i=0;i<60;i++){if(await window.webContents.executeJavaScript(`document.querySelector('.saved-table').innerText.includes('230-260元/天')`))break;await new Promise(resolve=>setTimeout(resolve,50));}
    check((await window.webContents.executeJavaScript(`document.querySelector('.saved-table').innerText`)).includes('230-260元/天'),'new salary renders in local list');
    check(refreshed.change_check?.status==='CHANGED' && refreshed.change_check.changes.some(change=>change.field==='薪资' && change.before==='200-220元/天' && change.after==='230-260元/天'),'saved refresh records salary before and after');
    await window.webContents.executeJavaScript(`document.querySelector('.job-changes details').open=true`);
    check(await window.webContents.executeJavaScript(`document.querySelector('.job-changes').innerText.includes('之前：200-220元/天')`),'change history renders original and refreshed salary');
    await new Promise(resolve=>setTimeout(resolve,1400));
    await window.webContents.executeJavaScript(`document.querySelector('.job-changes details').open=true`);
    await new Promise(resolve=>setTimeout(resolve,250));
    writeFileSync(join(directory,'boss-changes.png'),(await window.webContents.capturePage()).toPNG());
    savedRefreshBlocked=true;await request('saved.refresh',{ids:[savedDaily.id]});
    for(let i=0;i<100 && browser.state().saved_refresh?.running;i++)await new Promise(resolve=>setTimeout(resolve,50));
    const failed=service.managedJob(service.get('jobs',savedDaily.id));check(failed.salary_raw===refreshed.salary_raw && failed.refresh?.status==='FAILED' && failed.refresh.last_success_at===refreshed.refresh!.last_success_at,'security redirect preserves prior data and success time');
    savedRefreshBlocked=false;savedRefreshDelay=true;await request('saved.refresh',{ids:[savedDaily.id]});await request('saved.refresh.stop');
    for(let i=0;i<80 && browser.state().saved_refresh?.running;i++)await new Promise(resolve=>setTimeout(resolve,50));
    check(browser.state().saved_refresh?.updated===0 && service.get<typeof refreshed>('jobs',savedDaily.id).salary_raw==='230-260元/天','stopped update cannot apply late detail');savedRefreshDelay=false;
    check(BrowserWindow.getAllWindows().length===1,'saved refresh disposes all hidden workers');
    await new Promise(resolve=>setTimeout(resolve,1100));
    writeFileSync(join(directory,'boss-saved-management-smoke.png'),(await window.webContents.capturePage()).toPNG());
    window.setSize(760,850);await new Promise(resolve=>setTimeout(resolve,150));writeFileSync(join(directory,'boss-saved-management-narrow.png'),(await window.webContents.capturePage()).toPNG());window.setSize(1600,900);
    window.webContents.reload();await new Promise<void>(resolve=>window.webContents.once('did-finish-load',()=>resolve()));
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.app-topbar button')).find(b=>b.textContent==='已保存岗位').click()`);
    for(let i=0;i<80;i++){if(await window.webContents.executeJavaScript(`document.querySelector('.saved-table')?.innerText.includes('230-260元/天')`))break;await new Promise(resolve=>setTimeout(resolve,50));}
    check((await window.webContents.executeJavaScript(`document.querySelector('.saved-table').innerText`)).includes('230-260元/天'),'reload restores refreshed salary');
    check(!(await browser.request({operation:'saved.refresh',payload:{ids:[savedDaily.id],url:'https://example.com'}})).ok,'saved refresh refuses caller-supplied navigation');
  };
  const runIncremental=async()=>{
    stage='incremental-management';
    const initialCounts=['messages','actions','attempts','tasks'].map(t=>service.store.all(t as 'messages').length).join(',');
    const next={...actualDefaultSearchConfig,keywords:['增量验证'],experience:'ALL' as const,rounds:1,salary_enrichment:false};
    service.saveBossSearchConfig(next);
    window.webContents.reload();await new Promise<void>(resolve=>window.webContents.once('did-finish-load',()=>resolve()));
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.app-topbar button')).find(b=>b.textContent==='岗位搜索').click()`);
    for(let i=0;i<80;i++){if(await window.webContents.executeJavaScript(`document.querySelector('[aria-label="目标岗位关键词"]')?.value==='增量验证'`))break;await new Promise(resolve=>setTimeout(resolve,50));}
    const finish=async()=>{for(let i=0;i<120 && browser.state().search_running;i++)await new Promise(resolve=>setTimeout(resolve,50));check(!browser.state().search_running,'incremental search completes');await new Promise(resolve=>setTimeout(resolve,2200));return (await request('search.get')).search_run!;};
    await request('search.start',next);const first=await finish();
    check(first.results.length===2 && first.results.every(item=>item.discovery==='NEW'),'first scan discovers two new jobs');
    incrementalAdded=true;
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.search-workspace button')).find(b=>b.textContent==='重新获取岗位').click()`);
    for(let i=0;i<80 && (await request('search.get')).search_run?.id===first.id;i++)await new Promise(resolve=>setTimeout(resolve,50));
    const second=await finish();check(second.results.length===1 && second.skipped_processed===2 && second.results[0]!.discovery==='NEW','second UI fetch skips parsed old cards and returns only new third job');
    check((await window.webContents.executeJavaScript(`document.querySelector('.search-workspace').innerText`)).includes('相同条件已完成筛选 2 个'),'incremental counts render');
    const setInput=async(label:string,value:string)=>window.webContents.executeJavaScript(`(()=>{const input=document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await setInput('条件名称','武汉 Java 增量');
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.search-presets button')).find(b=>b.textContent==='保存为常用条件').click()`);
    for(let i=0;i<80 && !service.listSearchPresets().length;i++)await new Promise(resolve=>setTimeout(resolve,50));
    check(service.listSearchPresets()[0]?.name==='武汉 Java 增量','preset UI saves name and criteria');
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.search-workspace button')).find(b=>b.textContent==='重新检查旧岗位').click()`);
    for(let i=0;i<80 && (await request('search.get')).search_run?.id===second.id;i++)await new Promise(resolve=>setTimeout(resolve,50));
    const reread=await finish();check(reread.results.length===3 && reread.results.every(item=>item.discovery==='SEEN') && !reread.config.skip_processed && !reread.config.skip_saved,'explicit recheck refreshes all known cards and labels previously read');
    check(reread.results[0]!.first_read_at===first.results[0]!.first_read_at && reread.results[0]!.observed_at>first.results[0]!.observed_at,'recheck preserves first discovery and updates actual observation');
    await window.webContents.executeJavaScript(`(()=>{const source=document.querySelector('[aria-label="读取来源"]');source.value='NEW';source.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    check((await window.webContents.executeJavaScript(`document.querySelector('.search-table').innerText`)).includes('当前来源分类暂无岗位'),'discovery filter has truthful empty feedback');
    await window.webContents.executeJavaScript(`(()=>{const source=document.querySelector('[aria-label="读取来源"]');source.value='SEEN';source.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    check((await window.webContents.executeJavaScript(`document.querySelectorAll('.search-table tbody tr').length`))===3,'previously-read filter shows three current observations');
    await window.webContents.executeJavaScript(`document.querySelector('.search-settings').open=true`);
    writeFileSync(join(directory,'boss-incremental-smoke.png'),(await window.webContents.capturePage()).toPNG());
    window.setSize(980,850);await new Promise(resolve=>setTimeout(resolve,150));writeFileSync(join(directory,'boss-incremental-narrow.png'),(await window.webContents.capturePage()).toPNG());window.setSize(1600,900);
    window.webContents.reload();await new Promise<void>(resolve=>window.webContents.once('did-finish-load',()=>resolve()));
    for(let i=0;i<80;i++){if(await window.webContents.executeJavaScript(`document.querySelector('[aria-label="常用搜索条件"]')?.textContent.includes('武汉 Java 增量')`))break;await new Promise(resolve=>setTimeout(resolve,50));}
    check((await window.webContents.executeJavaScript(`document.querySelector('[aria-label="常用搜索条件"]').textContent`)).includes('武汉 Java 增量'),'reload restores preset');
    const before=requests;
    await window.webContents.executeJavaScript(`const preset=document.querySelector('[aria-label="常用搜索条件"]');preset.value=preset.options[1].value;preset.dispatchEvent(new Event('change',{bubbles:true}));`);
    check(requests===before && (await window.webContents.executeJavaScript(`document.querySelector('[aria-label="目标岗位关键词"]').value`))==='增量验证','loading preset restores criteria without navigating or fetching');
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.search-workspace button')).find(b=>b.textContent==='重新获取岗位').click()`);
    for(let i=0;i<80 && (await request('search.get')).search_run?.id===reread.id;i++)await new Promise(resolve=>setTimeout(resolve,50));
    const empty=await finish();check(empty.results.length===0 && empty.skipped_processed===3,'preset resumes incremental behavior after reload');
    check((await window.webContents.executeJavaScript(`document.querySelector('.search-table').innerText`)).includes('重新检查旧岗位'),'all-processed feedback offers recheck');
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.search-presets button')).find(b=>b.textContent==='删除这组条件').click()`);
    for(let i=0;i<80 && service.listSearchPresets().length;i++)await new Promise(resolve=>setTimeout(resolve,50));
    check(!service.listSearchPresets().length,'preset delete does not remove job history');
    check(['messages','actions','attempts','tasks'].map(t=>service.store.all(t as 'messages').length).join(',')===initialCounts,'incremental controls create no communications');
  };
  try {
    if(process.env.RA_FILTER_SMOKE==='1'){
      await request('layout',{visible:false,x:0,y:0,width:0,height:0});await request('open');await settle();
      const config={...actualDefaultSearchConfig,keywords:['Java实习'],experience:'INTERN' as const,rounds:1,salary_enrichment:false};
      service.saveBossSearchConfig(config);window.webContents.reload();await new Promise<void>(resolve=>window.webContents.once('did-finish-load',()=>resolve()));
      await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.app-topbar button')).find(b=>b.textContent==='岗位搜索').click()`);
      for(let i=0;i<80;i++){if(await window.webContents.executeJavaScript(`document.querySelector('[aria-label="目标岗位关键词"]')?.value==='Java实习'`))break;await new Promise(resolve=>setTimeout(resolve,50));}
      check(await window.webContents.executeJavaScript(`!document.querySelector('.search-advanced').open && document.querySelector('[aria-label="岗位类型 / 经验"]').value==='INTERN'`),'advanced filters start collapsed and internship type is restored');
      writeFileSync(join(directory,'boss-filter-form.png'),(await window.webContents.capturePage()).toPNG());
      await window.webContents.executeJavaScript(`document.querySelector('.search-config').requestSubmit()`);
      for(let i=0;i<160 && browser.state().search_running;i++)await new Promise(resolve=>setTimeout(resolve,50));await new Promise(resolve=>setTimeout(resolve,2200));
      check((await request('search.get')).search_run?.results.length===6,'read-only fixture collection keeps all evidence');
      check(await window.webContents.executeJavaScript(`document.querySelectorAll('.search-table tbody tr').length===2 && document.querySelector('.search-results-toolbar button[aria-pressed=true]').textContent.startsWith('符合条件')`),'default results only show the two affirmative Java internship jobs');
      await window.webContents.executeJavaScript(`document.querySelectorAll('.search-table input[type=checkbox]').forEach(input=>input.click())`);
      await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.search-results-toolbar button')).find(b=>b.textContent.startsWith('对比所选')).click()`);
      check(await window.webContents.executeJavaScript(`document.querySelector('.job-comparison').open && document.querySelector('.job-comparison').innerText.includes('200-220元/天') && document.querySelector('.job-comparison').innerText.includes('5-6K')`),'comparison opens from selected search rows and preserves daily/monthly units');
      writeFileSync(join(directory,'boss-comparison.png'),(await window.webContents.capturePage()).toPNG());
      await window.webContents.executeJavaScript(`document.querySelector('.comparison-heading button').click()`);
      check(await window.webContents.executeJavaScript(`!document.querySelector('.job-comparison')`),'comparison closes cleanly');
      await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.search-results-toolbar button')).find(b=>b.textContent.startsWith('待核实')).click()`);
      check(await window.webContents.executeJavaScript(`document.querySelectorAll('.search-table tbody tr').length===1 && document.querySelector('.search-table').innerText.includes('未明确实习类型')`),'unconfirmed experience-unlimited job is pending, never a match');
      await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.search-results-toolbar button')).find(b=>b.textContent.startsWith('符合条件')).click()`);
      window.setSize(980,850);await new Promise(resolve=>setTimeout(resolve,150));await window.webContents.executeJavaScript(`document.querySelector('.search-settings').open=true`);await new Promise(resolve=>setTimeout(resolve,80));
      writeFileSync(join(directory,'boss-filter-narrow.png'),(await window.webContents.capturePage()).toPNG());
      check(rendererErrors.length===0,rendererErrors.join(';'));return {offline:true,internship_filter:true,comparison:true,renderer_errors:rendererErrors.length};
    }
    if(process.env.RA_INCREMENTAL_SMOKE==='1'){
      await request('layout',{visible:false,x:0,y:0,width:0,height:0});await request('open');await settle();
      await runIncremental();check(rendererErrors.length===0,rendererErrors.join(';'));return {offline:true,incremental:true,renderer_errors:rendererErrors.length};
    }
    if(process.env.RA_SAVED_SMOKE==='1'){
      await request('layout',{visible:false,x:0,y:0,width:0,height:0});await request('open');await settle();
      service.importJobs([browserJobInput({url:'https://www.zhipin.com/job_detail/VERIFYDAY123456.html',title:'Java日薪岗位',company:'独立补全测试企业',salary:'200-220元/天',location:'武汉',education:'本科',experience:'经验不限',tags:[]},new Date().toISOString()),browserJobInput({url:'https://www.zhipin.com/job_detail/VERIFYMONTH123456.html',title:'Java月薪岗位',company:'独立补全测试企业',salary:'5k-6k',location:'武汉',education:'本科',experience:'经验不限',tags:[]},new Date().toISOString())]);
      await runSavedManagement();check(rendererErrors.length===0,rendererErrors.join(';'));return {offline:true,saved_management:true,renderer_errors:rendererErrors.length};
    }
    // Legacy regressions intentionally reread the same offline fixtures. Restore
    // their explicit preferences in the renderer too, rather than inheriting the
    // production incremental default and accidentally skipping test jobs.
    service.saveBossSearchConfig(defaultSearchConfig);
    window.webContents.reload();await new Promise<void>(resolve=>window.webContents.once('did-finish-load',()=>resolve()));
    await request("layout", { visible: true, x: 260, y: 250, width: 620, height: 500 });
    await request("open"); await settle();
    const both = await Promise.all([browser.request({ operation: "read" }), browser.request({ operation: "read" })]);
    check(both[0]!.ok && !both[1]!.ok, "duplicate reads must be rejected");
    const read = browser.state().snapshot!;
    check(browser.state().snapshot_current, "a successful read belongs to the current list");
    check(read.jobs.length === 2, "only visible recognized cards are read and deduplicated");
    check(read.jobs[0]!.salary === "140-280元/天" && !read.jobs[0]!.url.includes("?"), "salary preserved, session query removed");
    check(read.jobs[0]!.location === "武汉市·江夏区" && read.jobs[0]!.education === "本科及以上", "split city/district and education suffix are preserved");
    check(read.jobs[1]!.title === "前端开发" && read.jobs[1]!.company === "离线测试企业乙" && read.jobs[1]!.education === "大专" && read.jobs[1]!.location === "武汉", "live-observed city layout scopes job and company names correctly");
    const counts = () => ["actions", "attempts", "messages", "tasks"].map(table => service.store.all(table as "actions").length).join(",");
    const before = counts();
    check(!(await browser.request({operation:"detail.read"})).ok,"detail reading rejects lists");
    const initialSave = await request("save", { snapshot_id: read.id, urls: read.jobs.map(j => j.url) });
    check(initialSave.save_summary?.created === 2 && initialSave.save_summary.updated === 0, "initial save reports two new jobs");
    const repeatedSave = await request("save", { snapshot_id: read.id, urls: read.jobs.map(j => j.url) });
    check(repeatedSave.save_summary?.created === 0 && repeatedSave.save_summary.updated === 2, "repeat save reports updates instead of new records");
    check(service.store.all<{ source_instance_id: string }>("jobs").filter(j => j.source_instance_id === "desktop-browser:boss").length === 2, "repeated saving deduplicates");
    check(counts() === before, "saving creates no communication actions, attempts, tasks or messages");
    check(!(await browser.request({ operation: "send", payload: {} })).ok, "sending is not exposed");
    check(!(await browser.request({ operation: "job.open", payload: { url: "file:///E:/secret" } })).ok, "external navigation blocked");
    const authView = window.contentView.children.find(view => view instanceof WebContentsView) as WebContentsView;
    await authView.webContents.executeJavaScript(`document.querySelector('.sub-li .job-text span:last-child').textContent='中专/中技'`);
    const combinedEducationRead = await authView.webContents.executeJavaScript(BOSS_READ_SCRIPT);
    check(combinedEducationRead.jobs[1].education === "中专/中技", "combined education labels are read instead of treated as missing");
    await authView.webContents.executeJavaScript(`document.querySelector('.sub-li .job-text span:last-child').textContent='大专'`);
    const beforeLocateRequests = requests, beforeLocateUrl = authView.webContents.getURL();
    await request("job.locate",{snapshot_id:read.id,url:read.jobs[1]!.url});
    check(requests === beforeLocateRequests && authView.webContents.getURL() === beforeLocateUrl && counts() === before, "locating scrolls the current page without navigation, requests or communication");
    check((await authView.webContents.executeJavaScript(`(() => {const r=document.querySelector('.sub-li').getBoundingClientRect();return r.bottom>0 && r.top<innerHeight;})()`)), "located job is in the current viewport");
    const markRevisionCount = service.store.all("job_revisions").length;
    const marked = await request("job.mark",{snapshot_id:read.id,url:read.jobs[0]!.url,mark:"REJECTED"});
    check(marked.records?.[read.jobs[0]!.url]?.mark === "REJECTED" && service.store.all("job_revisions").length === markRevisionCount && counts() === before, "marking an existing snapshot changes only the personal mark");
    const structureRead = await authView.webContents.executeJavaScript(BOSS_READ_SCRIPT);
    check(structureRead.diagnostic.missing_company === 1 && structureRead.diagnostic.invisible === 1, "rejection diagnostics distinguish missing company from hidden cards");
    check(read.jobs[0]!.title === "Java 开发 双休" && read.jobs[0]!.company === "离线测试企业甲", "outer row, empty placeholders and explicit company link are compatible");
    await authView.webContents.loadURL("https://www.zhipin.com/web/geek/job?seed=never-persist"); await settle();
    const rejectedRead = await browser.request({ operation: "read" });
    check(!rejectedRead.ok && rejectedRead.error.includes("缺企业名 1") && browser.state().snapshot!.id === read.id, "missing fields report specific reason without overwriting snapshot");
    const missingLocate = await browser.request({operation:"job.locate",payload:{snapshot_id:read.id,url:read.jobs[0]!.url}});
    check(!missingLocate.ok && missingLocate.error.includes("页面已变化"), "a removed job is not located or opened by guessing");
    const localDiagnostic = readFileSync(join(directory, "evidence", "boss-reader-diagnostic.json"), "utf8");
    check(localDiagnostic.includes("job-card-wrapper") && !localDiagnostic.includes("never-persist") && !localDiagnostic.includes("缺企业字段的测试岗位"), "diagnostics persist shape only, without query tokens or page text");
    await authView.webContents.loadURL("https://www.zhipin.com/web/passport/zp/security.html?seed=fixture-secret");
    await settle();
    check(browser.state().page_kind === "SECURITY" && !browser.state().url.includes("fixture-secret"), "security page state strips query secrets");
    const securityRead = await browser.request({ operation: "read" });
    check(!securityRead.ok && securityRead.error.includes("安全验证") && browser.state().snapshot!.id === read.id, "security page with job-like fixture is never parsed");
    check(!(await browser.request({operation:"job.locate",payload:{snapshot_id:read.id,url:read.jobs[0]!.url}})).ok, "locating never inspects the security page");
    await authView.webContents.loadURL("https://www.zhipin.com/web/user/"); await settle();
    const loginRead = await browser.request({ operation: "read" });
    check(!loginRead.ok && loginRead.error.includes("登录页"), "login page is not parsed");
    await request("restart"); await settle();
    await request("job.open", { url: read.jobs[0]!.url }); await settle();
    check(!(await browser.request({ operation: "read", payload: {} })).ok, "reading is limited to job listings");
    const detailRequests=requests;
    const detailRead=await request("detail.read");
    const detailed=detailRead.state.snapshot!.jobs.find(job=>job.url===read.jobs[0]!.url)!;
    check(detailed.detail?.description.includes("SQL") && !detailed.detail.description.includes("销售") && detailed.detail.address==="武汉市江夏区测试路", "detail reads visible job text and address without company introduction or hidden text");
    check(detailRead.state.snapshot!.jobs.length===2 && requests===detailRequests && counts()===before,"detail deduplicates into collection without extra requests or communication");
    await request("save",{snapshot_id:detailRead.state.snapshot!.id,urls:[detailed.url]});
    check(service.store.findSourceJob("IMPORT","desktop-browser:boss:ABCDEF123456")?.description?.includes("SQL"),"detail persists in saved job");
    const detailView=window.contentView.children.find(view=>view instanceof WebContentsView) as WebContentsView;
    const originalDetailExecution=detailView.webContents.executeJavaScript.bind(detailView.webContents);
    detailView.webContents.executeJavaScript=async()=>{await new Promise(resolve=>setTimeout(resolve,150));return null;};
    const lateDetail=browser.request({operation:"detail.read"});
    check(!(await browser.request({operation:"detail.read"})).ok,"duplicate detail reads are blocked");
    await request("back");
    check(!(await lateDetail).ok && browser.state().snapshot!.id===detailRead.state.snapshot!.id,"navigation discards late detail without changing collection");
    detailView.webContents.executeJavaScript=originalDetailExecution;
    await settle();
    check(browser.state().url.includes("/web/geek/jobs"), "back restores listing");
    await partition.cookies.set({ url: "https://www.zhipin.com", name: "offline-session-test", value: "fixture-only" });
    await request("restart"); await settle();
    check((await partition.cookies.get({ name: "offline-session-test" }))[0]?.value === "fixture-only", "browser restart keeps the partition session");
    await request("read");
    check(browser.state().snapshot!.id !== read.id, "new reading replaces snapshot");
    check(!(await browser.request({ operation: "save", payload: { snapshot_id: read.id, urls: [read.jobs[0]!.url] } })).ok, "obsolete snapshot cannot be saved");
    check(!(await browser.request({operation:"job.mark",payload:{snapshot_id:read.id,url:read.jobs[0]!.url,mark:"INTERESTED"}})).ok, "obsolete snapshot cannot change personal marks");
    check(!(await browser.request({operation:"job.locate",payload:{snapshot_id:read.id,url:read.jobs[0]!.url}})).ok, "obsolete snapshot cannot scroll current page");
    let remoteView = window.contentView.children.find(view => view instanceof WebContentsView) as WebContentsView;
    const isolation = await remoteView.webContents.executeJavaScript(`({node:typeof require,process:typeof process,bridge:typeof window.recruitment})`);
    check(isolation.node === "undefined" && isolation.process === "undefined" && isolation.bridge === "undefined", "remote page has no Node or app bridge");
    // Force a slow read in the isolated test instance. A navigation must discard
    // its result, and a hung evaluation must not spawn repeated evaluations.
    const stableSnapshot = browser.state().snapshot!;
    const originalRead = remoteView.webContents.executeJavaScript.bind(remoteView.webContents);
    remoteView.webContents.executeJavaScript = async () => { await new Promise(resolve => setTimeout(resolve, 150)); return stableSnapshot.jobs; };
    const changingRead = browser.request({ operation: "read", payload: {} });
    await request("job.open", { url: read.jobs[0]!.url });
    check(!(await changingRead).ok && browser.state().snapshot!.id === stableSnapshot.id, "navigation discards stale read");
    remoteView.webContents.executeJavaScript = originalRead;
    await settle(); await request("restart"); await settle();
    remoteView = window.contentView.children.find(view => view instanceof WebContentsView) as WebContentsView;
    let finishLate: (value: unknown) => void = () => {};
    remoteView.webContents.executeJavaScript = () => new Promise(resolve => { finishLate = resolve; });
    const timedOut = await browser.request({ operation: "read", payload: {} });
    check(!timedOut.ok && timedOut.error.includes("超时") && browser.state().reading, "timed out JS keeps its latch until settled");
    check(!(await browser.request({ operation: "read", payload: {} })).ok, "no repeat after timeout");
    await request("restart"); await settle();
    finishLate(stableSnapshot.jobs);
    await new Promise(resolve => setTimeout(resolve, 20));
    check(browser.state().snapshot!.id === stableSnapshot.id && !browser.state().reading, "late result cannot replace snapshot after restart");
    await request("read");
    const networkBefore = requests;
    const repeatedBefore = counts();
    const revisionCount = service.store.all("job_revisions").length;
    for (let iteration = 0; iteration < 20; iteration++) {
      await request("read");
      const snapshot = browser.state().snapshot!;
      await request("save", {snapshot_id:snapshot.id,urls:snapshot.jobs.map(job=>job.url)});
    }
    check(requests === networkBefore && counts() === repeatedBefore && service.store.all("job_revisions").length === revisionCount, "twenty repeated reads and saves create no website requests, communication or false revisions");
    check(service.listJobs({platform:"boss",mode:"IMPORT"}).total === 2, "repeated observations keep two unique records");
    const collectionBefore=browser.state().snapshot!;
    const collectionView=window.contentView.children.find(view=>view instanceof WebContentsView) as WebContentsView;
    await collectionView.webContents.loadURL("https://www.zhipin.com/shanghai/");await settle();
    const collectionRequests=requests;
    const appended=await request("read.append");
    check(appended.read_summary?.added===1 && appended.read_summary.repeated===1 && appended.state.snapshot!.jobs.length===3, "another page adds one new job and updates the overlapping job");
    check(appended.state.snapshot!.observations?.[collectionBefore.jobs[1]!.url]?.observed_at===collectionBefore.observed_at, "retained jobs keep their previous read time");
    check(!(await browser.request({operation:"job.locate",payload:{snapshot_id:appended.state.snapshot!.id,url:collectionBefore.jobs[1]!.url}})).ok, "previous-page jobs cannot be located in the latest page");
    const repeatedAppend=await request("read.append");
    check(repeatedAppend.read_summary?.added===0 && repeatedAppend.state.snapshot!.jobs.length===3 && requests===collectionRequests, "repeated append is deduplicated and does not navigate or fetch");
    await collectionView.webContents.loadURL("https://www.zhipin.com/web/geek/job");await settle();
    const failedAppend=await browser.request({operation:"read.append"});
    check(!failedAppend.ok && browser.state().snapshot!.id===repeatedAppend.state.snapshot!.id && browser.state().snapshot!.jobs.length===3, "failed append preserves the whole collection");
    await collectionView.webContents.loadURL("https://www.zhipin.com/shenzhen/");await settle();await request("read");
    check(browser.state().snapshot!.jobs.length===100, "each DOM read is bounded to one hundred recognized cards");
    const longAppend=await request("read.append");
    check(longAppend.read_summary?.added===20 && longAppend.state.snapshot!.jobs.length===120, "append prioritizes unseen cards beyond the first hundred");
    check((await request("read.append")).state.snapshot!.jobs.length===120, "long-list append remains deduplicated");
    await collectionView.webContents.loadURL("https://www.zhipin.com/web/geek/jobs");await settle();await request("read");
    check(browser.state().snapshot!.jobs.length===2, "fresh read starts a new collection");
    const networkAfterCollection=requests;
    await new Promise(resolve => setTimeout(resolve, 1300));
    check(requests === networkAfterCollection, "idle does not reload or fetch");
    await window.webContents.executeJavaScript(`document.querySelector('nav button').click()`);
    await new Promise(resolve => setTimeout(resolve, 200));
    const ui = await window.webContents.executeJavaScript(`({text:document.body.innerText,bridge:!!window.recruitment.bossBrowser,node:typeof require})`);
    await window.webContents.executeJavaScript(`document.querySelector('[aria-expanded]').click()`);
    await new Promise(resolve => setTimeout(resolve, 80));
    check(ui.bridge && ui.node === "undefined" && ui.text.includes("读取岗位"), "desktop helper renders with isolated bridge");
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(el=>el.textContent==='追加当前页').click()`);
    await new Promise(resolve=>setTimeout(resolve,150));
    check((await window.webContents.executeJavaScript(`document.body.innerText`)).includes("新增 0 个、重复更新 2 个；累计 2 个岗位"), "append UI explains duplicate reads and cumulative total");
    // Exercise local filtering through the app UI, not the remote page.
    const fillLocal = async (selector: string, value: string) => {
      await window.webContents.executeJavaScript(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
      await new Promise(resolve => setTimeout(resolve, 70));
    };
    await fillLocal('.boss-filter-form input[maxlength="80"]', '武汉');
    check((await window.webContents.executeJavaScript(`document.querySelector('.boss-results-header').innerText`)).includes("2 / 2"), "typing Wuhan immediately matches both card layouts");
    await window.webContents.executeJavaScript(`(() => { const el=document.querySelector('.boss-filter-form select'); const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; setter.call(el,'本科');el.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await new Promise(resolve => setTimeout(resolve, 70));
    check((await window.webContents.executeJavaScript(`document.querySelector('.boss-results-header').innerText`)).includes("1 / 2"), "bachelor filter includes bachelor-and-above requirement");
    await fillLocal('.boss-filter-form input[placeholder="如 销售 外包"]', '双休');
    check((await window.webContents.executeJavaScript(`document.querySelector('.boss-results-header').innerText`)).includes("0 / 2"), "exclusion combines with city and education");
    check((await window.webContents.executeJavaScript(`document.querySelector('.boss-helper').innerText`)).includes("命中排除词"), "zero result explains excluded keywords");
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.boss-filter-form button')).find(el=>el.textContent==='清空条件').click()`);
    await new Promise(resolve => setTimeout(resolve, 150));
    check((await window.webContents.executeJavaScript(`document.querySelector('.boss-results-header').innerText`)).includes("2 / 2"), "clear conditions restores every captured job");
    await window.webContents.executeJavaScript(`(() => { const el=document.querySelector('.boss-filter-form input'); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(el,'Java'); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await new Promise(resolve => setTimeout(resolve, 60));
    await window.webContents.executeJavaScript(`document.querySelector('.boss-filter-form').requestSubmit()`);
    await new Promise(resolve => setTimeout(resolve, 80));
    const filtered = await window.webContents.executeJavaScript(`document.querySelector('.boss-results-header').innerText`);
    check(filtered.includes("1 / 2"), "local one-click filter finds one job");
    check(service.getBrowserFilter().keyword === "Java", "filter submission persists in local database");
    const currentSnapshot = browser.state().snapshot!;
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.boss-job button')).find(el=>el.textContent==='定位原站岗位').click()`);
    await new Promise(resolve=>setTimeout(resolve,100));
    check((await window.webContents.executeJavaScript(`document.body.innerText`)).includes("已滚动到原网页对应岗位"), "locate UI reports scrolling success");
    check((await window.webContents.executeJavaScript(`document.querySelector('.boss-job').innerText`)).includes("已保存 · 不合适"), "saved status and prior mark are shown beside filtered job");
    await window.webContents.executeJavaScript(`(() => {const el=document.querySelector('.boss-job select');el.value='CONSIDERING';el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await new Promise(resolve=>setTimeout(resolve,150));
    check((await request("records",{snapshot_id:currentSnapshot.id})).records?.[currentSnapshot.jobs[0]!.url]?.mark === "CONSIDERING", "card mark UI persists to the existing local record");
    await window.webContents.executeJavaScript(`document.querySelector('.boss-results-header button').click()`);
    await new Promise(resolve=>setTimeout(resolve,60));
    check((await window.webContents.executeJavaScript(`document.querySelector('.boss-helper').innerText`)).includes("其中 1 个已保存"), "selection exposes duplicate-save reminder");
    await window.webContents.executeJavaScript(`document.querySelector('.boss-wide').click()`);
    await new Promise(resolve=>setTimeout(resolve,150));
    check((await window.webContents.executeJavaScript(`document.body.innerText`)).includes("新增 0 个，更新已有 1 个"), "save UI reports duplicate updates accurately");
    const navigationView = window.contentView.children.find(view => view instanceof WebContentsView) as WebContentsView;
    const beforeQueryNavigation = requests;
    await navigationView.webContents.executeJavaScript(`history.pushState({},'', '/web/geek/jobs?city=101200100&page=2&query=frontend')`);
    await new Promise(resolve=>setTimeout(resolve,1300));
    check(!browser.state().snapshot_current && browser.state().snapshot!.id === currentSnapshot.id && requests === beforeQueryNavigation, "in-page city/page change marks the retained snapshot stale without rereading");
    check((await window.webContents.executeJavaScript(`document.body.innerText`)).includes("上次读取结果"), "the UI explicitly labels the old list after in-page navigation");
    check(await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.boss-job button')).find(el=>el.textContent==='定位原站岗位').disabled`), "old list cannot drive a page-location action");
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(el=>el.textContent==='读取岗位').click()`);
    await new Promise(resolve=>setTimeout(resolve,150));
    check(browser.state().snapshot_current && browser.state().snapshot!.id !== currentSnapshot.id, "manual read refreshes the in-page navigation snapshot");
    const refreshedSnapshot = browser.state().snapshot!;
    await request("job.locate",{snapshot_id:refreshedSnapshot.id,url:refreshedSnapshot.jobs[1]!.url});
    const scrollBeforeDetail = await navigationView.webContents.executeJavaScript('scrollY');
    await request("job.open",{url:refreshedSnapshot.jobs[0]!.url});await settle();
    await new Promise(resolve=>setTimeout(resolve,1300));
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(el=>el.textContent==='读取当前详情').click()`);
    await new Promise(resolve=>setTimeout(resolve,120));
    check((await window.webContents.executeJavaScript(`document.querySelector('.boss-job').innerText`)).includes("已读职位描述"),"manual detail toolbar updates renderer card");
    await window.webContents.executeJavaScript(`(() => {const form=document.querySelector('.matching-form');const inputs=form.querySelectorAll('input');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;[['1','Java'],['2','武汉'],['3','Java SQL'],['4','销售']].forEach(([i,v])=>{setter.call(inputs[Number(i)],v);inputs[Number(i)].dispatchEvent(new Event('input',{bubbles:true}));});inputs[0].click();})()`);
    await new Promise(resolve=>setTimeout(resolve,60));
    await window.webContents.executeJavaScript(`document.querySelector('.matching-form').requestSubmit()`);
    await new Promise(resolve=>setTimeout(resolve,100));
    check(service.getMatchingPreferences().enabled && service.getMatchingPreferences().skills==="Java SQL","matching preferences UI persists locally");
    check((await window.webContents.executeJavaScript(`document.querySelector('.match-score').innerText`)).includes("100 / 100"),"detail keywords yield explained matching score");
    await request("back");await settle();
    await new Promise(resolve=>setTimeout(resolve,100));
    check(Math.abs((await navigationView.webContents.executeJavaScript('scrollY'))-scrollBeforeDetail)<=3, "back from detail restores the list scroll position");
    check(service.getBrowserFilter().keyword === "Java" && !browser.state().snapshot_current, "back keeps preferences but requires a fresh list read");
    await request("read");
    await new Promise(resolve=>setTimeout(resolve,1300));
    await window.webContents.executeJavaScript(`document.querySelector('.boss-helper').scrollTop=300`);
    const finalView = window.contentView.children.find(view => view instanceof WebContentsView) as WebContentsView;
    // Native child views require a compositor surface. Briefly show this isolated
    // fixture window without taking focus; it contains no real account data.
    window.showInactive();
    await new Promise(resolve => setTimeout(resolve, 250));
    // Capture before resize/hide cycles: Electron's Windows compositor can
    // invalidate a child-view capture surface during those transitions.
    const position = await window.webContents.executeJavaScript(`(() => {const r=document.querySelector('.boss-browser-host').getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width)}})()`);
    const bounds = finalView.getBounds();
    check(Math.abs(bounds.x - position.x) <= 2 && Math.abs(bounds.y - position.y) <= 2 && Math.abs(bounds.width - position.width) <= 2, "native view follows helper notice/layout changes");
    check(finalView.getVisible(), "native view is visible before capture");
    await window.webContents.executeJavaScript(`document.querySelector('[aria-expanded]').click()`);
    await new Promise(resolve => setTimeout(resolve, 180));
    const fullBounds = finalView.getBounds();
    const [fullWidth = 0, fullHeight = 0] = window.getContentSize();
    check(fullBounds.width >= fullWidth - 4 && fullBounds.height >= fullHeight - 130, "collapsed helper gives native page nearly full window");
    await window.webContents.executeJavaScript(`document.querySelector('[aria-expanded]').click()`);
    await new Promise(resolve => setTimeout(resolve, 180));
    if (process.env.RA_DESKTOP_CAPTURE === "1") {
      try { writeFileSync(join(directory, "boss-browser-smoke.png"), (await finalView.webContents.capturePage(undefined, { stayAwake: true })).toPNG()); }
      catch (error) { throw new Error(`Child view screenshot failed (${JSON.stringify(bounds)}): ${String(error)}`); }
    }
    const beforeSwitch = requests;
    await window.webContents.executeJavaScript(`document.querySelectorAll('nav button')[1].click()`);
    await new Promise(resolve => setTimeout(resolve, 120));
    check(!finalView.getVisible(), "switching modules hides remote view");
    await new Promise(resolve => setTimeout(resolve, 120));
    await window.webContents.executeJavaScript(`(() => {const el=document.querySelector('.saved-table select');const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;setter.call(el,'INTERESTED');el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await new Promise(resolve => setTimeout(resolve, 120));
    check(service.listJobs({platform:"boss",mode:"IMPORT",personal_mark:"INTERESTED"}).total === 1 && counts() === before, "UI personal mark saves locally without communicating");
    await window.webContents.executeJavaScript(`document.querySelector('nav button').click()`);
    for(let i=0;i<60 && !finalView.getVisible();i++)await new Promise(resolve=>setTimeout(resolve,50));
    check(finalView.getVisible() && requests === beforeSwitch, `returning to workbench does not reload webpage (visible=${finalView.getVisible()}, requests=${requests}/${beforeSwitch})`);
    check((await window.webContents.executeJavaScript(`document.querySelector('.boss-results-header').innerText`)).includes("1 / 2"), "module switch preserves local filter");
    window.setSize(1100, 800);
    await new Promise(resolve => setTimeout(resolve, 200));
    const resized = finalView.getBounds();
    const [contentWidth = 0, contentHeight = 0] = window.getContentSize();
    check(resized.x + resized.width <= contentWidth && resized.y + resized.height <= contentHeight, "resize clips view inside content bounds");
    window.setSize(1600, 900);
    await new Promise(resolve => setTimeout(resolve, 200));
    const beforeReload = requests;
    window.webContents.reload();
    await new Promise<void>(resolve => window.webContents.once("did-finish-load", () => resolve()));
    await new Promise(resolve => setTimeout(resolve, 200));
    check((await window.webContents.executeJavaScript(`document.querySelector('.boss-filter-form input').value`)) === "Java", "renderer restart restores saved filter");
    check(requests === beforeReload && browser.state().snapshot!.jobs.length === 2, "tool reload preserves remote page and snapshot without website requests");
    check(browser.state().snapshot_current, "tool renderer reload does not invalidate the unchanged website list");
    await finalView.webContents.loadURL("https://www.zhipin.com/wuhan/");await settle();
    await finalView.webContents.executeJavaScript('document.fonts.ready.then(()=>true)');
    await new Promise(resolve=>setTimeout(resolve,1300));
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='读取岗位').click()`);
    await new Promise(resolve=>setTimeout(resolve,150));
    check(browser.state().snapshot!.jobs[0]!.salary===salaryFont.raw,"encrypted salary remains raw before recognition");
    const incompleteDiagnostic=JSON.parse(readFileSync(join(directory,"evidence","boss-reader-diagnostic.json"),"utf8"));
    check(incompleteDiagnostic.job_count===1 && incompleteDiagnostic.diagnostic.missing_location===1 && incompleteDiagnostic.diagnostic.missing_education===1, "successful partial reads persist missing-field diagnostics");
    check(!JSON.stringify(incompleteDiagnostic).includes("薪资测试虚构企业") && !JSON.stringify(incompleteDiagnostic).includes("Java 薪资验收岗位"), "partial-field diagnostic includes shape only, not job text");
    const unsavedSnapshot = browser.state().snapshot!, beforeCardMark = counts(), beforeCardRequests = requests;
    const originalMarkJob = service.markJob.bind(service);
    const rollbackJobCount = service.store.all("jobs").length;
    service.markJob = () => {throw new Error("offline simulated mark failure");};
    try {
      check(!(await browser.request({operation:"job.mark",payload:{snapshot_id:unsavedSnapshot.id,url:unsavedSnapshot.jobs[0]!.url,mark:"INTERESTED"}})).ok, "mark failure is reported");
      check(service.store.all("jobs").length === rollbackJobCount && !service.store.findSourceJob("IMPORT","desktop-browser:boss:OCRTEST123456"), "mark-and-save rollback leaves no partially saved job");
    } finally {service.markJob = originalMarkJob;}
    await window.webContents.executeJavaScript(`(() => {const el=document.querySelector('.boss-job select');el.value='INTERESTED';el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await new Promise(resolve=>setTimeout(resolve,150));
    check((await request("records",{snapshot_id:unsavedSnapshot.id})).records?.[unsavedSnapshot.jobs[0]!.url]?.mark === "INTERESTED", "marking an unsaved card saves and marks that job");
    check(counts() === beforeCardMark && requests === beforeCardRequests, "mark-and-save creates no communication or website requests");
    await fillLocal('.boss-filter-form input[maxlength="80"]', '武汉');
    check((await window.webContents.executeJavaScript(`document.querySelector('.boss-helper').innerText`)).includes("待核实：地点未读取"), "missing city remains visible as pending instead of disappearing");
    check((await window.webContents.executeJavaScript(`document.querySelector('.boss-results-header').innerText`)).includes("0 / 1"), "pending location is not counted as verified match");
    await fillLocal('.boss-filter-form input[maxlength="80"]', '');
    const salaryBefore=counts(),salaryRequests=requests;
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='识别此岗位薪资').click()`);
    const salaryEnd=Date.now()+10000;
    while(Date.now()<salaryEnd && !browser.state().snapshot?.jobs[0]?.salary_ocr)await new Promise(resolve=>setTimeout(resolve,40));
    const recognized=browser.state().snapshot!.jobs[0]!.salary_ocr;
    check(recognized?.candidate==='15-25K·13薪' && !recognized.confirmed,"real local OCR returns pending candidate from font-rendered pixels");
    await new Promise(resolve=>setTimeout(resolve,100));
    check((await window.webContents.executeJavaScript(`document.querySelector('.salary-ocr').innerText`)).includes('待核对'),"UI exposes candidate and explicit confirmation");
    const pending=browser.state().snapshot!;
    await request("save",{snapshot_id:pending.id,urls:pending.jobs.map(j=>j.url)});
    const salaryJob=()=>service.store.findSourceJob('IMPORT','desktop-browser:boss:OCRTEST123456')!;
    check(salaryJob().salary_raw===salaryFont.raw,"saving before confirmation retains raw salary");
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='已核对，采用此薪资').click()`);
    await new Promise(resolve=>setTimeout(resolve,100));
    const confirmed=browser.state().snapshot!;
    await request("save",{snapshot_id:confirmed.id,urls:confirmed.jobs.map(j=>j.url)});
    check(salaryJob().salary_raw==='15-25K·13薪' && salaryJob().extra.salary_source==='LOCAL_FONT_OCR_CONFIRMED',"checked salary is stored with provenance");
    check(counts()===salaryBefore && requests===salaryRequests,"OCR and confirmation create no communications or website requests");
    if (process.env.RA_DESKTOP_CAPTURE === "1") {
      try { writeFileSync(join(directory, "boss-helper-smoke.png"), (await window.webContents.capturePage()).toPNG()); }
      catch (error) { throw new Error(`App screenshot failed: ${String(error)}`); }
    }
    await finalView.webContents.loadURL("https://www.zhipin.com/hangzhou/");await settle();
    // The smoke window is intentionally hidden; allow its fixture scroll events to run.
    finalView.webContents.setBackgroundThrottling(false);
    // The fixture simulates a normal page request; production code never calls fetch.
    await finalView.webContents.executeJavaScript(`fetch('/wapi/zpgeek/job/detail.json').then(r=>r.json())`);
    await new Promise(resolve=>setTimeout(resolve,200));
    const responseRead=await request("read"),responseJob=responseRead.state.snapshot!.jobs[0]!;
    check(responseJob.salary==="12.5-18K·13薪" && responseJob.location==="武汉·江夏区" && !!responseJob.detail_response,"real Electron observer supplements salary and city from a fixture response");
    await request("save",{snapshot_id:responseRead.state.snapshot!.id,urls:[responseJob.url]});
    check(service.store.findSourceJob("IMPORT","desktop-browser:boss:RESPONSE123456")?.extra.salary_source==="BROWSER_DETAIL_RESPONSE","response provenance persists");
    const batchRequests=requests,batchCommunication=counts();
    await new Promise(resolve=>setTimeout(resolve,1300));
    check((await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='批量读取并保存' && !b.disabled)`)),"batch button is enabled on a loaded job list");
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='批量读取并保存').click()`);
    await new Promise(resolve=>setTimeout(resolve,200));
    check(browser.state().batch?.running,"UI starts batch task");
    await new Promise(resolve=>setTimeout(resolve,1300));
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='停止读取').click()`);
    for(let i=0;i<30 && browser.state().batch?.running;i++)await new Promise(resolve=>setTimeout(resolve,100));
    check(!browser.state().batch?.running && browser.state().batch?.reason.includes("已停止"),"UI stops an active batch");
    await request("batch.start");
    const batchEnd=Date.now()+12000;
    while(browser.state().batch?.running && Date.now()<batchEnd)await new Promise(resolve=>setTimeout(resolve,100));
    check(!browser.state().batch?.running && browser.state().batch?.reason.includes("没有新增"),"batch stops on repeated IDs without claiming exhaustion");
    check(browser.state().snapshot?.jobs.length===3 && !!service.store.findSourceJob("IMPORT","desktop-browser:boss:BATCHJOB123452"),`new batches are deduplicated and automatically saved (${JSON.stringify({batch:browser.state().batch,urls:browser.state().snapshot?.jobs.map(job=>job.url),ids:service.store.all<any>('jobs').map(job=>job.external_job_id)})})`);
    check(requests===batchRequests && counts()===batchCommunication,"batch controls issue no detail requests or communications");
    await request("response.disable");check(browser.state().response_status==="UNAVAILABLE","response observation can be disabled without navigation");
    check((await request("read.append")).state.snapshot!.jobs[0]!.salary==="12.5-18K·13薪","disabling observer retains previously read response evidence");
    await new Promise(resolve=>setTimeout(resolve,1400));
    check((await window.webContents.executeJavaScript(`document.querySelector('.boss-plugin').innerText`)).includes("批量读取结束"),"batch completion renders progress");
    writeFileSync(join(directory,"boss-batch-smoke.png"),(await window.webContents.capturePage()).toPNG());
    stage='multi-query';
    // Search workbench uses the hidden, isolated fixture browser, never the live site.
    await window.webContents.executeJavaScript(`document.querySelectorAll('nav button')[2].click()`);
    await new Promise(resolve=>setTimeout(resolve,250));
    check(!finalView.getVisible(),"search table hides the original webpage");
    stage='salary-enrichment';
    const salaryMessages=counts();
    await request('search.start',{...defaultSearchConfig,keywords:['薪资验证'],experience:'ALL',salary_min:5,salary_max:6,rounds:1});
    for(let i=0;i<160 && browser.state().search_running;i++)await new Promise(resolve=>setTimeout(resolve,50));
    const salaryRun=(await request('search.get')).search_run!;
    check(salaryRun.salary_progress?.updated===2 && salaryRun.results.length===2,'hidden sequential worker completes both salary types');
    check(salaryRun.results[0]!.job.salary==='5k-6k' && salaryRun.results[1]!.job.salary==='200-220元/天','monthly and daily values preserve original units');
    check(salaryRun.results.every(item=>item.job.salary_detail?.source==='DETAIL_DOM' && item.job.location==='武汉' && item.job.education==='本科'),'DOM provenance and detail requirement separators are parsed');
    check(finalView.webContents.getURL().includes('query=') && !finalView.webContents.getURL().includes('job_detail'),'salary worker does not navigate the search list');
    check(BrowserWindow.getAllWindows().length===1 && counts()===salaryMessages,'worker closes after enrichment and creates no communications');
    await new Promise(resolve=>setTimeout(resolve,2100));
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.search-results-toolbar button')).find(b=>b.textContent.startsWith('全部已读')).click()`);
    const salaryText=await window.webContents.executeJavaScript(`document.querySelector('.search-workspace').innerText`);
    check(salaryText.includes('5k-6k') && salaryText.includes('200-220元/天') && salaryText.includes('详情原文') && salaryText.includes('补全 2'),'salary provenance and progress render in search table');
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.search-results-toolbar button')).find(b=>b.textContent.startsWith('符合条件')).click()`);
    check((await window.webContents.executeJavaScript(`document.querySelectorAll('.search-table tbody tr').length`))===1,'monthly filters accept K at both endpoints and keep daily salary out');
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.search-results-toolbar button')).find(b=>b.textContent.startsWith('全部已读')).click()`);
    writeFileSync(join(directory,'boss-salary-detail-smoke.png'),(await window.webContents.capturePage()).toPNG());
    await request('search.save',{run_id:salaryRun.id,urls:salaryRun.results.map(item=>item.job.url)});
    check(service.store.findSourceJob('IMPORT','desktop-browser:boss:SALARYDAY123456')?.extra.salary_source==='BROWSER_DETAIL_DOM','saved salary keeps independent DOM evidence');
    stage='salary-stop';
    await request('search.start',{...defaultSearchConfig,keywords:['薪资停止'],rounds:1});
    for(let i=0;i<80 && !(await request('search.get')).search_run?.salary_progress?.running;i++)await new Promise(resolve=>setTimeout(resolve,30));
    check((await request('search.get')).search_run?.salary_progress?.running,'stop test reaches an in-flight detail');
    const stopAt=Date.now();await request('search.stop');
    for(let i=0;i<50 && browser.state().search_running;i++)await new Promise(resolve=>setTimeout(resolve,30));
    const stoppedSalary=(await request('search.get')).search_run!;
    check(!browser.state().search_running && Date.now()-stopAt<1500 && stoppedSalary.results[0]?.job.salary.includes('\uE001') && !stoppedSalary.results[0]?.job.salary_detail,'cancellation aborts loading promptly without adopting a late salary');
    check(BrowserWindow.getAllWindows().length===1,'cancelled worker is destroyed');
    stage='salary-security';
    await request('search.start',{...defaultSearchConfig,keywords:['薪资验证页'],rounds:1});
    for(let i=0;i<100 && browser.state().search_running;i++)await new Promise(resolve=>setTimeout(resolve,30));
    const blockedSalary=(await request('search.get')).search_run!;
    check(blockedSalary.status==='STOPPED' && blockedSalary.reason.includes('安全验证') && blockedSalary.results[0]?.job.salary.includes('\uE001'),'security redirect stops enrichment while retaining original jobs');
    check(BrowserWindow.getAllWindows().length===1 && counts()===salaryMessages,'blocked worker is destroyed without communication');
    stage='multi-query';
    const searchRequests=requests,searchCommunications=counts();
    await request("search.start",{...defaultSearchConfig,keywords:["Java","前端"],rounds:1});
    const searchEnd=Date.now()+10000;
    while(browser.state().search_running && Date.now()<searchEnd)await new Promise(resolve=>setTimeout(resolve,50));
    const search=(await request("search.get")).search_run!;
    check(search.status==="PARTIAL" && search.results.length===2 && search.pairs.every(pair=>pair.status==="LIMIT"),"multi-keyword search collects a fresh deduplicated dataset");
    check(search.results.every(item=>item.queries.length===2 && !!item.observed_at) && requests===searchRequests+2,"each query navigates once and every result has observation time and provenance");
    check(!search.results.some(item=>item.job.url.includes('BATCHJOB')),"historical batch results never fill fresh search");
    check(!(await browser.request({operation:"search.save",payload:{run_id:search.id,urls:['https://www.zhipin.com/job_detail/NOTFOUND123456.html']}})).ok,"saving rejects jobs outside the search run");
    await new Promise(resolve=>setTimeout(resolve,2100));
    check((await window.webContents.executeJavaScript(`document.querySelector('.search-table').innerText`)).includes('Java 开发 双休'),"search results render real parsed fixture cards");
    await window.webContents.executeJavaScript(`document.querySelector('.search-table input[type=checkbox]').click()`);
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.search-workspace button')).find(b=>b.textContent.startsWith('保存所选')).click()`);
    await new Promise(resolve=>setTimeout(resolve,150));
    check((await window.webContents.executeJavaScript(`document.querySelector('.search-workspace').innerText`)).includes('已保存 1 个岗位'),"selection saves through the UI");
    check(counts()===searchCommunications,"search and saving create no communication tasks or messages");
    stage='ui-stop';
    // Saved configuration is unchanged in the renderer; exercise its start/stop controls.
    await window.webContents.executeJavaScript(`document.querySelector('.search-settings summary').click()`);
    await fillLocal('.search-keywords input','Java');
    // This legacy test deliberately rereads already-saved fixture cards.
    await window.webContents.executeJavaScript(`(()=>{const input=Array.from(document.querySelectorAll('.search-config label')).find(label=>label.textContent.includes('跳过已保存岗位')).querySelector('input');if(input.checked)input.click();})()`);
    await window.webContents.executeJavaScript(`document.querySelector('.search-config button[type=submit]').click()`);
    await new Promise(resolve=>setTimeout(resolve,150));
    check(browser.state().search_running,"UI starts a new search");
    const second=(await request('search.get')).search_run!;
    check(second.id!==search.id && second.results.every(item=>item.queries.every(query=>query.includes('Java'))),"new run resets query provenance");
    for(let i=0;i<60 && !(await request('search.get')).search_run?.results.length && browser.state().search_running;i++)await new Promise(resolve=>setTimeout(resolve,50));
    check((await request('search.get')).search_run?.results.length===2,'stop-with-results scenario waits for its first observed batch');
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.search-workspace button')).find(b=>b.textContent==='停止获取' && b.offsetParent).click()`);
    for(let i=0;i<40 && browser.state().search_running;i++)await new Promise(resolve=>setTimeout(resolve,50));
    check(!browser.state().search_running && (await request('search.get')).search_run?.status==='STOPPED',"UI stops search promptly with preserved observations");
    await new Promise(resolve=>setTimeout(resolve,2100));
    writeFileSync(join(directory,'boss-search-smoke.png'),(await window.webContents.capturePage()).toPNG());
    stage='original-post';
    for(let i=0;i<80;i++){
      if(await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.search-table tbody tr')).some(row=>row.querySelector('strong')?.textContent==='Java 开发 双休' && !row.querySelector('button')?.disabled)`))break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.search-table tbody tr')).find(row=>row.querySelector('strong')?.textContent==='Java 开发 双休').querySelector('button').click()`);
    for(let i=0;i<100 && (finalView.webContents.getURL()!=='https://www.zhipin.com/job_detail/ABCDEF123456.html' || !finalView.getVisible() || finalView.webContents.isLoading());i++)await new Promise(resolve=>setTimeout(resolve,50));
    const originalLayout=await window.webContents.executeJavaScript(`JSON.stringify({hidden:document.hidden,page:document.querySelector('nav button[aria-current="page"]')?.textContent,host:document.querySelector('.boss-browser-host')?.getBoundingClientRect().toJSON(),errors:Array.from(document.querySelectorAll('.app-error,.boss-plugin-error')).map(e=>e.textContent)})`);
    check(finalView.webContents.getURL()==='https://www.zhipin.com/job_detail/ABCDEF123456.html' && finalView.getVisible(),`view original opens the canonical source in BOSS module (${finalView.webContents.getURL()}, visible=${finalView.getVisible()}, ${originalLayout})`);
    check(counts()===searchCommunications,"opening original post sends no communication");
    stage='java-normal-navigation';
    await window.webContents.executeJavaScript(`document.querySelectorAll('nav button')[2].click()`);
    await new Promise(resolve=>setTimeout(resolve,100));
    const originalSearchExecute=finalView.webContents.executeJavaScript.bind(finalView.webContents);
    let mutateDuringRead=true;
    finalView.webContents.executeJavaScript=async(script,userGesture)=>{
      const result=await originalSearchExecute(script,userGesture);
      if(mutateDuringRead && script.includes('const diagnostic=')){
        mutateDuringRead=false;
        await originalSearchExecute(`history.replaceState({},'',location.href+'&ka=during-read')`);
        await new Promise(resolve=>setTimeout(resolve,40));
        return {jobs:[{...search.results[0]!.job,url:'https://www.zhipin.com/job_detail/STALEPAGE123456.html'}],links:1,cards:1};
      }
      return result;
    };
    const javaConfig={...defaultSearchConfig,keywords:['java'],experience:'ALL' as const,rounds:1};
    await request('search.start',javaConfig);
    for(let i=0;i<100 && browser.state().search_running;i++)await new Promise(resolve=>setTimeout(resolve,50));
    const javaRun=(await request('search.get')).search_run!;
    check(javaRun.status==='PARTIAL' && javaRun.results.length===2 && javaRun.pairs[0]!.status==='LIMIT','java search survives asynchronous cards and normal SPA navigation');
    check(!javaRun.results.some(item=>item.job.url.includes('STALEPAGE')),'late data from an earlier page revision is discarded and reread');
    finalView.webContents.executeJavaScript=originalSearchExecute;
    await new Promise(resolve=>setTimeout(resolve,2100));
    stage='empty-classification';
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.search-results-toolbar button')).find(b=>b.textContent.startsWith('待核实')).click()`);
    check((await window.webContents.executeJavaScript(`document.querySelector('.search-table').innerText`)).includes('本次已读取 2 个岗位'),'empty classification reports fetched count instead of missing jobs');
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.search-table button')).find(b=>b.textContent==='查看全部已读岗位').click()`);
    check((await window.webContents.executeJavaScript(`document.querySelectorAll('.search-table tbody tr').length`))===2,'empty category can return to all fetched results');
    // An actual city change must still discard the in-flight result.
    stage='city-change';
    let changeCity=true;
    finalView.webContents.executeJavaScript=async(script,userGesture)=>{
      const result=await originalSearchExecute(script,userGesture);
      if(changeCity && script.includes('const diagnostic=')){
        changeCity=false;
        await originalSearchExecute(`(()=>{const url=new URL(location.href);url.searchParams.set('city','101020100');history.replaceState({},'',url.href);})()`);
        await new Promise(resolve=>setTimeout(resolve,40));
      }
      return result;
    };
    await request('search.start',javaConfig);
    for(let i=0;i<100 && browser.state().search_running;i++)await new Promise(resolve=>setTimeout(resolve,50));
    const changedRun=(await request('search.get')).search_run!;
    check(changedRun.results.length===0 && changedRun.status==='STOPPED' && changedRun.reason.includes('搜索条件已变化'),'real city change remains blocked without mixing data');
    finalView.webContents.executeJavaScript=originalSearchExecute;
    await new Promise(resolve=>setTimeout(resolve,2100));
    stage='zero-reading-feedback';
    check((await window.webContents.executeJavaScript(`document.querySelector('.search-table').innerText`)).includes('尚未进入筛选'),'zero fetched results show collection failure before filters');
    writeFileSync(join(directory,'boss-search-smoke.png'),(await window.webContents.capturePage()).toPNG());
    stage='ui-restart';
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.search-workspace button')).find(b=>b.textContent==='修改搜索条件').click()`);
    await fillLocal('.search-keywords input','java');
    await window.webContents.executeJavaScript(`(()=>{const select=document.querySelector('[aria-label="岗位类型 / 经验"]');select.value='ALL';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.search-results-toolbar button')).find(b=>b.textContent.startsWith('已排除')).click()`);
    await window.webContents.executeJavaScript(`document.querySelector('.search-config button[type=submit]').click()`);
    for(let i=0;i<80 && (await request('search.get')).search_run?.id===changedRun.id;i++)await new Promise(resolve=>setTimeout(resolve,50));
    check((await request('search.get')).search_run?.id!==changedRun.id,'UI restart creates a new run before waiting for completion');
    for(let i=0;i<800 && browser.state().search_running;i++)await new Promise(resolve=>setTimeout(resolve,50));
    check(!browser.state().search_running,'UI restart completes before testing restored history');
    await new Promise(resolve=>setTimeout(resolve,2100));
    check((await window.webContents.executeJavaScript(`document.querySelectorAll('.search-table tbody tr').length`))===1,'new UI search resets classification to the one keyword-matching result');
    writeFileSync(join(directory,'boss-search-smoke.png'),(await window.webContents.capturePage()).toPNG());
    check(counts()===searchCommunications,'navigation regression tests create no communications');
    stage='restore-history';
    window.webContents.reload();
    await new Promise<void>(resolve=>window.webContents.once('did-finish-load',()=>resolve()));
    for(let i=0;i<60;i++){
      if(await window.webContents.executeJavaScript(`document.querySelector('.search-progress')?.innerText.includes('历史读取结果')`))break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    check((await window.webContents.executeJavaScript(`document.querySelector('.search-progress').innerText`)).includes('历史读取结果'),"renderer reload labels restored results as history");
    check((await window.webContents.executeJavaScript(`document.querySelector('.search-keywords input').value`))==='java',"renderer reload restores latest search configuration");
    stage='breadth-continuation';
    await request('search.start',{...defaultSearchConfig,keywords:['广度验证'],experience:'ALL',rounds:3,salary_enrichment:false});
    for(let i=0;i<180 && browser.state().search_running;i++)await new Promise(resolve=>setTimeout(resolve,50));
    const breadthFirst=(await request('search.get')).search_run!;
    check(breadthFirst.results.length===15 && breadthFirst.pairs[0]?.status==='LIMIT' && breadthFirst.pairs[0]?.advance?.at_end===false,'first bounded segment stops in the middle rather than claiming exhaustion');
    const breadthRequests=requests;
    await new Promise(resolve=>setTimeout(resolve,2100));
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.search-workspace button')).find(b=>b.textContent==='继续获取').click()`);
    for(let i=0;i<80 && (await request('search.get')).search_run?.segment?.number!==2;i++)await new Promise(resolve=>setTimeout(resolve,50));
    for(let i=0;i<220 && browser.state().search_running;i++)await new Promise(resolve=>setTimeout(resolve,50));
    const breadthNext=(await request('search.get')).search_run!;
    check(breadthNext.id===breadthFirst.id && breadthNext.results.length===30 && breadthNext.segment?.added===15 && breadthNext.segment.number===2,'UI continuation crosses the initial fifteen-card boundary and preserves the same run');
    check(requests===breadthRequests && breadthNext.segment?.refreshed===15,'continuation reuses the current scroll position without reloading and reports overlap');
    check(!(await browser.request({operation:'search.continue',payload:{run_id:search.id}})).ok,'continuation rejects an obsolete run');
    await new Promise(resolve=>setTimeout(resolve,2100));
    const breadthText=await window.webContents.executeJavaScript(`document.querySelector('.search-workspace').innerText`);
    check(breadthText.includes('新增 15 个') && breadthText.includes('重读已有 15 个') && (await window.webContents.executeJavaScript(`document.querySelectorAll('.search-table tbody tr').length`))===30,'continuation counts and thirty result rows render');
    await window.webContents.executeJavaScript(`document.querySelector('.search-progress details').open=true`);
    writeFileSync(join(directory,'boss-breadth-smoke.png'),(await window.webContents.capturePage()).toPNG());
    stage='safe-pagination';
    await request('search.start',{...defaultSearchConfig,keywords:['翻页验证'],experience:'ALL',rounds:5,salary_enrichment:false});
    for(let i=0;i<180 && browser.state().search_running;i++)await new Promise(resolve=>setTimeout(resolve,50));
    const paged=(await request('search.get')).search_run!;
    check(paged.results.length===2 && paged.pairs[0]?.status==='END' && finalView.webContents.getURL().includes('page=2'),'explicit official next page loads additional jobs and disabled next reports source end');
    check(!(await finalView.webContents.executeJavaScript(`!!window.talked`)) && counts()===searchCommunications,'pagination never clicks communication or creates messages');
    stage='verify-and-save';
    const repairConfig={...actualDefaultSearchConfig,keywords:['补全验证'],experience:'ALL' as const,rounds:1,salary_enrichment:false,salary_period:'DAY' as const,salary_min:200,salary_max:220,skip_processed:false};
    await request('search.start',repairConfig);
    for(let i=0;i<100 && browser.state().search_running;i++)await new Promise(resolve=>setTimeout(resolve,50));
    const repairSeed=(await request('search.get')).search_run!,pageReads=searchPageRequests,originalList=finalView.webContents.getURL();
    check(repairSeed.results.length===2 && repairSeed.results.every(item=>item.job.salary.includes('\uE001')),'repair seed contains two real parsed missing-field fixtures');
    await new Promise(resolve=>setTimeout(resolve,2100));
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.search-workspace button')).find(b=>b.textContent.startsWith('补全待核实')).click()`);
    for(let i=0;i<80 && (await request('search.get')).search_run?.activity!=='VERIFY';i++)await new Promise(resolve=>setTimeout(resolve,50));
    for(let i=0;i<240 && browser.state().search_running;i++)await new Promise(resolve=>setTimeout(resolve,50));
    const repaired=(await request('search.get')).search_run!;
    check(repaired.id===repairSeed.id && repaired.detail_progress?.updated===2 && repaired.detail_progress.checked===2 && !repaired.detail_progress.running,'manual repair fills both pending jobs under the same run');
    check(searchPageRequests===pageReads && finalView.webContents.getURL()===originalList && repaired.results.every((item,i)=>item.observed_at===repairSeed.results[i]!.observed_at),'repair never rescans the search page or refreshes list observation dates');
    check(repaired.results[1]!.job.salary==='200-220元/天' && repaired.results[0]!.job.salary==='5k-6k' && repaired.results.every(item=>item.job.location==='武汉'),'repair preserves daily/monthly units and fills missing city');
    check(BrowserWindow.getAllWindows().length===1,'manual repair closes its hidden detail window');
    await new Promise(resolve=>setTimeout(resolve,2100));
    check((await window.webContents.executeJavaScript(`document.querySelector('.search-workspace').innerText`)).includes('字段补全结束'),'repair progress renders');
    writeFileSync(join(directory,'boss-verification-smoke.png'),(await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.search-workspace button')).find(b=>b.textContent==='保存全部符合').click()`);
    for(let i=0;i<80 && !service.savedBossUrls().some(url=>url.includes('VERIFYDAY'));i++)await new Promise(resolve=>setTimeout(resolve,50));
    check(service.savedBossUrls().some(url=>url.includes('VERIFYDAY')) && !service.savedBossUrls().some(url=>url.includes('VERIFYMONTH')),'save-all includes only verified daily matches');
    await new Promise(resolve=>setTimeout(resolve,2100));
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.search-results-toolbar button')).find(b=>b.textContent.startsWith('全部已读')).click()`);
    check((await window.webContents.executeJavaScript(`document.querySelectorAll('.search-table tbody tr').length`))===1 && !(await window.webContents.executeJavaScript(`document.querySelector('.search-table').innerText`)).includes('Java日薪岗位'),'saved job disappears immediately from search results');
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.search-workspace label')).find(label=>label.textContent.includes('显示已保存岗位')).querySelector('input').click()`);
    check((await window.webContents.executeJavaScript(`document.querySelectorAll('.search-table tbody tr').length`))===2,'show-saved override reveals the preserved observation');
    await request('search.start',repairConfig);
    for(let i=0;i<100 && browser.state().search_running;i++)await new Promise(resolve=>setTimeout(resolve,50));
    const skipped=(await request('search.get')).search_run!;
    check(skipped.results.length===1 && skipped.skipped_saved===1 && skipped.results[0]!.job.url.includes('VERIFYMONTH'),'future scan skips saved card before parsing without dropping unsaved cards');
    await request('search.save',{run_id:skipped.id,urls:skipped.results.map(item=>item.job.url)});
    await request('search.start',repairConfig);
    for(let i=0;i<100 && browser.state().search_running;i++)await new Promise(resolve=>setTimeout(resolve,50));
    const allSaved=(await request('search.get')).search_run!;
    check(allSaved.results.length===0 && allSaved.skipped_saved===2 && allSaved.pairs[0]?.status!=='FAILED','all-saved list is recognized rather than reported as extraction failure');
    window.webContents.reload();await new Promise<void>(resolve=>window.webContents.once('did-finish-load',()=>resolve()));
    for(let i=0;i<80;i++){if(await window.webContents.executeJavaScript(`document.querySelector('.search-table')?.innerText.includes('已跳过 2 个')`))break;await new Promise(resolve=>setTimeout(resolve,50));}
    check((await window.webContents.executeJavaScript(`document.querySelector('.search-table').innerText`)).includes('已跳过 2 个'),'reload retains saved skip list and explicit all-saved feedback');
    writeFileSync(join(directory,'boss-saved-skip-smoke.png'),(await window.webContents.capturePage()).toPNG());
    await runSavedManagement();
    await runIncremental();
    check(counts()===searchCommunications,'repair and persistent saving create no messages or communication tasks');
    check(rendererErrors.length===0,`renderer console has no errors: ${rendererErrors.join(';')}`);
    window.hide();
    return { offline: true, jobs: 2, salary_ocr:true, salary_candidate:'15-25K·13薪', salary_confirmation:true, repeated_reads:20, city_layout: true, security_page_guard: true, full_page_bounds: true, deduplicated: true, communication: "NOT_EXECUTED", filter: "1/2", persistent_filter:true, personal_mark:true, persistent_session: true, timeout_guard: true, navigation_guard: true, isolated_remote_page: true, module_switch_preserved: true, bounds_checked: true, search_workbench:true, fresh_multi_query:true, search_stop:true, original_post:true, search_history:true, renderer_errors:rendererErrors.length, capture_requested: process.env.RA_DESKTOP_CAPTURE === "1" };
  } catch(error){throw new Error(`BOSS_BROWSER_SMOKE (${stage}): ${String(error)}; renderer: ${rendererErrors.join(';')}`);}
  finally {window.webContents.executeJavaScript=localExecute;window.webContents.removeListener('console-message',consoleListener); browser.dispose(); partition.protocol.unhandle("https"); }
}
