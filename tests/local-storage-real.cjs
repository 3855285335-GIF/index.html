// Full local Supabase stack: Auth, PostgREST and real Storage HTTP APIs.
// It MUST only connect to the loopback test stack and never to production.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const url = process.env.API_URL || 'http://127.0.0.1:54321';
const anonKey = process.env.ANON_KEY;
const serviceKey = process.env.SERVICE_ROLE_KEY;
assert.match(url,/^http:\/\/127\.0\.0\.1:\d+$/,'Test must use local stack');
assert.ok(anonKey && serviceKey,'Local Supabase credentials were not exported');
const options = {auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}};
const admin = createClient(url,serviceKey,options);
const create = () => createClient(url,anonKey,options);
const id = randomUUID();
const path = 'alice/' + id + '.png';
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489','hex');
async function must(result,context) {
  if(result.error)throw Error(context + ': ' + result.error.message);
  return result.data;
}
async function account(name) {
  const email = name + '-' + id + '@example.invalid';
  const password = 'OnlyForIsolatedTest-2026!Aa' + name;
  const info = await must(await admin.auth.admin.createUser({email,password,email_confirm:true}),'create local user');
  await must(await admin.from('test_accounts').insert({user_id:info.user.id,account_id:name}),'map local user');
  const client = create();
  const session = await must(await client.auth.signInWithPassword({email,password}),'log in local user');
  assert.ok(session.session?.access_token);
  return client;
}
async function deny(result,action) {assert.ok(result.error,'Unexpected access allowed: '+action);}
async function main(){
  const [alice,bob,carol]=await Promise.all([account('alice'),account('bob'),account('carol')]);
  const bucket='chatter-private';
  const config=await must(await admin.from('app_config').select('value').eq('key','private_chat_attachments').single(),'default config');
  assert.equal(config.value.enabled,false);
  await deny(await alice.storage.from(bucket).upload(path,png,{contentType:'image/png'}),'upload with feature disabled');
  await must(await admin.from('app_config').update({value:{enabled:true}}).eq('key','private_chat_attachments'),'enable local test only');
  await deny(await carol.storage.from(bucket).upload(path,png,{contentType:'image/png'}),'upload to other sender prefix');
  await must(await alice.storage.from(bucket).upload(path,png,{contentType:'image/png'}),'upload owned image');

  // Exercise the exact REST signing API used by the backup Edge Function,
  // against real local Storage, not a mocked endpoint.
  const signResponse = await fetch(url+'/storage/v1/object/sign/'+bucket, {
    method:'POST',
    headers:{apikey:serviceKey,Authorization:'Bearer '+serviceKey,'Content-Type':'application/json'},
    body:JSON.stringify({paths:[path],expiresIn:900})
  });
  assert.equal(signResponse.status,200,'real local Storage bulk signing API must accept paths/expiresIn');
  const signs=await signResponse.json();
  assert.ok(Array.isArray(signs) && signs.length===1 && signs[0].path===path && signs[0].signedURL,
    'real Storage signing response shape differs from Edge Function expectation');
  const signedLink=signs[0].signedURL.startsWith('/object/')
    ? url+'/storage/v1'+signs[0].signedURL : url+signs[0].signedURL;
  const signedDownload=await fetch(signedLink);
  assert.equal(signedDownload.status,200,'signed private object must be retrievable');
  assert.deepEqual(Buffer.from(await signedDownload.arrayBuffer()),png,'signed private object bytes must match');

  await deny(await bob.storage.from(bucket).download(path),'receive without message');
  const publicUrl=alice.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  const anonymousResponse=await fetch(publicUrl);
  assert.notEqual(anonymousResponse.status,200,'private bucket exposed through public URL');
  await must(await alice.from('messages').insert({id,conv_key:'alice::bob',from_acc:'alice',to_acc:'bob',type:'image',body:'image',private_attachment_path:path}),'bind private image to message');
  const downloaded=await must(await bob.storage.from(bucket).download(path),'recipient authenticated download');
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),png);
  await deny(await carol.storage.from(bucket).download(path),'stranger download');
  await deny(await carol.storage.from(bucket).download(path+'.t'),'stranger thumbnail');
  await deny(await bob.storage.from(bucket).createSignedUrl(path,60),'recipient signed URL');
  const list=await must(await bob.storage.from(bucket).list('alice'),'recipient list');
  assert.ok(!list.some(f=>f.name===id+'.png'),'recipient bucket enumeration');
  // Storage may return 200 with an empty list when RLS silently filters deletion.
  // The security condition is that the object still exists and the owner can read it.
  await bob.storage.from(bucket).remove([path]);
  const afterStrangerDelete=await must(await alice.storage.from(bucket).download(path),'owner content after unauthorized deletion attempt');
  assert.deepEqual(Buffer.from(await afterStrangerDelete.arrayBuffer()),png,'recipient must not delete the private object');
  await must(await admin.from('app_config').update({value:{enabled:false}}).eq('key','private_chat_attachments'),'disable local uploads');
  await deny(await alice.storage.from(bucket).upload('alice/'+randomUUID()+'.png',png,{contentType:'image/png'}),'uploads after disable');
  await must(await bob.storage.from(bucket).download(path),'previously uploaded image remains accessible');
  await must(await alice.storage.from(bucket).remove([path]),'sender delete');
  await deny(await bob.storage.from(bucket).download(path),'deleted image inaccessible');
  console.log('真实本地 Supabase：三账号身份隔离、私有上传、消息绑定、匿名拒绝、签名拒绝、禁止枚举、删除权限、开关切换与下载回滚均通过。');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
