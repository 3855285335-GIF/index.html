// CacheStorage 可能在隐私模式或存储故障时不可用。保留正常联网读取和通知打开目标。
const {test}=require('node:test');
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const root='https://example.org/chatter/';
function service(tabs=[]) {
  let opened;const handlers={};
  const self={location:new URL(root), registration:{scope:root},clients:{matchAll:async()=>tabs,openWindow:async url=>{opened=url;}},
    addEventListener:(event,fn)=>{handlers[event]=fn;}};
  const ctx={self,URL,Request,Response,setTimeout,clearTimeout,caches:{open:async()=>{throw Error('storage unavailable');}},fetch:async()=>new Response('online')};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../sw.js'),'utf8'),ctx);
  return {async get(req){let result;handlers.fetch({request:req,respondWith:p=>{result=p;}});return (await result).text();},
    open:async()=>{await self.__chatter.openUrl('./#c=abc');return opened;}};
}
test('CacheStorage 拒绝访问，仍能联网取程序和图片',async()=>{
  const sw=service();
  for(const [url,destination] of [[root+'app.js?v=1','script'],['https://uaoiqbxptnbrvkzjwguc.supabase.co/storage/v1/object/public/chat-media/test','image']]){
    assert.equal(await sw.get({method:'GET',url,destination,headers:new Headers()}),'online');
  }
});
test('仅开着导航或审阅页时，通知应打开聊天主页面',async()=>{
  const tabs=['navigation.html','review/site/'].map(file=>({url:root+file,postMessage(){},focus(){}}));
  assert.equal(await service(tabs).open(),root+'#c=abc');
});
