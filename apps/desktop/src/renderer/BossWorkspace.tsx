import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { evaluateBrowserJob, BROWSER_COLLECTION_LIMIT, type BossBrowserOperation, type BossBrowserState, type BrowserFilter, type BrowserRecords } from "../../../../packages/contracts/src/boss-browser.js";
import { browserFilterSchema, jobMarkLabels } from "../../../../packages/contracts/src/job-management.js";
import { emptyMatchingPreferences, matchingPreferencesSchema, scoreBrowserJob } from "../../../../packages/contracts/src/boss-matching.js";
import { MatchingPanel } from "./MatchingPanel.js";

const emptyState: BossBrowserState = { opened: false, loading: false, reading: false, crashed: false, url: "", error: "", can_back: false, can_forward: false, snapshot: null, page_kind: "OTHER", snapshot_current: false };
const emptyFilter: BrowserFilter = { keyword: "", city: "", education: "", exclude: "" };
const showSalary = (value: string) => /[\uE000-\uF8FF]/.test(value) ? "薪资字体受限，请查看原站" : value || "薪资未读取";
const hasRestrictedGlyph = (value: string) => [...value].some(c => c.charCodeAt(0) >= 0xE000 && c.charCodeAt(0) <= 0xF8FF);

export function BossWorkspace({ onSaved, active, revision }: { onSaved: () => void; active: boolean; revision: number }) {
  const bridge = window.recruitment?.bossBrowser;
  const [state, setState] = useState(emptyState);
  const [draft, setDraft] = useState(emptyFilter), [filter, setFilter] = useState(emptyFilter);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [records, setRecords] = useState<BrowserRecords>({});
  const [recordsReady, setRecordsReady] = useState(false);
  const [helperOpen, setHelperOpen] = useState(false);
  const [filterReady, setFilterReady] = useState(false), [filterSaving, setFilterSaving] = useState(false);
  const [preferences,setPreferences]=useState(emptyMatchingPreferences),[matchingReady,setMatchingReady]=useState(false);
  const filterLock = useRef(false);
  const host = useRef<HTMLDivElement>(null), locked = useRef(false);
  const mounted = useRef(true);
  const wasBatchRunning=useRef(false);
  useEffect(()=>{
    if(wasBatchRunning.current && !state.batch?.running)onSaved();
    wasBatchRunning.current=!!state.batch?.running;
  },[state.batch?.running,onSaved]);
  const evaluated = useMemo(() => (state.snapshot?.jobs ?? []).map(job => evaluateBrowserJob(job, draft)), [state.snapshot, draft]);
  const matches=useMemo(()=>new Map((state.snapshot?.jobs ?? []).map(job=>[job.url,scoreBrowserJob(job,preferences)])),[state.snapshot,preferences]);
  const jobs = evaluated.filter(item => item.status === "MATCH" && (!preferences.enabled || !matches.get(item.job.url)?.excluded)).map(item => item.job);
  const visible = evaluated.filter(item => item.status !== "EXCLUDED").sort((a,b)=>preferences.enabled ? Number(matches.get(a.job.url)!.excluded)-Number(matches.get(b.job.url)!.excluded) || (matches.get(b.job.url)!.score ?? -1)-(matches.get(a.job.url)!.score ?? -1) : 0);
  const unknownCount = evaluated.filter(item => item.status === "UNKNOWN" && (!preferences.enabled || !matches.get(item.job.url)?.excluded)).length;
  const excludedCount = evaluated.filter(item => item.status === "EXCLUDED" || (preferences.enabled && matches.get(item.job.url)?.excluded)).length;
  const dirty = (Object.keys(draft) as (keyof BrowserFilter)[]).some(key => draft[key] !== filter[key]);
  const snapshotId = state.snapshot?.id;
  const snapshotIdRef = useRef(snapshotId);
  snapshotIdRef.current = snapshotId;
  useEffect(() => {
    if (!bridge || !active || !snapshotId) return;
    let cancelled = false;
    setRecordsReady(false);
    void bridge.request("records",{snapshot_id:snapshotId}).then(result => {
      if (cancelled) return;
      if (!result.ok) {setError(result.error);return;}
      setRecords(result.records ?? {});setRecordsReady(true);
    }).catch(() => {if(!cancelled)setError("本地保存状态读取失败，请重新读取岗位");});
    return () => {cancelled = true;};
  }, [bridge, active, snapshotId, revision]);
  const request = useCallback(async (operation: BossBrowserOperation, payload?: unknown) => {
    if (!bridge || locked.current) return;
    locked.current = true;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await bridge.request(operation, payload);
      if (!mounted.current) return;
      if (!result.ok) throw new Error(result.error);
      setState(result.state);
      if (result.records && snapshotIdRef.current === result.state.snapshot?.id) {setRecords(result.records);setRecordsReady(true);}
      if (operation === "read" || operation === "read.append") {
        if(operation === "read")setSelected([]);
        setHelperOpen(true);
        const captured = result.state.snapshot?.jobs ?? [];
        const missingLocation = captured.filter(job=>!job.location).length, missingEducation = captured.filter(job=>!job.education).length;
        const summary=result.read_summary;
        const prefix=operation === "read.append" && summary ? `本页读取 ${summary.read} 个，新增 ${summary.added} 个、重复更新 ${summary.repeated} 个；累计 ${summary.total} 个岗位` : `已读取 ${captured.length} 个岗位`;
        setNotice(`${prefix}${missingLocation || missingEducation ? `；累计缺地点 ${missingLocation} 个、缺学历 ${missingEducation} 个，请对照原站。未猜测缺失字段。` : ""}`);
      }
      if(operation==="salary.recognize")setNotice("本地识别完成。请对照下方字体预览和原站核对，确认后再保存岗位。");
      if(operation==="detail.read") {setHelperOpen(true);setSelected([]);setNotice("已读取当前详情并更新本地快照。展开职位描述可核对内容；需要长期保留请保存岗位。缺失内容仍待核实。");}
      if(operation==="batch.start"){setHelperOpen(true);setSelected([]);setNotice("批量读取已开始，每批自动保存到本地；可以随时停止。");}
      if(operation==="response.disable")setNotice("已关闭详情数据补全；仍可读取网页可见字段。已读结果保留。");
      if(operation==="response.enable")setNotice("详情补全已尝试启用；在原网页打开岗位后，再读取。未触发网站请求。");
      if(operation==="salary.confirm")setNotice("已确认此快照的薪资，保存岗位后会更新本地记录。没有执行沟通。");
      if(operation==="job.locate")setNotice("已滚动到原网页对应岗位。没有打开详情或执行沟通。");
      if(operation==="job.mark") {setNotice("个人标记已保存到本地；未保存的岗位已一并保存。未执行沟通。");onSaved();}
      if (result.saved !== undefined && operation!=="job.mark") { setNotice(result.save_summary ? `保存完成：新增 ${result.save_summary.created} 个，更新已有 ${result.save_summary.updated} 个。重复岗位合并，未执行沟通。` : `已保存或更新 ${result.saved} 个岗位。未执行沟通。`); onSaved(); }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "网页操作失败"); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  }, [bridge, onSaved]);
  useEffect(()=>{
    let cancelled=false;
    void window.recruitment?.command("matching.get").then(result=>{
      if(cancelled)return;
      if(!result.ok)throw new Error(result.error.message);
      setPreferences(matchingPreferencesSchema.parse(result.data));setMatchingReady(true);
    }).catch(e=>{if(!cancelled)setError(e instanceof Error?e.message:"匹配偏好读取失败");});
    return ()=>{cancelled=true;};
  },[]);
  const saveMatching=async(next:typeof preferences)=>{
    try {
      const result=await window.recruitment?.command("matching.save",next);
      if(!result?.ok)throw new Error(result && !result.ok?result.error.message:"本地服务未连接");
      if(mounted.current){setPreferences(matchingPreferencesSchema.parse(result.data));setSelected([]);setNotice("匹配偏好已保存；排序只使用本地已读字段。");}
    }catch(e){if(mounted.current)setError(e instanceof Error?e.message:"匹配偏好保存失败");}
  };
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (!window.recruitment) throw new Error("本地服务未连接");
        const result = await window.recruitment.command("browser-filter.get");
        if (!result.ok) throw new Error(result.error.message);
        const saved = browserFilterSchema.parse(result.data);
        if (!cancelled) {setDraft(saved);setFilter(saved);setFilterReady(true);}
      } catch(e) { if (!cancelled) setError(e instanceof Error ? e.message : "筛选条件读取失败"); }
    })();
    return () => {cancelled=true;};
  }, []);
  const applyFilter = async (next: BrowserFilter) => {
    if (!window.recruitment || !filterReady || filterLock.current) return;
    filterLock.current=true;setFilterSaving(true);setError("");
    try {
      const result=await window.recruitment.command("browser-filter.save", next);
      if (!result.ok) throw new Error(result.error.message);
      if (mounted.current) {setDraft(next);setFilter(next);setSelected([]);setNotice("筛选条件已保存，下次启动自动恢复。没有操作 BOSS 页面。");}
    } catch(e) {if(mounted.current)setError(e instanceof Error ? e.message : "筛选条件保存失败");}
    finally {filterLock.current=false;if(mounted.current)setFilterSaving(false);}
  };
  useEffect(() => {
    mounted.current = true;
    if (!bridge) return () => { mounted.current = false; };
    let active = true, polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try { const result = await bridge.request("state"); if (active && result.ok) setState(result.state); }
      catch { if (active) setError("桌面网页连接已中断，请重启软件"); }
      finally { polling = false; }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1200); // Local IPC only; never reloads or reads BOSS DOM.
    return () => { active = false; mounted.current = false; clearInterval(timer); void bridge.request("layout", { visible: false, x: 0, y: 0, width: 0, height: 0 }).catch(() => {}); };
  }, [bridge]);
  useEffect(() => {
    if (!bridge || !host.current) return;
    if (!active) {
      void bridge.request("layout", { visible: false, x: 0, y: 0, width: 0, height: 0 }).catch(() => {});
      return;
    }
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const rect = host.current?.getBoundingClientRect();
        if (!rect) return;
        const toolbarBottom = host.current?.closest(".boss-plugin")?.querySelector(".boss-browser-toolbar")?.getBoundingClientRect().bottom ?? 0;
        const x = Math.max(0, Math.round(rect.left)), y = Math.max(0, Math.round(rect.top), Math.round(toolbarBottom));
        const right = Math.min(window.innerWidth, Math.round(rect.right)), bottom = Math.min(window.innerHeight, Math.round(rect.bottom));
        void bridge.request("layout", { visible: state.opened && !document.hidden && bottom > y && right > x, x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) }).catch(() => {});
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(host.current);
    const workspace = host.current.closest(".plugin-main");
    if (workspace) observer.observe(workspace);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    document.addEventListener("visibilitychange", measure);
    measure();
    return () => { cancelAnimationFrame(raf); observer.disconnect(); window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); document.removeEventListener("visibilitychange", measure); };
  }, [bridge, active, state.opened, error, state.error, notice, helperOpen]);
  const change = (key: keyof BrowserFilter, value: string) => {setDraft(previous => ({ ...previous, [key]: value }));setSelected([]);};
  const blocked = state.page_kind === "SECURITY" || state.page_kind === "LOGIN";
  const canRead = !!bridge && !busy && state.opened && !state.loading && !state.reading && !state.crashed && state.page_kind === "JOBS";
  const time = (value: string) => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  const statusText = state.crashed ? "网页进程停止" : state.page_kind === "SECURITY" ? "需要安全验证" : state.page_kind === "LOGIN" ? "等待登录" : state.loading ? "加载中" : state.page_kind === "JOBS" ? "岗位列表" : state.page_kind === "DETAIL" ? "岗位详情" : "";
  return <section className={`boss-plugin ${helperOpen ? "helper-open" : ""}`} aria-label="BOSS 网页辅助工具">
    <div className="boss-browser-toolbar">
      <div className="wrap">
        {!state.opened && <button className="primary" disabled={!bridge || busy} onClick={() => void request("open")}>打开 BOSS</button>}
        <button className="icon" title="后退" aria-label="后退" disabled={!bridge || busy || !state.can_back} onClick={() => void request("back")}>←</button>
        <button className="icon" title="前进" aria-label="前进" disabled={!bridge || busy || !state.can_forward} onClick={() => void request("forward")}>→</button>
        {state.loading ? <button className="icon" title="停止加载" aria-label="停止加载" disabled={!bridge} onClick={() => void request("stop")}>✕</button>
          : <button className="icon" title="手动重载" aria-label="手动重载" disabled={!bridge || busy || !state.opened || state.crashed} onClick={() => void request("reload")}>↻</button>}
        <span className="divider"/>
        <button className="primary" disabled={!canRead} onClick={() => void request("read")}>{busy || state.reading ? "读取中…" : "读取岗位"}</button>
        <button disabled={!canRead} onClick={()=>void request("read.append")}>追加当前页</button>
        {!state.batch?.running && <button disabled={!canRead} onClick={()=>void request("batch.start")}>批量读取并保存</button>}
        {state.batch?.running && <button className="danger" onClick={()=>void request("batch.stop")}>停止读取</button>}
        {state.page_kind==="DETAIL" && <button className="primary" disabled={!bridge || busy || state.loading || state.reading || state.crashed} onClick={()=>void request("detail.read")}>读取当前详情</button>}
        <details className="browser-more"><summary>更多</summary><div><button disabled={!bridge || busy || state.batch?.running || !state.opened} onClick={() => void request("restart")}>重启网页</button><button disabled={!bridge || busy || state.reading || !state.opened} onClick={()=>void request(state.response_status==="READY"?"response.disable":"response.enable")}>{state.response_status==="READY"?"关闭详情补全":"启用详情补全"}</button></div></details>
      </div>
      {statusText && <span className="browser-status">{statusText}</span>}
      <button className={helperOpen ? "toggle on" : "toggle"} aria-expanded={helperOpen} onClick={() => setHelperOpen(value => !value)}>筛选结果{state.snapshot ? ` · ${jobs.length}` : ""}</button>
    </div>
    {(error || state.error) && <p role="alert" className="boss-plugin-error">{error || state.error}</p>}
    {notice && <p role="status" className="boss-plugin-notice">{notice}</p>}
    {state.batch && <p role="status" className="boss-plugin-notice">{state.batch.running?"批量读取中":"批量读取结束"}：{state.batch.rounds} 批，新增 {state.batch.added} 个，保存/更新 {state.batch.saved} 次。{state.batch.reason}</p>}
    {blocked ? <p role="status" className="verification-note">{state.page_kind === "SECURITY" ? "BOSS 安全验证中，请在下方网页完成验证后再读取。" : "请在下方网页登录 BOSS，然后打开岗位列表。"}</p>
      : state.snapshot && !state.snapshot_current && <p role="status" className="verification-note">{state.page_kind==="DETAIL"?"当前是岗位详情页，可点击“读取当前详情”补充职位描述。":"网页已离开读取时的列表，侧栏显示的是上次读取结果。返回列表后可“追加当前页”，或“读取岗位”开始新一轮。"}</p>}
    <div className="boss-plugin-columns">
      <div ref={host} className="boss-browser-host" aria-label="BOSS 原网页显示区域">
        <div className="boss-browser-placeholder">
          <span className="boss-browser-symbol">BOSS</span>
          <h2>{state.opened ? "BOSS 网页已打开" : "打开 BOSS 开始浏览"}</h2>
          <p>{bridge ? "在官方页面自行登录并浏览岗位，然后点击“读取岗位”。" : "内置网页只在桌面程序中运行，请双击“启动招聘助手.cmd”。"}</p>
        </div>
      </div>
      <div className="boss-helper" hidden={!helperOpen}>
        <div className="section-heading"><h2>岗位筛选</h2><button aria-label="收起筛选侧栏" onClick={() => setHelperOpen(false)}>×</button></div>
        <form onSubmit={event => { event.preventDefault(); void applyFilter({ ...draft }); }} className="boss-filter-form">
          <fieldset disabled={!filterReady || filterSaving}>
          <label>包含关键词<input value={draft.keyword} onChange={e => change("keyword", e.target.value)} maxLength={200} placeholder="如 Java 双休，空格分隔（需全部命中）" /></label>
          <label>城市或地区<input value={draft.city} onChange={e => change("city", e.target.value)} maxLength={80} placeholder="如 武汉；北京（任一）" /></label>
          <div className="two">
            <label>学历要求<select value={draft.education} onChange={e => change("education", e.target.value)}><option value="">全部学历</option>{["大专", "本科", "硕士", "博士", "学历不限"].map(value => <option key={value}>{value}</option>)}</select></label>
            <label>排除关键词<input value={draft.exclude} onChange={e => change("exclude", e.target.value)} maxLength={200} placeholder="如 销售 外包" /></label>
          </div>
          <div className="wrap"><button type="submit" disabled={!dirty}>{filterSaving ? "保存中…" : dirty ? "保存条件" : "条件已保存"}</button><button type="button" onClick={() => void applyFilter(emptyFilter)}>清空条件</button></div>
          </fieldset>
        </form>
        {matchingReady && <MatchingPanel value={preferences} onSave={saveMatching}/>}
        <div className="boss-results-header"><div><strong>{jobs.length}</strong><span className="muted"> / {state.snapshot?.jobs.length ?? 0} 个符合</span>{state.snapshot && <small>待核实 {unknownCount} · 排除 {excludedCount} · 读取于 {time(state.snapshot.observed_at)}</small>}</div><button disabled={!jobs.length} onClick={() => setSelected(jobs.map(j => j.url))}>全选符合</button></div>
        <div className="boss-results">
          {!visible.length && <p className="muted">{state.snapshot ? "当前条件未匹配到岗位，可点击“清空条件”。" : "读取岗位后，筛选结果会显示在这里。"}</p>}
          {!visible.length && excludedCount > 0 && <small>{[...new Set(evaluated.flatMap(item => item.reasons))].slice(0, 6).join("；")}</small>}
          {visible.map(({job,status,reasons}) => {
            const match = matches.get(job.url)!;
            const offPage = !!state.snapshot?.current_urls && !state.snapshot.current_urls.includes(job.url);
            const record = records[job.url];
            return <article className={`boss-job ${selected.includes(job.url) ? "selected" : ""}`} key={job.url}>
            <div className="boss-job-top">
              <label className="boss-job-choice"><input type="checkbox" disabled={preferences.enabled && match.excluded} checked={selected.includes(job.url)} onChange={e => setSelected(previous => e.target.checked ? [...previous, job.url] : previous.filter(url => url !== job.url))} /><strong>{job.title}</strong></label>
              <span className="boss-job-salary">{job.salary_ocr?.confirmed ? job.salary_ocr.candidate : showSalary(job.salary)}</span>
            </div>
            <p>{job.company}</p>
            <small>{[job.location || "地点未读取", job.education || "学历未读取", job.experience].filter(Boolean).join(" · ")}</small>
            <div className="boss-job-tags">
              {recordsReady && record && <span className="search-badge">已保存 · {jobMarkLabels[record.mark]}</span>}
              {offPage && <span className="search-badge">之前页面</span>}
            </div>
            {preferences.enabled && <div className={`match-score ${match.excluded ? "bad" : ""}`} title={match.reasons.join("；")}><strong>{match.excluded ? "不推荐：命中排除词" : match.score === null ? "请先填写匹配偏好" : `匹配 ${match.score} / 100`}</strong><small>依据完整度 {match.coverage}%</small></div>}
            {status === "UNKNOWN" && <small className="pending">待核实：{reasons.join("；")}</small>}
            {hasRestrictedGlyph(job.salary) &&!job.salary_ocr && <button disabled={!bridge || busy || state.reading || !state.snapshot_current || offPage || state.page_kind!=="JOBS"} onClick={()=>void request("salary.recognize",{snapshot_id:state.snapshot?.id,url:job.url})}>识别此岗位薪资</button>}
            {job.salary_ocr && !job.salary_ocr.confirmed && <div className="salary-ocr"><img src={job.salary_ocr.preview} alt="使用原页面字体绘制的薪资核对图"/><small>本地 OCR：{job.salary_ocr.candidate}（待核对）</small><button disabled={busy || state.reading} onClick={()=>void request("salary.confirm",{snapshot_id:state.snapshot?.id,url:job.url})}>已核对，采用此薪资</button></div>}
            {job.detail && <details className="job-description"><summary>已读职位描述</summary><p>{job.detail.address || "详细地址未读取"}</p><p>{job.detail.description || "职位描述未读取，请查看原站"}</p><small>读取于 {time(job.detail.observed_at)}</small></details>}
            <div className="boss-job-actions">
              <select className="compact" aria-label={`${job.title}的个人标记`} value={record?.mark ?? ""} disabled={!bridge || busy || !recordsReady} onChange={e=>void request("job.mark",{snapshot_id:state.snapshot?.id,url:job.url,mark:e.target.value})}><option value="" disabled>标记并保存</option>{Object.entries(jobMarkLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>
              <button className="link" disabled={!bridge || busy || state.loading || state.reading || !state.snapshot_current || offPage || state.page_kind!=="JOBS" || state.crashed} onClick={()=>void request("job.locate",{snapshot_id:state.snapshot?.id,url:job.url})}>定位原站岗位</button>
              <button className="link" disabled={!bridge || busy} onClick={() => void request("job.open", { url: job.url })}>详情</button>
            </div>
          </article>;})}
        </div>
        <div className="boss-helper-footer">
          {selected.length > 0 && recordsReady && <small>已选 {selected.length} 个，其中 {selected.filter(url=>records[url]).length} 个已保存（将更新）</small>}
          <button className="primary boss-wide" disabled={!bridge || busy || !selected.length || !state.snapshot} onClick={() => void request("save", { snapshot_id: state.snapshot?.id, urls: selected })}>保存所选岗位（{selected.length}）</button>
        </div>
      </div>
    </div>
  </section>;
}
