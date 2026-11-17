import { createRequire } from "node:module";
import { createWorker, PSM } from "tesseract.js";
import { z } from "zod";

const png = z.string().max(300000).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
export const renderedSalarySchema = z.object({raw:z.string().min(1).max(200),preview:png,runs:z.array(z.object({raw:z.string().min(1).max(12),images:z.tuple([png,png])}).strict()).min(1).max(8)}).strict();
export type RenderedSalary = z.infer<typeof renderedSalarySchema>;
export function assembleSalary(raw:string, readings:{raw:string;digits:string;confidence:number}[]) {
  let index=0;
  const candidate=raw.replace(/[\uE000-\uF8FF0-9]+/g,run=>{
    if (!/[\uE000-\uF8FF]/.test(run)) return run;
    const reading=readings[index++];
    if (!reading || reading.raw!==run || !/^\d+$/.test(reading.digits) || reading.digits.length!==run.length || reading.confidence<70 || [...run].some((char,i)=>/\d/.test(char) && char!==reading.digits[i])) throw new Error("数字识别不可靠，请查看原站薪资；未修改数据");
    return reading.digits;
  });
  if (index!==readings.length || /[\uE000-\uF8FF]/.test(candidate) || !/\d/.test(candidate) || !/[Kk万千元薪]/.test(candidate)) throw new Error("薪资格式无法确认，未修改数据");
  return candidate;
}

// The language model is installed with npm. No network access or cloud upload.
export async function recognizeSalary(raw:unknown) {
  const rendered=renderedSalarySchema.parse(raw);
  for(const image of [rendered.preview,...rendered.runs.flatMap(run=>run.images)]) {
    const bytes=Buffer.from(image.split(',')[1]!,"base64");
    if(bytes.length<24 || bytes.subarray(0,8).toString('hex')!=="89504e470d0a1a0a" || bytes.readUInt32BE(16)>1800 || bytes.readUInt32BE(20)>200 || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20))throw new Error("薪资图像超出本地识别范围");
  }
  const require=createRequire(import.meta.url);
  const model=require("@tesseract.js-data/eng") as {langPath:string};
  let expired=false;
  const creating=createWorker("eng",1,{langPath:model.langPath,cacheMethod:"none",gzip:true,errorHandler:()=>{}});
  void creating.then(worker=>{if(expired)void worker.terminate();},()=>{});
  let timer:ReturnType<typeof setTimeout> | undefined;
  let worker:Awaited<typeof creating> | undefined;
  const recognition=(async()=>{
    worker=await creating;
    if(expired)throw new Error("薪资识别已超时");
    await worker.setParameters({tessedit_pageseg_mode:PSM.SINGLE_WORD,tessedit_char_whitelist:"0123456789",user_defined_dpi:"300"});
    const readings=[];
    for(const run of rendered.runs){
      const first=(await worker.recognize(Buffer.from(run.images[0].split(',')[1]!,"base64"))).data;
      const second=(await worker.recognize(Buffer.from(run.images[1].split(',')[1]!,"base64"))).data;
      const a=first.text.trim(),b=second.text.trim();
      if(a!==b)throw new Error("两次识别结果不一致，请查看原站薪资；未修改数据");
      readings.push({raw:run.raw,digits:a,confidence:Math.min(first.confidence,second.confidence)});
    }
    return {candidate:assembleSalary(rendered.raw,readings),confidence:Math.min(...readings.map(r=>r.confidence)),preview:rendered.preview,confirmed:false};
  })();
  try {return await Promise.race([recognition,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(new Error("本地薪资识别超时，未修改数据；可稍后手动重试"));},20000);})]);}
  finally {clearTimeout(timer);expired=true;if(worker)await worker.terminate();}
}

// Render only the salary label with fonts already loaded by the original page.
// Offscreen canvas is never attached to DOM, and no website requests are made.
export function renderSalary(job:{url:string;salary:string}) {
  const anchor=Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/job_detail/"]')).find(a=>{try{const u=new URL(a.href);return `${u.origin}${u.pathname}`===job.url;}catch{return false;}});
  if(!anchor)throw new Error("岗位已离开当前页面，请重新读取岗位");
  const card=anchor.closest("li.job-card-wrapper,li.job-card-box,li.job-card-wrap,li.job-list-item") || anchor.closest(".job-card-wrapper,.job-card-wrap,.job-card-box,.job-card,.job-list-item,.sub-li,li");
  if(!card || !anchor.getClientRects().length)throw new Error("岗位尚未显示，请重新读取");
  const label=Array.from(card.querySelectorAll(".salary,.job-salary,.salary-text,.job-salary-text")).find(el=>el.getClientRects().length && el.textContent?.trim());
  if(!label)throw new Error("当前卡片没有可读取的薪资字段");
  const raw=(label.textContent??"").trim().replace(/\s+/g," ");
  if(raw!==job.salary)throw new Error("薪资内容已变化，请重新读取岗位");
  const walker=document.createTreeWalker(label,NodeFilter.SHOW_TEXT);
  const families=new Set<string>();let node:Node|null;
  while((node=walker.nextNode()))if(/[\uE000-\uF8FF]/.test(node.textContent??""))families.add(getComputedStyle(node.parentElement!).fontFamily);
  if(families.size!==1)throw new Error("特殊字体未识别或混合使用，请查看原站薪资");
  const family=[...families][0]!;
  if(!document.fonts.check(`72px ${family}`,raw))throw new Error("薪资字体尚未加载，请稍后手动识别");
  const draw=(value:string,size:number)=>{
    const canvas=document.createElement('canvas');const context=canvas.getContext('2d');
    if(!context)throw new Error("本地字体绘制不可用");
    context.font=`${size}px ${family}`;
    canvas.width=Math.ceil(context.measureText(value).width)+48;canvas.height=size*2;
    if(canvas.width>1800)throw new Error("薪资文本超出识别范围");
    context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);
    context.font=`${size}px ${family}`;context.fillStyle='#000';context.textBaseline='middle';context.fillText(value,24,size);
    return canvas.toDataURL('image/png');
  };
  const runs=[...raw.matchAll(/[\uE000-\uF8FF0-9]+/g)].filter(m=>/[\uE000-\uF8FF]/.test(m[0])).map(m=>({raw:m[0],images:[draw(m[0],72),draw(m[0],96)]}));
  if(!runs.length || runs.length>8)throw new Error("没有可识别的特殊字体数字");
  return {raw,preview:draw(raw,32),runs};
}
