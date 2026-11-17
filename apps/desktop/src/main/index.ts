import {
  app,
  BrowserWindow,
  ipcMain,
  Notification,
  shell,
  dialog,
} from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { Store } from "../../../../packages/persistence/src/database.js";
import { runtimeDirectory } from "../../../../packages/persistence/src/runtime.js";
import { claimInstance } from "../../../../packages/persistence/src/instance.js";
import { RecruitmentService } from "../../../../packages/application/src/service.js";
import { Scheduler } from "../../../../packages/scheduler/src/index.js";
import { desktopCommand } from "../../../../packages/application/src/desktop-commands.js";
import { BossBrowser } from "./boss-browser.js";

async function bootstrap() {
  await app.whenReady();
  const directory = runtimeDirectory();
  const release = claimInstance(directory);
  const store = new Store(join(directory, "database", "app.sqlite"));
  const delivered = new Set<string>();
  const service = new RecruitmentService(store, directory, {
    async send(title, body, eventId) {
      if (!Notification.isSupported()) throw new Error("DESKTOP_NOT_SUPPORTED");
      if (delivered.has(eventId)) return;
      new Notification({ title, body }).show();
      delivered.add(eventId);
    },
  });
  const scheduler = new Scheduler(service);
  const window = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 980,
    minHeight: 650,
    show: false,
    title: "求职助手 · CyuBack 专属",
    icon: fileURLToPath(new URL("../../../../renderer/icon.png", import.meta.url)),
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Hidden smoke windows need frame production for native-view capture. Normal
  // interactive windows retain Chromium's default background throttling.
  if (process.env.RA_DESKTOP_SMOKE === "1" && process.env.RA_DESKTOP_CAPTURE === "1") window.webContents.setBackgroundThrottling(false);
  const path = fileURLToPath(
    new URL("../../../../renderer/index.html", import.meta.url),
  );
  const expected = pathToFileURL(path).href;
  const verifySender = (event: Electron.IpcMainInvokeEvent) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame?.url !== expected
    )
      throw new Error("IPC_SENDER_DENIED");
  };
  const bossBrowser = new BossBrowser(window, service, directory);
  ipcMain.handle("recruitment:boss-browser", async (event, raw: unknown) => {
    verifySender(event);
    return bossBrowser.request(raw);
  });
  ipcMain.handle("recruitment:command", async (event, raw: unknown) => {
    verifySender(event);
    const p = z
      .object({ operation: z.string(), payload: z.unknown() })
      .strict()
      .parse(raw);
    return desktopCommand(service, scheduler, p.operation, p.payload);
  });
  ipcMain.handle("recruitment:open-source", async (event, raw: unknown) => {
    verifySender(event);
    const p = z
      .object({ url: z.string().url().max(2048) })
      .strict()
      .parse(raw);
    const url = new URL(p.url);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("SOURCE_URL_DENIED");
    await shell.openExternal(url.href);
  });
  window.webContents.session.on("will-download", (_event, item) => {
    if (!item.getURL().startsWith("blob:")) {
      item.cancel();
      return;
    }
    const save = dialog.showSaveDialogSync(window, {
      title: "导出台账",
      defaultPath: "求职投递台账.csv",
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    item.cancel();
    if (save) writeFileSync(save, service.ledgerCsv(), { encoding: "utf8" });
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== expected) event.preventDefault();
  });
  await window.loadFile(path);
  if (process.env.RA_DESKTOP_SMOKE !== "1") window.show();
  scheduler.start();
  app.on("window-all-closed", () => app.quit());
  let closed = false;
  app.on("before-quit", (event) => {
    if (closed) return;
    event.preventDefault();
    void scheduler.stop().then(() => {
      store.close();
      release();
      closed = true;
      app.quit();
    });
  });
  window.on("close", () => bossBrowser.dispose());
  if(process.env.RA_PACKAGE_SMOKE==='1'){
    try{
      if(!process.env.RA_DATA_DIR)throw new Error('打包验收必须使用独立数据目录');
      const tables=['jobs','accounts','messages','actions','attempts','tasks'] as const;
      const counts=Object.fromEntries(tables.map(table=>[table,store.all(table).length]));
      const cookies=await window.webContents.session.cookies.get({});
      const content=await window.webContents.executeJavaScript(`({title:document.title,modules:document.querySelectorAll('nav button').length,body:document.body.innerText,nodeEnabled:typeof require!=='undefined'})`);
      if(!app.isPackaged || Object.values(counts).some(count=>count!==0) || cookies.length || content.modules!==3 || content.nodeEnabled || !content.body.includes('求职助手') || !content.body.includes('CyuBack制作，仅个人使用') || bossBrowser.state().opened)throw new Error('打包空数据验收失败');
      const result={packaged:app.isPackaged,attribution:'CyuBack制作，仅个人使用',version:app.getVersion(),counts,cookies:cookies.length,modules:content.modules,nodeEnabled:content.nodeEnabled,bossOpened:bossBrowser.state().opened};
      writeFileSync(join(directory,'package-smoke-result.json'),JSON.stringify(result,null,2));
      app.quit();
    }catch(error){console.error(error);app.exit(1);}
    return;
  }
  if (process.env.RA_DESKTOP_SMOKE === "1") {
    try {
      const result = await window.webContents.executeJavaScript(`(async()=>{
        const snapshot=await window.recruitment.command('snapshot');
        await window.recruitment.command('queue.control',{paused:true});
        const paused=await window.recruitment.command('snapshot');
        await window.recruitment.command('queue.control',{paused:false});
        document.querySelectorAll('nav button')[1].click();
        return {version:snapshot.data.overview.version,paused:paused.data.overview.queue_paused,modules:document.querySelectorAll('nav button').length,nodeEnabled:typeof require!=='undefined'};
      })()`);
      if (
        result.version !== "0.2.0" ||
        !result.paused ||
        result.modules !== 3 ||
        result.nodeEnabled
      )
        throw new Error("DESKTOP_SMOKE_FAILED");
      const { runBossBrowserSmoke } = await import("./boss-browser-smoke.js");
      const browserResult = await runBossBrowserSmoke(window, bossBrowser, service, directory);
      console.log("BOSS_BROWSER_SMOKE_OK", JSON.stringify(browserResult));
      console.log("DESKTOP_SMOKE_OK", JSON.stringify(result));
      app.quit();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
      app.quit();
    }
  }
}
// Chromium cookies/session/cache remain in this app's private runtime directory.
// Smoke checks supply a separate RA_DATA_DIR and never touch the user's login.
if(app.isPackaged)process.chdir(dirname(process.execPath));
const browserProfile = join(runtimeDirectory(), "electron-profile");
mkdirSync(browserProfile, { recursive: true });
app.setPath("userData", browserProfile);
if (!app.requestSingleInstanceLock()) app.quit();
else
  void bootstrap().catch((error) => {
    console.error(error);
    app.exit(1);
  });
