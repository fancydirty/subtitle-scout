# 诊断笔记：活动页 hero 的「已进行 N 秒」不自增

**日期**：2026-07-31
**状态**：**根因已查明**，修复方案已确定，未实施
**归属**：subtitle-scout 个人项目。本文件在 `docs/` 下已被 `.gitignore`，只存在本机。

---

## 根因（已证实）

**`startedAtLease` 取的是 `jobs.updated_at`，而 `updated_at` 每次续租都被刷新。**

证据链：

1. `src/dashboard/apiV2.ts:1032` — `startedAtLease: r.updated_at`
2. `src/v2/jobsRepo.ts:284` — `renewLease` 执行 `SET lease_until = ?, updated_at = ?`
3. daemon 每 15 秒一拍，`tickInner` 步骤 0 给所有 inflight job 续租
4. 实测 job 23：`created_at=1784826307169`、`updated_at=1785512533877`，
   **相差 686226 秒（约 8 天）** —— `updated_at` 被反复刷新过

所以屏上那个读数是 `now - updated_at`，两端**一起前进**：
- 秒表往前走 15 秒
- 下一次续租把 `updated_at` 也往前推 15 秒
- 差值回到原点

表现就是「恒定在 3~14 秒之间跳，从不累积」。它不是卡住，是**被续租重置**。

---

## 这条结论推翻了我之前的修复

`d5988e0` 里我给 `ActivityPage` 加了每秒 tick 的 `setInterval`：

```ts
const [now, setNow] = useState(() => Date.now())
const hasLiveWork = (workers.data?.running.length ?? 0) > 0
useEffect(() => {
  if (!hasLiveWork) return
  const id = setInterval(() => setNow(Date.now()), 1000)
  return () => clearInterval(id)
}, [hasLiveWork])
```

那段代码**本身是对的且必要的**（隔离测试用 fake timer 推进 3 秒，读数从「已进行 9 秒」
变成「已进行 12 秒」，通过）。但它修的是**错误的问题**——不管前端多频繁地重算，
数据源里就没有「开始时刻」这个信息。

**这段代码应当保留**（否则秒表在两次轮询之间确实不动），但它不足以解决问题。

---

## 修复方案

### 后端：DTO 加一个真正的开始时刻

`WorkflowRunningWorkerDTO` 现有 `startedAtLease`（语义是「最后一次续租时刻」，
名字其实是准的，是**消费方**误用了它）。

需要加：

```ts
/** 这一轮工作真正的开始时刻。
 *  与 startedAtLease 的区别：后者是 jobs.updated_at，每 15 秒续租一次就被刷新，
 *  拿它算「已进行多久」会得到一个恒定在 0~15 秒之间跳的值（2026-07-31 实测）。 */
startedAt: number
```

**取哪个字段需要先查清**（我没查完）：
- `jobs.created_at` — 是 job **入队**时刻，不是本轮开始时刻。job 23 的 created_at
  是 8 天前（它被反复重派过），拿它会显示「已进行 8 天」，同样错
- 候选：`jobs.claimed_at`（如果有这个列）
- 候选：`runs` 表里本轮 run 的 `started_at`（`runs` 有 `started_at` 列，
  见 `src/v2/runsRepo.ts`）——但 running 那个查询目前不 JOIN runs
- 候选：给 `jobs` 加一列 `run_started_at`，在 `claim()` 时写入、续租时**不动**

我倾向最后一个（新列），因为它语义最直白，且 `claim()` 是唯一该写它的地方。
但要先确认 `jobs` 表的 CHECK 约束与迁移成本（`src/v2/db.ts` 的 MIGRATIONS 数组，
当前最新是 v28）。

### 前端：改用新字段

`web/src/activity/ActivityHero.tsx:125` 的
`formatElapsed(now - running.startedAtLease, lang)` 改成用 `startedAt`。

### 测试

现有测试**不会发现这个 bug**，因为它们直接构造 `startedAtLease` 为一个固定值。
需要加的锁是**语义级**的：

```ts
// 回归锁：秒表必须读「本轮开始时刻」，不能读被续租刷新的字段。
// 造两次轮询：第二次的 startedAtLease 前进了 15 秒（模拟续租），
// 而 startedAt 不变 → 屏上读数必须累积，不能回退。
```

---

## 我在这次诊断中犯的 5 处方法错误（避免重犯）

1. **grep 产物找 `setNow` 零命中** → 归因「代码没上线」。实际是 minify 改名。
   我的模式 `setInterval([^)]*,1e3)` 也因箭头函数含括号而匹配失败。
   **教训**：验证代码是否上线，不要 grep 变量名（会被 minify），
   用注释里的独特中文字符串或 `data-*` 属性。

2. **怀疑 Docker 层缓存** → `--no-cache` 重建后现象不变。假设被推翻，浪费一轮。

3. **60 次采样得到 `MutationObserver: 0`（页面完全静止）** → 以为找到根因。
   实际那 60 次**全跑在登录页上**（容器重启后 session 失效），数据全废。
   **教训**：每轮采样前先断言页面状态（`!!document.querySelector('.act-hero')`），
   不要假设登录态还在。部署会重启容器 → session 是内存态 → 必然掉线。

4. **选择器 `[class*=act-stuck]` 误匹配** → 以为屏上是卡死态、"已进行"是我看错字。
   再查 `stuckExists: false`。

5. **`docker cp` 手动塞诊断产物进容器** → 这是**真实污染**：
   `index.html` 被指向那个野文件，生产跑了一段我的诊断代码。
   而且我当时还判断错了（以为浏览器加载旧文件所以探针 null，实际探针在跑）。
   **教训**：调试产物绝不 `docker cp`。走完整部署流程，否则 index.html 与 JS 不一致。
   已用正规部署覆盖，并验证：只剩一个产物、`grep -c __tickOn` = 0、revision 匹配 HEAD。

---

## 当前状态（交接时已验证）

- 源码干净：诊断探针已 `git checkout` 撤销，`git status` 空
- HEAD = `d5988e0`，生产 revision 匹配
- 容器内只有一个前端产物，`index.html` 指向它，探针 0 命中
- 前端 584 测试全绿 / 后端 2472 全绿 / 两边 tsc 0
- 服务健康，daemon 正常 ingest

## 复现方法

```bash
# 1. 隧道（局域网直连；在公司用 media-router-wan）
nohup ssh -N -L 8099:127.0.0.1:8099 media-router-tunnel &

# 2. 造一个在跑的 job（Young Sheldon，16 集）
#    先清字幕 → 重置状态 → 把 job 23 置回 wanted
ssh media-router-tunnel 'docker exec subtitle-scout sh -c "rm -f \"/media/tv/Young Sheldon\"/*.ass"'
# 然后跑 /tmp/r3.cjs（重置 16 集为 missing）与 /tmp/enq2.cjs（job 23 → wanted）
# ⚠️ 两个脚本可能已随 /tmp 清理丢失，逻辑见本文件末尾附录

# 3. 浏览器（注意：每次部署后都要重新登录，session 是内存态）
agent-browser open "http://localhost:8099/#/workflow"
# 登录 admin / ScoutAdmin2026x（我在 2026-07-31 用 CLI auth reset 后重建的）

# 4. 采样时先断言 hero 在场，再读秒表
agent-browser eval 'JSON.stringify({hero:!!document.querySelector(".act-hero"),
  e:document.body.innerText.split("\n").map(s=>s.trim()).find(l=>/^已进行/.test(l))})'
```

**worker 跑得很快（20~40 秒）**，采样间隔要 ≤2 秒，否则会错过在跑窗口。
更好的办法：直接读 DB 确认 `state='searching'` 的 job 存在，再开始采样。

## 附录：重置脚本逻辑

```js
// r3.cjs — 清 Young Sheldon 的字幕记录并回到 missing
const d = new (require('/app/node_modules/better-sqlite3'))('/cache/scout.db')
const sid = 'tmdb:71728'
const eps = d.prepare('select id from episodes where series_id=?').all(sid).map(r => r.id)
const ph = eps.map(() => '?').join(',')
d.prepare(`delete from subtitles where item_id in (${ph})`).run(...eps)
d.prepare(`update episodes set sub_status='missing', search_attempts=0 where series_id=?`).run(sid)
d.prepare('delete from meta where key=?').run('last_ingest_at')

// enq2.cjs — 把既有 job 置回 wanted（不能新建：jobs_identity 唯一约束）
const row = d.prepare("select id from jobs where series_id='tmdb:71728' and kind='worker_task'").get()
d.prepare(`update jobs set state='wanted', priority=10, next_retry_at=NULL, lease_until=NULL,
  last_error=NULL, error_attempt=0, updated_at=? where id=?`).run(Date.now(), row.id)
```

注意 `jobs.state` 的合法值是 `wanted`（不是 `pending`），见 `db.ts:65` 的 CHECK 约束。

## 备份提醒

Young Sheldon 的 16 个原始字幕文件备份在容器内 `/cache/ys-backup/`。
如果不再需要这个实验条目，可以从那里恢复：
```sh
docker exec subtitle-scout sh -c 'cp /cache/ys-backup/* "/media/tv/Young Sheldon/"'
```
然后触发一次 ingest 让它重新记账成 covered。
