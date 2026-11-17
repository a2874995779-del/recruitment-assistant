import { runtimeDirectory } from '../packages/persistence/src/runtime.js';
import { restoreBackup } from '../packages/persistence/src/backup.js';
const source=process.argv[2];
if(!source)throw new Error('用法：npm.cmd run restore -- "完整备份目录"；必须先关闭所有运行实例');
console.log(restoreBackup(source,runtimeDirectory()));
