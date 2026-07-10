#!/usr/bin/env node
// echoes canned candidates on stdout + one api_call event on stderr; `resolve` mode returns a URL
const isResolve = process.argv[2] === 'resolve'
process.stderr.write(JSON.stringify({ event: 'api_call', provider: 'assrt', endpoint: 'sub/search', status: 0, durationMs: 5 }) + '\n')
if (isResolve) {
  process.stdout.write(JSON.stringify({ url: 'https://dl.example/x.zip', filename: 'x.zip' }) + '\n')
} else {
  process.stdout.write(JSON.stringify([{ provider: 'assrt', providerId: '1', videoName: 'V', nativeName: null, language: null, subtype: null, releaseSite: null, uploadDate: null, fileList: [] }]) + '\n')
}
