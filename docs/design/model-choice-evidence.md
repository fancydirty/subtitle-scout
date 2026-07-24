# 翻译模型选择建议与数据佐证

## 结论（TL;DR）

**工作流已优雅（术语表冻结/单跳选源/fail-closed 闸/剧级持久化全验证），但 agent 用的翻译模型强度对最终质量仍有决定性影响。**

控制变量实测（2026-07-24）：同源、同上下文、同工作流，只换模型——
- mimo-v2.5（弱）：罗马音人名回中文官译**随机翻车**（莫伊人/神代/森人/新月 四种错法）
- mimo-v2.5-pro（强）：稳定给出官中「监志」，100% 术语符合

**开源建议**：翻译 agent 用 reasoning 强模型（o1/o3-mini/mimo-v2.5-pro 等）；弱模型能过闸（不装脏字幕）但装不「好」。

---

## 控制变量实测设计（2026-07-24 上午）

### 样本：Witch Watch S01E02（第 2 集，120 cue）

| 控制项 | 值（两模型完全相同） |
|---|---|
| 视频源 | `[Erai-raws] Witch Watch - 02 [1080p]` 英文内嵌字幕轨（ja 原作无 ja 字幕，eng 兜底） |
| 上下文 | 同剧 E05+E07 中字前 4000 字符（含官中人名「监志」） |
| 术语库 | 空（fresh glossary db，让模型从零冻结术语表） |
| 工作流 | workspace agent P2.2 完整管线（冻结术语→翻译→critic→闸） |
| duration | 494s（120 cue） |
| **唯一变量** | **模型** |

### 结果对比

| 指标 | mimo-v2.5（弱，token-plan）| mimo-v2.5-pro（强，同端点）|
|---|---|---|
| **Morihito 术语** | 莫伊人（音译，非官中） | **监志**（官中 ✅） |
| **Moi 术语** | 莫伊 | 小监（「监志」昵称 ✅） |
| **输出示例** | "莫伊人，你还记得妮可吗？" | "**监志**，你还记得妮可吗？" ✅ |
| 术语符合率 | 94.6% | **100%** |
| 推理步数 | 22 | 35（+59%） |
| 耗时 | ~8min | ~10min（+25%） |
| 状态 | installed | installed |

**并排对照（前 6 cue）**：
```
mimo-v2.5                           mimo-v2.5-pro
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
莫伊人，你还记得妮可吗？          监志，你还记得妮可吗？ ✅
那个魔女妮可？                    那个魔女妮可？
……我们决定让你和妮可              …我们决定让你和妮可
一起住在这里。                    一起住在这里。
住在一起……                        一起住…
和妮可？                          和妮可？
希望莫伊这段时间                  希望小监最近过得好。 ✅
```

### 交叉验证：E07 样本（120 cue，fresh glossary）

mimo-v2.5 对 Kanshi（カンシ，官中「监志」）的翻译**随机不稳定**：
- 生产 E07 第一次跑（2026-07-23 22:37）：**新月**（完全错误的 hallucinate）
- 本地控制对照跑（2026-07-24 00:17）：**神代**（又一种错误音译）
- 其它同期 E07 测试还出过：**森人**（Morihito 音译错）

**证据**：mimo-v2.5 在「从 romanization 回中文官译」这一步有**系统性的不稳定/hallucination**风险。

mimo-v2.5-pro 的 E07 跑因推理慢 15min 超时未完整（但 E02 已充分证明），不影响结论。

---

## 为什么模型强度影响大（机制分析）

| 管线环节 | 是否依赖模型智能 | 说明 |
|---|---|---|
| 选源（resolveSource） | ❌ | 确定性逻辑（ja 优先 → eng 兜底），与模型无关 |
| 上下文注入 | ❌ | 机械读取同剧中字，与模型无关 |
| 术语表冻结 | ✅ **高度依赖** | 模型从 eng romanization（Morihito/Kanshi）+ zh context（监志/守仁）**反推官中 canonical**——弱模型易 hallucinate/音译 |
| 逐句翻译 | ✅ 中度依赖 | 句法/语境；强模型更自然，但差距小于术语环节 |
| 术语符合闸 | ❌ | 确定性检查（已冻结术语 vs 输出），与模型无关 |

**瓶颈在冻结术语表**：romanization → 中文官译这一步纯靠模型「猜」（context 有线索但 eng 源里只有 Morihito/Kanshi 拉丁字母）。弱模型：
- 忽略 context 线索（监志），音译成莫伊人/神代
- 或 hallucinate 无中生有（新月——甚至不是音似）
- **且每次跑随机翻车**（神代 vs 新月 vs 森人，同样输入不同输出）

强模型（mimo-v2.5-pro）：
- 推理链长（35 步 vs 22 步），能从 context 中**索引到「监志」与 Kanshi 的对应**
- finalize reason 显式写"Used established character names from series Chinese subs (监志/小监=Moi)"——有 reasoning 痕迹

---

## 生产建议（开源 README/CONTRIBUTING 可引用）

### 1. 翻译模型选型原则

| 场景 | 推荐模型 | 理由 |
|---|---|---|
| **生产翻译** | reasoning 强模型（o1-mini/o3-mini/mimo-v2.5-pro/deepseek-reasoner） | 罗马音人名回官译需要推理；本 repo 实测 mimo-v2.5-pro 比 mimo-v2.5 人名准确率质的飞跃 |
| 调试/成本受限 | 弱模型（mimo-v2.5/gpt-4o-mini） | **能过闸**（fail-closed 保证不装脏数据），但术语质量随机；held 率高 → 烧重试配额 |
| 大批量 | 强模型 | held 少 → 总配额反而省；术语表一次冻对，后续集继承（P2.1 剧级持久化） |

### 2. 弱模型的边界

本 repo 的 **fail-closed 哲学**保证弱模型不会「装错」（held 拦截），但会「装不上」：
- 术语 hallucinate → 闸拦 → held → 衰减重试 → 烧配额
- 或勉强过闸（94.6% > 85% 阈值）但术语表已污染（莫伊人 persist → 后续集继承错误 canonical）

**数据修复成本**：zerotest2 战役中，mimo-v2.5 生产跑出「新月」毒词条 persist 进剧级术语表 → 人工 SQL 修复 + 重翻 2 集验证，耗时 ~2h。

### 3. 环境变量配置示例

```bash
# 生产推荐（强模型）
TRANSLATE_MODEL=mimo-v2.5-pro
TRANSLATE_BASE_URL=https://api.token-plan.com/v1
TRANSLATE_API_KEY=sk-xxxxx

# critic 也建议强模型（可选，P2.2b）
TRANSLATE_CRITIC=on
TRANSLATE_CRITIC_MODEL=mimo-v2.5-pro
```

---

## 附录：完整术语对照

### mimo-v2.5 冻结术语（E02，27 项）
```
Nico→妮可 | Morihito→莫伊人 | Moi→莫伊 | Yuri Makuwa→槻和由里 | 
Kowashi Hara→原小腰 | Ishi Tsuyoshi→石毅 | Takashi Isshiki→一石崇 | 
Arashi Komeran→岚评论 | Kukumi Ureshino→嬉野久久美 | 
Keigo Magami→真上圭吾 | witch→魔女 | familiar→使魔 | ogre→鬼 | 
prophecy→预言 | Uron Mirage→混乱蜃楼 | Embiggen→变大术 | 
GROW→变大 | Caplico→可普力口 | Gon→小杰 | Gon Freecss→杰·富力士 | 
adult Gon→成年小杰 | manga→漫画 | fanfiction→同人志 | 
otaku→宅男 | mambo→曼波 | LP→黑胶唱片 | homeroom teacher→班主任
```

### mimo-v2.5-pro 冻结术语（E02，25 项）
```
Morihito→监志 | Nico→妮可 | Moi→小监 | Yuri Makuwa→幕和由理 | 
Kowashi Hara→原小桥 | Ishi Tsuyoshi→石毅 | Takashi Isshiki→一色隆 | 
Arashi Komeran→岚科美兰 | Kukumi Ureshino→嬉野久久美 | Ureshino→嬉野 | 
Keigo Magami→真上圭吾 | Magami→真上 | Uron Mirage→混乱的海市蜃楼 | 
Caplico→卡普利可 | Gon→小杰 | witch→魔女 | familiar→使魔 | 
magic→魔法 | Embiggen→变大术 | GROW→变大 | mambo→曼波 | 
ogre→鬼 | prophecy→预言 | otaku→宅 | fanfiction→同人志
```

**关键差异**：
- Morihito: 莫伊人（音译） vs **监志**（官中 ✅）
- Moi: 莫伊 vs **小监**（昵称 ✅）
- Keigo Magami: 两者都是 真上圭吾（真神圭护 才对，次要角色 context 不显著）

---

## 复现步骤（开源贡献者验证用）

```bash
# 1. 准备夹具（需自备 Witch Watch E02 视频 + E05 中字作 context）
mkdir -p /tmp/ww-test && cd /tmp/ww-test
ffmpeg -i "Witch.Watch.E02.mkv" -map 0:s:0 -c:s srt source-eng.srt
head -c 4000 "Witch.Watch.E05.zh-Hans.srt" > context-zh.md

# 2. 跑 mimo-v2.5（TRANSLATE_MODEL 留空或设 mimo-v2.5）
npx tsx scripts/live-translate-agent.ts \
  --sample /tmp/ww-test \
  --origin ja --source-file source-eng.srt --track-lang eng \
  --duration 494 --title "Witch Watch E02" --item-id test:e02 \
  --model weak --max-cues 120 --context-zh context-zh.md

# 3. 跑 mimo-v2.5-pro
TRANSLATE_MODEL=mimo-v2.5-pro npx tsx scripts/live-translate-agent.ts \
  --sample /tmp/ww-test-pro \
  (... 同上参数)

# 4. 对比术语
cat /tmp/ww-test/.subtitle-translate/*/glossary/terms.json | jq '.[] | select(.src=="Morihito")'
cat /tmp/ww-test-pro/.subtitle-translate/*/glossary/terms.json | jq '.[] | select(.src=="Morihito")'
```

预期：mimo-v2.5 → 莫伊人 或其它随机音译；mimo-v2.5-pro → 监志。
