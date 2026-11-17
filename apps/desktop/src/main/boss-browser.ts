import { WebContentsView, type BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { allowedBossUrl, canonicalBossJob, browserJobSchema, BROWSER_COLLECTION_LIMIT, bossPageKind, BOSS_HOME, bossBrowserRequest, type BossBrowserState, type BossBrowserResult, type BrowserRecords } from "../../../../packages/contracts/src/boss-browser.js";
import type { RecruitmentService } from "../../../../packages/application/src/service.js";
import { BOSS_READ_SCRIPT, bossReadScript, browserJobInput, validateBrowserRead, locateBossCard, mergeBrowserRead, extractBossDetail, advanceBossList, advanceBossSearchList } from "./boss-reader.js";
import { BossResponseObserver, enrichBrowserJob } from "./boss-response.js";
import { z } from "zod";
import { renderSalary, recognizeSalary } from "./salary-ocr.js";
import { BossSearchRunner, SearchBlocked } from "./boss-search-runner.js";
import { searchConfigSchema, sameBossSearch, type BossSearchConfig } from "../../../../packages/contracts/src/boss-search-config.js";
import { BossVerificationRunner } from './boss-verification-runner.js';
import { BossDetailWorker } from './boss-detail-worker.js';
import type { BossSearchRun } from '../../../../packages/contracts/src/boss-search.js';
import { BossSavedRefresh } from './boss-saved-refresh.js';
import {renderGreeting} from '../../../../packages/contracts/src/greeting.js';
import {findCommunicationLink,greetingPage,greetingEcho,hasCommunicationDraft} from './boss-greeting.js';

export class BossBrowser {
  private greetingBusy=false;
  private greetingPreview:{id:string;token:string;text:string;url:string;epoch:number;expires:number}|null=null;
  private view: WebContentsView | null = null;
  private epoch = 0;
  private snapshotEpoch: number | null = null;
  private readPending = false;
  private responseObserver:BossResponseObserver|null=null;
  private responseEnabled=true;
  private batchToken:{cancelled:boolean}|null=null;
  private searchRunner:BossSearchRunner|BossVerificationRunner|null=null;
  private savedRefresh:BossSavedRefresh|null=null;
  private searchExpectedUrl:string|null=null;
  private loadingTimer: ReturnType<typeof setTimeout> | undefined;
  private downloadHandler: ((event: Electron.Event, item: Electron.DownloadItem) => void) | undefined;
  private layout = { visible: false, x: 0, y: 0, width: 0, height: 0 };
  private data: BossBrowserState = { opened: false, loading: false, reading: false, crashed: false, url: "", error: "", can_back: false, can_forward: false, snapshot: null, page_kind: "OTHER", snapshot_current: false };
  constructor(private window: BrowserWindow, private service: RecruitmentService, private directory?: string) {
    window.on("resize", () => this.applyBounds());
  }
  state(): BossBrowserState {
    const wc = this.view?.webContents;
    if (wc && !wc.isDestroyed()) this.data.page_kind = bossPageKind(wc.getURL());
    this.data.snapshot_current = !!wc && !wc.isDestroyed() && !!this.data.snapshot && this.snapshotEpoch === this.epoch && !this.data.loading && !this.data.crashed && this.data.page_kind === "JOBS";
    return { ...this.data, ...(this.data.batch?{batch:{...this.data.batch}}:{}),saved_refresh:this.savedRefresh?.progress, search_running:!!this.searchRunner,response_status:this.responseObserver?.ready?"READY":"UNAVAILABLE", reading: this.readPending || !!this.data.batch?.running || !!this.searchRunner || !!this.savedRefresh?.progress.running, can_back: !!wc && !wc.isDestroyed() && wc.navigationHistory.canGoBack(), can_forward: !!wc && !wc.isDestroyed() && wc.navigationHistory.canGoForward() };
  }
  private applyBounds() {
    if (!this.view) return;
    const [width = 0, height = 0] = this.window.getContentSize();
    const x = Math.min(this.layout.x, width), y = Math.min(this.layout.y, height);
    const w = Math.min(this.layout.width, width - x), h = Math.min(this.layout.height, height - y);
    // Keep the last usable viewport when hidden. Shrinking a native child to
    // 1x1 while switching modules can invalidate Chromium's compositor surface.
    if (!this.layout.visible || w < 200 || h < 100) { this.view.setVisible(false); return; }
    this.view.setBounds({ x, y, width: w, height: h });
    this.view.setVisible(true);
  }
  private create() {
    if (this.view) return this.view;
    const view = new WebContentsView({ webPreferences: { partition: "persist:boss-helper", contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: true } });
    this.view = view;
    this.data.opened = true;
    this.data.crashed = false;
    this.window.contentView.addChildView(view);
    this.applyBounds();
    const wc = view.webContents;
    if(this.responseEnabled)this.responseObserver=new BossResponseObserver(wc.debugger,()=>({epoch:this.epoch,url:wc.isDestroyed()?"":wc.getURL()}));
    wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    wc.session.setPermissionCheckHandler(() => false);
    // No preload bridge in the remote page. Remote content cannot call app IPC.
    wc.on("will-navigate", (event, url) => {
      if (!allowedBossUrl(url)) { event.preventDefault(); this.data.error = "已阻止离开 BOSS 网站的跳转"; }
    });
    wc.on("will-redirect", (event, url) => {
      if (!allowedBossUrl(url)) { event.preventDefault(); this.data.error = "该登录跳转暂不支持，请停止后检查原站"; }
    });
    wc.setWindowOpenHandler(({ url }) => {
      if (allowedBossUrl(url)) void this.navigate(url).catch(() => {});
      else this.data.error = "外部窗口未打开";
      return { action: "deny" };
    });
    this.downloadHandler = (_event, item) => item.cancel();
    wc.session.on("will-download", this.downloadHandler);
    wc.on("did-start-navigation", (_event, _url, inPlace, isMainFrame) => {
      if (this.view !== view || !isMainFrame) return;
      this.epoch++;
      this.savedRefresh?.stop('原网页地址已变化，已停止更新；旧记录保留');
      this.responseObserver?.clear();
      if(this.batchToken)this.batchToken.cancelled=true;
      if(this.searchRunner && (this.searchRunner instanceof BossVerificationRunner || !this.searchExpectedUrl || !sameBossSearch(_url,this.searchExpectedUrl)))this.searchRunner.stop(["LOGIN","SECURITY"].includes(bossPageKind(_url))?"原站需要登录或安全验证":"原网页搜索条件已变化，请重新获取");
      this.data.loading = !inPlace;
      this.data.error = "";
      clearTimeout(this.loadingTimer);
      if (inPlace) return;
      this.loadingTimer = setTimeout(() => {
        if (this.view === view && this.data.loading) this.data.error = "页面加载较久；可停止加载或手动重载。助手不会自动刷新。";
      }, 25000);
    });
    const updateUrl = () => {
      if (this.view !== view || wc.isDestroyed()) return;
      const raw = wc.getURL();
      this.data.page_kind = bossPageKind(raw);
      this.data.url = allowedBossUrl(raw) ? `${new URL(raw).origin}${new URL(raw).pathname}` : "";
    };
    wc.on("did-navigate", updateUrl);
    wc.on("did-navigate-in-page", updateUrl);
    wc.on("did-stop-loading", () => {
      if (this.view !== view) return;
      this.data.loading = false;
      clearTimeout(this.loadingTimer);
      updateUrl();
    });
    wc.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
      if (this.view !== view || !isMainFrame || code === -3) return;
      this.data.error = `页面加载失败（${code}），请检查网络后手动重载`;
    });
    wc.on("render-process-gone", () => {
      if (this.view !== view) return;
      this.epoch++;
      this.data.crashed = true;
      this.data.loading = false;
      this.data.error = "网页进程已停止，可重启网页；本地岗位记录仍保留";
      clearTimeout(this.loadingTimer);
    });
    return view;
  }
  private async navigate(url: string) {
    if (!allowedBossUrl(url)) throw new Error("仅支持 BOSS 官方 HTTPS 页面");
    const wc = this.create().webContents;
    this.epoch++;
    this.data.error = "";
    // loadURL rejection is handled once; never retry or reload automatically.
    void wc.loadURL(url).catch(() => {
      if (!wc.isDestroyed() && this.view?.webContents === wc && !this.data.error) this.data.error = "页面未能加载，请手动检查";
    });
  }
  private async read(append = false) {
    const view = this.view;
    if (!view || this.data.crashed) throw new Error("请先打开 BOSS 网页");
    if (this.readPending) throw new Error("上一次读取尚未结束，请等待或重启网页");
    const url = view.webContents.getURL();
    const kind = bossPageKind(url);
    if (kind === "SECURITY") throw new Error("BOSS 正在进行安全验证，请在原网页自行完成验证。验证完成并返回岗位列表后再读取；助手不会绕过验证。");
    if (kind === "LOGIN") throw new Error("当前是 BOSS 登录页，请在原网页自行登录后打开岗位列表");
    if (this.data.loading) throw new Error("页面加载中，暂不读取");
    // Never inspect chat, login, account settings or private profile DOM.
    if (kind !== "JOBS") throw new Error("请先打开 BOSS 推荐岗位或职位搜索列表；详情页请使用“读取当前详情”");
    const epoch = this.epoch;
    const previousSnapshot = this.data.snapshot;
    this.readPending = true;
    let executionSettled = false, finished = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let execution: Promise<unknown>;
    try { execution = view.webContents.executeJavaScript(append ? bossReadScript(previousSnapshot?.jobs.map(job=>job.url) ?? []) : BOSS_READ_SCRIPT, false); }
    catch (error) { this.readPending = false; throw error; }
    // A timeout cannot cancel JS. Keep the latch until that execution settles;
    // navigation or browser restart invalidates the result before any save.
    void execution.finally(() => {executionSettled = true; if (finished && this.view === view) this.readPending = false;}).catch(() => {});
    try {
      const raw = await Promise.race([execution, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("读取超时，未保存数据；不会重试。可重启网页后再读")), 8000); })]);
      if (this.view === view && bossPageKind(view.webContents.getURL()) === "SECURITY") throw new Error("读取期间 BOSS 跳转到安全验证页，请在原网页自行完成验证后再读取");
      if (this.epoch !== epoch || this.view !== view) throw new Error("读取期间页面已变化，请在页面稳定后重新读取");
      if(this.batchToken?.cancelled)throw new Error("已停止，本批读取结果已丢弃");
      const parsed = validateBrowserRead(raw);
      const { links, cards } = parsed;
      let jobs=parsed.jobs.map(job=>enrichBrowserJob(job,this.responseObserver?.get(job.url) ?? null));
      if(this.batchToken){
        const known=new Set(previousSnapshot?.jobs.map(job=>job.url));let remaining=BROWSER_COLLECTION_LIMIT-known.size;
        jobs=jobs.filter(job=>known.has(job.url) || remaining-->0);
      }
      const diagnostic = "diagnostic" in parsed ? parsed.diagnostic : undefined;
      let diagnosticSaved = false;
      if (diagnostic && this.directory && (!jobs.length || diagnostic.missing_location || diagnostic.missing_education)) {
          // Local bounded DOM shape only. Never persist page HTML or auth URLs.
          diagnosticSaved = await writeFile(join(this.directory, "evidence", "boss-reader-diagnostic.json"), JSON.stringify({ reader_version: 3, page_path: new URL(url).pathname, job_count:jobs.length, links, cards, diagnostic }, null, 2), "utf8").then(() => true, () => false);
      }
      // File I/O can yield while the original page navigates. Never publish a stale read.
      if (this.epoch !== epoch || this.view !== view) throw new Error("读取期间页面已变化，请重新读取");
      if(this.batchToken?.cancelled)throw new Error("已停止，本批读取结果已丢弃");
      if (!jobs.length) {
        const reason = diagnostic ? `无效链接 ${diagnostic.invalid_link}、不可见容器 ${diagnostic.invisible}、缺岗位名 ${diagnostic.missing_title}、缺企业名 ${diagnostic.missing_company}。${diagnosticSaved ? "结构诊断已写入本地 evidence/boss-reader-diagnostic.json。" : ""}` : "";
        throw new Error(`当前列表暂未识别到岗位（岗位链接 ${links}、卡片 ${cards}）。${reason}请保留当前岗位列表以便修复字段兼容；不需要重新登录。`);
      }
      const observation = {page_url:`${new URL(url).origin}${new URL(url).pathname}`,observed_at:new Date().toISOString()};
      const merged = mergeBrowserRead(previousSnapshot,jobs,observation,append);
      this.data.snapshot = { id: randomUUID(), ...observation, jobs:merged.jobs, observations:merged.observations, current_urls:jobs.map(job=>job.url) };
      this.snapshotEpoch = epoch;
      this.data.error = "";
      return merged.summary;
    } finally { clearTimeout(timeout); finished = true; if(executionSettled && this.view === view)this.readPending = false; }
  }
  private async readDetail() {
    const view=this.view;
    if(!view || this.data.loading || this.data.crashed || bossPageKind(view.webContents.getURL())!=="DETAIL")throw new Error("请在原网页打开已加载的岗位详情，再点击读取当前详情");
    if(this.readPending)throw new Error("上一次读取尚未结束，请稍候");
    const url=canonicalBossJob(view.webContents.getURL())!,epoch=this.epoch,previous=this.data.snapshot;
    if(previous && previous.jobs.length>=BROWSER_COLLECTION_LIMIT && !previous.jobs.some(job=>job.url===url))throw new Error("累计岗位已达上限，请先保存后开始新一轮");
    this.readPending=true;
    let settled=false,finished=false,timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const execution=view.webContents.executeJavaScript(`(${extractBossDetail.toString()})()`,false);
      void execution.finally(()=>{settled=true;if(finished && this.view===view)this.readPending=false;}).catch(()=>{});
      const raw=await Promise.race([execution,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("详情读取超时，未修改数据；不会自动重试")),8000);})]);
      if(this.epoch!==epoch || this.view!==view || this.data.snapshot!==previous || canonicalBossJob(view.webContents.getURL())!==url)throw new Error("读取期间页面已变化，详情结果已丢弃");
      if(!raw)throw new Error("当前详情结构尚未兼容：未读到明确的岗位名和企业名。未猜测页面内容。");
      const parsed=browserJobSchema.omit({detail:true,salary_ocr:true}).extend({description:z.string().max(20000),address:z.string().max(100)}).strict().parse(raw);
      if(parsed.url!==url)throw new Error("详情来源与当前页面不一致，未修改数据");
      const {description,address,...fields}=parsed;
      const old=previous?.jobs.find(job=>job.url===url);
      const observed_at=new Date().toISOString();
      const domJob=browserJobSchema.parse({...fields,location:fields.location || old?.location || "",education:fields.education || old?.education || "",experience:fields.experience || old?.experience || "",tags:[...new Set([...fields.tags,...(old?.tags ?? [])])].slice(0,20),detail:{description,address,observed_at}});
      const job=enrichBrowserJob(domJob,this.responseObserver?.get(url) ?? null);
      const observation={page_url:url,observed_at};
      const merged=mergeBrowserRead(previous,[job],observation,true);
      this.data.snapshot={id:randomUUID(),...observation,jobs:merged.jobs,observations:merged.observations,current_urls:[]};
      this.snapshotEpoch=null;this.data.error="";
      return merged.summary;
    } finally {clearTimeout(timer);finished=true;if((settled || !timer) && this.view===view)this.readPending=false;}
  }
  private async readSalary(payload:{snapshot_id:string;url:string}) {
    const snapshot=this.data.snapshot;
    const job=snapshot?.jobs.find(j=>j.url===payload.url);
    const view=this.view;
    if(!snapshot || snapshot.id!==payload.snapshot_id || !job)throw new Error("岗位快照已变化，请重新读取后识别");
    if(!view || this.data.loading || this.data.crashed || bossPageKind(view.webContents.getURL())!=="JOBS")throw new Error("请在已加载的岗位列表中识别薪资");
    if(this.snapshotEpoch !== this.epoch)throw new Error("当前列表已变化，请重新读取后识别薪资");
    if(snapshot.current_urls && !snapshot.current_urls.includes(job.url))throw new Error("此岗位来自之前读取的页面，请在原站找到并追加读取后再识别薪资");
    if(this.readPending)throw new Error("上一次读取或识别尚未结束，请稍候");
    if(!/[\uE000-\uF8FF]/.test(job.salary))throw new Error("该岗位没有特殊字体薪资，无需 OCR");
    const epoch=this.epoch;
    let cancelled=false;
    this.readPending=true;
    const execution=(async()=>{
      const rendered=await view.webContents.executeJavaScript(`(${renderSalary.toString()})(${JSON.stringify({url:job.url,salary:job.salary})})`,false);
      if(cancelled || this.epoch!==epoch || this.view!==view || this.data.snapshot!==snapshot)throw new Error("页面或快照已变化，识别结果已丢弃");
      const result=await recognizeSalary(rendered);
      if(cancelled || this.epoch!==epoch || this.view!==view || this.data.snapshot!==snapshot)throw new Error("页面或快照已变化，识别结果已丢弃");
      this.data.snapshot={...snapshot,id:randomUUID(),jobs:snapshot.jobs.map(j=>j.url===job.url?{...j,salary_ocr:result}:j)};
    })();
    void execution.finally(()=>{if(this.view===view)this.readPending=false;}).catch(()=>{});
    let timer:ReturnType<typeof setTimeout> | undefined;
    try {await Promise.race([execution,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{cancelled=true;reject(new Error("薪资识别超时，未修改数据；等待识别结束或重启网页后再试"));},25000);})]);}
    finally {clearTimeout(timer);}
  }
  private records(): BrowserRecords {
    return Object.fromEntries((this.data.snapshot?.jobs ?? []).flatMap(job => {
      const key = new URL(job.url).pathname.split("/").pop()!.replace(/\.html$/, "");
      const saved = this.service.store.findSourceJob("IMPORT", `desktop-browser:boss:${key}`);
      return saved ? [[job.url, {id:saved.id,mark:this.service.jobMark(saved.id)}]] : [];
    }));
  }
  private startBatch() {
    const view=this.view;
    if(this.batchToken || this.readPending)throw new Error("已有读取任务，请先停止或等待结束");
    if(!view || this.data.loading || this.data.crashed || bossPageKind(view.webContents.getURL())!=="JOBS")throw new Error("请先打开已加载的岗位列表；验证页和登录页不能批量读取");
    const token={cancelled:false};this.batchToken=token;
    this.data.batch={running:true,rounds:0,added:0,saved:0,reason:"读取中；每批结果自动保存到本地"};
    void this.runBatch(view,this.epoch,token);
  }
  private startSearch(raw:BossSearchConfig,previous?:BossSearchRun){
    if(this.searchRunner || this.batchToken || this.readPending)throw new Error("已有读取任务，请先停止后再获取");
    const view=this.view;
    if(!view || this.data.crashed || ["LOGIN","SECURITY","OTHER"].includes(bossPageKind(view.webContents.getURL())))throw new Error("请先在 BOSS 登录并打开岗位页，再返回岗位搜索开始获取");
    const config=searchConfigSchema.parse(raw);this.service.prepareSearchHistory();this.service.saveBossSearchConfig(config);
    let detailWorker:BossDetailWorker|undefined;
    class SearchPageChanged extends Error {}
    const guard=()=>{
      if(this.view!==view || view.webContents.isDestroyed() || this.data.crashed)throw new SearchBlocked("网页进程已停止，请登录后重新获取");
      const kind=bossPageKind(view.webContents.getURL());
      if(kind==="LOGIN" || kind==="SECURITY")throw new SearchBlocked("需要在 BOSS 原网页登录或完成验证，已停止获取");
      if(kind!=="JOBS" || !this.searchExpectedUrl || !sameBossSearch(view.webContents.getURL(),this.searchExpectedUrl))throw new SearchBlocked("原网页搜索条件已变化，已停止获取，未读取其他条件的结果");
    };
    const execute=async(script:string)=>{
      guard();const evaluationEpoch=this.epoch;let settled=false,finished=false,timer:ReturnType<typeof setTimeout>|undefined;
      this.readPending=true;
      let execution:Promise<unknown>;
      try {execution=view.webContents.executeJavaScript(script,false);}
      catch(error){this.readPending=false;throw error;}
      void execution.finally(()=>{settled=true;if(finished && this.view===view)this.readPending=false;}).catch(()=>{});
      try {const result=await Promise.race([execution,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new SearchBlocked("读取超时，已停止；可以重启网页后重新获取")),8000);})]);guard();if(this.epoch!==evaluationEpoch)throw new SearchPageChanged();return result;}
      catch(error){if(this.epoch!==evaluationEpoch && !(error instanceof SearchBlocked)){guard();throw new SearchPageChanged();}throw error;}
      finally{clearTimeout(timer);finished=true;if(settled && this.view===view)this.readPending=false;}
    };
    const skippedSaved=new Set<string>();
    const readLoaded=async(known:string[],waitForNew=false,ignored:string[]=[])=>{
      const deadline=Date.now()+(waitForNew?8000:20000),seen=new Set(known);let last:ReturnType<typeof validateBrowserRead>|undefined;
      while(Date.now()<deadline && !runner.cancelled){
        guard();
        if(!this.data.loading){
          try {
            last=validateBrowserRead(await execute(bossReadScript(known,ignored)));
            for(const url of last.skipped_urls ?? [])skippedSaved.add(url);
            if(!waitForNew && last.skipped_saved && !last.jobs.length)return [];
            if(last.jobs.length && (!waitForNew || last.jobs.some(job=>!seen.has(job.url))))return last.jobs.map(job=>enrichBrowserJob(job,this.responseObserver?.get(job.url) ?? null));
          }catch(error){if(!(error instanceof SearchPageChanged))throw error;}
        }
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      if(runner.cancelled)return [];
      if(last?.skipped_saved && !last.jobs.length)return [];
      if(last?.jobs.length)return last.jobs.map(job=>enrichBrowserJob(job,this.responseObserver?.get(job.url) ?? null));
      throw new Error(`等待岗位列表加载后仍未读到岗位（链接 ${last?.links ?? 0}、卡片 ${last?.cards ?? 0}、缺岗位名 ${last?.diagnostic?.missing_title ?? 0}、缺企业名 ${last?.diagnostic?.missing_company ?? 0}）。这是加载或页面识别问题，不是筛选无结果；请查看 BOSS 原网页。`);
    };
    const runner=new BossSearchRunner(config,{
      now:Date.now,wait:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
      checkpoint:run=>this.service.saveBossSearchRun(run),
      open:async (url,reuse)=>{
        if(reuse && sameBossSearch(view.webContents.getURL(),url) && !this.data.loading){this.searchExpectedUrl=url;this.responseObserver?.clear();guard();return;}
        this.searchExpectedUrl=url;this.responseObserver?.clear();
        let timer:ReturnType<typeof setTimeout>|undefined;
        try {await Promise.race([view.webContents.loadURL(url,{extraHeaders:"Cache-Control: no-cache\nPragma: no-cache\n"}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new SearchBlocked("搜索页面加载超时，已停止")),25000);})]);}
        catch(error){throw new SearchBlocked(error instanceof Error?error.message:"搜索页面未能加载");}
        finally{clearTimeout(timer);}
        if(runner.cancelled)return;
        guard();
      },
      read:readLoaded,skippedUrls:()=>[...skippedSaved],savedUrls:()=>this.service.savedBossUrls(),
      processedUrls:()=>this.service.processedBossUrls(config),seenJobs:()=>this.service.seenBossJobs(),
      salary:async (job,deadline)=>{
        guard();
        detailWorker ??= new BossDetailWorker(view.webContents.session,()=>{
          if(runner.cancelled)return false;
          try {guard();return true;} catch{return false;}
        });
        const result=await detailWorker.read(job,deadline);guard();return result;
      },
      advance:async()=>{
        try{return await execute(`(${advanceBossSearchList.toString()})()`) as ReturnType<typeof advanceBossSearchList>;}
        catch(error){if(!(error instanceof SearchPageChanged))throw error;await readLoaded([]);return true;}
      },
    },previous);
    this.searchRunner=runner;
    // A user-started search must keep loading and scrolling when its view is hidden.
    const throttled=view.webContents.getBackgroundThrottling();view.webContents.setBackgroundThrottling(false);
    void runner.execute().catch(error=>{this.data.error=error instanceof Error?error.message:"搜索结果保存失败";}).finally(()=>{
      detailWorker?.dispose();
      if(!view.webContents.isDestroyed())view.webContents.setBackgroundThrottling(throttled);
      if(this.searchRunner===runner){this.searchRunner=null;this.searchExpectedUrl=null;}
    });
  }
  private startVerification(previous:BossSearchRun){
    if(this.searchRunner || this.batchToken || this.readPending)throw new Error('已有读取任务，请先停止');
    const view=this.view,epoch=this.epoch;
    if(!view || this.data.loading || this.data.crashed || !['JOBS','DETAIL'].includes(bossPageKind(view.webContents.getURL())))throw new Error('请先打开已登录的 BOSS 岗位页，再补全待核实');
    const valid=():boolean=>!runner.cancelled && this.view===view && !view.webContents.isDestroyed() && !this.data.crashed && this.epoch===epoch;
    const worker=new BossDetailWorker(view.webContents.session,valid);
    const runner=new BossVerificationRunner(previous,{now:Date.now,wait:ms=>new Promise(resolve=>setTimeout(resolve,ms)),savedUrls:()=>this.service.savedBossUrls(),checkpoint:run=>this.service.saveBossSearchRun(run),read:(job,deadline)=>worker.read(job,deadline,true)});
    this.searchRunner=runner;
    void runner.execute().catch(error=>{this.data.error=error instanceof Error?error.message:'补全保存失败';}).finally(()=>{worker.dispose();if(this.searchRunner===runner)this.searchRunner=null;});
  }
  private startSavedRefresh(ids:string[]){
    if(this.searchRunner || this.batchToken || this.readPending || this.savedRefresh?.progress.running)throw new Error('已有读取任务，请先停止');
    const view=this.view,epoch=this.epoch;
    if(!view || this.data.loading || this.data.crashed || !['JOBS','DETAIL'].includes(bossPageKind(view.webContents.getURL())))throw new Error('请先打开已登录的 BOSS 岗位页，再更新本地岗位');
    const jobs=ids.map(id=>({id,job:this.service.savedBrowserJob(id)}));
    const valid=():boolean=>!runner.cancelled && this.view===view && !view.webContents.isDestroyed() && !this.data.crashed && this.epoch===epoch;
    const worker=new BossDetailWorker(view.webContents.session,valid);
    const runner=new BossSavedRefresh(jobs,{now:Date.now,wait:ms=>new Promise(resolve=>setTimeout(resolve,ms)),read:(job,deadline)=>worker.read(job,deadline,true,true),save:(id,job,at)=>{this.service.refreshSavedJob(id,job,at);},record:(id,status,reason,at)=>this.service.recordSavedRefresh(id,status,reason,at)});
    this.savedRefresh=runner;void runner.execute().catch(error=>{this.data.error=error instanceof Error?error.message:'本地更新保存失败';}).finally(()=>worker.dispose());
  }
  private async runBatch(view:WebContentsView,epoch:number,token:{cancelled:boolean}) {
    const progress=this.data.batch!;
    const started=Date.now();let idle=0,reason="达到本次 20 批上限，可继续读取";
    const valid=()=>!token.cancelled && this.view===view && this.epoch===epoch && !this.data.loading && !this.data.crashed && bossPageKind(view.webContents.getURL())==="JOBS";
    try {
      for(let round=0;round<20;round++) {
        if(!valid()){reason="已停止：用户停止或原网页已变化";break;}
        if(Date.now()-started>=90000){reason="达到本次 90 秒上限，可继续读取";break;}
        if((this.data.snapshot?.jobs.length ?? 0)>=BROWSER_COLLECTION_LIMIT){reason="累计达到 500 个岗位，已停止";break;}
        const summary=await this.read(true);
        if(!valid()){reason="页面变化，本批未保存";break;}
        progress.rounds++;progress.added+=summary.added;
        const snapshot=this.data.snapshot!;
        const urls=new Set(snapshot.current_urls);
        const jobs=snapshot.jobs.filter(job=>urls.has(job.url));
        this.service.importJobs(jobs.map(job=>browserJobInput(job,snapshot.observations?.[job.url]?.observed_at ?? snapshot.observed_at)));
        progress.saved+=jobs.length; // Number of writes, including updates; UI labels it accordingly.
        idle=summary.added===0?idle+1:0;
        if(idle>=3){reason="连续三批没有新增岗位，已停止；不代表原站全部岗位已读完";break;}
        if(snapshot.jobs.length>=BROWSER_COLLECTION_LIMIT){reason="累计达到 500 个岗位，已停止";break;}
        if(round===19)break;
        const scroll=view.webContents.executeJavaScript(`(${advanceBossList.toString()})()`,false);
        this.readPending=true;let scrollSettled=false,scrollFinished=false;
        void scroll.finally(()=>{scrollSettled=true;if(scrollFinished && this.view===view)this.readPending=false;}).catch(()=>{});
        let timer:ReturnType<typeof setTimeout>|undefined;
        try {
          const advanced=await Promise.race([scroll,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("滚动超时，已停止")),4000);})]);
          if(!advanced){reason="未找到可滚动的岗位列表，已保存当前结果";break;}
        }finally{clearTimeout(timer);scrollFinished=true;if(scrollSettled && this.view===view)this.readPending=false;}
        // Short cancellable waits allow both site loading and immediate stop commands.
        for(let tick=0;tick<15 && valid();tick++)await new Promise(resolve=>setTimeout(resolve,100));
      }
    }catch(error){reason=error instanceof Error?error.message:"批量读取失败，已保存的岗位保留";}
    finally {
      progress.running=false;progress.reason=token.cancelled?"已停止；已保存的岗位保留":reason;
      if(this.batchToken===token)this.batchToken=null;
    }
  }
  private async locate(payload: {snapshot_id: string; url: string}) {
    const snapshot = this.data.snapshot, view = this.view;
    if (!snapshot || snapshot.id !== payload.snapshot_id || !snapshot.jobs.some(job => job.url === payload.url)) throw new Error("岗位快照已变化，请重新读取后定位");
    if (!view || this.data.loading || this.data.crashed || bossPageKind(view.webContents.getURL()) !== "JOBS") throw new Error("请先返回已加载的岗位列表，再定位岗位");
    if(this.snapshotEpoch !== this.epoch)throw new Error("当前页面已变化，请重新读取后定位岗位");
    if(snapshot.current_urls && !snapshot.current_urls.includes(payload.url))throw new Error("此岗位来自之前读取的页面，可打开原站详情；当前列表未读取到此岗位");
    if (this.readPending) throw new Error("上一次网页操作尚未结束，请稍候");
    const epoch = this.epoch;
    this.readPending = true;
    let cancelled = false;
    let execution: Promise<unknown>;
    try {execution = view.webContents.executeJavaScript(`(${locateBossCard.toString()})(${JSON.stringify(payload.url)})`,false);}
    catch(error) {this.readPending = false;throw error;}
    void execution.finally(() => {if(this.view === view)this.readPending = false;}).catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const found = await Promise.race([execution,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{cancelled=true;reject(new Error("定位超时，请等待或重启网页"));},8000);})]);
      if(cancelled || this.epoch !== epoch || this.view !== view || this.data.snapshot !== snapshot) throw new Error("定位期间页面已变化，请重新读取");
      if(!found) throw new Error("该岗位已不在当前加载的列表中，请重新读取岗位；未打开详情或发送消息");
    } finally {clearTimeout(timer);}
  }
  private async communication(id:string,prepare:boolean):Promise<BossBrowserResult>{
    this.greetingBusy=true;this.greetingPreview=null;
    try{
      const job=this.service.savedBrowserJob(id);
      const record=this.service.greetingRecord(id);
      if(prepare && record && record.status!=='FAILED')throw new Error('此岗位已有发送记录或待核实记录，请打开沟通查看；不会重复发送');
      const wc=this.create().webContents;
      const identity={url:job.url,title:job.title,company:job.company};
      let check=await wc.executeJavaScript(`(${greetingPage.toString()})(${JSON.stringify({...identity,inspectOnly:true})})`,false);
      const waitLoaded=async()=>{
        const until=Date.now()+10000;
        while(Date.now()<until){if(wc.isDestroyed())throw new Error('网页已关闭');if(!wc.isLoading() && !this.data.loading)return;await new Promise(resolve=>setTimeout(resolve,150));}
        throw new Error('沟通页面加载超时，请查看原站后重试；未发送');
      };
      if(!check.ready){
        if(await wc.executeJavaScript(`(${hasCommunicationDraft.toString()})()`,false))throw new Error('当前沟通窗口已有草稿，请先处理；未跳转或覆盖');
        await this.navigate(job.url);await waitLoaded();
        const link=await wc.executeJavaScript(`(${findCommunicationLink.toString()})(${JSON.stringify(job.url)})`,false);
        if(!link)throw new Error('已打开岗位原帖。未识别到可直接进入的沟通链接，请在原站建立会话后再打招呼；未点击可能发送默认消息的“立即沟通”');
        const target=new URL(link);
        if(target.origin!=='https://www.zhipin.com'||target.pathname!=='/web/geek/chat'||!target.search)throw new Error('沟通链接不受支持');
        await this.navigate(target.href);await waitLoaded();
        check=await wc.executeJavaScript(`(${greetingPage.toString()})(${JSON.stringify({...identity,inspectOnly:true})})`,false);
      }
      if(!check.ready)throw new Error(check.reason);
      if(!prepare)return {ok:true,state:this.state()};
      check=await wc.executeJavaScript(`(${greetingPage.toString()})(${JSON.stringify(identity)})`,false);
      if(!check.ready)throw new Error(check.reason);
      const text=renderGreeting(this.service.getGreetingConfig().template,{title:job.title,company_name:job.company});
      const expires=Date.now()+120000,token=randomUUID();
      this.greetingPreview={id,token,text,url:wc.getURL(),epoch:this.epoch,expires};
      return {ok:true,state:this.state(),greeting:{token,text,expires_at:new Date(expires).toISOString()}};
    }finally{this.greetingBusy=false;}
  }
  private async sendGreeting(payload:{id:string;token:string;text:string}):Promise<BossBrowserResult>{
    const preview=this.greetingPreview;this.greetingPreview=null;
    const wc=this.view?.webContents;
    if(!preview || preview.id!==payload.id || preview.token!==payload.token || preview.text!==payload.text || preview.expires<Date.now() || !wc || wc.isDestroyed() || preview.epoch!==this.epoch || preview.url!==wc.getURL() || this.data.loading)throw new Error('发送预览已过期或页面变化，请重新核对');
    const job=this.service.savedBrowserJob(payload.id),record=this.service.greetingRecord(payload.id);
    if(record && record.status!=='FAILED')throw new Error('此岗位已有发送或待核实记录，禁止重复发送');
    this.greetingBusy=true;
    let attempted=false;
    const attempted_at=new Date().toISOString();
    try{
      const identity={url:job.url,title:job.title,company:job.company};
      const check=await wc.executeJavaScript(`(${greetingPage.toString()})(${JSON.stringify(identity)})`,false);
      if(!check.ready)throw new Error(check.reason);
      if(await wc.executeJavaScript(`(${greetingEcho.toString()})(${JSON.stringify(payload.text)})`,false))throw new Error('会话中已存在相同招呼语，请查看原站；未重复发送');
      if(preview.epoch!==this.epoch || preview.url!==wc.getURL())throw new Error('页面已变化；未发送');
      // Persist before the irreversible click. A crash never makes this automatically retryable.
      this.service.recordGreeting(payload.id,{status:'PENDING',text:payload.text,attempted_at,reason:'正在提交；若程序中断请到原站核实，禁止自动重发'});attempted=true;
      const deadline=Date.now()+8000;
      let timer:ReturnType<typeof setTimeout>|undefined;
      const result=await Promise.race([
        wc.executeJavaScript(`(${greetingPage.toString()})(${JSON.stringify({...identity,text:payload.text,deadline})})`,false),
        new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('发送操作超时，请在原站核实；不会自动重发')),8500);}),
      ]).finally(()=>clearTimeout(timer));
      if(!result.clicked){this.service.recordGreeting(payload.id,{status:'FAILED',text:payload.text,attempted_at,reason:result.reason});return {ok:false,error:result.reason};}
      let echo=false;
      const until=Date.now()+6000;
      while(Date.now()<until && !wc.isDestroyed() && preview.epoch===this.epoch && preview.url===wc.getURL()){
        echo=await wc.executeJavaScript(`(${greetingEcho.toString()})(${JSON.stringify(payload.text)})`,false);
        if(echo)break;await new Promise(resolve=>setTimeout(resolve,250));
      }
      this.service.recordGreeting(payload.id,{status:echo?'SENT':'UNKNOWN',text:payload.text,attempted_at,reason:echo?'页面已显示发出的招呼语；送达和回复请查看原站':'已尝试发送但未确认回显，请到原站核实；不会自动重发'});
      return {ok:true,state:this.state()};
    }catch(error){
      if(attempted)this.service.recordGreeting(payload.id,{status:'UNKNOWN',text:payload.text,attempted_at,reason:'发送过程异常，结果待核实；不会自动重发'});
      throw error;
    }finally{this.greetingBusy=false;}
  }
  async request(raw: unknown): Promise<BossBrowserResult> {
    try {
      const request = bossBrowserRequest.parse(raw);
      if(this.greetingBusy && !['state','layout'].includes(request.operation))throw new Error('正在处理单个岗位的沟通，请稍候');
      if(this.savedRefresh?.progress.running && !['state','layout','saved.refresh.get','saved.refresh.stop','stop'].includes(request.operation))throw new Error('正在更新已保存岗位，请先停止');
      if(this.searchRunner && !["state","layout","saved.refresh.get","search.get","search.stop","stop"].includes(request.operation))throw new Error("搜索中，请先停止后再执行其他网页操作");
      if(this.batchToken && !["state","layout","saved.refresh.get","records","search.get","batch.stop","stop"].includes(request.operation))throw new Error("批量读取中，请先停止后再执行其他操作");
      switch (request.operation) {
        case 'greeting.prepare':return await this.communication(request.payload.id,true);
        case 'communication.open':return await this.communication(request.payload.id,false);
        case 'greeting.send':return await this.sendGreeting(request.payload);
        case 'saved.refresh':this.startSavedRefresh(request.payload.ids);break;
        case 'saved.refresh.get':break;
        case 'saved.refresh.stop':this.savedRefresh?.stop();break;
        case 'search.verify': {
          const previous=this.service.getBossSearchRun();
          if(!previous || previous.id!==request.payload.run_id)throw new Error('搜索结果已变化，请刷新后补全');
          this.startVerification(previous);return {ok:true,state:this.state(),search_run:this.searchRunner!.run};
        }
        case "search.start": this.startSearch(request.payload);return {ok:true,state:this.state(),search_run:this.searchRunner!.run};
        case "search.continue": {
          const previous=this.service.getBossSearchRun();
          if(!previous || previous.id!==request.payload.run_id)throw new Error('搜索结果已变化，请刷新后继续获取');
          if(previous.results.length>=2000)throw new Error('累计已达到 2000 个岗位上限，请保存后重新获取');
          this.startSearch(previous.config,previous);return {ok:true,state:this.state(),search_run:this.searchRunner!.run};
        }
        case "search.stop": this.searchRunner?.stop();if(this.data.loading)this.view?.webContents.stop();break;
        case "search.get":return {ok:true,state:this.state(),saved_urls:this.service.savedBossUrls(),search_run:this.searchRunner?.run ?? this.service.getBossSearchRun()};
        case "search.save": {
          const run=this.service.getBossSearchRun();
          if(!run || run.id!==request.payload.run_id)throw new Error("搜索结果已变化，请重新选择");
          const urls=new Set(request.payload.urls),jobs=run.results.filter(item=>urls.has(item.job.url));
          if(jobs.length!==urls.size)throw new Error("只能保存本次搜索结果中的岗位");
          let saved=0;
          this.service.store.transaction(()=>{for(let offset=0;offset<jobs.length;offset+=100)saved+=this.service.importJobs(jobs.slice(offset,offset+100).map(item=>({...browserJobInput(item.job,item.observed_at),extra:{...browserJobInput(item.job,item.observed_at).extra,...(item.verification?{boss_verification:item.verification}:{})}}))).length;});
          return {ok:true,state:this.state(),saved};
        }
        case "response.disable": this.responseEnabled=false;this.responseObserver?.dispose();this.responseObserver=null;break;
        case "response.enable": {
          this.responseEnabled=true;
          const wc=this.view?.webContents;
          if(wc && !wc.isDestroyed() && !this.responseObserver?.ready){this.responseObserver?.dispose();this.responseObserver=new BossResponseObserver(wc.debugger,()=>({epoch:this.epoch,url:wc.isDestroyed()?"":wc.getURL()}));}
          break;
        }
        case "batch.start": this.startBatch(); break;
        case "batch.stop": if(this.batchToken)this.batchToken.cancelled=true;break;
        case "state": break;
        case "layout": this.layout = request.payload; this.applyBounds(); break;
        case "open": if (!this.view) await this.navigate(BOSS_HOME); break;
        case "job.open": await this.navigate(request.payload.url); break;
        case "detail.read": {const summary=await this.readDetail();return {ok:true,state:this.state(),read_summary:summary};}
        case "job.locate": await this.locate(request.payload); break;
        case "records": {
          if (this.data.snapshot?.id !== request.payload.snapshot_id) throw new Error("岗位快照已变化，请重新读取");
          return {ok:true,state:this.state(),records:this.records()};
        }
        case "job.mark": {
          const snapshot = this.data.snapshot;
          const job = snapshot?.jobs.find(job => job.url === request.payload.url);
          if (!snapshot || snapshot.id !== request.payload.snapshot_id || !job) throw new Error("岗位快照已变化，请重新选择");
          const record = this.records()[job.url];
          // Existing marks must not overwrite a newer observation with an old snapshot.
          this.service.store.transaction(() => {
            const saved = record ?? this.service.importJobs([browserJobInput(job,snapshot.observations?.[job.url]?.observed_at ?? snapshot.observed_at)])[0]!;
            this.service.markJob(saved.id,request.payload.mark);
          });
          return {ok:true,state:this.state(),records:this.records(),saved:record ? undefined : 1,save_summary:record ? undefined : {created:1,updated:0}};
        }
        case "back": if (this.view?.webContents.navigationHistory.canGoBack()) { this.epoch++; this.view.webContents.navigationHistory.goBack(); } break;
        case "forward": if (this.view?.webContents.navigationHistory.canGoForward()) { this.epoch++; this.view.webContents.navigationHistory.goForward(); } break;
        case "reload": if (this.view && !this.data.crashed) { this.epoch++; this.view.webContents.reload(); } break;
        case "stop": this.savedRefresh?.stop();this.searchRunner?.stop();this.view?.webContents.stop(); this.data.loading = false; this.epoch++; clearTimeout(this.loadingTimer); break;
        case "restart": this.dispose(); await this.navigate(BOSS_HOME); break;
        case "read": case "read.append": {
          const read_summary = await this.read(request.operation === "read.append");
          return {ok:true,state:this.state(),read_summary};
        }
        case "salary.recognize": await this.readSalary(request.payload); break;
        case "salary.confirm": {
          const snapshot=this.data.snapshot;
          const job=snapshot?.jobs.find(j=>j.url===request.payload.url);
          if(!snapshot || snapshot.id!==request.payload.snapshot_id || !job?.salary_ocr)throw new Error("薪资识别快照已变化，请重新识别");
          this.data.snapshot={...snapshot,id:randomUUID(),jobs:snapshot.jobs.map(j=>j.url===job.url?{...j,salary_ocr:{...job.salary_ocr!,confirmed:true}}:j)};
          break;
        }
        case "save": {
          const snapshot = this.data.snapshot;
          if (!snapshot || snapshot.id !== request.payload.snapshot_id) throw new Error("岗位快照已变化，请重新选择");
          const urls = new Set(request.payload.urls);
          const jobs = snapshot.jobs.filter(j => urls.has(j.url));
          if (jobs.length !== urls.size) throw new Error("只能保存当前读取快照中的岗位");
          const records = this.records();
          const updated = jobs.filter(job => records[job.url]).length;
          const saved = this.service.importJobs(jobs.map(j => browserJobInput(j, snapshot.observations?.[j.url]?.observed_at ?? snapshot.observed_at)));
          return { ok: true, state: this.state(), saved: saved.length, records:this.records(), save_summary:{created:saved.length-updated,updated} };
        }
      }
      return { ok: true, state: this.state() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "网页操作失败" };
    }
  }
  dispose() {
    this.savedRefresh?.stop('软件窗口已关闭，旧记录保留');
    clearTimeout(this.loadingTimer);
    this.epoch++;
    if(this.batchToken)this.batchToken.cancelled=true;
    this.searchRunner?.stop();
    this.responseObserver?.dispose();this.responseObserver=null;
    const view = this.view;
    this.view = null;
    this.readPending = false;
    this.data.opened = false;
    this.data.loading = false;
    this.data.crashed = false;
    if (view) {
      if (this.downloadHandler) view.webContents.session.removeListener("will-download", this.downloadHandler);
      this.downloadHandler = undefined;
      this.window.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
  }
}
