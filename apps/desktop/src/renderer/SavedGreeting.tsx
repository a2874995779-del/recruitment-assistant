import {useEffect,useRef,useState} from 'react';
import {defaultGreeting,greetingConfigSchema} from '../../../../packages/contracts/src/greeting.js';
import type {ManagedJob} from '../../../../packages/contracts/src/job-management.js';

export function GreetingSettings(){
  const [template,setTemplate]=useState(defaultGreeting.template),[saved,setSaved]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[loaded,setLoaded]=useState(false);
  const lock=useRef(false);
  useEffect(()=>{let cancelled=false;void(async()=>{try{const result=await window.recruitment?.command('greeting-config.get');if(!result)throw new Error('本地服务未连接');if(!result.ok)throw new Error(result.error.message);const config=greetingConfigSchema.parse(result.data);if(!cancelled){setTemplate(config.template);setSaved(config.template);setLoaded(true);}}catch(error){if(!cancelled)setMessage(error instanceof Error?error.message:'读取招呼语失败');}})();return()=>{cancelled=true;};},[]);
  async function save(){if(lock.current)return;lock.current=true;setBusy(true);setMessage('');try{const config=greetingConfigSchema.parse({template});const result=await window.recruitment?.command('greeting-config.save',config);if(!result)throw new Error('本地服务未连接');if(!result.ok)throw new Error(result.error.message);setSaved(config.template);setTemplate(config.template);setMessage('招呼语已保存到本机');}catch(error){setMessage(error instanceof Error?error.message:'保存失败');}finally{lock.current=false;setBusy(false);}}
  return <details className="greeting-settings"><summary>设置招呼语</summary><label>预设招呼语<textarea aria-label="预设招呼语" value={template} onChange={e=>setTemplate(e.target.value)} maxLength={500} rows={3} disabled={!loaded||busy}/></label><small>支持 {'{岗位}'}、{'{公司}'}，点击岗位的“一键打招呼”后可预览实际内容。一次只发送一个岗位，不附带简历。</small><div className="wrap"><button disabled={!loaded||busy||template===saved||!template.trim()} onClick={()=>void save()}>{busy?'保存中…':'保存招呼语'}</button><span role="status">{message}</span></div></details>;
}

export function SavedGreeting({job,blocked,onSaved,onBrowser}:{job:ManagedJob;blocked:boolean;onSaved:()=>void;onBrowser:()=>void}){
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[preview,setPreview]=useState<{token:string;text:string;expires_at:string}>();
  const lock=useRef(false),dialog=useRef<HTMLDialogElement>(null);
  const status=job.greeting?.status;
  const prevented=!!status&&status!=='FAILED';
  useEffect(()=>{if(preview){dialog.current?.showModal();}else{dialog.current?.close();}},[preview]);
  async function open(prepare:boolean){if(lock.current)return;lock.current=true;setBusy(true);setError('');try{const bridge=window.recruitment?.bossBrowser;if(!bridge)throw new Error('请使用桌面软件');const result=await bridge.request(prepare?'greeting.prepare':'communication.open',{id:job.id});if(!result.ok)throw new Error(result.error);if(prepare){if(!result.greeting)throw new Error('未生成发送预览');setPreview(result.greeting);}else onBrowser();}catch(error){setError(error instanceof Error?error.message:'打开沟通失败');}finally{lock.current=false;setBusy(false);}}
  async function send(){if(lock.current||!preview)return;lock.current=true;setBusy(true);setError('');try{const bridge=window.recruitment?.bossBrowser;if(!bridge)throw new Error('请使用桌面软件');const result=await bridge.request('greeting.send',{id:job.id,token:preview.token,text:preview.text});if(!result.ok)throw new Error(result.error);setPreview(undefined);}catch(error){setError(error instanceof Error?error.message:'发送结果待核实，请查看原站');setPreview(undefined);}finally{onSaved();lock.current=false;setBusy(false);}}
  return <div className="saved-greeting"><div className="wrap"><button disabled={blocked||busy||prevented} onClick={()=>void open(true)}>{busy?'处理中…':'一键打招呼'}</button><button disabled={blocked||busy} onClick={()=>void open(false)}>打开沟通</button></div>{job.greeting&&<small title={job.greeting.text}>{status==='SENT'?'招呼语已在页面显示':status==='FAILED'?'未发送': '发送结果待核实'} · {job.greeting.reason}</small>}{error&&<small role="alert">{error} <button disabled={busy} onClick={onBrowser}>查看原站</button></small>}
    <dialog ref={dialog} className="greeting-dialog" onCancel={e=>{if(busy)e.preventDefault();else setPreview(undefined);}}><h2>发送招呼语</h2><p><strong>{job.title}</strong> · {job.company_name}</p><p className="greeting-preview">{preview?.text}</p><small>将向已核对的当前 BOSS 会话发送以上内容。预览两分钟内有效；结果不明确时禁止重复发送。</small><div className="wrap"><button className="primary" disabled={busy||blocked} onClick={()=>void send()}>{busy?'正在发送…':'确认发送招呼'}</button><button disabled={busy} onClick={()=>setPreview(undefined)}>取消</button></div></dialog>
  </div>;
}
