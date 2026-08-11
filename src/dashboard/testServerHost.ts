// src/dashboard/testServerHost.ts —— dashboard HTTP 测试起 server 的地址族约定（仅测试用）。
//
// ── 这个模块存在的唯一理由：根治那条"随机一条 HTTP 用例拿到别人的响应"的 flake ──────
// 症状（server.test.ts / eventStream.test.ts / health.test.ts 三个文件共有，全量并行下偶发
// 一条红）：`SyntaxError: Unexpected end of JSON input`、
// `TypeError: Cannot read properties of null (reading 'current')`、
// `SyntaxError: Unexpected token '<', "<!DOCTYPE "`、`expected 200 to be 400`。
//
// 真因（2026-08-12 实测定位，十进程 × 600 轮复现脚本）：
//   `startDashboard({ port: 0 })` 里的 `server.listen(0)` **不带 host**，Node 绑的是 IPv6 通配
//   `::`；OS 只保证该端口在 `::` 的 ephemeral 空间内唯一。而测试拼 base 时用的是
//   `http://127.0.0.1:<port>`——**IPv4**。两个地址族的端口空间不互斥，同一个号可以同时被本机
//   另一个进程的 IPv4 socket 持有（并行的另一个 vitest worker，或开发机上任何监听 0.0.0.0 的
//   服务）。请求于是压根没到本用例的 server，而是打给了陌生人。
//   决定性指纹：出错那一轮 `server.on('request')` 计数为 **0**。
//
// 前人（server.test.ts 头注释）归因为"`port: 0` 端口回收 + undici 按 host:port 缓存 keep-alive
// 连接、复用到已关闭的 server"，并加了两层缓解（closeAllConnections + 每个用例换 dispatcher）。
// 那两层本身无害，但修的是一条在 Node 19+ 上不成立的通道：`close()` 会主动回收空闲 keep-alive
// socket，单进程 300 轮"关旧 server → 新 server 抢同一端口 → 再请求"实测 **0/300** 串台。
// 真正的串台是**跨进程 + 跨地址族**的，客户端连接池清得再干净也拦不住——那条连接是新建的、
// 也确实连上了 IPv4 的那个端口，只不过端口另有其主。
//
// 修法：测试一律 `listen(port, '127.0.0.1')`，让端口的**分配**与**拨号**处在同一个地址族，
// OS 的 ephemeral 端口唯一性保证重新生效。生产（Docker，需容器外可达）不传 host，保持 `::`
// 通配原样。
//
// 实测对照（同一脚本，十进程 × 600 轮 = 6000 次 start→fetch→close）：
//   不绑 host  → 4/6000 串台（含上面两类症状原样复现）
//   绑 127.0.0.1 → 0/6000

/** dashboard 测试起 server 一律绑这个地址——必须与 baseOf() 拼出的主机名同一地址族。 */
export const TEST_HOST = '127.0.0.1'

/**
 * 从已 listen 的 server 拼出请求 base，并且**拒绝**在地址异常时降级成一个能跑的字符串。
 *
 * 为什么要抛而不是 `?? 0`：三个测试文件原来都写
 * `const port = typeof addr === 'object' && addr ? addr.port : 0`。`startDashboard` 的 listen
 * 失败分支（`server.on('error', … resolve(server))`）会 resolve 一个**没在监听**的 server，
 * 此时 `address()` 是 `null` → port 落成 `0` → base 变 `http://127.0.0.1:0`。那不是一个无效
 * 地址：多数平台把 `:0` 当"随便挑一个"处理，请求于是又打到某个陌生端口上，把一个明确的
 * 启动失败伪装成一条随机的断言失败。这里直接抛，让启动失败长成启动失败的样子。
 */
export function baseOf(server: { address(): string | { port: number } | null }): string {
  const addr = server.address()
  if (typeof addr !== 'object' || addr === null) {
    throw new Error(`dashboard 未在监听（address()=${JSON.stringify(addr)}）——listen 失败被吞了`)
  }
  return `http://${TEST_HOST}:${addr.port}`
}
