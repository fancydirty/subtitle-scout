import chardet from 'chardet'
import * as iconv from 'iconv-lite'

export interface DecodedText {
  /** 归一化为 UTF-8 后的字节 */
  data: Buffer
  /** chardet 探测到的原始编码名（小写），无法判定时为 null；ascii 记为 'utf-8'（是其子集） */
  encoding: string | null
}

// 与 subtitleWriter.ts 的落盘归一化共用同一套探测+解码逻辑：ASSRT 等来源常见 GBK/GB18030，
// 朴素按 utf-8 解码会把合法中文变成乱码（decodable 误判）。两处都必须走同一条路径，
// 否则「写入时认得的编码」和「体检时认不出的编码」互相矛盾。
export function decodeToUtf8(raw: Buffer): DecodedText {
  const detected = chardet.detect(raw)
  let encoding = detected ? String(detected).toLowerCase() : null
  let data = raw
  if (encoding && encoding !== 'utf-8' && encoding !== 'ascii' && iconv.encodingExists(encoding)) {
    data = Buffer.from(iconv.decode(raw, encoding), 'utf8')
  } else if (encoding === 'ascii') {
    encoding = 'utf-8' // ascii 是 utf-8 子集
  }
  return { data, encoding }
}
