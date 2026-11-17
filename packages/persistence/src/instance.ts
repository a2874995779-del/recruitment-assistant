import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function claimInstance(directory: string) {
  const filename=join(directory,'instance-lock');
  if (existsSync(filename)) {
    const lock=JSON.parse(readFileSync(filename,'utf8')) as {pid:number};
    let alive=false;try {process.kill(lock.pid,0);alive=true;} catch {}
    if (alive) throw new Error('此数据目录已有运行实例；请关闭原实例或使用独立数据目录');
    rmSync(filename);
  }
  writeFileSync(filename,JSON.stringify({pid:process.pid,started_at:new Date().toISOString()}),{flag:'wx',mode:0o600});
  return ()=>{if (existsSync(filename)) {const lock=JSON.parse(readFileSync(filename,'utf8')) as {pid:number};if(lock.pid===process.pid)rmSync(filename);}};
}
