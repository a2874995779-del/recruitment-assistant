import { browserJobSchema, BROWSER_COLLECTION_LIMIT, type BrowserJob, type BrowserSnapshot, type BrowserObservation } from "../../../../packages/contracts/src/boss-browser.js";
import { jobInput, type JobInput } from "../../../../packages/contracts/src/index.js";
import { z } from "zod";
import { enrichBrowserJob } from "./boss-response.js";

// Serialized into the isolated remote page. Reads rendered job cards only;
// no fetch, hidden app stores, cookies, input changes, clicks or timers.
export function extractBossCards(diagnostic = { invalid_link: 0, invisible: 0, missing_title: 0, missing_company: 0, missing_location: 0, missing_education: 0, structures: [] as string[] }, knownUrls: string[] = [], ignoredUrls:string[]=[], stats={skipped_saved:0,skipped_urls:[] as string[]}) {
  const result = [];
  const seen = new Set();
  // Selector priority matters: an empty placeholder must not mask a later field.
  const clean = (value: string | null, max = 200) => (value ?? "").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").trim().replace(/\s+/g, " ").slice(0, max);
  const text = (root: Element, selectors: string, max = 200): string => {
    for (const selector of selectors.split(",")) {
      for (const node of Array.from(root.querySelectorAll(selector)).slice(0, 30)) {
        if (!node.getClientRects().length || getComputedStyle(node).visibility === "hidden") continue;
        const value = clean(node.textContent, max);
        if (value) return value;
      }
    }
    return "";
  };
  const known = new Set(knownUrls),ignored=new Set(ignoredUrls);
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/job_detail/"]')).slice(0, 1200);
  const priority = (anchor: HTMLAnchorElement) => {try {const url=new URL(anchor.href);return known.has(`${url.origin}${url.pathname}`) ? 1 : 0;}catch{return 0;}};
  if (known.size) anchors.sort((a,b)=>priority(a)-priority(b));
  for (const anchor of anchors) {
    let u: URL;
    try { u = new URL(anchor.href); } catch { diagnostic.invalid_link++; continue; }
    if (u.origin !== "https://www.zhipin.com" || !/^\/job_detail\/[A-Za-z0-9_-]{8,200}\.html$/.test(u.pathname)) { diagnostic.invalid_link++; continue; }
    const url = `${u.origin}${u.pathname}`;
    if (seen.has(url)) continue;
    let card = anchor.closest(".job-card-wrapper,.job-card-wrap,.job-card-box,.job-card,.job-list-item,.sub-li,li");
    // Some lists put the job link inside a named sub-card, while company info
    // is a sibling in the outer row. Never climb beyond one recognized row.
    const row = anchor.closest("li.job-card-wrapper,li.job-card-box,li.job-card-wrap,li.job-list-item");
    if (row) card = row;
    if (!card || !anchor.getClientRects().length || !card.getClientRects().length || getComputedStyle(card).visibility === "hidden" || getComputedStyle(card).display === "none") { diagnostic.invisible++; continue; }
    if(ignored.has(url)){seen.add(url);stats.skipped_saved++;stats.skipped_urls.push(url);continue;}
    if (diagnostic.structures.length < 3) {
      // Shape only: no text, hrefs, input values, IDs, HTML or session tokens.
      const shape = [card, ...Array.from(card.querySelectorAll("*")).slice(0, 70)].map(n => `${n.tagName.toLowerCase()}.${Array.from(n.classList).slice(0, 5).join(".")}`).join(" > ").slice(0, 3500);
      if (!diagnostic.structures.includes(shape)) diagnostic.structures.push(shape);
    }
    // On current city pages the two `.name` fields have different meanings.
    // Scope job name to the job link and company name to the company link.
    const title = text(card, ".job-name,.job-title-text,.job-name-text") || text(anchor, ".sub-li-info .name,.job-info .name,.name,.job-title") || clean(anchor.getAttribute("title")) || text(card, ".job-title");
    const company = text(card, ".company-name,.company-title,.sub-li-bottom .user-info .name,.company-info .name,.company-info h3,.company-info h4,.company-text .name,.company-info a[href*='/gongsi/'],a[href*='/gongsi/']");
    if (!title) diagnostic.missing_title++;
    if (!company) diagnostic.missing_company++;
    if (!title || !company) continue; // Unknown markup stays unknown.
    const tagNodes = card.querySelectorAll(".tag-list li,.tag-list span,.job-tag-list li,.job-tag-list span,.job-text span,.job-labels span");
    const tags = [...new Set(Array.from(tagNodes).filter(n => n.getClientRects().length && getComputedStyle(n).visibility !== "hidden").map(n => clean(n.textContent, 100)).filter(Boolean))].slice(0, 20);
    // Read the whole location wrapper before individual district nodes. Join
    // split city/district fields without borrowing the page's selected city.
    const parts = [text(card, ".job-city,.area-city", 100), text(card, ".area-district", 100)].filter(Boolean);
    const cityLocation = card.matches(".sub-li") ? text(card, ".job-text span", 100) : "";
    const location = text(card, ".job-area-wrapper,.job-area,.job-location,.job-address,.area-text", 100) || [...new Set(parts)].join("·").slice(0, 100) || cityLocation;
    const educationLabel = (value: string) => /^(学历不限|不限学历|(?:大学)?(?:初中及以下|中专|中技|高中|大专|本科|硕士|博士)(?:学历|毕业)?(?:及以上|以上)?)$/.test(value.trim());
    const education = text(card, ".job-education,.education", 40) || (tags.find(t => t.split(/[/、或]/).every(educationLabel)) ?? "");
    if (!location) diagnostic.missing_location++;
    if (!education) diagnostic.missing_education++;
    result.push({ url, title, company, salary: text(card, ".salary,.job-salary,.salary-text,.job-salary-text"), location,
      education,
      experience: tags.find(t => /经验|应届|\d+.*年/.test(t)) ?? "", tags });
    seen.add(url);
    if (result.length >= 100) break;
  }
  return result;
}
export function bossReadScript(knownUrls: string[] = [],ignoredUrls:string[]=[]) {
  return `(() => { const diagnostic={invalid_link:0,invisible:0,missing_title:0,missing_company:0,missing_location:0,missing_education:0,structures:[]}; const stats={skipped_saved:0,skipped_urls:[]}; const jobs = (${extractBossCards.toString()})(diagnostic,${JSON.stringify(knownUrls)},${JSON.stringify(ignoredUrls)},stats); return {jobs,diagnostic,skipped_saved:stats.skipped_saved,skipped_urls:stats.skipped_urls,links:Math.min(10000,document.querySelectorAll('a[href*="/job_detail/"]').length), cards:Math.min(10000,document.querySelectorAll('.job-card-wrapper,.job-card-wrap,.job-card-box,.job-card,.job-list-item,.sub-li').length)}; })()`;
}
export const BOSS_READ_SCRIPT = bossReadScript();
const diagnosticSchema = z.object({ invalid_link: z.number().int().min(0).max(1200), invisible: z.number().int().min(0).max(1200), missing_title: z.number().int().min(0).max(1200), missing_company: z.number().int().min(0).max(1200), missing_location:z.number().int().min(0).max(100).default(0), missing_education:z.number().int().min(0).max(100).default(0), structures: z.array(z.string().max(3500)).max(3) }).strict();
const pageReadSchema = z.object({ skipped_urls:z.array(browserJobSchema.shape.url).max(1200).optional(), skipped_saved:z.number().int().min(0).max(1200).optional(), jobs: browserJobSchema.array().max(100), links: z.number().int().min(0).max(10000), cards: z.number().int().min(0).max(10000), diagnostic: diagnosticSchema.optional() }).strict();
export function validateBrowserRead(raw: unknown) {
  // Arrays remain accepted for isolated test harnesses and existing adapters.
  if (Array.isArray(raw)) return { jobs: validateBrowserJobs(raw), links: 0, cards: 0 };
  return pageReadSchema.parse(raw);
}
export function validateBrowserJobs(raw: unknown): BrowserJob[] {
  return browserJobSchema.array().max(100).parse(raw);
}
export function mergeBrowserRead(previous: BrowserSnapshot | null, jobs: BrowserJob[], observation: BrowserObservation, append: boolean) {
  const collected = new Map<string,BrowserJob>();
  const observations: Record<string,BrowserObservation> = {};
  if (append && previous) for (const job of previous.jobs) {
    collected.set(job.url,job);
    observations[job.url] = previous.observations?.[job.url] ?? {page_url:previous.page_url,observed_at:previous.observed_at};
  }
  const existing = new Set(collected.keys());
  let added = 0, repeated = 0;
  for (const job of jobs) {
    if (existing.has(job.url)) repeated++; else added++;
    existing.add(job.url);
    const old=previous?.jobs.find(item=>item.url===job.url);
    const sameIdentity=old?.title===job.title && old.company===job.company;
    const detail = job.detail ?? (sameIdentity?old?.detail:undefined);
    const enriched=job.detail_response?job:enrichBrowserJob(job,sameIdentity?old ?? null:null);
    collected.set(job.url, {...enriched,...(enriched.detail || detail ? {detail:enriched.detail ?? detail} : {})});
    observations[job.url] = {...observation};
  }
  if (collected.size > BROWSER_COLLECTION_LIMIT) throw new Error(`累计岗位超过 ${BROWSER_COLLECTION_LIMIT} 个，本次未追加。请先保存所选岗位，再点击“读取岗位”开始新一轮。`);
  return {jobs:[...collected.values()],observations,summary:{read:jobs.length,added,repeated,total:collected.size}};
}
// User-triggered scrolling only. Never click a job or communication control.
export function locateBossCard(url: string): boolean {
  for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/job_detail/"]')).slice(0, 1200)) {
    let parsed: URL;
    try {parsed = new URL(anchor.href);} catch {continue;}
    if (`${parsed.origin}${parsed.pathname}` !== url) continue;
    const card = anchor.closest("li.job-card-wrapper,li.job-card-wrap,li.job-card-box,li.job-list-item") || anchor.closest(".job-card-wrapper,.job-card-wrap,.job-card-box,.job-card,.job-list-item,.sub-li,li");
    if (!card || !anchor.getClientRects().length || !card.getClientRects().length || getComputedStyle(card).visibility === "hidden") continue;
    card.scrollIntoView({block:"center",inline:"nearest",behavior:"instant"});
    return true;
  }
  return false;
}
export function browserJobInput(job: BrowserJob, observedAt: string): JobInput {
  return jobInput.parse({ external_job_id: new URL(job.url).pathname.split("/").pop()!.replace(/\.html$/, ""),
    source_instance_id: "desktop-browser:boss", source_url: job.url, platform: "boss", mode: "IMPORT", title: job.title,
    company_name: job.company, locations: job.location ? [job.location] : null, salary_raw: (job.salary_ocr?.confirmed ? job.salary_ocr.candidate : job.salary) || null,
    education: job.education || null, experience_raw: job.experience || null, tags: job.tags, description:job.detail?.description || null, status: "UNVERIFIED",
    apply_target: { kind: "UNKNOWN", url: job.url },
    extra: { capture_method: "LOCAL_BROWSER_DOM", observed_at: observedAt, automatic_collection: false, salary_warning: "保留原站文本，不推断币种或周期", ...(job.detail ? {boss_detail:job.detail} : {}), ...(job.detail_response ? {boss_detail_response:job.detail_response,...(job.detail_response.salary?{salary_source:"BROWSER_DETAIL_RESPONSE"}:{})} : {}), ...(job.salary_detail ? {boss_salary_detail:job.salary_detail,salary_source:job.salary_detail.source==='DETAIL_RESPONSE'?'BROWSER_DETAIL_RESPONSE':'BROWSER_DETAIL_DOM',salary_original:job.salary_detail.original} : {}), ...(job.salary_ocr?.confirmed ? {salary_source:"LOCAL_FONT_OCR_CONFIRMED",salary_original:job.salary} : {}) } });
}

// A bounded scroll of the actual job list. Never click cards or controls.
export function advanceBossList():boolean {
  if(Array.from(document.querySelectorAll('.verify-wrap,.geetest_panel,.captcha-container,[class*="security-check"]')).some(node=>node.getClientRects().length && getComputedStyle(node).visibility!=="hidden"))return false;
  const list=Array.from(document.querySelectorAll(".rec-job-list,.job-list-box,.job-list-container,.job-list,ul")).find(node=>node.getClientRects().length && getComputedStyle(node).visibility!=="hidden" && node.querySelector('.job-card-wrapper a[href*="/job_detail/"],.job-card-box a[href*="/job_detail/"],.job-card-wrap a[href*="/job_detail/"],.sub-li a[href*="/job_detail/"]'));
  if(!list)return false;
  let node:Element|null=list;
  for(let i=0;node && i<7;i++,node=node.parentElement){
    const style=getComputedStyle(node);
    if(/auto|scroll/.test(style.overflowY) && node.scrollHeight>node.clientHeight+4){node.scrollBy({top:Math.max(200,node.clientHeight*0.85),behavior:"instant"});return true;}
  }
  const scrolling=document.scrollingElement;
  if(scrolling && scrolling.scrollHeight>scrolling.clientHeight+4){window.scrollBy({top:Math.max(200,innerHeight*0.85),behavior:"instant"});return true;}
  return false;
}

/** Read-only list progression. Only an explicit pagination next control may be
 * clicked; job, chat, interest, resume and arbitrary page controls are excluded.
 * This function is serialized into the remote page and must be self-contained. */
export function advanceBossSearchList() {
  const visible=(node:Element)=>!!node.getClientRects().length && getComputedStyle(node).visibility!=='hidden' && getComputedStyle(node).display!=='none';
  const anchors=Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/job_detail/"]')).slice(0,1200).filter(anchor=>visible(anchor) && anchor.closest('.job-card-wrapper,.job-card-wrap,.job-card-box,.job-card,.job-list-item,.sub-li'));
  const cards=[...new Set(anchors.map(anchor=>anchor.closest('li.job-card-wrapper,li.job-card-box,li.job-card-wrap,li.job-list-item') || anchor.closest('.job-card-wrapper,.job-card-wrap,.job-card-box,.job-card,.job-list-item,.sub-li')))].filter((node):node is Element=>!!node);
  const output={action:'UNSUPPORTED' as 'SCROLL'|'NEXT_PAGE'|'END'|'UNSUPPORTED'|'SECURITY',moved:false,at_end:false,top:0,max:0,cards:cards.length,target:'',reason:''};
  if(Array.from(document.querySelectorAll('.verify-wrap,.geetest_panel,.captcha-container,[class*="security-check"]')).some(visible)){output.action='SECURITY';output.reason='页面出现安全验证，未滚动或翻页';return output;}
  if(!cards.length){output.reason='没有识别到可滚动的岗位卡片';return output;}
  // Start from the actual cards, rather than the first generic UL on the page.
  const candidates=new Map<Element,number>();
  for(const card of cards){let node=card.parentElement;for(let i=0;node && i<12;i++,node=node.parentElement){
    if(/auto|scroll/.test(getComputedStyle(node).overflowY) && node.clientHeight>80 && node.scrollHeight>node.clientHeight+4)candidates.set(node,(candidates.get(node) ?? 0)+1);
  }}
  const internal=[...candidates].sort((a,b)=>b[1]-a[1])[0]?.[0];
  const target=internal ?? document.scrollingElement;
  if(!target){output.reason='没有可识别的滚动容器';return output;}
  output.target=`${target.tagName.toLowerCase()}.${Array.from(target.classList).slice(0,4).join('.')}`.slice(0,200);
  output.top=Math.max(0,target.scrollTop);output.max=Math.max(0,target.scrollHeight-target.clientHeight);
  output.at_end=output.top>=output.max-3;
  if(!output.at_end){
    const before=output.top,top=Math.min(output.max,before+Math.max(200,target.clientHeight*.9));
    target.scrollTo({top,behavior:'instant'});
    output.top=Math.max(0,target.scrollTop);output.at_end=output.top>=output.max-3;
    output.moved=output.top>before+1;
    output.action=output.moved?'SCROLL':'UNSUPPORTED';output.reason=output.moved?'滚动已加载的岗位列表':'滚动位置没有变化';return output;
  }
  const pagers=Array.from(document.querySelectorAll('.pagination,.pagination-wrapper,.page-box,.options-pages,.page')).filter(visible);
  for(const pager of pagers){
    const nextControls=Array.from(pager.querySelectorAll('a,button')).filter(visible).filter(node=>{
      const label=(node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent || '').trim();
      return /^(下一页|下页|Next(?: page)?|[›»])$/i.test(label);
    });
    for(const next of nextControls){
    const disabled=next.hasAttribute('disabled') || next.getAttribute('aria-disabled')==='true' || next.matches('.disabled,[class*="disabled"]') || !!next.parentElement?.matches('.disabled');
    if(next instanceof HTMLAnchorElement && next.getAttribute('href') && !/^javascript:|^#/.test(next.getAttribute('href')!)){
      try{
        const url=new URL(next.href),current=new URL(location.href);
        if(url.origin!==current.origin || url.pathname!=='/web/geek/jobs' || url.searchParams.get('city')!==current.searchParams.get('city') || (url.searchParams.get('query') ?? '').normalize('NFKC').toLowerCase()!==(current.searchParams.get('query') ?? '').normalize('NFKC').toLowerCase())continue;
        if(url.href===current.href && !disabled)continue;
      }catch{continue;}
    }
    if(disabled){output.action='END';output.reason='原网页的下一页控件已禁用';return output;}
    (next as HTMLElement).click();output.action='NEXT_PAGE';output.moved=true;output.at_end=false;output.reason='点击原网页明确的下一页控件，等待岗位加载';return output;
    }
  }
  const lists=[...new Set(cards.map(card=>card.closest('.rec-job-list,.job-list-box,.job-list-container,.job-list,ul') ?? card.parentElement))].filter((node):node is Element=>!!node);
  const endings=lists.flatMap(list=>Array.from((list.parentElement ?? list).querySelectorAll('.no-more,.load-more,.end-message,.bottom-tips,.job-list-empty'))).filter(visible);
  if(endings.some(node=>/^(已显示全部(?:岗位)?|没有更多(?:岗位|职位|了)?|暂无更多(?:岗位|职位)?|到底了)[！!。\s]*$/.test((node.textContent ?? '').trim()))){output.action='END';output.reason='原网页明确显示没有更多岗位';return output;}
  // Re-dispatch a real scroll at the bottom to permit a delayed lazy-load retry.
  target.dispatchEvent(new Event('scroll',{bubbles:true}));
  output.action='SCROLL';output.reason='已到当前列表底部，等待延迟加载；尚不能证明搜索结果已穷尽';return output;
}

// Only invoked on a canonical detail URL after the host checks the current page kind.
export function extractBossDetail() {
  const visible=(node:Element)=>!!node.getClientRects().length && getComputedStyle(node).visibility!=="hidden";
  const text=(scope:ParentNode,selector:string,max=200)=>Array.from(scope.querySelectorAll(selector)).filter(visible).map(node=>(node instanceof HTMLElement?node.innerText:node.textContent ?? "").trim()).find(Boolean)?.slice(0,max) ?? "";
  const header=Array.from(document.querySelectorAll(".job-banner,.job-detail-box,.job-header")).find(visible);
  if(!header)return null;
  const title=text(header,".name h1,h1,.job-name");
  const company=text(header,".company-name,.company-info a[href*='/gongsi/']") || text(document,".sider-company .company-info a[href*='/gongsi/'],.sider-company .company-name,.sider-company .company-info a");
  if(!title || !company)return null;
  const requirements=Array.from(header.querySelectorAll('.info-primary .text,.job-primary .text,.job-primary p')).filter(visible).flatMap(node=>Array.from(node.childNodes).map(child=>(child.textContent ?? '').trim())).filter(Boolean);
  const tags=[...Array.from(header.querySelectorAll(".tag-list li,.job-tags span,.info-primary .text span,.job-info span")).filter(visible).map(n=>(n.textContent ?? "").trim().slice(0,100)),...requirements.map(value=>value.slice(0,100))].filter(Boolean).slice(0,20);
  const description=Array.from(document.querySelectorAll(".job-detail .job-sec-text,.job-detail .job-sec .text,.job-detail-section .job-sec-text")).filter(visible).filter(node=>{
    const section=node.closest('.job-sec,.job-detail-section');
    const heading=section ? text(section,'h3,h2,.section-title',100) : '';
    return heading ? /职位描述|岗位职责|任职要求|工作职责|岗位要求/.test(heading) : node.matches('.job-sec-text');
  }).map(n=>(n instanceof HTMLElement?n.innerText:n.textContent ?? "").trim()).filter(Boolean).join("\n\n").slice(0,20000);
  const address=text(document,".job-detail .location-address,.job-location .location-address,.job-detail .job-address",100);
  const education=text(header,".job-education,.education",40) || tags.find(t=>/^(学历不限|不限学历|(?:大专|本科|硕士|博士|高中|中专|中技)(?:及以上|以上)?)$/.test(t)) || "";
  // Some detail headers expose the city as a plain official city link.
  // Scope to this job's header and require both the link path and visible name.
  const cityPaths:Record<string,string>={'/wuhan/':'武汉','/beijing/':'北京','/shanghai/':'上海','/shenzhen/':'深圳','/guangzhou/':'广州','/hangzhou/':'杭州'};
  const cityLink=Array.from(header.querySelectorAll('a[href]')).filter(visible).map(node=>{
    try{const target=new URL(node.getAttribute('href') ?? '',location.href),name=(node.textContent ?? '').trim();return target.origin===location.origin && cityPaths[target.pathname]===name?name:'';}catch{return '';}
  }).find(Boolean) ?? '';
  return {url:`${location.origin}${location.pathname}`,title,company,salary:text(header,".salary,.job-salary"),location:text(header,".job-area,.job-location,.city,.info-primary .text a,.job-primary .text a",100) || cityLink,education,experience:text(header,".job-experience,.experience") || tags.find(t=>/经验|应届|\d+.*年/.test(t)) || "",tags,description,address};
}
