#!/usr/bin/env node
// 把含中文候选的 JSON 在一个多字节字符的字节序列中间劈成两次 write，
// 验证读取端（providerPort）对跨 chunk 的 UTF-8 边界安全（setEncoding/StringDecoder）。
const payload = Buffer.from(JSON.stringify([{
  provider: 'assrt', providerId: '1', videoName: 'V', nativeName: '黑客帝国',
  language: null, subtype: null, releaseSite: null, uploadDate: null, fileList: [],
}]) + '\n', 'utf8')
const i = payload.indexOf(Buffer.from('黑', 'utf8')) + 1  // 劈在 '黑' 的三字节序列中间
process.stdout.write(payload.subarray(0, i))
setTimeout(() => process.stdout.write(payload.subarray(i)), 20)
