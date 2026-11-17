/** These functions execute in the remote page. They must have no imported dependencies. */
export function findCommunicationLink(jobUrl:string):string|null {
  if(location.href.split('?')[0]!==jobUrl)return null;
  const candidates=Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).filter(a=>{
    const u=new URL(a.href,location.href);
    return u.origin==='https://www.zhipin.com' && u.pathname==='/web/geek/chat' && !!u.search && a.getBoundingClientRect().width>0 && /^(继续沟通|查看沟通)$/.test((a.innerText??'').trim());
  });
  return candidates.length===1?candidates[0]!.href:null;
}

export async function greetingPage(input:{url:string;title:string;company:string;text?:string;inspectOnly?:boolean;deadline?:number}):Promise<{ready:boolean;reason:string;clicked?:boolean}>{
  const fail=(reason:string)=>({ready:false,reason});
  if(location.origin!=='https://www.zhipin.com' || location.pathname!=='/web/geek/chat')return fail('请先进入此岗位的沟通窗口');
  const visible=(el:HTMLElement)=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden';};
  const normalize=(s:string)=>s.normalize('NFKC').replace(/\s/g,'');
  // Only the current position/header can establish identity, never old messages or the sidebar.
  const cards=Array.from(document.querySelectorAll<HTMLElement>('.chat-job-card, .chat-position, .chat-conversation .chat-header, .chat-container .chat-header')).filter(visible);
  const identity=cards.find(card=>Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]')).some(a=>a.href.split('?')[0]===input.url) && normalize(card.innerText).includes(normalize(input.title)) && normalize(card.innerText).includes(normalize(input.company)));
  if(!identity)return fail('无法确认当前会话的岗位与企业，请在原站核对；未发送');
  if(input.inspectOnly)return {ready:true,reason:'已核对岗位与企业'};
  const editors=Array.from(document.querySelectorAll<HTMLElement>('.chat-container textarea, .chat-conversation textarea, .chat-container [contenteditable="true"], .chat-conversation [contenteditable="true"], #chat-input')).filter(visible);
  if(editors.length!==1)return fail('未识别到唯一的沟通输入框；未发送');
  const editor=editors[0]!;
  if(editor instanceof HTMLTextAreaElement && (editor.disabled||editor.readOnly))return fail('当前输入框不可用');
  const current=editor instanceof HTMLTextAreaElement?editor.value:editor.innerText;
  if(current.trim())return fail('原站输入框已有草稿，请先处理草稿；未覆盖');
  if(!input.text)return {ready:true,reason:'已核对岗位与企业'};
  const buttons=Array.from(document.querySelectorAll<HTMLElement>('.chat-container button, .chat-container .btn-send, .chat-conversation button, .chat-conversation .btn-send')).filter(el=>visible(el)&&el.innerText.trim()==='发送');
  if(buttons.length!==1)return fail('未识别到唯一的发送按钮；未发送');
  if(editor instanceof HTMLTextAreaElement){Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(editor,input.text);}else{editor.textContent=input.text;}
  editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:input.text}));
  // Let the site's controlled input update before checking the send button.
  await new Promise(resolve=>setTimeout(resolve,0));
  if(!identity.isConnected || !editor.isConnected || location.pathname!=='/web/geek/chat' || !input.deadline || Date.now()>input.deadline)return fail('页面已变化或发送已超时；未发送');
  const button=buttons[0]!;
  const entered=editor instanceof HTMLTextAreaElement?editor.value:editor.innerText;
  if(entered!==input.text || button.matches(':disabled,[aria-disabled="true"],.disabled'))return fail('招呼语已填入，但发送按钮不可用，请查看原站');
  button.click();
  return {ready:true,clicked:true,reason:'已点击发送，等待页面回显'};
}

export function hasCommunicationDraft():boolean {
  if(location.pathname!=='/web/geek/chat')return false;
  return Array.from(document.querySelectorAll<HTMLElement>('.chat-container textarea, .chat-conversation textarea, .chat-container [contenteditable="true"], .chat-conversation [contenteditable="true"], #chat-input')).some(el=>(el instanceof HTMLTextAreaElement?el.value:el.innerText).trim().length>0);
}

export function greetingEcho(text:string):boolean {
  // Check outgoing bubbles only. A matching draft or an incoming message is not confirmation.
  return Array.from(document.querySelectorAll<HTMLElement>('.chat-container .message-item.is-self .text, .chat-container .message-item.is-me .text, .chat-conversation .message-item.is-self .text')).some(el=>el.innerText.trim()===text && !el.closest('.failed,.send-failed,.sending'));
}
