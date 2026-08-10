# SQLite 任务队列 + 调和循环模式调研报告（2026）

**服务项目**：subtitle-scout v2（Node.js sidecar + better-sqlite3 单库状态机）  
**调研时间**：2026-07-09

---

## 一、SQLite 做任务队列/状态机的最佳实践

### 1.1 核心模式：UPDATE...RETURNING + Visibility Timeout

#### 原子领取任务模式

生产级实现借鉴 AWS SQS 的 **visibility timeout** 设计，用时间戳作为任务状态标记：

```sql
UPDATE jobs 
SET 
  visibility_timeout = unixepoch() + 300,  -- 5分钟租约
  worker_id = :worker_id,
  attempts = attempts + 1
WHERE id = (
  SELECT id FROM jobs
  WHERE visibility_timeout < unixepoch()  -- 已过期或未领取
    AND status = 'pending'
  ORDER BY priority DESC, created_at ASC
  LIMIT 1
)
RETURNING *;
```

**关键优势**：
- **无竞态条件**：子查询找下一个任务，外层 UPDATE 原子地领取并更新租约
- **无需两阶段锁**：SQLite 单写者保证原子性，避免 SELECT-then-UPDATE 竞态
- **自动重入队列**：worker 崩溃后租约超时，下个 worker 自动接管

**来源**：
- [Building a Durable Message Queue on SQLite for AI Agent Orchestration](https://dev.to/minnzen/building-a-durable-message-queue-on-sqlite-for-ai-agent-orchestration-335m)
- [A SQLite Background Job System - JasonGorman](https://jasongorman.uk/writing/sqlite-background-job-system/)

#### 参考实现库

| 库名 | 语言 | 特性 | Stars |
|------|------|------|-------|
| [litequeue](https://github.com/litements/litequeue) | Python | 多队列支持，任务完成时长追踪 | 高星 |
| [goqite](https://github.com/maragudk/goqite) | Go | 模仿 SQS，保证租约期内不重复投递 | 活跃 |
| [liteque](https://github.com/karakeep-app/liteque) | TypeScript | 2026 新作，填补 TS 生态空白 | 新兴 |
| [workmatic](https://github.com/litepacks/workmatic) | Node.js | 完整 Node.js 任务队列实现 | 生产级 |

**来源**：
- [LiteQueue Documentation](https://litements.exampl.io/queue/)
- [Goqite Documentation](https://maragudk.github.io/goqite/)
- [Show HN: Goqite - Hacker News Discussion](https://news.ycombinator.com/item?id=39666467)

### 1.2 事务模式：BEGIN IMMEDIATE vs BEGIN DEFERRED

#### 问题根源

SQLite 默认使用 `BEGIN DEFERRED`：
1. 首个 SELECT 不加锁
2. 后续 UPDATE 尝试升级到写锁
3. 此时若数据库已被其他连接锁定，立即报 `SQLITE_BUSY`，**忽略 `busy_timeout` 设置**

#### 解决方案

```javascript
// ❌ 错误：会遭遇 SQLITE_BUSY
db.transaction(() => {
  const job = db.prepare('SELECT * FROM jobs WHERE ...').get();
  db.prepare('UPDATE jobs SET ...').run();
});

// ✅ 正确：立即申请写锁
db.exec('BEGIN IMMEDIATE');
const job = db.prepare('SELECT * FROM jobs WHERE ...').get();
db.prepare('UPDATE jobs SET ...').run();
db.exec('COMMIT');
```

**适用场景**：
- 任务队列 worker 领取任务（读后写）
- 状态机迁移检查（先查状态再更新）
- 任何需要"原子性读-修改-写"的操作

**来源**：
- [What to do about SQLITE_BUSY errors despite setting a timeout](https://berthub.eu/articles/posts/a-brief-post-on-sqlite3-database-locked-despite-timeout/)
- [SQLite User Forum: BEGIN IMMEDIATE explanation](https://sqlite.org/forum/forumpost/04ed1d235b)

### 1.3 WAL 模式配置清单（better-sqlite3）

```javascript
const Database = require('better-sqlite3');
const db = new Database('queue.db');

// 生产级配置（必须全套应用）
db.pragma('journal_mode = WAL');          // 启用 WAL，支持并发读写
db.pragma('synchronous = NORMAL');        // 在 WAL 下足够安全
db.pragma('busy_timeout = 5000');         // 至少 5 秒
db.pragma('foreign_keys = ON');           // 强制外键约束
db.pragma('temp_store = MEMORY');         // 临时表放内存
db.pragma('cache_size = -64000');         // 64MB 缓存（负数表示 KB）
```

**关键参数解析**：

1. **`busy_timeout = 5000`**：基准测试显示，<5 秒会出现零星 "database is locked" 错误，≥5 秒几乎无错误
2. **WAL 模式优势**：
   - **并发模型**：1 个写者 + N 个读者同时活跃
   - **读者隔离**：每个读事务看到事务开始时的一致性快照
   - **95% 场景正确选择**：Web 后端、桌面应用、嵌入式设备均适用

3. **WAL 已知陷阱 - Checkpoint Starvation**：
   - 活跃读者会阻止 checkpoint 收缩 WAL 文件
   - 如果始终有至少 1 个读者，WAL 文件将无限增长
   - **缓解方案**：定期手动 `PRAGMA wal_checkpoint(TRUNCATE);`

**来源**：
- [How to Set Up SQLite for Production Use](https://oneuptime.com/blog/post/2026-02-02-sqlite-production-setup/view)
- [SQLite concurrent writes and database is locked errors](https://tenthousandmeters.com/blog/sqlite-concurrent-writes-and-database-is-locked-errors/)
- [The Write Stuff: Concurrent Write Transactions in SQLite](https://oldmoe.blog/2024/07/08/the-write-stuff-concurrent-write-transactions-in-sqlite/)

### 1.4 避免写放大的工程惯例

#### 单写者架构模式（推荐用于 subtitle-scout）

```
┌─────────────┐
│ HTTP/Timer  │ 推送写任务到内存队列
│  Threads    │ ──────────┐
└─────────────┘           │
                          ▼
                  ┌────────────────┐
                  │  写任务队列     │
                  │ (in-memory)    │
                  └────────────────┘
                          │
                          ▼
                  ┌────────────────┐
                  │  唯一写者线程   │ ──► SQLite WAL
                  │ (single write) │
                  └────────────────┘
```

**优势**：
- 彻底消除 SQLITE_BUSY（写-写冲突）
- 简化错误处理逻辑
- 天然提供写操作批处理机会

**来源**：
- [SQLite for Production: Not Just a Development Database](https://0x.run/sqlite-production-not-just-development)

#### 保持事务短小精悍

```javascript
// ❌ 反模式：事务内做耗时操作
db.transaction(() => {
  const data = heavyComputation();  // 持锁期间做计算
  db.prepare('INSERT ...').run(data);
});

// ✅ 最佳实践：事务外准备数据
const data = heavyComputation();
db.transaction(() => {
  db.prepare('INSERT ...').run(data);  // 仅持锁写入
});
```

**现代硬件性能参考**（2026）：
- NVMe SSD：10K-50K writes/sec
- 典型 SaaS（1 万 DAU）：<100 writes/sec
- **结论**：对于小规模系统，SQLite 写性能绰绰有余

**来源**：
- [The SQLite Renaissance: Why the World's Most Deployed Database Is Taking Over Production in 2026](https://dev.to/pockit_tools/the-sqlite-renaissance-why-the-worlds-most-deployed-database-is-taking-over-production-in-2026-3jcc)

---

## 二、调和循环（Reconciliation Loop）模式

### 2.1 核心原则：Level-Triggered + Idempotent

> **黄金法则**：调和必须是幂等的，且基于水平触发（level-triggered），而非边缘触发（edge-triggered）。你的 `reconcile()` 函数应该根据当前世界状态推导期望状态，而非依赖触发它的事件。

#### Level-Triggered vs Edge-Triggered

| 维度 | Edge-Triggered（事件驱动） | Level-Triggered（水平触发） |
|------|----------------------------|----------------------------|
| 关注点 | 发生了什么事件 | 当前状态是什么 |
| WorkQueue 存储 | 事件对象 | 资源键（Key） |
| 错误恢复 | 事件丢失需要重放 | 重新读取当前状态即可 |
| 调和逻辑 | `if (event.type == 'Added')` | 总是：`actualState vs desiredState` |

**来源**：
- [The Reconciler Pattern](https://www.farishuskovic.dev/blog/k8s-reconciler-pattern/)
- [Understanding and Implementing the Reconciliation Loop Pattern](https://oneuptime.com/blog/post/2026-02-09-operator-reconciliation-loop/view)

### 2.2 幂等性要求

同一个 reconcile 输入运行多次，必须产生相同结果，无副作用。

```javascript
// ✅ 幂等实现示例
async function reconcileShow(showId) {
  // 1. 获取当前状态
  const show = db.prepare('SELECT * FROM shows WHERE id = ?').get(showId);
  const seasons = db.prepare('SELECT * FROM seasons WHERE show_id = ?').all(showId);
  
  // 2. 推导期望状态
  const desiredSeasons = await fetchFromTMDB(show.tmdb_id);
  
  // 3. Diff + Apply（幂等操作）
  for (const desired of desiredSeasons) {
    const existing = seasons.find(s => s.season_number === desired.season_number);
    if (!existing) {
      // 创建前先检查是否存在（防止重复运行时出错）
      db.prepare('INSERT OR IGNORE INTO seasons ...').run(desired);
    } else if (needsUpdate(existing, desired)) {
      // 更新操作天然幂等
      db.prepare('UPDATE seasons SET ... WHERE id = ?').run(desired, existing.id);
    }
  }
}
```

**核心设计原则**：
- **始终检查资源是否存在**：创建前先查询或用 `INSERT OR IGNORE`
- **对比后再更新**：避免无意义的写操作
- **不假设事件顺序**：任何时刻可能收到任何状态的资源

**来源**：
- [Reconciliation Loop: Definition & AI Orchestration](https://inferensys.com/glossary/tool-calling-and-api-execution/orchestration-layer-design/reconciliation-loop)
- [Good Practices - The Kubebuilder Book](https://book.kubebuilder.io/reference/good-practices.html)

### 2.3 错误处理与 Requeue 退避

#### Kubernetes Controller 标准模式

```javascript
// 典型调和函数签名
async function reconcile(key) {
  try {
    await doReconcile(key);
    return { requeue: false };  // 成功，无需重试
  } catch (error) {
    if (error instanceof TransientError) {
      // 瞬态错误（网络、外部 API 限流等）
      // 使用指数退避重试
      return { requeue: true };  // 触发 rate limiter
    } else if (error instanceof PermanentError) {
      // 永久错误（配置错误、业务逻辑错误等）
      logger.error('Permanent failure', { key, error });
      return { requeue: false, requeueAfter: 3600 };  // 1小时后重试
    } else {
      throw error;  // 未知错误，上报
    }
  }
}
```

#### Rate Limiter 配置（controller-runtime 默认值）

- **Per-Item Exponential Backoff**：
  - 起始延迟：5 ms
  - 指数倍增至上限：1000 秒（~16 分钟）
  - **关键特性**：每个 item 独立退避，一个资源的持续失败不影响其他资源的首次重试延迟
  
- **Global Rate Limit**：
  - 每秒最多处理 10 个重试
  - Burst：100

**来源**：
- [Rate Limiting in controller-runtime and client-go](https://danielmangum.com/posts/controller-runtime-client-go-rate-limiting/)
- [Building Resilient Kubernetes Controllers: A Practical Guide to Retry Mechanisms](https://medium.com/@vamshitejanizam/building-resilient-kubernetes-controllers-a-practical-guide-to-retry-mechanisms-0d689160fa51)
- [How to Implement Reconciliation Loops with Exponential Backoff in Controllers](https://oneuptime.com/blog/post/2026-02-09-reconciliation-loops-exponential-backoff/view)

### 2.4 小型 Node.js 守护进程适配指南

Kubernetes controller-runtime 模式可直接简化用于单机守护进程：

```javascript
class ShowReconciler {
  constructor(db) {
    this.db = db;
    this.retries = new Map();  // showId -> { count, nextRetry }
  }

  async runLoop() {
    while (true) {
      const now = Date.now();
      
      // 1. 找出需要调和的 shows（定期全量 + 失败重试）
      const shows = this.db.prepare(`
        SELECT id FROM shows 
        WHERE last_reconcile_at < ? OR last_reconcile_at IS NULL
        ORDER BY last_reconcile_at ASC NULLS FIRST
        LIMIT 10
      `).all(now - 3600 * 1000);  // 1小时未调和过的
      
      // 2. 处理每个 show
      for (const show of shows) {
        // 检查是否在退避期
        const retry = this.retries.get(show.id);
        if (retry && now < retry.nextRetry) continue;
        
        try {
          await this.reconcileShow(show.id);
          this.retries.delete(show.id);  // 成功后清除重试记录
          
          // 更新调和时间戳
          this.db.prepare('UPDATE shows SET last_reconcile_at = ? WHERE id = ?')
            .run(now, show.id);
        } catch (error) {
          this.handleError(show.id, error);
        }
      }
      
      // 3. 下一轮前休眠
      await sleep(10000);  // 10秒
    }
  }

  handleError(showId, error) {
    const retry = this.retries.get(showId) || { count: 0 };
    retry.count++;
    // 指数退避：5s, 10s, 20s, 40s, ...，最多 900s (15min)
    const delay = Math.min(5000 * Math.pow(2, retry.count), 900000);
    retry.nextRetry = Date.now() + delay;
    this.retries.set(showId, retry);
    
    logger.warn('Reconcile failed, will retry', { showId, delay, error });
  }

  async reconcileShow(showId) {
    // 幂等的调和逻辑（见 2.2 节示例）
  }
}
```

**来源**：
- [Kubernetes Reconcile Loop Explained: Workqueue, Reconcile() & Code (2026)](https://www.golinuxcloud.com/kubernetes-reconcile-loop-explained/)
- [The Principle of Reconciliation](https://www.chainguard.dev/unchained/the-principle-of-reconciliation)

---

## 三、Node.js SQLite 选型 2026

### 3.1 better-sqlite3 vs node:sqlite（内置）

| 维度 | better-sqlite3 | node:sqlite（Node 22.5+） |
|------|----------------|--------------------------|
| **安装方式** | `npm install better-sqlite3`<br>需编译 native binding | 无需安装，`require('node:sqlite')` |
| **稳定性** | 生产级稳定，社区成熟 | Node 22.22 仍带实验警告<br>**Node 26+ 才稳定** |
| **API 成熟度** | 功能完整，API 优雅 | 更冗长，功能基本覆盖 |
| **Docker 兼容性** | 需注意 glibc/musl 区别 | 零问题（嵌入 Node 二进制） |
| **Prebuilt 覆盖** | 覆盖主流平台，但有坑 | N/A（不需要） |
| **性能** | 最快 | 相近（都是同步 API） |

**来源**：
- [SQLite Driver Benchmark: better-sqlite3, node:sqlite, libSQL, Turso](https://sqg.dev/blog/sqlite-driver-benchmark/)
- [Node.js Built-in SQLite: A Practical Guide](https://jangwook.net/en/blog/en/node-sqlite-builtin-practical-guide-2026/)
- [better-sqlite3 vs libsql vs sql.js 2026 — PkgPulse Guides](https://www.pkgpulse.com/guides/better-sqlite3-vs-libsql-vs-sql-js-sqlite-nodejs-2026)

### 3.2 Prebuilt Binary 实战陷阱（better-sqlite3）

#### 已知问题（截至 2026-07）

1. **musl libc 覆盖不完整**：
   - Node 24 + ARM64 + musl（Alpine）无 prebuilt，需现场编译
   - 报错示例：`No prebuilt binaries found (target=12.16.3 runtime=node arch=x64 libc=musl platform=linux)`
   
2. **Docker 多阶段构建陷阱**：
   - ❌ **错误示例**：
     ```dockerfile
     FROM node:22 AS builder        # glibc (Debian)
     RUN npm install better-sqlite3
     
     FROM node:22-alpine AS runtime # musl (Alpine)
     COPY --from=builder /app/node_modules ./node_modules  # 💥 不兼容！
     ```
   - ✅ **正确示例**：两阶段用同一 libc
     ```dockerfile
     FROM node:22-slim AS builder   # glibc
     FROM node:22-slim AS runtime   # glibc
     # 或两阶段都用 alpine + 安装 musl-dev 和 build-base
     ```

**来源**：
- [Docker build - No prebuilt binaries · Issue #387 · better-sqlite3](https://github.com/JoshuaWise/better-sqlite3/issues/387)
- [Provide prebuilt binary for Node 24 musl · Issue #1382 · better-sqlite3](https://github.com/WiseLibs/better-sqlite3/issues/1382)
- [How to use with Alpine and Docker? · Discussion #1270 · better-sqlite3](https://github.com/WiseLibs/better-sqlite3/discussions/1270)

### 3.3 Multi-Arch Docker 构建指南（针对 subtitle-scout）

#### 目标架构：linux/amd64 + linux/arm64（Debian bookworm）

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-slim AS builder

# 使用 BuildKit 内置变量
ARG TARGETPLATFORM
ARG BUILDPLATFORM
RUN echo "Building on $BUILDPLATFORM for $TARGETPLATFORM"

WORKDIR /app
COPY package*.json ./

# 安装依赖（better-sqlite3 会自动检测架构并下载对应 prebuilt）
RUN npm ci --production

# 如果 prebuilt 不存在，需安装编译工具
# RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY . .

# --- Runtime 阶段 ---
FROM node:22-slim

WORKDIR /app
COPY --from=builder /app ./

CMD ["node", "index.js"]
```

#### 使用 Docker Buildx 构建

```bash
# 创建 builder（仅首次）
docker buildx create --name multiarch --use

# 构建并推送
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag your-registry/subtitle-scout:latest \
  --push \
  .
```

**关键提示**：
- **QEMU 下编译会很慢**：如果 prebuilt 缺失，交叉编译可能耗时 10+ 分钟
- **建议方案**：优先使用 glibc 镜像（node:22-slim），better-sqlite3 对 glibc 覆盖更好

**来源**：
- [Multi-Architecture Docker Builds for Node.js: From Apple Silicon to AWS Graviton](https://dev.to/raju_dandigam/multi-architecture-docker-builds-for-nodejs-from-apple-silicon-to-aws-graviton-34dn)
- [How to Write Dockerfiles That Work on Both ARM and x86](https://oneuptime.com/blog/post/2026-02-08-how-to-write-dockerfiles-that-work-on-both-arm-and-x86/view)
- [Better-SQLite3 Setup for Node.js](https://www.nxsi.io/guides/better-sqlite3)

### 3.4 选型结论

**subtitle-scout v2 推荐方案**：

```
✅ better-sqlite3 + node:22-slim (Debian bookworm, glibc)
```

**理由**：
1. ✅ **生产稳定**：better-sqlite3 社区成熟，node:sqlite 要到 Node 26 LTS 才稳定
2. ✅ **Docker 友好**：node:22-slim 基于 Debian bookworm (glibc 2.36)，better-sqlite3 prebuilt 对 amd64/arm64 + glibc 覆盖良好
3. ✅ **API 优势**：better-sqlite3 同步 API 更直观，事务封装更优雅
4. ⚠️ **避坑指引**：不要用 Alpine（musl libc）除非团队有处理编译失败的能力

**未来迁移路径**（可选）：
- 当 Node 26 LTS 发布且项目依赖升级无障碍时，可评估迁移到 node:sqlite
- 迁移成本低：API 差异小，Bun 的 bun:sqlite 已证明兼容性

**来源**：
- [Understanding Better-SQLite3: The Fastest SQLite Library for Node.js](https://dev.to/lovestaco/understanding-better-sqlite3-the-fastest-sqlite-library-for-nodejs-4n8)

---

## 四、对 subtitle-scout v2 spec 的具体修订建议

基于以上调研，针对 v2 架构（Node.js sidecar + SQLite 单库状态机）的关键设计决策：

### 4.1 Jobs 表设计（任务队列）

```sql
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  
  -- 队列分类
  queue_name TEXT NOT NULL DEFAULT 'default',
  
  -- 任务元数据
  job_type TEXT NOT NULL,  -- 'scan_show', 'fetch_subtitles', etc.
  payload TEXT NOT NULL,   -- JSON 字符串
  
  -- 租约机制（核心）
  visibility_timeout INTEGER NOT NULL DEFAULT 0,  -- Unix timestamp
  worker_id TEXT,          -- 当前持有租约的 worker 标识
  
  -- 状态追踪
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'succeeded', 'failed'
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  
  -- 优先级 & 调度
  priority INTEGER NOT NULL DEFAULT 0,  -- 越大越优先
  created_at INTEGER NOT NULL,
  started_at INTEGER,      -- 首次被领取的时间
  completed_at INTEGER,    -- 完成（成功或永久失败）的时间
  
  -- 错误信息
  last_error TEXT,
  
  -- 索引
  INDEX idx_acquire (visibility_timeout, status, priority, created_at),
  INDEX idx_queue_status (queue_name, status, created_at)
);
```

**关键设计点**：
1. **`visibility_timeout`**：
   - `0` = 未领取
   - `< unixepoch()` = 租约已过期，可被重新领取
   - `≥ unixepoch()` = 租约有效，对其他 worker 不可见
   
2. **索引策略**：`idx_acquire` 覆盖领取任务查询的所有过滤条件，避免全表扫描

### 4.2 领取任务的原子实现（better-sqlite3）

```javascript
const acquireJob = db.prepare(`
  UPDATE jobs 
  SET 
    visibility_timeout = :timeout,
    worker_id = :workerId,
    attempts = attempts + 1,
    started_at = CASE WHEN started_at IS NULL THEN :now ELSE started_at END
  WHERE id = (
    SELECT id FROM jobs
    WHERE queue_name = :queue
      AND status = 'pending'
      AND visibility_timeout < :now
      AND attempts < max_attempts
    ORDER BY priority DESC, created_at ASC
    LIMIT 1
  )
  RETURNING *
`);

function tryAcquireJob(workerId, queueName = 'default', leaseSeconds = 300) {
  const now = Math.floor(Date.now() / 1000);
  const timeout = now + leaseSeconds;
  
  // 使用 BEGIN IMMEDIATE 避免升级锁失败
  db.exec('BEGIN IMMEDIATE');
  try {
    const job = acquireJob.get({ 
      workerId, 
      queue: queueName, 
      timeout, 
      now 
    });
    db.exec('COMMIT');
    return job || null;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
```

### 4.3 调和循环主循环设计

```javascript
class ShowReconciler {
  constructor(db, tmdbClient) {
    this.db = db;
    this.tmdbClient = tmdbClient;
    
    // 配置
    this.reconcileInterval = 3600 * 1000;  // 1小时全量调和周期
    this.batchSize = 10;                   // 每轮处理数量
    this.retries = new Map();              // showId -> { count, nextRetry }
  }

  async run() {
    logger.info('ShowReconciler started');
    
    while (true) {
      try {
        await this.reconcileOnce();
      } catch (error) {
        logger.error('Reconcile loop error', { error });
      }
      
      await sleep(10000);  // 10秒一轮
    }
  }

  async reconcileOnce() {
    const now = Date.now();
    
    // 1. 找出需要调和的 shows（按优先级排序）
    const shows = this.db.prepare(`
      SELECT id, tmdb_id 
      FROM shows 
      WHERE last_reconcile_at IS NULL 
         OR last_reconcile_at < ?
      ORDER BY 
        CASE WHEN last_reconcile_at IS NULL THEN 0 ELSE 1 END,  -- NULL 优先
        last_reconcile_at ASC
      LIMIT ?
    `).all(now - this.reconcileInterval, this.batchSize);
    
    for (const show of shows) {
      // 检查退避
      const retry = this.retries.get(show.id);
      if (retry && now < retry.nextRetry) continue;
      
      try {
        await this.reconcileShow(show);
        this.retries.delete(show.id);  // 成功后清除重试状态
        
        // 更新调和时间戳
        this.db.prepare(`
          UPDATE shows 
          SET last_reconcile_at = ?, reconcile_error = NULL 
          WHERE id = ?
        `).run(now, show.id);
        
      } catch (error) {
        this.handleRetry(show.id, error);
      }
    }
  }

  async reconcileShow(show) {
    // 幂等的调和逻辑
    
    // 1. 获取当前状态
    const seasons = this.db.prepare(`
      SELECT * FROM seasons WHERE show_id = ?
    `).all(show.id);
    
    // 2. 获取期望状态（外部 API）
    const desiredSeasons = await this.tmdbClient.getSeasons(show.tmdb_id);
    
    // 3. Diff + Apply（在事务中，但事务外已准备好所有数据）
    const applyChanges = this.db.transaction((changes) => {
      for (const desired of changes.toCreate) {
        this.db.prepare(`
          INSERT OR IGNORE INTO seasons (show_id, season_number, name, air_date)
          VALUES (?, ?, ?, ?)
        `).run(show.id, desired.season_number, desired.name, desired.air_date);
      }
      
      for (const desired of changes.toUpdate) {
        this.db.prepare(`
          UPDATE seasons 
          SET name = ?, air_date = ?
          WHERE id = ?
        `).run(desired.name, desired.air_date, desired.id);
      }
    });
    
    const changes = this.computeChanges(seasons, desiredSeasons);
    applyChanges(changes);
  }

  computeChanges(current, desired) {
    // 纯计算逻辑，无副作用
    const toCreate = [];
    const toUpdate = [];
    
    for (const d of desired) {
      const c = current.find(s => s.season_number === d.season_number);
      if (!c) {
        toCreate.push(d);
      } else if (c.name !== d.name || c.air_date !== d.air_date) {
        toUpdate.push({ ...d, id: c.id });
      }
    }
    
    return { toCreate, toUpdate };
  }

  handleRetry(showId, error) {
    const retry = this.retries.get(showId) || { count: 0 };
    retry.count++;
    
    // 指数退避：5s -> 10s -> 20s -> ... -> 最多 15min
    const delay = Math.min(5000 * Math.pow(2, retry.count), 900000);
    retry.nextRetry = Date.now() + delay;
    this.retries.set(showId, retry);
    
    // 记录到数据库（可选）
    this.db.prepare(`
      UPDATE shows 
      SET reconcile_error = ?
      WHERE id = ?
    `).run(error.message, showId);
    
    logger.warn('Reconcile failed, will retry', { 
      showId, 
      attempt: retry.count, 
      nextRetryIn: delay,
      error: error.message 
    });
  }
}
```

**关键设计点**：
1. **Level-Triggered**：每次都从数据库重新读取 show 状态，不依赖事件
2. **幂等性**：`computeChanges` 纯函数 + `INSERT OR IGNORE` + 更新前对比
3. **事务边界**：外部 API 调用在事务外，事务仅包含数据库写操作
4. **错误处理**：瞬态错误自动重试（指数退避），永久错误记录后跳过

### 4.4 数据库初始化清单（better-sqlite3）

```javascript
function initDatabase(dbPath) {
  const db = new Database(dbPath);
  
  // === 必备配置（生产级） ===
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -64000');  // 64MB
  
  // === Schema 初始化 ===
  db.exec(`
    CREATE TABLE IF NOT EXISTS shows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tmdb_id INTEGER UNIQUE NOT NULL,
      name TEXT NOT NULL,
      last_reconcile_at INTEGER,
      reconcile_error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    
    CREATE INDEX IF NOT EXISTS idx_shows_reconcile 
      ON shows(last_reconcile_at) 
      WHERE last_reconcile_at IS NOT NULL;
    
    -- jobs 表见 4.1 节
    -- ... 其他表 ...
  `);
  
  // === 定期维护任务（可选） ===
  // 每小时执行一次 checkpoint，防止 WAL 无限增长
  setInterval(() => {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      logger.debug('WAL checkpoint completed');
    } catch (error) {
      logger.error('WAL checkpoint failed', { error });
    }
  }, 3600 * 1000);
  
  return db;
}
```

### 4.5 单写者架构建议（可选，但强烈推荐）

如果 subtitle-scout 部署为多进程/多容器，建议采用：

```
┌───────────────┐
│   HTTP API    │  只读查询 + 提交写任务到内存队列
│   (Express)   │  ────────┐
└───────────────┘          │
                           ▼
                    ┌─────────────┐
                    │  写任务队列  │
                    │ (in-memory) │
                    └─────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │ 写者进程     │  唯一可写 SQLite
                    │ (Worker)    │  的进程
                    └─────────────┘
                           │
                           ▼
                    [SQLite WAL]
```

**实现提示**：
- API 进程：只读连接 `SQLITE_OPEN_READONLY`
- Worker 进程：读写连接 + 监听内存队列（如 Redis/BullMQ）
- **优势**：彻底消除 SQLITE_BUSY（写-写冲突）

**来源**：
- [SQLite User Forum: Exclusive write-only lock](https://sqlite.org/forum/forumpost/1971358f2b)
- [Abusing SQLite to Handle Concurrency | SkyPilot Blog](https://blog.skypilot.co/abusing-sqlite-to-handle-concurrency/)

### 4.6 容器化最佳实践（Dockerfile）

```dockerfile
# syntax=docker/dockerfile:1

# === Builder Stage ===
FROM node:22-slim AS builder

WORKDIR /app

# 1. 仅复制依赖清单，利用 Docker 层缓存
COPY package*.json ./

# 2. 安装依赖（better-sqlite3 会下载 prebuilt 或编译）
RUN npm ci --production

# 3. 复制源码
COPY . .

# === Runtime Stage ===
FROM node:22-slim

# 安装运行时依赖（better-sqlite3 需要）
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 从 builder 复制已安装的依赖
COPY --from=builder /app ./

# 数据库持久化目录
VOLUME ["/app/data"]

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "src/index.js"]
```

**关键点**：
- ✅ 两阶段都用 `node:22-slim`（glibc），避免 glibc/musl 不兼容
- ✅ 生产环境安装 `libsqlite3-0`（虽然 better-sqlite3 自带，但系统库可作为 fallback）
- ✅ 使用 `VOLUME` 声明数据目录，提醒用户挂载持久化存储

---

## 五、延伸阅读与参考文献

### SQLite 任务队列实现
- [LiteQueue Documentation](https://litements.exampl.io/queue/)
- [Goqite - Go Queue Built on SQLite](https://maragudk.github.io/goqite/)
- [Building a Durable Message Queue on SQLite for AI Agent Orchestration](https://dev.to/minnzen/building-a-durable-message-queue-on-sqlite-for-ai-agent-orchestration-335m)
- [Why I Built a Job Queue With SQLite Instead of Redis](https://dev.to/d_security/why-i-built-a-job-queue-with-sqlite-instead-of-redis-and-what-i-learned-4f05)
- [A SQLite Background Job System - JasonGorman](https://jasongorman.uk/writing/sqlite-background-job-system/)

### SQLite 并发与 WAL 模式
- [How to Set Up SQLite for Production Use](https://oneuptime.com/blog/post/2026-02-02-sqlite-production-setup/view)
- [What to do about SQLITE_BUSY errors despite setting a timeout](https://berthub.eu/articles/posts/a-brief-post-on-sqlite3-database-locked-despite-timeout/)
- [SQLite concurrent writes and database is locked errors](https://tenthousandmeters.com/blog/sqlite-concurrent-writes-and-database-is-locked-errors/)
- [The Write Stuff: Concurrent Write Transactions in SQLite](https://oldmoe.blog/2024/07/08/the-write-stuff-concurrent-write-transactions-in-sqlite/)
- [SQLite in Practice (1): The Database Is Locked Again!](https://docsaid.org/en/blog/sqlite-wal-busy-timeout-for-workers/)

### 调和循环模式
- [Understanding and Implementing the Reconciliation Loop Pattern](https://oneuptime.com/blog/post/2026-02-09-operator-reconciliation-loop/view)
- [The Reconciler Pattern](https://www.farishuskovic.dev/blog/k8s-reconciler-pattern/)
- [The Principle of Reconciliation](https://www.chainguard.dev/unchained/the-principle-of-reconciliation)
- [Kubernetes Reconcile Loop Explained: Workqueue, Reconcile() & Code (2026)](https://www.golinuxcloud.com/kubernetes-reconcile-loop-explained/)
- [Good Practices - The Kubebuilder Book](https://book.kubebuilder.io/reference/good-practices.html)

### Kubernetes Controller 错误处理
- [Rate Limiting in controller-runtime and client-go](https://danielmangum.com/posts/controller-runtime-client-go-rate-limiting/)
- [Building Resilient Kubernetes Controllers: A Practical Guide to Retry Mechanisms](https://medium.com/@vamshitejanizam/building-resilient-kubernetes-controllers-a-practical-guide-to-retry-mechanisms-0d689160fa51)
- [How to Implement Reconciliation Loops with Exponential Backoff in Controllers](https://oneuptime.com/blog/post/2026-02-09-reconciliation-loops-exponential-backoff/view)
- [Error Back-off with Controller Runtime](https://stuartleeks.com/posts/error-back-off-with-controller-runtime/)

### Node.js SQLite 选型
- [SQLite Driver Benchmark: better-sqlite3, node:sqlite, libSQL, Turso](https://sqg.dev/blog/sqlite-driver-benchmark/)
- [Node.js Built-in SQLite: A Practical Guide](https://jangwook.net/en/blog/en/node-sqlite-builtin-practical-guide-2026/)
- [Understanding Better-SQLite3: The Fastest SQLite Library for Node.js](https://dev.to/lovestaco/understanding-better-sqlite3-the-fastest-sqlite-library-for-nodejs-4n8)
- [better-sqlite3 vs libsql vs sql.js 2026 — PkgPulse Guides](https://www.pkgpulse.com/guides/better-sqlite3-vs-libsql-vs-sql-js-sqlite-nodejs-2026)

### Docker 多架构构建
- [Multi-Architecture Docker Builds for Node.js: From Apple Silicon to AWS Graviton](https://dev.to/raju_dandigam/multi-architecture-docker-builds-for-nodejs-from-apple-silicon-to-aws-graviton-34dn)
- [How to Write Dockerfiles That Work on Both ARM and x86](https://oneuptime.com/blog/post/2026-02-08-how-to-write-dockerfiles-that-work-on-both-arm-and-x86/view)
- [Better-SQLite3 Setup for Node.js](https://www.nxsi.io/guides/better-sqlite3)
- [How to use with Alpine and Docker? · Discussion #1270 · better-sqlite3](https://github.com/WiseLibs/better-sqlite3/discussions/1270)

### SQLite 生产实践
- [The SQLite Renaissance: Why the World's Most Deployed Database Is Taking Over Production in 2026](https://dev.to/pockit_tools/the-sqlite-renaissance-why-the-worlds-most-deployed-database-is-taking-over-production-in-2026-3jcc)
- [SQLite for Production: Not Just a Development Database](https://0x.run/sqlite-production-not-just-development)
- [SQLite in Production - A Real-World Benchmark](https://shivekkhurana.com/blog/sqlite-in-production/)
- [Abusing SQLite to Handle Concurrency | SkyPilot Blog](https://blog.skypilot.co/abusing-sqlite-to-handle-concurrency/)

---

## 六、总结

本次调研针对 subtitle-scout v2 的技术选型与架构设计，得出以下核心结论：

### 6.1 技术栈定案

```
Node.js 22 + better-sqlite3 + node:22-slim (Debian bookworm, glibc)
```

- ✅ **生产稳定**：better-sqlite3 久经考验，Docker 多架构支持良好
- ⚠️ **避免 Alpine**：musl libc 的 prebuilt 覆盖不完整，除非愿意承受编译失败风险

### 6.2 关键设计模式

1. **任务队列**：
   - `UPDATE...RETURNING` + visibility timeout（SQS 模型）
   - `BEGIN IMMEDIATE` 避免锁升级失败
   - WAL 模式 + `busy_timeout = 5000` 是基线配置

2. **调和循环**：
   - Level-triggered（基于状态，不依赖事件）
   - 幂等性（`INSERT OR IGNORE` + 更新前对比）
   - 指数退避（5s → 15min，每个资源独立退避）

3. **并发模型**：
   - 优先单写者架构（彻底消除 SQLITE_BUSY）
   - 多写者场景：事务外准备数据 + 事务内快速写入

### 6.3 立即行动项（优先级排序）

1. **P0 - 数据库配置**：
   ```javascript
   db.pragma('journal_mode = WAL');
   db.pragma('busy_timeout = 5000');
   db.pragma('synchronous = NORMAL');
   ```

2. **P0 - Jobs 表设计**：
   - 添加 `visibility_timeout` 字段
   - 移除旧的 `status` 状态机，改用租约模型
   - 创建 `idx_acquire` 索引

3. **P1 - 调和循环重构**：
   - 实现 `reconcileShow()` 的幂等逻辑
   - 添加内存退避状态（`Map<showId, RetryState>`）
   - 记录 `last_reconcile_at` 和 `reconcile_error`

4. **P2 - Dockerfile 优化**：
   - 确认多阶段构建都用 `node:22-slim`
   - 添加 `VOLUME` 声明数据目录
   - 添加健康检查

---

**报告完成时间**：2026-07-09  
**下一步**：将本报告的设计决策更新到项目 MEMORY.md，并创建 v2 实现任务清单。
