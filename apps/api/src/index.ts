import { join } from 'node:path';
import { runtimeDirectory, apiToken } from '../../../packages/persistence/src/runtime.js';
import { claimInstance } from '../../../packages/persistence/src/instance.js';
import { Store } from '../../../packages/persistence/src/database.js';
import { RecruitmentService } from '../../../packages/application/src/service.js';
import { Scheduler } from '../../../packages/scheduler/src/index.js';
import { createServer } from './server.js';

const directory=runtimeDirectory();const release=claimInstance(directory);
const store=new Store(join(directory,'database','app.sqlite'));
const service=new RecruitmentService(store,directory);const scheduler=new Scheduler(service);
const server=createServer(service,scheduler,apiToken(directory));
const port=Number(process.env.RA_PORT??4318);
if (!Number.isInteger(port)||port<1||port>65535) throw new Error('RA_PORT 不合法');
let closing=false;
async function close() {if(closing)return;closing=true;await scheduler.stop();await server.close();store.close();release();}
process.once('SIGINT',()=>{void close();});process.once('SIGTERM',()=>{void close();});
try {
  await server.listen({host:'127.0.0.1',port});scheduler.start();
  console.log(`招聘助手 V0 后端：http://127.0.0.1:${port}\n数据目录：${directory}\n令牌文件：${join(directory,'api-token')}\n真实平台：待验证；模拟流程不会访问招聘网站。`);
} catch(error) {await close();throw error;}
