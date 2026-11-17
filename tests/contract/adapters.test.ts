import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../helpers.js';
import { validateStation } from '../../packages/adapters/core/src/index.js';
import { stationSchema } from '../../packages/contracts/src/index.js';

for (const platform of ['boss','wllm91'] as const) {
  test(`${platform}: mock capabilities do not imply verified real integration`,async()=>{
    const h=await setup();try{
      const mock=platform==='boss'?h.account:h.service.createAccount({platform,mode:'MOCK',nickname:'模拟91',station:{base_url:'https://gyjy.91wllm.cn'}});
      await h.service.connectAccount(mock.id);
      assert.ok(h.service.capabilities(mock.id).every(c=>c.mode==='MOCK'));
      const real=h.service.createAccount({platform,mode:'REAL',nickname:'真实待验证',...(platform==='wllm91'?{station:{base_url:'https://gyjy.91wllm.cn',school_id:'unknown'}}:{})});
      const connection=await h.service.connectAccount(real.id);assert.equal(connection.status,'ACTION_REQUIRED');assert.equal(connection.identity,null);
      assert.ok(connection.capabilities.every(c=>c.status==='UNVERIFIED'&&!c.enabled));
      assert.throws(()=>h.service.enqueueSync(real.id,'SYNC_JOBS'),/连接/);
    }finally{await h.cleanup();}
  });
}
test('91wllm substation configuration rejects arbitrary domains and cross-domain routes',()=>{
  assert.throws(()=>validateStation('wllm91',stationSchema.parse({base_url:'https://91wllm.cn.evil.example'})),/官方域名/);
  assert.throws(()=>validateStation('wllm91',stationSchema.parse({base_url:'http://gyjy.91wllm.cn'})),/HTTPS/);
  assert.throws(()=>validateStation('wllm91',stationSchema.parse({base_url:'https://gyjy.91wllm.cn',route_overrides:{login:'//evil.example'}})),/相对路径/);
  assert.doesNotThrow(()=>validateStation('wllm91',stationSchema.parse({base_url:'https://gyjy.91wllm.cn',route_overrides:{login:'/login'}})));
});
