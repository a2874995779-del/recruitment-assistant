import { BrowserWindow, type Session } from 'electron';
import { bossPageKind, canonicalBossJob, type BrowserJob } from '../../../../packages/contracts/src/boss-browser.js';
import { BossResponseObserver } from './boss-response.js';
import { extractBossDetail } from './boss-reader.js';
import { mergeSalaryDetail, mergeVerifiedDetail, mergeFreshDetail, parseDetailDom } from './boss-salary-detail.js';
import { SearchBlocked } from './boss-search-runner.js';

/** A sequential read-only detail page in the existing logged-in session.
 * No clicks, form submissions, private API calls, OCR or guessed digit tables.
 */
export class BossDetailWorker {
  private window: BrowserWindow | null = null;
  private observer: BossResponseObserver | null = null;
  private epoch = 0;
  private expected = '';
  private blocked = '';
  private create() {
    if (this.window) return this.window;
    const window = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { session: this.session, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false } });
    this.window = window;
    const wc = window.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const navigation = (event: Electron.Event, url: string) => {
      const kind = bossPageKind(url);
      if (kind === 'LOGIN' || kind === 'SECURITY') this.blocked = '详情补全遇到登录或安全验证，请在 BOSS 原网页处理后重新获取';
      if (canonicalBossJob(url) !== this.expected) { event.preventDefault(); this.blocked ||= '详情页跳转到其他地址，已停止补全，未读取其他页面'; }
    };
    wc.on('will-navigate', navigation); wc.on('will-redirect', navigation);
    wc.on('did-start-navigation', (_event, url, _inPlace, main) => { if (main) { this.epoch++; this.observer?.clear(); if (canonicalBossJob(url) !== this.expected) this.blocked ||= '详情页地址变化，已停止补全'; } });
    wc.on('render-process-gone', () => { this.blocked = '详情网页进程已停止，薪资补全已结束'; });
    this.observer = new BossResponseObserver(wc.debugger, () => ({ epoch: this.epoch, url: wc.isDestroyed() ? '' : wc.getURL() }));
    return window;
  }
  constructor(private session: Session, private valid: () => boolean) {}
  private check() {
    if (!this.valid()) throw new SearchBlocked('用户停止或搜索页面已变化，详情补全已停止');
    if (this.blocked) throw new SearchBlocked(this.blocked);
  }
  async read(job: BrowserJob, totalDeadline=Date.now()+12000,verification=false,refresh=false): Promise<BrowserJob | null> {
    this.check(); this.expected = job.url;
    const window = this.create(), wc = window.webContents;
    this.observer?.clear();
    const deadline = Math.min(Date.now() + 12000,totalDeadline);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watchdog:ReturnType<typeof setInterval>|undefined;
    const aborted=new Promise<never>((_,reject)=>{watchdog=setInterval(()=>{try{this.check();if(Date.now()>=deadline)throw new Error('达到详情读取时限');}catch(error){if(!wc.isDestroyed())wc.stop();reject(error);}},100);});
    // Guard remains active even while Chromium is loading or evaluating.
    void aborted.catch(()=>{});
    try {
      // A regular page navigation; no manual JSON endpoint requests.
      await Promise.race([wc.loadURL(job.url, { extraHeaders: 'Cache-Control: no-cache\nPragma: no-cache\n' }), aborted,new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('详情加载超时')), Math.max(1,deadline-Date.now())); })]);
      clearTimeout(timer);
      this.check();
      const currentEpoch = this.epoch;
      while (Date.now() < deadline) {
        this.check();
        if (wc.isDestroyed() || canonicalBossJob(wc.getURL()) !== job.url || currentEpoch !== this.epoch) throw new SearchBlocked('详情读取期间页面变化，结果已丢弃');
        const observed_at = new Date().toISOString();
        const merge=refresh?mergeFreshDetail:verification?mergeVerifiedDetail:mergeSalaryDetail;
        const response = merge(job, this.observer?.get(job.url) ?? null, 'DETAIL_RESPONSE', observed_at);
        if (response && !verification && !refresh) return response;
        const raw = await Promise.race([wc.executeJavaScript(`(${extractBossDetail.toString()})()`, false), aborted,new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('详情解析超时')), Math.min(3000, deadline - Date.now())); })]);
        clearTimeout(timer); this.check();
        if (currentEpoch !== this.epoch || canonicalBossJob(wc.getURL()) !== job.url) throw new SearchBlocked('详情读取期间页面变化，结果已丢弃');
        const dom = merge(response ?? job, parseDetailDom(raw, observed_at), 'DETAIL_DOM', observed_at);
        if (dom || response) return dom ?? response;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return null;
    } catch(error){this.check();throw error;}
    finally { clearTimeout(timer);clearInterval(watchdog); if (!wc.isDestroyed()) wc.stop(); }
  }
  dispose() {
    this.observer?.dispose(); this.observer = null;
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}
