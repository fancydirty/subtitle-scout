# zimuku 单源覆盖力大考 · 终报(2026-07-19)

用户令:"再度把所有字幕全删,然后让字幕提供商只有 zimuku,从而测试它的资源覆盖实力。"
spec:[2026-07-19-zimuku-solo-coverage-exam-design.md](2026-07-19-zimuku-solo-coverage-exam-design.md)。
取证目录(永久保留):`/mnt/nvme0n1-4/docker/subtitle-scout/e2e-zimuku-solo-run2-20260719/`。

## 前提:zimuku 先被修通(此前从未端到端成功过)

大考首航(run1)当场炸出:**zimuku provider 从建立起从未真正工作过**,整条链路每层都建在合成
fixture 上、与真站全不符。五个 bug 逐个攻克后 zimuku 才首次能用(详见记忆断点与 commit):
传输层 www→apex(`f37d08b`)、云锁验证码 cookie 协议(`00dbdbf`/`1561ced`)、验证会话内容重试
(`670e5ad`)、真实 4 跳下载链路 search→detail→dld→镜像(`d88a604`…`e0ced4a`)、**云锁 LB 连接
粘性→连接钉死**(`5d0b071`)。run2 是修通后的正式大考。

## 协议执行(全程可回滚,无事故)

archive 257 sidecar + manifest → 全库 wipe → cache 退休(cache-baseline=三源 244covered 恢复目标)
→ `.env` 只留 zimuku(assrt/OS 凭据注释,保 TMDB+LLM)→ **硬门验证 `adapters==["zimuku"]` 通过**
→ 部署全修复镜像从零重建 → orchestrator 派活 → agent 只带 zimuku 一杆枪逐单真打。

## 判卷(vs 三源基线)

| 指标 | 三源基线 | zimuku 单源 | 单源/三源 |
|---|---|---|---|
| episodes covered | 244 | **113** | 46% |
| episodes unavailable | 18 | 137 | — |
| movies covered | 6 | 4 | — |
| 缺口集(250 集)捞回 | — | 113 covered / 137 判无 | **45%** |

**分类捞回率(按 series.origin_lang,反直觉的核心发现)**:

| 原产语言 | covered | unavailable | 捞回率 |
|---|---|---|---|
| en(欧美) | 69 | 32 | **68%** |
| ja(动漫) | 38 | 105 | **27%** |
| de(德语) | 6 | 0 | 100% |

**结论与反直觉发现**:zimuku(字幕库)是一个**通用型**中文字幕站,**对欧美内容的覆盖(68%)显著强于
近期新番动漫(27%)**——与"中文站=动漫强"的先验假设相反。合理解释:欧美电影/剧的中文字幕(民间译制)
在 zimuku 存量丰厚;而库里的动漫多为近期季番,更依赖专门的动漫字幕源。**zimuku 作为三源中的"欧美补充位"
价值明确,不是可有可无的第三源。**

## 质量核验(北极星:silent 装错比留缺口更糟)

- **零假覆盖**:113 个 covered 集**无一例**缺 subtitle 行(SQL 核:`covered AND NOT EXISTS(subtitle)` = 0)。
- 记账:73 直装(scout-download)+ 41 领养(季包解压出的同季兄弟集——全库开考前已清零,故这些必为本次
  zimuku 下载后落盘再被领养,来源纯 zimuku)。
- **内容抽验(War② 法,读真文件核语言/时轴/归属)**:
  - The Rig S01E01(欧美,曾是同名陷阱案):真中文 SRT、时轴规范、内容"钻井平台/金洛克B区(Kinloch Bravo,
    正是 The Rig 2023 里的钻井平台)"——**身份正确**(是 2023 剧非同名老片)、语言 zh-Hans、时轴对。
  - SPY×FAMILY S01E11(动漫 .ass):真中文特效字幕(方正字体 + OP-JP 分镜样式),genuine 字幕组作品。
- **反爬/封禁:全程 ~3.3h 零 ban、零 "verified cookie rejected"、零 fetch failed**——连接钉死(单
  keep-alive socket)使云锁验证会话稳定被认,无一次因节点粘性丢失会话。住宅 IP 全程安全。
- 验证码求解成功率:daemon 未把 captcha 事件打进 log(仅生产内部调用),无法从日志统计次数;但 113 次
  成功装机(每次都必须过云锁 WAF)+ 零 cookie-rejected 反证求解链路稳定可靠。(改进项:未来把 captcha
  求解计数/成功率纳入 onApiCall 观测,见遗留。)

## 遗留与改进

1. captcha 求解成功率未被 daemon 观测化(只在验证脚本里打点)——纳入 onApiCall 可量化。
2. 单源大考是**破坏性 + 反爬压力**操作(全库 wipe + ~250 集真打),非常规回归项;zimuku 价值已测明
   (欧美补充位),后续无需重复整库单源大考,增量真机即可。
3. zimuku 未覆盖的 137 集里,105 集是动漫——如需提升动漫覆盖,方向是接入专门动漫字幕源(backlog)。

## 恢复(考完必做,见下方"恢复记录")

还原三源 .env → 用**含全部审计修复**的镜像重建 → archive 回灌 257 sidecar → cache-baseline DB(244)
→ 重启 → 硬门验证三源 → daemon 补齐 zimuku 没啃的缺口 → 终态覆盖 ≥ 基线 244。
