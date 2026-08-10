# Write-Probe Design: 媒体目录可写性预检

Status: approved by user on 2026-07-07
Scope: 一个纯代码级小增强——在跑 LLM/ASSRT 之前探测视频目录是否可写,不可写则干净止损。
核心流水线不变,不新增外部依赖,不绑定播放器。

## 动因

字幕采用 sidecar 写法(写到视频同目录,`<视频名>.zh-Hans.ass`)。若媒体目录**不可写**
(只读网盘挂载、只读 rclone/WebDAV 参数等),现在的行为是:watcher 通过 `pathExists`(仅查存在)
预检 → 跑完整 pipeline(烧 LLM + ASSRT 额度)→ 找到字幕后在 `writeSubtitle` 写入时才抛错 →
pipeline 捕获成 `decision:error` → 队列衰减重试,而这是**永久性**条件,重试永远失败,且每次白烧额度。

修复:在动手找字幕**之前**探一下能不能写,不能写就像现有 "media dir not accessible" 分支那样
干净跳过 + 明确日志,零额度浪费。

## 判断标准:能不能写 sidecar,不问物理形态

我们不关心用户媒体是实体 NAS 还是网盘挂载。唯一标准:subtitle-scout 进程能否往
"Jellyfin 看得见的那个视频目录"落文件。可写→sidecar(现方案);不可写→本次止损跳过。

## 探测方式:真实试写(非 fs.access W_OK)

`isDirWritable(dir)`:在 `dir` 下写一个几字节的唯一命名临时文件(如
`.subtitle-scout-writetest-<pid>-<counter>`),成功则删除并返回 true;任何异常(写失败/删失败均
catch)返回 false。目录不存在也返回 false。

**为何不用 `fs.accessSync(dir, W_OK)`**:网盘/WebDAV/rclone/CIFS 等网络文件系统上 W_OK 会撒谎
(报可写但实写失败,或反之),且容器内以 root 运行会绕过权限位。真实试写走的正是 sidecar 将来
要走的同一条写路径,是唯一对网络挂载可信的 ground truth。临时文件用隐藏前缀 `.` +
唯一后缀,避免被 orphanScanner 收编或与真实字幕冲突;写删成对,不残留。

确定性可测:签名 `isDirWritable(dir: string): boolean`,纯 fs 操作,单测可用真实 tmp 目录
(可写)、`chmod 0o555` 的目录(只读,注意测试进程非 root 时有效)、不存在的路径覆盖。

## 探测位置:共享 helper,两处调用

新函数 `isDirWritable` 放 `src/core/mediaContext.ts`(与 `isUnderRoots` 等路径工具同处)。

1. **watcher `maybeProcess`**(`src/daemon/watcher.ts`):在现有 `pathExists(mediaDir(ctx))`
   预检**紧后**加一道。`WatcherDeps` 新增注入 `isWritable: (dir: string) => boolean`
   (与 `pathExists` 同款可注入,便于测试);cli 装配处传 `dir => isDirWritable(dir)`。
   不可写时:`log('media dir not writable: <dir> — sidecar 无法写入,检查挂载读写权限')`,
   `processed = true`(进冷却,避免疯狂重试),`return`。**不调 runJob**(零 LLM/ASSRT)。
2. **cli `cmdRunItem`**(`src/cli/index.ts`):在现有 `existsSync(mediaDir(ctx))` 检查旁加一道,
   不可写则 `console.error(...)` + `process.exit(2)`,与现有 "not accessible" 分支一致。

## 不可写时行为:照搬现有 "media dir not accessible" 分支

watcher 已有 pathExists 失败分支的先例(清楚日志 + `processed=true` 进冷却 + return)。
写探针不可写走**完全相同**的处理形态,只是日志文案不同。cli 侧同理(error + exit 2)。

## 不记 ledger 事件(v1)

与旁边的 pathExists 预检保持一致——只落日志(会进 `logs/watch-YYYY-MM-DD.log`),不发 ledger 事件。
理由:两个预检是同类"配置/环境不满足即跳过",一致处理;pre-runJob 跳过不经过 onRunComplete,
加 ledger 需额外接线。YAGNI:若后续需要在 `report` 里看到只读跳过统计再补。

## 不做什么

- 不做"只读时改走 Jellyfin 字幕上传 API 兜底"——那是大功能且绑定 Jellyfin,与"播放器无关"
  架构有张力,留 backlog(触发条件:出现真实只读媒体用户且希望自动可见)。
- 不改 `writeSubtitle` 的现有抛错行为——它作为最后一道 suspenders 保留(探针通过但实写仍失败的
  竞态/边界仍会被 pipeline 捕获成 error)。探针是快速止损 + 明确信号,不是正确性保证。
- 不碰核心 pipeline / 判断点 / 缓存。

## 测试

- 单测 `isDirWritable`(`src/core/mediaContext.test.ts`):可写 tmp 目录→true;`chmod 0o555`
  只读目录→false(测试进程非 root 时有效,若 CI 以 root 跑则该用例 skip 并注释说明);
  不存在路径→false;调用后临时文件不残留(断言目录内无 `.subtitle-scout-writetest*`)。
- watcher 测试(`src/daemon/watcher.test.ts`):注入 `isWritable: () => false` → 断言
  不调 `runJob`、日志含 "not writable";所有现有 fake 的 `WatcherDeps` 补 `isWritable: () => true`
  以维持既有行为。
- 无判断点 prompt 改动。
- 真实(controller):软路由上人为造只读目录跑 `run-item`,确认干净止损 + 明确日志,不烧额度。

## 影响面

改动文件:`src/core/mediaContext.ts`(+helper)、`src/core/mediaContext.test.ts`(+单测)、
`src/daemon/watcher.ts`(+WatcherDeps 字段 + 预检)、`src/daemon/watcher.test.ts`(fake 补齐 + 只读用例)、
`src/cli/index.ts`(cmdRunItem 检查 + watcher 装配注入)。零新依赖。
