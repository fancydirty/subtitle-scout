import { readFileSync, readdirSync } from 'node:fs'
import { generateText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'

const apiKey = readFileSync('/Users/dirtyfancy/projects/token.txt', 'utf8')
  .split('\n').find(l => l.startsWith('XIAOMI_API_KEY='))?.split('=')[1]?.trim()

const client = createOpenAI({ baseURL: 'https://api.xty.app/v1', apiKey })
const model = client('mimo-v2.5')

const DIR = '/tmp/zimuku-captcha-fixtures'
const files = readdirSync(DIR).filter(f => f.endsWith('.bmp')).sort()

for (const file of files) {
  const bytes = readFileSync(`${DIR}/${file}`)
  
  const result = await generateText({
    model,
    prompt: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Read exactly 5 digits from this CAPTCHA, left to right. Reply with only 5 digits.' },
        { type: 'file', data: bytes, mediaType: 'image/bmp' },
      ],
    }],
    maxOutputTokens: 20,
  })
  
  const match = result.text.match(/\d{5}/)
  console.log(`${file.replace('.bmp', '')}: ${match ? match[0] : 'FAIL'}`)
}
