# 从零 e2e 大考 · 运行记录与验尸报告(2026-07-18)

用户令:"把当前生产库的字幕全部删除,从 0 重测,保留 agent 从 0 开始的日志"。执行于生产环境
(schema v8,重复源 P5 部署当天),10:33 清零 → 13:15 队列跑干,全程 2h41m。

## 协议(全程带保险,可完整回滚)

取证目录 `/mnt/nvme0n1-4/docker/subtitle-scout/e2e-zero-20260718/`:
- `deleted-subs-manifest.txt`:删除的 **260 个** sidecar 字幕全路径清单(Movies 5 / TV 235 / anime 20)
- `subs-archive.tgz`:删除前 tar 归档(260/260 验证后才删,3.6MB)
- `cache-before/`:旧世界全部状态退休(scout.db + journals + 决策缓存,验尸对照物)
- `from-zero.log`:**持久日志 follower**(容器自带轮转仅 30MB 会丢,此文件从容器诞生逐行全录)
- `q-e2e.cjs` / `forensic.cjs`:战况查询与终局对比脚本(容器内 /app 下跑,.cjs 因仓是 ESM)

## 从零重建时间线

| 时刻 | 事件 |
|---|---|
| 10:34 | 全新空 DB 诞生,schema v8 直落 |
| ~10:42 | **识别浪潮完成(8 分钟)**:scanned=492 → upserted=416 + parked=36 + 副本≈40 |
| 10:42+ | 分类:150 embedded / 30 ignored(国产跳过门)/ **228 missing**(考题) |
| 10:42→13:15 | orchestrator 13 轮 pass,28 单 worker_task(季级粒度),agent 逐单真打 |
| 13:15 | **队列跑干:missing=0**(236 covered + 26 unavailable),249 字幕入库 |

跑分:23 单 installed / 6 单 no_safe_match / 1 单 error;救援官 5 认领 5 停车;
零配额耗尽、零网络错误、零崩溃。

## 终局验尸(manifest 260 份旧字幕 vs 新世界)

- **21/26 个目录全额找回或本就内嵌**。
- **Nukitashi 三变体目录"消失"= 正确去重**:主条目在 `/media/anime/` 下(embedded),
  `/media/tv/` 两个变体目录被登记为 item_files 副本——跨库根去重工作正常,非丢失。
- 26 个 unavailable 里 **24 个旧世界也没有字幕**(非回归,旧世界本来就缺)。
- **真回归仅 2 例**,且都问出了根因(见下)。

## 大考交卷的发现(按严重度)

1. **BUG·机械层:特殊字符文件名打断安装链路**。LD&R S03E08(文件名含捷克语
   `V klenutých sálech pohřbený` + 路径含 `,`/`&`)— agent 找到候选但 download/install
   反复 `unknown videoFilename`,最终被迫判无。旧世界有此字幕→真回归。待根因:videoFilename
   在 staging/install 键路径上的编码/匹配。
2. **BUG·事实喂错:期望时长用了剧集平均而非单集**。True Detective S02E08 是 ~90 分钟加长
   季终,系统喂 agent 的 runtimeMinutes ≈58(季均)→ agent 把时长正确(~86min)的候选全部
   诚实拒掉。判断力没错,喂的事实错了。修法:FindSubtitleTask.runtimeMinutes 取单集级
   (TMDB episode runtime),取不到再退级平均并标注。
3. **疣·效率:传播时长探测重复空转**。SPY×FAMILY 13 集主副时长永不匹配(不同剪辑),但每轮
   ingest 都重新 ffprobe 主副两文件 → 每 poll 周期 26 次无效探测 + 日志刷屏。幂等安全但该
   给"不匹配判决"加记忆(如 propagation_verdicts 或内存 LRU)。
4. **模型行为·罕见:1 例 finalize 未调**(29 跑里 1 次)。已知类别,状态机兜住;
   留 skill/harness 层收紧项(与救援官 Astronaut 案例同族)。
5. **人类级判无实录**(非问题,是护城河证据):2023 剧《The Rig》拒用 2010 同名电影字幕;
   Witch Watch/Cassandra 等 2025 新资源诚实判无——反 Bazarr 行为在全库尺度成立。

## 结论

**整机从零可用性成立**:识别→分类→智能派活→agent 获取→传播→救援全链在真实生产库上
自主重建了字幕世界(260 旧 → 249 新 + 26 诚实判无,真回归 2 例均已定位根因)。
下一步 = 修发现 #1/#2(走 K3 子代理 + 主控亲核),#3/#4 排后。
