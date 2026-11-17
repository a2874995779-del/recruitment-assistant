import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultSearchConfig, searchCities, searchConfigSchema, searchRunSchema, searchPresetSchema, evaluateSearchJob, needsSearchVerification, type BossSearchConfig, type BossSearchRun, type SearchPreset } from "../../../../packages/contracts/src/boss-search.js";
import { searchConditions, searchEmptyFeedback, type SearchResultView } from './search-feedback.js';

import {JobComparison} from './JobComparison.js';

const formatTime=(value:string)=>new Date(value).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"});
const pairLabels={WAITING:"未扫描",RUNNING:"扫描中",STALLED:"暂时没有新增",LIMIT:"达到本段上限",BLOCKED:"需要处理",FAILED:"读取失败",STOPPED:"已停止",END:"原网页显示结束"};
export function SearchWorkspace({active,onBrowser,onOpen,onSaved}:{active:boolean;onBrowser:()=>void;onOpen:(url:string)=>void;onSaved:()=>void}){
  const [config,setConfig]=useState<BossSearchConfig>(defaultSearchConfig),[keywords,setKeywords]=useState(defaultSearchConfig.keywords.join("，"));
  const [ready,setReady]=useState(false),[run,setRun]=useState<BossSearchRun|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const [savedUrls,setSavedUrls]=useState<string[]>([]),[showSaved,setShowSaved]=useState(false);
  const [settingsOpen,setSettingsOpen]=useState(true);
  const [presets,setPresets]=useState<SearchPreset[]>([]),[presetId,setPresetId]=useState(''),[presetName,setPresetName]=useState('');
  const [discovery,setDiscovery]=useState<'ALL'|'NEW'|'SEEN'>('ALL');
  const [view,setView]=useState<SearchResultView>("MATCH"),[page,setPage]=useState(0),[selected,setSelected]=useState<string[]>([]),[comparing,setComparing]=useState(false);
  const lock=useRef(false),freshRun=useRef<string|null>(null),mounted=useRef(true),generation=useRef(0);
  const bridge=window.recruitment?.bossBrowser;
  const running=run?.status==="RUNNING";
  useEffect(()=>{if(run?.id){setSettingsOpen(false);setShowSaved(!run.config.skip_saved);}},[run?.id]);
  useEffect(()=>{
    if(run && run.status!=="RUNNING")setNotice(old=>old.startsWith("正在补全") || old.startsWith("正在重新获取") || old.startsWith("正在继续获取") || old.startsWith("已请求停止")?"":old);
  },[run?.id,run?.status]);
  const refresh=useCallback(async()=>{
    const token=++generation.current;
    if(!window.recruitment)return;
    const result=bridge?await bridge.request("search.get"):await window.recruitment.command("search-run.get");
    if(!result.ok)throw new Error("error" in result && typeof result.error==="string"?result.error:typeof result.error==="object"?result.error.message:"读取失败");
    const value="search_run" in result?result.search_run:"data" in result?result.data:null;
    if(mounted.current && token===generation.current){
      const next=value?searchRunSchema.parse(value):null;
      if(next?.status==="RUNNING")freshRun.current=next.id;
      setRun(next);if(!bridge){const saved=await window.recruitment.command("search-saved.get");if(saved.ok && mounted.current && token===generation.current)setSavedUrls(saved.data as string[]);}if("saved_urls" in result)setSavedUrls(result.saved_urls ?? []);
    }
  },[bridge]);
  useEffect(()=>{
    mounted.current=true;let cancelled=false;
    void (async()=>{if(!window.recruitment)return;const [result,list]=await Promise.all([window.recruitment.command('search-config.get'),window.recruitment.command('search-presets.list')]);
      if(cancelled)return;if(!result.ok)throw new Error(result.error.message);if(!list.ok)throw new Error(list.error.message);
      const next=searchConfigSchema.parse(result.data);setConfig(next);setKeywords(next.keywords.join("，"));setPresets((list.data as unknown[]).map(value=>searchPresetSchema.parse(value)));setReady(true);
    })().catch(e=>{if(!cancelled)setError(e instanceof Error?e.message:"配置读取失败");});
    return()=>{cancelled=true;mounted.current=false;generation.current++;};
  },[]);
  useEffect(()=>{
    if(!active)return;let cancelled=false,polling=false;
    const poll=async()=>{if(polling)return;polling=true;try{await refresh();}catch(e){if(!cancelled)setError(e instanceof Error?e.message:"连接失败");}finally{polling=false;}};
    void poll();const timer=setInterval(()=>void poll(),2000);
    return()=>{cancelled=true;generation.current++;clearInterval(timer);};
  },[active,refresh]);
  const parsedConfig=()=>searchConfigSchema.parse({...config,keywords:[...new Set(keywords.split(/[,，;；、\n]+/).map(word=>word.trim()).filter(Boolean))]});
  const perform=async(action:"start"|"recheck"|"continue"|"verify"|"stop"|"save-config"|"save-preset"|"delete-preset"|"save-jobs"|"save-matches")=>{
    if(lock.current || !window.recruitment)return;lock.current=true;setBusy(true);setError("");setNotice("");
    try {
      const saveUrls=action==='save-matches'?evaluated.filter(item=>item.status==='MATCH' && !savedSet.has(item.job.url)).map(item=>item.job.url):selected;
      if(action==='save-preset' || action==='delete-preset'){
        const result=await window.recruitment.command(action==='save-preset'?'search-presets.save':'search-presets.delete',action==='save-preset'?{...(presetId?{id:presetId}:{}),name:presetName,config:parsedConfig()}:{id:presetId});
        if(!result.ok)throw new Error(result.error.message);
        if(action==='save-preset'){const preset=searchPresetSchema.parse(result.data);setPresets(old=>[preset,...old.filter(value=>value.id!==preset.id)]);setPresetId(preset.id);setPresetName(preset.name);setNotice('常用条件已保存；选择条件不会自动获取岗位。');}
        else{setPresets(old=>old.filter(value=>value.id!==presetId));setPresetId('');setPresetName('');setNotice('已删除这组常用条件，岗位和读取记录保留。');}
      }else if(action==="save-config"){
        const result=await window.recruitment.command("search-config.save",parsedConfig());if(!result.ok)throw new Error(result.error.message);setNotice("搜索条件已保存；重新获取后生效。");
      }else{
        if(!bridge)throw new Error("请在桌面软件中获取岗位；网页预览只显示本地数据");
        const input=action==='recheck'?{...parsedConfig(),skip_saved:false,skip_processed:false}:null;
        const result=action==="start" || action==='recheck'?await bridge.request("search.start",input ?? parsedConfig()):action==='continue'?await bridge.request('search.continue',{run_id:run?.id}):action==='verify'?await bridge.request('search.verify',{run_id:run?.id}):action==="stop"?await bridge.request("search.stop"):await bridge.request("search.save",{run_id:run?.id,urls:saveUrls});
        if(!result.ok)throw new Error(result.error);
        if(action==="start" || action==='recheck' || action==='continue' || action==='verify'){
          if(input)setConfig(input);setDiscovery('ALL');
          generation.current++;const next=searchRunSchema.parse(result.search_run);freshRun.current=next.id;setRun(next);setView("MATCH");setPage(0);setSelected([]);setSettingsOpen(false);setNotice(action==='recheck'?'正在重新获取并核对旧岗位，本轮关闭两种跳过规则。读取失败保留本地保存记录。':action==='verify'?'正在补全待核实，只检查缺失字段，不重新扫描列表。':action==='continue'?"正在继续获取，沿用原任务条件并保留已有岗位。各岗位保留各自读取时间，未重读的旧岗位不表示已刷新。":"正在重新获取。本次结果独立展示，历史岗位没有混入。");
        }else if(action==="stop")setNotice("已请求停止，当前读取结束后保留已读结果。");
        else{setSavedUrls(old=>[...new Set([...old,...saveUrls])]);setSelected([]);onSaved();setNotice(`已保存 ${result.saved ?? 0} 个岗位。没有发送消息或简历。`);}
      }
    }catch(e){if(mounted.current)setError(e instanceof Error?e.message:"操作失败");}
    finally{lock.current=false;if(mounted.current)setBusy(false);}
  };
  const savedSet=useMemo(()=>new Set(savedUrls),[savedUrls]);
  const hiddenSaved=(run?.results ?? []).filter(item=>savedSet.has(item.job.url)).length;
  const pendingDetails=(run?.results ?? []).filter(item=>!savedSet.has(item.job.url) && needsSearchVerification(item.job,run!.config)).length;
  const evaluated=useMemo(()=>(run?.results ?? []).filter(item=>showSaved || !savedSet.has(item.job.url)).map(item=>({...item,...evaluateSearchJob(item.job,run!.config)})),[run,showSaved,savedSet]);
  const counts=useMemo(()=>({MATCH:evaluated.filter(item=>item.status==="MATCH").length,UNKNOWN:evaluated.filter(item=>item.status==="UNKNOWN").length,EXCLUDED:evaluated.filter(item=>item.status==="EXCLUDED").length}),[evaluated]);
  const filtered=useMemo(()=>evaluated.filter(item=>(discovery==='ALL' || item.discovery===discovery) && (view==="ALL" || (view==="CANDIDATES"?item.status!=="EXCLUDED":item.status===view))),[evaluated,view,discovery]);
  const emptyFeedback=searchEmptyFeedback(run,view);
  const maxPage=Math.max(0,Math.ceil(filtered.length/50)-1),currentPage=Math.min(page,maxPage),visible=filtered.slice(currentPage*50,(currentPage+1)*50);
  const terminal=run?.pairs.filter(pair=>!["WAITING","RUNNING"].includes(pair.status)).length ?? 0;
  const historical=!!run && run.status!=="RUNNING" && freshRun.current!==run.id;
  const progressText=run?.salary_progress?.running?`薪资补全中 ${run.salary_progress.checked}/${run.salary_progress.total}`:run?.detail_progress?.running?`字段补全中 ${run.detail_progress.checked}/${run.detail_progress.total}`:run?`${running?(run.activity==="VERIFY"?"正在补全":"正在获取"):historical?"历史结果":"已完成"} · 组合 ${terminal}/${run.pairs.length}`:"";
  const restricted=(salary:string)=>[...salary].some(c=>c.charCodeAt(0)>=0xE000 && c.charCodeAt(0)<=0xF8FF);
  return <section className="search-workspace" aria-label="岗位搜索">
    <div className="page-head"><div><h1>岗位搜索</h1><p className="muted">按条件获取 BOSS 岗位，筛选后保存到本地。</p></div><button onClick={onBrowser}>登录 / 查看 BOSS</button></div>
    {error && <p role="alert" className="app-error">{error}</p>}{notice && <p role="status" className="boss-plugin-notice">{notice}</p>}
    <div className="card">
    <details className="search-settings" open={settingsOpen} onToggle={event=>setSettingsOpen(event.currentTarget.open)}><summary><strong>搜索条件</strong>{run && !settingsOpen && <span className="muted"> · {searchConditions(run.config)}</span>}</summary>
    <form className="search-config" onSubmit={event=>{event.preventDefault();void perform("start");}}>
      <fieldset disabled={!ready || busy || running}>
        <label className="search-keywords">岗位关键词<input aria-label="目标岗位关键词" value={keywords} maxLength={365} onChange={event=>setKeywords(event.target.value)} placeholder="Java，后端开发，软件开发"/><small>逗号分隔，最多 6 个</small></label>
        <div className="search-cities"><span className="field-label">工作城市 <small>（最多 3 个）</small></span><div className="wrap">{Object.keys(searchCities).map(city=><label key={city}><input type="checkbox" checked={config.cities.includes(city as typeof config.cities[number])} onChange={event=>setConfig(old=>({...old,cities:event.target.checked?[...old.cities,city as typeof old.cities[number]]:old.cities.filter(value=>value!==city)}))}/>{city}</label>)}</div></div>
        <label className="search-type">岗位类型<select aria-label="岗位类型 / 经验" value={config.experience} onChange={event=>setConfig(old=>({...old,experience:event.target.value as typeof old.experience}))}><option value="GRADUATE">应届 / 经验不限</option><option value="INTERN">仅实习岗位</option><option value="ALL">不限</option></select></label>
        <label>薪资周期<select aria-label="薪资周期" value={config.salary_period} onChange={event=>setConfig(old=>({...old,salary_period:event.target.value as 'MONTH'|'DAY',salary_min:null,salary_max:null}))}><option value="MONTH">月薪（K/月）</option><option value="DAY">日薪（元/天）</option></select></label>
        <label>薪资下限（{config.salary_period==='DAY'?'元/天':'K/月'}）<input aria-label="薪资下限" type="number" min="0" max="100000" step="0.5" value={config.salary_min ?? ""} onChange={event=>setConfig(old=>({...old,salary_min:event.target.value===""?null:Number(event.target.value)}))}/></label>
        <label>薪资上限（{config.salary_period==='DAY'?'元/天':'K/月'}）<input aria-label="薪资上限" type="number" min="0" max="100000" step="0.5" value={config.salary_max ?? ""} onChange={event=>setConfig(old=>({...old,salary_max:event.target.value===""?null:Number(event.target.value)}))}/></label>
        <label>学历要求<select value={config.education} onChange={event=>setConfig(old=>({...old,education:event.target.value as typeof old.education}))}><option value="">全部学历</option>{["大专","本科","硕士","博士","学历不限"].map(value=><option key={value}>{value}</option>)}</select></label>
        <label>排除关键词<input value={config.exclude} maxLength={200} onChange={event=>setConfig(old=>({...old,exclude:event.target.value}))} placeholder="如 外包 销售"/></label>
        <details className="search-advanced"><summary>高级选项</summary><div className="search-advanced-grid">
          <label>每组合扫描批数<select value={config.rounds} onChange={event=>setConfig(old=>({...old,rounds:Number(event.target.value)}))}>{[5,15,30].map(value=><option key={value} value={value}>{value} 批</option>)}</select></label>
          <label className="check"><input type="checkbox" checked={config.salary_enrichment} onChange={event=>setConfig(old=>({...old,salary_enrichment:event.target.checked}))}/> 自动补全受限薪资</label>
          <label className="check"><input type="checkbox" checked={config.skip_saved} onChange={event=>setConfig(old=>({...old,skip_saved:event.target.checked}))}/> 跳过已保存岗位</label>
          <label className="check"><input type="checkbox" checked={config.skip_processed} onChange={event=>setConfig(old=>({...old,skip_processed:event.target.checked}))}/> 跳过相同条件已筛选岗位</label>
        </div></details>
        <div className="wrap search-presets">
          <select className="compact" aria-label="常用搜索条件" value={presetId} onChange={event=>{const id=event.target.value;setPresetId(id);const preset=presets.find(value=>value.id===id);setPresetName(preset?.name ?? '');if(preset){setConfig(preset.config);setKeywords(preset.config.keywords.join('，'));setSettingsOpen(true);setNotice('已载入常用条件，点击“获取岗位”后生效。');}}}><option value="">常用条件…</option>{presets.map(preset=><option key={preset.id} value={preset.id}>{preset.name}</option>)}</select>
          <input className="compact" aria-label="条件名称" value={presetName} maxLength={60} onChange={event=>setPresetName(event.target.value)} placeholder="条件名称，如 武汉 Java 应届"/>
          <button type="button" disabled={!presetName.trim()} onClick={()=>void perform('save-preset')}>{presetId?'更新常用条件':'保存为常用条件'}</button>
          {presetId && <button type="button" onClick={()=>{setPresetId('');setPresetName('');}}>新建</button>}
          {presetId && <button type="button" onClick={()=>void perform('delete-preset')}>删除这组条件</button>}
          </div>
      </fieldset>
      <div className="wrap form-actions"><button className="primary" type="submit" disabled={!bridge || !ready || busy || running}>重新获取岗位</button><button type="button" disabled={!ready || busy || running} onClick={()=>void perform("save-config")}>保存为默认条件</button>{running && <button type="button" className="danger" disabled={busy} onClick={()=>void perform("stop")}>停止获取</button>}</div>
    </form>
    </details>
    <div className="wrap search-run-controls">
      {!settingsOpen && <><button className="primary" disabled={!bridge || !ready || busy || running} onClick={()=>void perform("start")}>重新获取岗位</button><button disabled={busy} onClick={()=>setSettingsOpen(true)}>修改搜索条件</button>{running && <button className="danger" disabled={busy} onClick={()=>void perform("stop")}>停止获取</button>}</>}
      {run && <button disabled={!bridge || busy || running || run.results.length>=2000} onClick={()=>void perform('continue')} title="沿用当前结果的条件继续扫描，保留已有岗位">继续获取</button>}
      {run && <button disabled={!bridge || busy || running || !pendingDetails} onClick={()=>void perform('verify')} title="打开详情补全缺失字段，不重新扫描列表">补全待核实（{pendingDetails}）</button>}
      <button disabled={!bridge || !ready || busy || running} onClick={()=>void perform('recheck')} title="不跳过已保存和已筛选岗位，重新读取">重新检查旧岗位</button>
      {progressText && <span className="run-status">{running && <i className="spinner"/>}{progressText}</span>}
    </div>
    </div>
    <div className="search-stats">{([["已读取",run?.results.length ?? 0,""],["符合条件",counts.MATCH,"ok"],["待核实",counts.UNKNOWN,"warn"],["已排除",counts.EXCLUDED,"bad"]] as const).map(([label,value,tone])=><div key={label} className={tone}><small>{label}</small><strong>{value}</strong></div>)}</div>
    {run && <div className="search-progress">
      <p><strong>{running?(run.activity==="VERIFY"?"正在补全":"正在获取"):historical?"历史读取结果":"累计读取结果"}</strong> · 开始于 {formatTime(run.started_at)}{run.finished_at?` · 结束于 ${formatTime(run.finished_at)}`:""} · 查询进度 {terminal} / {run.pairs.length}</p>
      <p>本轮新发现 {run.results.filter(item=>item.discovery==='NEW').length} 个，重读 {run.results.filter(item=>item.discovery==='SEEN').length} 个；跳过已保存 {run.skipped_saved ?? 0} 个、相同条件已完成筛选 {run.skipped_processed ?? 0} 个。{run.segment && ` 第 ${run.segment.number} 段：新增 ${run.segment.added} 个，重读已有 ${run.segment.refreshed} 个。`}</p>
      {run.detail_progress && <p>字段补全{run.detail_progress.running?"中":"结束"}：{run.detail_progress.checked} / {run.detail_progress.total}，更新 {run.detail_progress.updated}，未能核实 {run.detail_progress.failed}。{run.detail_progress.reason}</p>}
      {run.salary_progress && <p>薪资补全{run.salary_progress.running?"中":"结束"}：{run.salary_progress.checked} / {run.salary_progress.total}，补全 {run.salary_progress.updated}，未能核实 {run.salary_progress.failed}。{run.salary_progress.reason}</p>}
      <details><summary>扫描范围与原因{run.reason?` · ${run.reason}`:""}</summary>{run.pairs.map(pair=><p key={`${pair.city}:${pair.keyword}`}>{pair.city} · {pair.keyword}：{pairLabels[pair.status]}，{pair.rounds} 批 / {pair.seen} 个。{pair.reason}{pair.advance && ` 已识别卡片 ${pair.advance.cards} 个；${pair.advance.action==='NEXT_PAGE'?'已尝试下一页':pair.advance.at_end?'已到底部':'未到底部'}。${pair.advance.reason}`}</p>)}</details>
    </div>}
    <div className="search-results-toolbar">
      <div className="segmented">{([["MATCH","符合条件"],["UNKNOWN","待核实"],["CANDIDATES","候选岗位"],["EXCLUDED","已排除"],["ALL","全部已读"]] as const).map(([value,label])=><button key={value} aria-pressed={view===value} onClick={()=>{setView(value);setPage(0);}}>{label} <em>{value==='ALL'?evaluated.length:value==='CANDIDATES'?counts.MATCH+counts.UNKNOWN:counts[value]}</em></button>)}</div>
      <select className="compact" aria-label="读取来源" value={discovery} onChange={event=>{setDiscovery(event.target.value as typeof discovery);setPage(0);setSelected([]);}}><option value="ALL">全部来源</option><option value="NEW">本轮新发现</option><option value="SEEN">以前已读</option></select>
      <label className="check"><input type="checkbox" checked={showSaved} onChange={event=>{setShowSaved(event.target.checked);setSelected([]);setPage(0);}}/> 显示已保存岗位（{hiddenSaved}）</label>
      <div className="wrap push-right"><button disabled={running || selected.length<2 || selected.length>4} onClick={()=>setComparing(true)}>对比（{selected.length}）</button><button disabled={busy || running || !selected.length} onClick={()=>void perform("save-jobs")}>保存所选（{selected.length}）</button><button className="primary" disabled={busy || running || !evaluated.some(item=>item.status==="MATCH" && !savedSet.has(item.job.url))} onClick={()=>void perform("save-matches")}>保存全部符合</button></div>
    </div>
    <div className="search-table"><table><thead><tr><th></th><th>岗位 / 企业</th><th>薪资</th><th>地区 / 要求</th><th>筛选结果</th><th></th></tr></thead><tbody>{visible.map(item=><tr key={item.job.url}>
      <td><input type="checkbox" aria-label={`选择${item.job.title}`} disabled={running || item.status==="EXCLUDED"} checked={selected.includes(item.job.url)} onChange={event=>setSelected(old=>event.target.checked?[...old,item.job.url]:old.filter(url=>url!==item.job.url))}/></td>
      <td><strong>{item.job.title}</strong>{savedSet.has(item.job.url) && <span className="tag">已保存</span>}<small>{item.job.company}</small>{item.job.detail && <details className="job-description"><summary>职位描述</summary><p>{item.job.detail.description || "描述尚未读取"}</p></details>}</td>
      <td className="salary">{restricted(item.job.salary)?<span className="muted">薪资受限</span>:item.job.salary || <span className="muted">未读取</span>}<small>{item.job.salary_detail?.source==="DETAIL_DOM"?"详情原文":item.job.detail_response?.salary?"详情响应":"页面原文"}</small></td>
      <td>{item.job.location || "地点未读取"}<small>{[item.job.education,item.job.experience].filter(Boolean).join(" · ")}</small></td>
      <td><span className={`search-badge ${item.status.toLowerCase()}`}>{item.status==="MATCH"?"符合":item.status==="UNKNOWN"?"待核实":"已排除"}</span>{!!item.reasons.length && <small>{item.reasons.join("；")}</small>}<small title={item.queries.join("；")}>读取于 {formatTime(item.observed_at)}</small></td>
      <td><button className="link" disabled={running} onClick={()=>onOpen(item.job.url)}>原帖</button></td>
    </tr>)}</tbody></table>{!visible.length && <div className="empty" role="status"><p>{!showSaved && hiddenSaved && !evaluated.length?"本次读取的岗位均已保存，勾选“显示已保存”可查看。":discovery!=='ALL' && evaluated.length?'当前来源分类暂无岗位，可切换“全部来源”核对。':emptyFeedback.message}</p>{emptyFeedback.showAll && <button onClick={()=>{setView("ALL");setPage(0);}}>查看全部已读岗位</button>}{emptyFeedback.showBrowser && <button onClick={onBrowser}>查看 BOSS 原网页</button>}</div>}</div>
    {maxPage>0 && <div className="saved-pagination"><button disabled={currentPage===0} onClick={()=>setPage(old=>Math.max(0,old-1))}>上一页</button><span>{filtered.length} 个 · 第 {currentPage+1} / {maxPage+1} 页</span><button disabled={currentPage>=maxPage} onClick={()=>setPage(old=>old+1)}>下一页</button></div>}
    {comparing && <JobComparison items={evaluated.filter(item=>selected.includes(item.job.url)).map(item=>({job:item.job,observed_at:item.observed_at}))} onClose={()=>setComparing(false)} onOpen={onOpen}/>}
  </section>;
}
