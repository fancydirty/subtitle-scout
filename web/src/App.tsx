// web/src/App.tsx：hash 路由骨架：#/ 海报墙 · #/series/:id 详情 · #/history 历史。
import { useRoute } from './lib/hashRoute.js'
import { PosterWall } from './components/PosterWall.js'
import { SeriesDetail } from './components/SeriesDetail.js'
import { History } from './components/History.js'

export function App() {
  const route = useRoute()
  return (
    <div className="stage">
      {route.name === 'series' ? (
        <SeriesDetail id={route.id} />
      ) : route.name === 'history' ? (
        <History />
      ) : (
        <PosterWall />
      )}
    </div>
  )
}
