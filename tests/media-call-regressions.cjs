const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = process.env.CHATTER_SOURCE || path.join(__dirname, '..');
const { makeEnv, prof, ME, sleep } = require(path.join(root, 'tests/harness'));
const url = 'https://uaoiqbxptnbrvkzjwguc.supabase.co/storage/v1/object/public/chat-media/bob/photo.png';
function fixture(opts = {}) {
  const env = makeEnv({
    db: { profiles: [prof(ME), prof('bob')], friendships: [{ owner_acc: ME, friend_acc: 'bob' }] },
    ...opts,
    patch: src => src.replace('if (window.__TEST__) window.__T = {', 'if (window.__TEST__) window.__T = { mkCall, verSafe, upload, saveToPhone, patchMsg, ieFinish, ieUndo, vpvSendNow, VPV, IPV, renderGroupFiles,')
  });
  return env;
}
test('F01、F14 已接受来电后另一设备的迟到拒绝不会挂断；超时来电停止响铃', async () => {
  const e = fixture(); try {
    await e.login();
    const c = e.T.mkCall('bob', false, true, 'call-id'); e.T.S.call = c;
    c.pc = { signalingState: 'have-local-offer', async setRemoteDescription() { this.signalingState = 'stable'; }, close() {} };
    await e.T.onSig({ t: 'accept', from: 'bob', id: c.id, sdp: { type: 'answer', sdp: 'fixture' } });
    e.T.onSig({ t: 'reject', from: 'bob', id: c.id });
    assert.strictEqual(e.T.S.call, c, '通话被另一设备的拒绝挂断');
    e.T.S.call = null;
    const original = e.w.setTimeout;
    e.w.setTimeout = (fn, ms, ...args) => original.call(e.w, fn, ms === 40000 ? 15 : ms, ...args);
    await e.T.onInvite({ id: 'other-call', from: 'bob', sdp: { type: 'offer', sdp: 'fixture' } });
    await sleep(45);
    assert.equal(e.T.S.incoming, null);
    assert.equal(e.rpcLog.some(x => x.name === 'send_signal' && x.args.p_payload.id === 'other-call' && x.args.p_payload.t === 'reject'), false);
  } finally { e.close(); }
});
test('F07、F08 两路群邀请只应答一次；新入房成员通过服务器名单确认，群外不接入', async () => {
  let members = [ME,'bob'];
  const e = fixture({ onRpc: name => name === 'group_call_state' ? { data: { id:'room', members:members.map(acc=>({acc})) } } : null });
  try {
    await e.login();
    e.w.RTCPeerConnection = class {
      constructor() { this.connectionState='connecting'; this.signalingState='stable'; }
      async setRemoteDescription(desc) { this.remoteDescription=desc;this.signalingState='have-remote-offer'; }
      async createAnswer() { return {type:'answer',sdp:'answer'}; }
      async setLocalDescription() { this.signalingState='stable'; }
      close() { this.connectionState='closed'; }
    };
    Object.assign(e.T.GC,{on:true,cid:'room',gid:'group',local:{getTracks:()=>[]},roster:[{acc:ME}]});
    const offer = { from:'bob', id:'room',cid:'room',gid:'group',t:'goffer',sq:'sequence1',sdp:{type:'offer',sdp:'offer1'} };
    await e.T.onSig(offer); await sleep(30);
    const first = e.T.GC.peers.bob;
    assert.ok(first,'仍然拒绝真实已入房的新成员');
    await e.T.onSig(offer); await e.T.onSig({...offer,sq:'sequence2'}); await sleep(20);
    assert.strictEqual(e.T.GC.peers.bob,first);
    assert.equal(e.rpcLog.filter(x=>x.name==='send_signal'&&x.args.p_payload.t==='gans').length,1);
    await e.T.onSig({...offer,from:'stranger',sq:'sequence3'});
    assert.equal(e.T.GC.peers.stranger,undefined);
  } finally {e.close();}
});
test('F02、F06 发完只换成缩略图，临时加载失败也不立刻请求原图', async () => {
  const e = fixture(); try {
    await e.login(); await e.T.openConv('bob::me','bob');
    const m=e.T.newMsg('image','blob:preview'); e.T.S.msgs.push(m);
    const box=e.$('chat-messages'); box.innerHTML=e.T.msgHTML(m);
    e.T.patchMsg(m.id,{body:url+'#w=3000&h=2000&t=1'});
    const image=box.querySelector('.bubble.img img');
    assert.equal(image.getAttribute('src'),url+'.t');
    image.dispatchEvent(new e.w.Event('error'));
    assert.equal(image.getAttribute('src'),url+'.t'); assert.equal(image.dataset.rty,'1');
  } finally {e.close();}
});
test('F04 自动更新须等到另一会话上传完成或用户结束预览', async () => {
  const e=fixture();try {
    await e.login();
    assert.equal(e.T.verSafe(),true);
    e.T.S.out.set('other',{_st:'sending'}); assert.equal(e.T.verSafe(),false);
    e.T.S.out.clear(); e.T.IPV.resolve=()=>{}; assert.equal(e.T.verSafe(),false);
    e.T.IPV.resolve=null; e.T.VPV.resolve=()=>{}; assert.equal(e.T.verSafe(),false);
    e.T.VPV.resolve=null; e.T.IE.resolve=()=>{}; assert.equal(e.T.verSafe(),false);
    e.T.IE.resolve=null; e.$('moment-sheet').classList.add('active'); assert.equal(e.T.verSafe(),false);
  } finally {e.close();}
});
test('F10 大文件回包丢失每次最多写一遍，下次确认已有原件后直接复用',async()=>{
  const e=fixture();try {
    await e.login(); let writes=0, probes=0;
    e.w.XMLHttpRequest=class { open(){} setRequestHeader(){} send(){writes++;this.onerror();} };
    const blob=new e.w.Blob(['测试'],{type:'text/plain'});
    const storage = e.T.sb.storage.from('chat-media'); storage.upload=async()=>{writes++;return {data:{}};};
    e.T.sb.storage.from=()=>storage;
    e.w.fetch=async(_u,o)=>{assert.equal(o.method,'HEAD');probes++;return {ok:true,headers:{get:()=>String(blob.size)}};};
    await assert.rejects(e.T.upload(blob,'txt',blob.type,'','me/fixed.txt',()=>{}));
    assert.equal(writes,1);
    assert.match(await e.T.upload(blob,'txt',blob.type,'','me/fixed.txt',()=>{}),/fixed.txt$/);
    assert.equal(writes,1);assert.equal(probes,1);
  } finally {e.close();}
});
test('U09 离线保存已看过的原件，准备后再点系统分享，保留名称、格式和字节',async()=>{
  const e=fixture();try{
    await e.login();let shared, network=0;
    e.w.caches={match:async(src,o)=>{assert.equal(src,url);assert.equal(o.cacheName,'chatter-img-v1');return {ok:true,blob:async()=>new e.w.Blob(['image-bytes'],{type:'image/png'})};}};
    e.w.fetch=async()=>{network++;throw Error('offline');};
    Object.defineProperty(e.w.navigator,'userActivation',{value:{isActive:false}});
    e.w.navigator.canShare=()=>true;e.w.navigator.share=async({files})=>{shared=files[0];};
    await e.T.saveToPhone(url+'#w=2&h=2','照片.png');
    assert.equal(e.$('act-sheet').classList.contains('active'),true);
    assert.equal(shared,undefined); await sleep(400); e.$('as-items').querySelector('button').click(); await sleep(20);
    assert.equal(network,0);assert.equal(shared.name,'照片.png');assert.equal(shared.type,'image/png');assert.equal(shared.size,11);
  }finally{e.close();}
});
test('U09 原件下载失败保留重试；取消系统分享不会产生下载或成功提示',async()=>{
  const e=fixture();try{
    await e.login();
    let tries=0, shares=0, downloads=0;
    e.w.HTMLAnchorElement.prototype.click=()=>{downloads++;};
    e.w.navigator.canShare=()=>true;
    e.w.navigator.share=async()=>{shares++;throw new e.w.DOMException('取消','AbortError');};
    e.w.fetch=async()=>++tries===1?{ok:false,status:503}:{ok:true,blob:async()=>new e.w.Blob(['ok'],{type:'image/png'})};
    await e.T.saveToPhone(url,'照片.png');const retry=e.w.document.querySelector('.toast-act button');assert.ok(retry);
    retry.click();await sleep(30);
    assert.equal(tries,2);assert.equal(shares,1);assert.equal(downloads,0);
  }finally{e.close();}
});
test('F05 编辑器没有修改时原样返回同一份源文件',async()=>{
  const e=fixture();try{
    const src=new e.w.File(['original'],'original.png',{type:'image/png'});
    let result;
    Object.assign(e.T.IE,{file:src,changeCount:0,resolve:f=>{result=f;}});
    e.T.ieFinish();assert.strictEqual(result,src);
  }finally{e.close();}
});
