/** 救援R4（spec §3 机械铁案层）：文件名级特典硬过滤。词边界匹配、大小写不敏感。
 *  只收"绝无剧情"的映像/菜单/预告类标记——SP/OVA/OAD/Special 是灰区（时长/S0 才能判），
 *  归 rescueSkill 的 agent 判断，绝不进这张铁案表（否则会误杀有字幕的剧情向 OAD）。 */
const EXTRA_MARKERS = ['NCOP', 'NCED', 'Menu', 'PV', 'CM', 'Trailer', 'Preview']

export function isMechanicalExtra(filePath: string): boolean {
  const base = filePath.split('/').pop() ?? filePath
  // 词边界：marker 左侧必须是非字母数字或串首，右侧必须是非字母或串尾——避免 'PV' 命中 'PVC'、
  // 'CM' 命中 'CMovie'，同时允许 'NCOP01' 这类真实编号后缀命中。
  return EXTRA_MARKERS.some((m) => new RegExp(`(^|[^A-Za-z0-9])${m}([^A-Za-z]|$)`, 'i').test(base))
}
