// web/src/components/Brand.tsx：品牌字标，回海报墙。
import { go } from '../lib/hashRoute.js'
export function Brand() {
  return (
    <div className="brand" onClick={() => go('/')} role="link" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') go('/') }}>
      subtitle<em>·scout</em>
    </div>
  )
}
