const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const harness = process.env.CHATTER_TEST_ROOT ? path.join(process.env.CHATTER_TEST_ROOT, 'tests/harness') : './harness';
const { makeEnv, sleep, prof, ME, UID } = require(harness);
const key = 'bob::me';
const state = () => ({
  profiles: [prof(ME), prof('bob')],
  friendships: [{ owner_acc: ME, friend_acc: 'bob' }, { owner_acc: 'bob', friend_acc: ME }],
  conversations: [ME, 'bob'].map(acc => ({ owner_acc: acc, peer_acc: acc === ME ? 'bob' : ME, conv_key: key, unread: 0 })),
  messages: []
});
const bubble = (e, id) => e.$('chat-messages').querySelector('.msg[data-id="' + id + '"] .bubble');
const contextMenu = (e, id) => bubble(e, id).dispatchEvent(new e.w.MouseEvent('contextmenu', { bubbles: true }));
const snapshot = e => Object.fromEntries(Object.keys(e.w.localStorage).map(k => [k, e.w.localStorage.getItem(k)]));
async function until(predicate, timeout = 4500) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw Error('等待条件超时');
    await sleep(25);
  }
}
function make(db, extra = {}) {
  return makeEnv({ db, ...extra });
}
async function sender(db, extra = {}) {
  const e = make(db, extra);
  try {
    await e.login();
    await e.T.openConv(key, 'bob');
    return e;
  } catch (err) { e.close(); throw err; }
}
const failInsert = q => q.table === 'messages' && q.op === 'insert' ? { data: null, error: { message: 'offline fixture' } } : undefined;
function enter(e, text) {
  e.$('chat-input').value = text;
  e.$('btn-send').click();
  return e.T.S.msgs.find(m => m.body === text).id;
}
async function recipientBodies(db) {
  const e = make(db, { onRpc: name => name === 'bootstrap' ? {
    data: { me: prof('bob'), friends: [prof(ME)], convs: db.conversations.filter(c => c.owner_acc === 'bob'), peers: [], requests: [] }, error: null
  } : undefined });
  try {
    await e.T.getReady();
    await e.T.onAuth('SIGNED_IN', { user: { id: 'u-bob' }, access_token: 'fixture' });
    assert.equal(e.T.S.me.account_id, 'bob');
    await e.T.openConv(key, ME);
    return [...e.$('chat-messages').querySelectorAll('.bubble')].map(el => el.textContent);
  } finally { e.close(); }
}
for (const mode of ['单条删除', '多选删除', '撤销删除', '旧版本残留']) {
  test('取消发送后重启和联网：' + mode, async () => {
    const db = state(), e = await sender(db, { onQuery: failInsert });
    let saved, idb, keep, cancel;
    try {
      keep = enter(e, '保留');
      cancel = enter(e, '已取消');
      await until(() => e.T.S.out.get(cancel)?._st === 'failed');
      Object.defineProperty(e.w.navigator, 'onLine', { configurable: true, value: false });
      const storedBefore = e.w.localStorage.getItem('ch2outq:' + UID);
      contextMenu(e, cancel);
      if (mode === '多选删除') { e.$('msg-menu-multi').click(); e.$('multi-del').click(); }
      else e.$('msg-menu-del').click();
      if (mode === '撤销删除') e.w.document.querySelector('.toast-act button').click();
      if (mode === '旧版本残留') e.w.localStorage.setItem('ch2outq:' + UID, storedBefore);
      assert.equal(db.messages.length, 0);
      saved = snapshot(e); idb = e.idb;
    } finally { e.close(); }
    let online = false;
    const reopened = make(db, { idb, before: w => {
      Object.entries(saved).forEach(([k,v]) => w.localStorage.setItem(k,v));
      Object.defineProperty(w.navigator, 'onLine', { get: () => online });
    } });
    try {
      await reopened.login(); online = true;
      reopened.w.dispatchEvent(new reopened.w.Event('online'));
      await until(() => db.messages.some(m => m.id === keep));
      await sleep(100);
      assert.equal(db.messages.filter(m => m.id === cancel).length, mode === '撤销删除' ? 1 : 0);
      const received = await recipientBodies(db);
      assert.ok(received.includes('保留'));
      assert.equal(received.includes('已取消'), mode === '撤销删除');
    } finally { reopened.close(); }
  });
}
function row(i, at) {
  return { id: '00000000-0000-4000-8000-' + String(i).padStart(12, '0'),
    conv_key: key, from_acc: 'bob', to_acc: ME, type:'text', body: String(i), created_at: new Date(at).toISOString() };
}
test('重连取回跨多页、同一时间戳的中间消息', async () => {
  const db = state(), t = Date.now() - 600000;
  for (let i=1; i<=10; i++) db.messages.push(row(i,t+i));
  const e = await sender(db);
  try {
    for (let i=11; i<=95; i++) db.messages.push(row(i,t+11));
    e.w.dispatchEvent(new e.w.Event('online'));
    await until(() => e.T.S.msgs.some(m=>m.body==='95'));
    assert.equal(new Set(e.T.S.msgs.map(m=>m.id)).size,95);
  } finally {e.close();}
});
test('多行编辑保持换行，无变更不写入，服务端超时保留输入',async()=>{
  const db=state(); const m={...row(1,Date.now()),from_acc:ME,to_acc:'bob',body:'一行\n二行\n三行'};
  db.messages.push(m);
  const e=await sender(db,{onQuery:q=>q.table==='messages'&&q.op==='update'?{data:null,error:{message:'edit window passed'}}:undefined});
  async function edit(){
    contextMenu(e,m.id); e.$('msg-menu-edit').click(); await until(()=>e.$('form-sheet').classList.contains('active'));
    return e.$('fsf0');
  }
  try {
    let f=await edit(); assert.equal(f.value,m.body);
    e.$('fs-ok').click(); await sleep(30);
    assert.equal(e.log.filter(q=>q.table==='messages'&&q.op==='update').length,0);
    f=await edit(); f.value+='\n编辑后的草稿'; e.$('fs-ok').click(); await sleep(35);
    assert.ok(e.$('form-sheet').classList.contains('active'));
    assert.equal(f.value,'一行\n二行\n三行\n编辑后的草稿');
    assert.match(e.$('fs-msg').textContent,/超过 1 分钟/);
  } finally{e.close();}
});
test('未确认的文字先落盘，有发送标记，写入超时后正常重试',async()=>{
  const db=state(); let stalled=true;
  const e=await sender(db,{onQuery:q=>q.table==='messages'&&q.op==='insert'&&stalled?new Promise(()=>{}):undefined,
    before:w=>{const set=w.setTimeout.bind(w); w.setTimeout=(fn,delay,...rest)=>set(fn,delay===15000?120:delay,...rest);}});
  try {
    const id=enter(e,'悬挂写入');
    assert.ok(JSON.parse(e.w.localStorage.getItem('ch2outq:'+UID)).some(m=>m.id===id));
    assert.ok(e.$('chat-messages').querySelector('.st.sending'));
    await until(()=>e.T.S.out.get(id)?._st==='failed');
    stalled=false;
    e.w.dispatchEvent(new e.w.Event('online'));
    await until(()=>db.messages.some(m=>m.id===id));
    assert.equal(db.messages.filter(m=>m.id===id).length,1);
  } finally{e.close();}
});
test('失败媒体重启后按原顺序恢复内容、文件名、视频封面并清理待发',async()=>{
  const db=state(), e=await sender(db); let saved,idb; const ids=[];
  try {
    e.T.sb.storage.from=()=>({upload:async()=>({error:{message:'offline fixture'}}),getPublicUrl:()=>({data:{publicUrl:''}})});
    for(const type of ['voice','image','video','file']){
      const ext={voice:'wav',image:'png',video:'mp4',file:'pdf'}[type];
      const ct={voice:'audio/wav',image:'image/png',video:'video/mp4',file:'application/pdf'}[type];
      const b=new e.w.Blob(['合成/'+type],{type:ct}),u=e.w.URL.createObjectURL(b);
      const extra={_blob:b,_ct:ct,_ext:ext};
      if(type==='file') extra._fm={n:'报告.pdf',s:b.size};
      if(type==='video') extra._poster=new e.w.Blob(['封面'],{type:'image/jpeg'});
      const m=e.T.newMsg(type,extra._fm?JSON.stringify({...extra._fm,u}):u,1,extra);
      ids.push(m.id); e.T.addLocal(m);
    }
    await until(()=>ids.every(id=>e.T.S.out.get(id)?._st==='failed'));
    const queue=JSON.parse(e.w.localStorage.getItem('ch2outq:'+UID));
    assert.equal(queue.length,4);assert.ok(queue.every(m=>!m.body.includes('blob:')));
    saved=snapshot(e);idb=e.idb;
  } finally {e.close();}
  const restored=make(db,{idb,before:w=>Object.entries(saved).forEach(([k,v])=>w.localStorage.setItem(k,v))});
  const uploaded=new Map();
  try {
    await restored.T.getReady();
    restored.T.sb.storage.from=()=>({upload:async(k,blob)=>{
      const reader=new restored.w.FileReader();
      const text=await new Promise((ok,no)=>{reader.onload=()=>ok(reader.result);reader.onerror=no;reader.readAsText(blob);});
      uploaded.set(k,text);return {error:null};
    },getPublicUrl:k=>({data:{publicUrl:'https://storage.example.test/chat-media/'+k}})});
    await restored.login();restored.w.dispatchEvent(new restored.w.Event('online'));
    await until(()=>db.messages.length===4);
    assert.deepEqual(db.messages.map(m=>m.id),ids);
    for(const type of ['voice','image','video','file']) assert.ok([...uploaded.values()].includes('合成/'+type));
    assert.ok([...uploaded.values()].includes('封面'));
    assert.equal(JSON.parse(db.messages.at(-1).body).n,'报告.pdf');
    assert.equal(JSON.parse(restored.w.localStorage.getItem('ch2outq:'+UID)).length,0);
  } finally {restored.close();}
});
test('慢上传与随后文字在本会话有序，其他会话可独立提交',async()=>{
  const db=state(),e=await sender(db);let finish;
  try{
    e.T.sb.storage.from=()=>({upload:()=>new Promise(resolve=>{finish=()=>resolve({error:null});}),getPublicUrl:k=>({data:{publicUrl:'https://storage.example.test/'+k}})});
    const f=new e.w.Blob(['x'],{type:'image/png'});
    const a=e.T.newMsg('image',e.w.URL.createObjectURL(f),null,{_blob:f,_ct:f.type,_ext:'png'});
    e.T.addLocal(a);const id=enter(e,'看这张图');
    const another=e.T.newMsg('text','另一个聊天',null,{conv:'alice::me',to_acc:'alice'});e.T.addLocal(another);
    await until(()=>finish&&db.messages.some(m=>m.id===another.id));assert.ok(!db.messages.some(m=>m.id===id));
    finish();await until(()=>db.messages.length===3);
    assert.deepEqual(db.messages.filter(m=>m.conv_key===key).map(m=>m.id),[a.id,id]);
  } finally{e.close();}
});
