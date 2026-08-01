/**
 * zimuku 验证码数字字形模板
 * Bootstrap 集：从 cap-00, cap-01, cap-10, cap-11 肉眼确认的 16 个字形
 * 覆盖数字：0-9 全部
 */
export const ZIMUKU_DIGIT_TEMPLATES: Array<{ sig: string; digit: string }> = [
  // cap-00: 02998
  { sig: '8x14:3c7ee7e7c3cbdfcbc3c3e7e77e3c', digit: '0' },
  { sig: '8x14:feff8703030307060c183060ffff', digit: '2' },
  { sig: '8x14:7efee7c3c3e7ff7f3b07074e7e7c', digit: '9' },
  { sig: '8x14:7efee7c3c3c3ff7f3b07074e7e7c', digit: '9' },
  { sig: '8x14:7e7fe7c3c37e7e7ec3c3c3e7ff7e', digit: '8' },
  // cap-01: 43319
  { sig: '9x14:0e070783c1e1b198cce67ffff6f06030', digit: '4' },
  { sig: '8x14:7eff8703031f3e1e07030387fffe', digit: '3' },
  { sig: '8x14:feff8703031f3e1e03030387ff7e', digit: '3' },
  { sig: '7x14:79f3e1c3870e1c3870e1cfffc0', digit: '1' },
  { sig: '8x14:7e7ee7c3c3c3ff7f3b07074e7e7c', digit: '9' },
  // cap-10: 75177
  { sig: '8x14:ffff0606060c0c0c1c1c18383830', digit: '7' },
  { sig: '8x14:7e7e60607c7e7f4703030387fe7c', digit: '5' },
  { sig: '7x14:79f3e1c3870e1c3870e1cfffc0', digit: '1' },
  { sig: '8x14:ffff0606060c0c0c181c18183830', digit: '7' },
  { sig: '8x14:ffff0606060c0c0c1c1818381830', digit: '7' },
  // cap-11: 69020 (只添加未命中的 6)
  { sig: '8x14:3e7e72e0e0dcfeffc3c3c3e77f7e', digit: '6' },
]
