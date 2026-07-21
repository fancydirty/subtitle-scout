# 战役 run-log:F1+F2 上线 + Astronaut live(2026-07-21)

## 授权
除推公开 GitHub 外:commit/部署/烧配额全自主。

## 心跳协议
opencode 官方 **无** 会话 timer。本战役用 `nohup` + `*.done` + 主控短轮询(2–5min)。

## Commits
- `f29d690` feat(translate): F2 jimaku + F1 批重试/超时
- `ff0d442` fix(extract): 内嵌抽轨默认超时 300s

## 时间线

| 时间 | 事件 |
|---|---|
| 21:27 | 1873 绿;commit F2+F1 |
| 21:30 | rsync + 生产 .env TRANSLATE_*/JIMAKU_* |
| 21:31 | docker build+up OK |
| 21:32 | identify_overrides tmdb:1086260;reconcile → movies 入库 missing |
| 21:33 | 首次 translate 误用 **mimo**(compose 未透传 TRANSLATE_*)→ kill |
| 21:34 | 补 docker-compose environment 透传;确认 TRANSLATE_MODEL |
| 21:35 | 再跑 → **extract-failed**(默认 30s 不够 4K 抽轨) |
| 21:40 | fix extract 300s;commit+热部署 |
| 21:42 | Astronaut translate 重开 opus |
| 21:56 | **sidecar 写出** 45KB / 764 cues |
| 22:12 | 进程写盘后挂起(undici/keep-alive 疑);kill;recheck → **already-covered** |
| 22:12 | movies.sub_status=**covered** |

## Astronaut 验收

| 项 | 结果 |
|---|---|
| 片源 | `/media/movies/The Astronaut (2025)/...YTS.MX].mkv` 4K ~4.3GB |
| 路径 | E 内嵌 subrip(非 F1 fetch) |
| 模型 | claude-opus-4-8 + critic 开 |
| 产出 | `....zh-Hans.srt` **764 cues / 45KB** |
| 库状态 | `tmdb:1086260` **covered** |
| 再跑 | `already-covered` ✓ |
| 抽验 | 对白通顺(「你醒了」「完全正常」…「回头见」);heavy_ascii≈0 |
| 尾轴 | 末 cue ~01:20(PGS 片长~01:29,可能片尾无对白/credits) |

## 真机逼出的修
1. compose 必须透传 TRANSLATE_* / JIMAKU_API_KEY(仅写 .env 不够)
2. extract 默认超时 30s→**300s**(4K 长片)
3. 写盘后 CLI 偶发不退出→记债(不挡 covered)

## 生产 compose 补丁(路由侧)
`docker-compose.yml` environment 增加 TRANSLATE_* / JIMAKU_*(bak:`docker-compose.yml.bak-pre-f2`)。公开仓 deploy.sh 不覆盖路由 compose——**勿 rsync 冲掉**。

## 未做 / 非目标
- 未 push 公开 GitHub
- 未做票数 tiebreak
- CLI 写盘后挂起根因未深挖(已 finally+exit 兜底)

## 战役 2:AI 翻译设置页开关(2026-07-21 晚)

**用户拍板**:AI 翻译=默认关、用户显式开的行为级开关(防 token 随无字幕媒体失控)。

| 项 | 结果 |
|---|---|
| `settings.ai_translate_enabled` | 新增(true/false,默认关),白名单+zod |
| daemon 门 | `TRANSLATE_* && ai_translate_enabled==='true'` 才派活;worker 端仍只认 env |
| 手动 CLI | 不受开关限制 |
| 设置页 | BehaviorSection Switch(中/英注记:默认关+需三件套+烧配额) |
| ja 优先 | runSearch ja 时 jimaku 排最前 |
| CLI 挂起 | db close 进 finally;打印结果后立即 exit |
| 测试 | 1877 passed + tsc + web 293 |
| commit | `e3988de`(未 push) |
| 部署 | media-router 已重 build+up,生产 `ai_translate_enabled=false` 落库 |
| 生产自动翻译 | **关闭**(开关未设/false;符合默认关) |

**注意**:dashboard API 当前 `setup required`(未建管理员),UI 验证待用户首登;开关写库路径已被 server/apiV2 单测覆盖。

## 战役 3:从零 live test(2026-07-21 23:15 起,过夜)

**目的**:清全部字幕+清库,弱模型(mimo)跑整夜暴露问题。

| 项 | 值 |
|---|---|
| 备份 | `/mnt/nvme0n1-4/backup/20260721-zerotest/`(subtitles-all.tar.gz 274 条 + scout.db.bak + .env.bak-pre-zerotest) |
| 字幕删除 | 274 → 0(.srt/.ass/.ssa/.sub/.vtt/.sup,Movies/TV/anime) |
| 库 | scout.db 清空重建(schema 自动迁移) |
| LLM_* | mimo-v2.5(未动) |
| TRANSLATE_* | **改指 mimo**(base/key=LLM 同,model=mimo-v2.5)——弱模型才能暴露问题 |
| ai_translate_enabled | **true**(测试期开启,让翻译腿参与) |
| 恢复路径 | 字幕 tar + scout.db.bak + .env.bak 三件套回滚 |

**起步确认(23:18)**:17 series / 231 episodes / 8 movies / 36 parked 已入库,daemon 15s tick 中。
**监控**:主控心跳轮询(nohup+done 不适用——这是 daemon 常驻;改为定期查库+logs 记此文件)。
