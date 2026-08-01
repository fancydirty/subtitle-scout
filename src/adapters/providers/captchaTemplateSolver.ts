import { ZIMUKU_DIGIT_TEMPLATES } from './captchaTemplates.js'

interface BBox {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 解析 24-bit BMP
 */
function parseBMP24(buf: Uint8Array): { width: number; height: number; gray: number[] } | null {
  if (buf.length < 54) return null
  if (buf[0] !== 0x42 || buf[1] !== 0x4D) return null // 'BM'
  
  const offset = buf[10] | (buf[11] << 8) | (buf[12] << 16) | (buf[13] << 24)
  const width = buf[18] | (buf[19] << 8) | (buf[20] << 16) | (buf[21] << 24)
  const height = buf[22] | (buf[23] << 8) | (buf[24] << 16) | (buf[25] << 24)
  const bpp = buf[28] | (buf[29] << 8)
  
  if (bpp !== 24) return null
  if (width <= 0 || height <= 0) return null
  if (offset >= buf.length) return null
  
  const rowSize = Math.floor((width * 3 + 3) / 4) * 4
  const gray: number[] = []
  
  // BMP 从底到顶存储
  for (let y = height - 1; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      const idx = offset + y * rowSize + x * 3
      if (idx + 2 >= buf.length) return null
      const r = buf[idx + 2]
      const g = buf[idx + 1]
      const b = buf[idx]
      // 灰度化
      gray.push(Math.floor(0.299 * r + 0.587 * g + 0.114 * b))
    }
  }
  
  return { width, height, gray }
}

/**
 * Otsu 二值化
 */
function otsuThreshold(gray: number[]): number {
  const histogram = new Array(256).fill(0)
  for (const g of gray) histogram[g]++
  
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * histogram[i]
  
  let sumB = 0
  let wB = 0
  let maxVar = 0
  let threshold = 0
  
  for (let t = 0; t < 256; t++) {
    wB += histogram[t]
    if (wB === 0) continue
    
    const wF = gray.length - wB
    if (wF === 0) break
    
    sumB += t * histogram[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const varBetween = wB * wF * (mB - mF) * (mB - mF)
    
    if (varBetween > maxVar) {
      maxVar = varBetween
      threshold = t
    }
  }
  
  return threshold
}

/**
 * 连通分量提取外接框
 */
function findBBoxes(binary: number[], width: number, height: number): BBox[] {
  const visited = new Set<number>()
  const boxes: BBox[] = []
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (binary[idx] === 1 && !visited.has(idx)) {
        // BFS
        const queue = [idx]
        visited.add(idx)
        let minX = x, maxX = x, minY = y, maxY = y
        
        while (queue.length > 0) {
          const cur = queue.shift()!
          const cy = Math.floor(cur / width)
          const cx = cur % width
          minX = Math.min(minX, cx)
          maxX = Math.max(maxX, cx)
          minY = Math.min(minY, cy)
          maxY = Math.max(maxY, cy)
          
          // 4-连通
          for (const [dy, dx] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const ny = cy + dy
            const nx = cx + dx
            if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
              const nidx = ny * width + nx
              if (binary[nidx] === 1 && !visited.has(nidx)) {
                visited.add(nidx)
                queue.push(nidx)
              }
            }
          }
        }
        
        const w = maxX - minX + 1
        const h = maxY - minY + 1
        
        // 过滤噪点
        if (w >= 5 && h >= 10) {
          boxes.push({ x: minX, y: minY, w, h })
        }
      }
    }
  }
  
  return boxes
}

/**
 * 生成签名 `宽x高:hex`
 */
function makeSignature(binary: number[], box: BBox, imgWidth: number): string {
  const { x, y, w, h } = box
  const bits: number[] = []
  
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const idx = (y + dy) * imgWidth + (x + dx)
      bits.push(binary[idx])
    }
  }
  
  // 打包成 hex
  const bytes: string[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8 && i + j < bits.length; j++) {
      byte |= bits[i + j] << (7 - j)
    }
    bytes.push(byte.toString(16).padStart(2, '0'))
  }
  
  return `${w}x${h}:${bytes.join('')}`
}

/**
 * 汉明距离（两个签名的差异位数）
 * 签名格式: "宽x高:hex"
 */
function hammingDistance(sig1: string, sig2: string): number {
  // 尺寸必须完全一致
  const [dim1, hex1] = sig1.split(':')
  const [dim2, hex2] = sig2.split(':')
  if (dim1 !== dim2) return Infinity
  if (hex1.length !== hex2.length) return Infinity
  
  let dist = 0
  for (let i = 0; i < hex1.length; i++) {
    const a = parseInt(hex1[i], 16)
    const b = parseInt(hex2[i], 16)
    const xor = a ^ b
    // 统计 xor 中的 1 的个数
    dist += (xor & 1) + ((xor >> 1) & 1) + ((xor >> 2) & 1) + ((xor >> 3) & 1)
  }
  return dist
}

/**
 * 模板匹配求解器（最近邻）
 * @returns 5 位数字字符串，或 null（任一字形未命中）
 */
export function solveByTemplate(bmpBytes: Uint8Array): string | null {
  // 1. 解析 BMP
  const bmp = parseBMP24(bmpBytes)
  if (!bmp) return null
  
  // 2. Otsu 二值化
  const threshold = otsuThreshold(bmp.gray)
  const binary = bmp.gray.map(g => (g < threshold ? 1 : 0))
  
  // 3. 连通分量
  const boxes = findBBoxes(binary, bmp.width, bmp.height)
  
  // 4. 必须恰好 5 个数字
  if (boxes.length !== 5) return null
  
  // 5. 按 x 坐标排序
  boxes.sort((a, b) => a.x - b.x)
  
  // 6. 最近邻识别每个字形
  const digits: string[] = []
  
  for (const box of boxes) {
    const sig = makeSignature(binary, box, bmp.width)
    
    // 找汉明距离最小的模板
    let bestDist = Infinity
    let bestDigit: string | null = null
    
    for (const template of ZIMUKU_DIGIT_TEMPLATES) {
      const dist = hammingDistance(sig, template.sig)
      if (dist < bestDist) {
        bestDist = dist
        bestDigit = template.digit
      }
    }
    
    // 阈值：8×14 = 112 bits，容忍 20% 差异 ≈ 22 bits
    // 但精确匹配距离=0，细微差异距离 <5
    const maxTolerance = 10
    if (bestDigit !== null && bestDist <= maxTolerance) {
      digits.push(bestDigit)
    } else {
      return null // 任一字形差异过大 → 整体失败
    }
  }
  
  return digits.join('')
}
