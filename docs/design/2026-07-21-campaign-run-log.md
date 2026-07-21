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
- CLI 写盘后挂起根因未深挖
