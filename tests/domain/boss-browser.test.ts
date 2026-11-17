import test from "node:test";
import assert from "node:assert/strict";
import { allowedBossUrl, canReadBossJobs, bossPageKind, canonicalBossJob, bossBrowserRequest, filterBrowserJobs, evaluateBrowserJob, type BrowserJob } from "../../packages/contracts/src/boss-browser.js";
import { browserJobInput, validateBrowserJobs, mergeBrowserRead } from "../../apps/desktop/src/main/boss-reader.js";

const job: BrowserJob = { url: "https://www.zhipin.com/job_detail/ABCDEF123456.html", title: "Java 开发 双休", company: "测试企业", salary: "140-280元/天", location: "武汉·江夏区", education: "本科", experience: "应届生", tags: ["本科", "应届生"] };
test("BOSS browser navigation rejects credentials, foreign domains and executable schemes", () => {
  for (const url of ["file:///E:/secret", "javascript:alert(1)", "http://www.zhipin.com/", "https://www.zhipin.com.evil.example/", "https://evilzhipin.com/", "https://user:pass@www.zhipin.com/", "https://www.zhipin.com:444/"]) assert.equal(allowedBossUrl(url), false, url);
  assert.equal(allowedBossUrl("https://www.zhipin.com/web/geek/jobs"), true);
  assert.equal(allowedBossUrl("https://passport.zhipin.com/"), true);
  assert.equal(canonicalBossJob(`${job.url}?securityId=private&ka=tracking`), job.url);
  assert.equal(canonicalBossJob("https://www.zhipin.com/web/geek/chat"), null);
  assert.equal(canonicalBossJob("https://other.example/job_detail/ABCDEF123456.html"), null);
  for (const path of ["/login/", "/chat/", "/user/", "/web/geek/chat", "/web/geek/resume", "/web/geek/settings"]) assert.equal(canReadBossJobs(`https://www.zhipin.com${path}`), false);
  assert.equal(canReadBossJobs("https://www.zhipin.com/wuhan/?ka=home"), true);
  assert.equal(canReadBossJobs("https://passport.zhipin.com/"), false);
});
test("Security and login pages are distinguished from jobs without following callback URLs", () => {
  const url = "https://www.zhipin.com/web/passport/zp/security.html?callbackUrl=https%3A%2F%2Fwww.zhipin.com%2Fweb%2Fgeek%2Fjobs&seed=fixture-secret";
  assert.equal(bossPageKind(url), "SECURITY");
  assert.equal(canReadBossJobs(url), false);
  assert.equal(bossPageKind("https://www.zhipin.com/web/user/"), "LOGIN");
  assert.equal(bossPageKind("https://www.zhipin.com/web/geek/jobs"), "JOBS");
  assert.equal(bossPageKind(job.url), "DETAIL");
});
test("BOSS browser IPC admits no sending, arbitrary JS or unbounded payloads", () => {
  for (const operation of ["send", "GREETING", "executeJavaScript", "login", "cookies"]) assert.equal(bossBrowserRequest.safeParse({ operation, payload: {} }).success, false);
  assert.equal(bossBrowserRequest.safeParse({ operation: "read", payload: { script: "alert(1)" } }).success, false);
  assert.equal(bossBrowserRequest.safeParse({ operation: "job.open", payload: { url: `${job.url}?securityId=secret` } }).success, false);
  assert.equal(bossBrowserRequest.safeParse({ operation: "layout", payload: { visible: true, x: -1, y: 0, width: 800, height: 600 } }).success, false);
});
test("Card shortcuts only accept a bounded local mark or a canonical job from a UUID snapshot", () => {
  const snapshot_id = "123e4567-e89b-42d3-a456-426614174000";
  assert.equal(bossBrowserRequest.safeParse({operation:"job.locate",payload:{snapshot_id,url:job.url}}).success,true);
  assert.equal(bossBrowserRequest.safeParse({operation:"job.mark",payload:{snapshot_id,url:job.url,mark:"INTERESTED"}}).success,true);
  for (const payload of [{snapshot_id,url:job.url,mark:"SEND"},{snapshot_id,url:job.url,mark:"INTERESTED",message:"hi"},{snapshot_id,url:`${job.url}?token=private`,mark:"INTERESTED"}]) assert.equal(bossBrowserRequest.safeParse({operation:"job.mark",payload}).success,false);
  assert.equal(bossBrowserRequest.safeParse({operation:"job.locate",payload:{snapshot_id,url:"https://www.zhipin.com/web/geek/chat"}}).success,false);
  assert.equal(bossBrowserRequest.safeParse({operation:"records",payload:{snapshot_id:"old",urls:[job.url]}}).success,false);
});
test("BOSS DOM observations preserve salary units and unknowns without inferring qualifications", () => {
  const input = browserJobInput(job, "2026-10-10T00:00:00.000Z");
  assert.equal(input.mode, "IMPORT"); assert.equal(input.status, "UNVERIFIED");
  assert.equal(input.salary_raw, "140-280元/天");
  assert.equal(input.salary_min, null); assert.equal(input.salary_period, null);
  assert.equal(input.recruitment_type, null); assert.equal(input.experience_range, null);
  assert.equal(input.source_url, job.url);
  assert.throws(() => validateBrowserJobs([{ ...job, cookies: "secret" }]));
  assert.throws(() => validateBrowserJobs([{ ...job, url: `${job.url}?token=secret` }]));
});
test("Local filters require all keywords, respect exclusions and do not treat missing education as a match", () => {
  const jobs = [job, { ...job, title: "Java 外包", education: "", location: "北京" }];
  assert.deepEqual(filterBrowserJobs(jobs, { keyword: "JAVA 双休", city: "武汉", education: "本科", exclude: "外包，销售" }), [job]);
  assert.equal(filterBrowserJobs(jobs, { keyword: "", city: "", education: "本科", exclude: "" }).length, 1);
  assert.equal(filterBrowserJobs(jobs, { keyword: "", city: "", education: "", exclude: "" }).length, 2);
});
const emptyFilter = { keyword: "", city: "", education: "", exclude: "" };
test("Appending pages retains unique jobs and their own observation time while updating repeated jobs", () => {
  const first = {...job,url:"https://www.zhipin.com/job_detail/FIRSTJOB123456.html"};
  const old={id:"old",jobs:[first,job],page_url:"https://www.zhipin.com/wuhan/",observed_at:"2026-10-11T01:00:00.000Z"};
  const next={page_url:"https://www.zhipin.com/shanghai/",observed_at:"2026-10-11T02:00:00.000Z"};
  const third={...job,url:"https://www.zhipin.com/job_detail/THIRDJOB123456.html",location:"上海"};
  const merged=mergeBrowserRead(old,[{...job,salary:"20-30K"},third],next,true);
  assert.equal(merged.jobs.length,3);
  assert.deepEqual(merged.summary,{read:2,added:1,repeated:1,total:3});
  assert.equal(merged.jobs[1]!.salary,"20-30K");
  assert.equal(merged.observations[first.url]!.observed_at,old.observed_at);
  assert.deepEqual(merged.observations[third.url],next);
  assert.equal(old.jobs[1]!.salary,job.salary);
  assert.equal(filterBrowserJobs(merged.jobs,{...emptyFilter,city:"上海"}).length,1);
  const repeated=mergeBrowserRead({...old,...merged},[third],next,true);
  assert.equal(repeated.jobs.length,3);assert.equal(repeated.summary.added,0);
});
test("Fresh reads replace a collection; reobserved salaries do not reuse earlier OCR mappings", () => {
  const old={id:"old",jobs:[{...job,salary_ocr:{candidate:"20-30K",confidence:90,preview:"data:image/png;base64,YQ==",confirmed:true}}],page_url:"https://www.zhipin.com/wuhan/",observed_at:"2026-10-11T01:00:00.000Z"};
  const next={page_url:old.page_url,observed_at:"2026-10-11T02:00:00.000Z"};
  assert.equal(mergeBrowserRead(old,[job],next,true).jobs[0]!.salary_ocr,undefined);
  const fresh={...job,url:"https://www.zhipin.com/job_detail/FRESHJOB123456.html"};
  assert.deepEqual(mergeBrowserRead(old,[fresh],next,false).jobs,[fresh]);
  assert.equal(mergeBrowserRead(null,[job,job],next,true).jobs.length,1);
});
test("Collection limit is explicit and saving more than a single page is allowed", () => {
  const jobs=Array.from({length:500},(_,i)=>({...job,url:`https://www.zhipin.com/job_detail/LIMITJOB${String(i).padStart(6,'0')}.html`}));
  const old={id:"123e4567-e89b-42d3-a456-426614174000",jobs,page_url:"https://www.zhipin.com/wuhan/",observed_at:"2026-10-11T01:00:00.000Z"};
  assert.throws(()=>mergeBrowserRead(old,[job],{page_url:old.page_url,observed_at:old.observed_at},true),/超过 500/);
  assert.equal(old.jobs.length,500);
  assert.equal(mergeBrowserRead(old,[jobs[0]!],{page_url:old.page_url,observed_at:old.observed_at},true).jobs.length,500);
  assert.equal(bossBrowserRequest.safeParse({operation:"save",payload:{snapshot_id:old.id,urls:jobs.map(j=>j.url)}}).success,true);
  assert.equal(bossBrowserRequest.safeParse({operation:"read.append",payload:{}}).success,true);
});
test("City filters normalize municipal suffix, invisible spacing and district separators, with city alternatives", () => {
  const jobs = [job, {...job, location:"北京·海淀区"}, {...job, company:"武汉科技",location:"上海"}];
  assert.deepEqual(filterBrowserJobs(jobs,{...emptyFilter,city:" 武\u200b汉市 "}),[job]);
  assert.deepEqual(filterBrowserJobs(jobs,{...emptyFilter,city:"武汉 江夏区"}),[job]);
  assert.equal(filterBrowserJobs(jobs,{...emptyFilter,city:"武汉；北京市"}).length,2);
  assert.equal(filterBrowserJobs([{...job,location:"济南·市中区"}],{...emptyFilter,city:"市中区"}).length,1);
});
test("Unknown location or education remains pending and a known mismatch still excludes it", () => {
  const missing = {...job,location:"",education:""};
  assert.equal(evaluateBrowserJob(missing,{...emptyFilter,city:"武汉",education:"本科"}).status,"UNKNOWN");
  assert.equal(filterBrowserJobs([missing],{...emptyFilter,city:"武汉"}).length,0);
  assert.equal(evaluateBrowserJob({...missing,title:"销售"},{...emptyFilter,city:"武汉",exclude:"销售"}).status,"EXCLUDED");
  assert.equal(evaluateBrowserJob({...job,location:"北京"},{...emptyFilter,city:"武汉"}).status,"EXCLUDED");
  assert.equal(evaluateBrowserJob({...job,location:"江夏区"},{...emptyFilter,city:"武汉"}).status,"UNKNOWN");
});
test("Education variants match the stated requirement without assuming applicant eligibility", () => {
  assert.equal(filterBrowserJobs([{...job,education:"大学本科及以上"}],{...emptyFilter,education:"本科"}).length,1);
  assert.equal(filterBrowserJobs([{...job,education:"大专以上"}],{...emptyFilter,education:"本科"}).length,0);
  assert.equal(filterBrowserJobs([{...job,education:"不限学历"}],{...emptyFilter,education:"学历不限"}).length,1);
  assert.equal(filterBrowserJobs([{...job,education:"本科/硕士"}],{...emptyFilter,education:"本科"}).length,1);
  assert.equal(filterBrowserJobs([{...job,education:"中专/中技"}],{...emptyFilter,education:"本科"}).length,0);
});
test("Keyword matching is literal, normalized, and does not confuse Java with JavaScript or Go with Google", () => {
  const javascript = {...job,title:"JavaScript 工程师",tags:[]};
  assert.equal(filterBrowserJobs([javascript],{...emptyFilter,keyword:"Java"}).length,0);
  assert.equal(filterBrowserJobs([{...job,title:"Google 工程师",tags:[]}],{...emptyFilter,keyword:"Go"}).length,0);
  assert.equal(filterBrowserJobs([{...job,title:"Ｃ＋＋ 开发"}],{...emptyFilter,keyword:"C++"}).length,1);
  assert.equal(filterBrowserJobs([job],{...emptyFilter,keyword:"ＪＡＶＡ；双休"}).length,1);
  assert.equal(filterBrowserJobs([javascript],{...emptyFilter,exclude:"Java"}).length,1);
  assert.equal(filterBrowserJobs([job],{...emptyFilter,exclude:"销售；双休"}).length,0);
});
