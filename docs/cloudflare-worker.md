# Cloudflare Worker Relay

> ⚠️ **已退役（2026-07-25）**：本文档描述的是 v1 时代的 ASSRT 下载中继方案，设计用于 Jellyfin plugin/agent 架构。当前架构已去 Jellyfin 化，src/ 对此 Worker 零引用，且没有 RELAY_URL 等环境变量配置。
>
> **当前状态**：孤儿组件，未被使用。详见 [worker/README.md](../worker/README.md)。

This Worker is a controlled fallback for ASSRT subtitle file downloads. It is not the agent brain.

Responsibilities:

- verify a shared secret from the Jellyfin plugin/agent;
- allow only ASSRT file hosts and known download path prefixes;
- stream or cache subtitle artifacts through Workers KV;
- return explicit errors when the ASSRT file host fails.

Runtime endpoints:

- `GET /health`
- `POST /relay`
- `POST /assrt/download-by-id`

Example relay body:

```json
{
  "url": "http://file0.assrt.net/onthefly/673114/-/1/example.zh.ass?_=...&-=...&api=1",
  "cacheKey": "assrt:673114:1"
}
```

Example by-id body:

```json
{
  "assrtId": 673114,
  "fileIndex": 0,
  "cacheKey": "assrt:673114:file:0"
}
```

The request must include:

```text
Authorization: Bearer <PLUGIN_WORKER_SHARED_SECRET>
```

Secrets:

- `PLUGIN_WORKER_SHARED_SECRET` is stored with `wrangler secret put`.
- `ASSRT_TOKEN` is stored with `wrangler secret put` only for the `/assrt/download-by-id` fallback.

Smoke result on 2026-07-02:

- Worker deploy succeeded at `https://assrt-subtitle-relay.fancydirty.workers.dev`.
- `/health` returned ok.
- unauthenticated `/relay` returned `401`.
- local direct ASSRT file downloads failed because local DNS resolves file hosts to `198.18.*` fake-ip with no working proxy.
- Worker outbound requests to ASSRT file URLs returned upstream `403 Forbidden`, including when the Worker generated a fresh `sub/detail` URL itself.

Implication:

- Cloudflare Workers are still useful for auth, metadata/decision cache, and possibly cached artifacts that are populated by another downloader.
- Cloudflare Workers should not currently be treated as a guaranteed ASSRT file-download egress. ASSRT file hosts appear to reject Cloudflare Worker egress or require a browser/site download path not reproduced by Worker fetch.
