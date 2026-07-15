// web/src/App.tsx：hash 路由骨架：#/ 海报墙 · #/series/:id 详情 · #/history 历史 ·
// #/parked park 救援（去 Jellyfin 化 P6）。
import { useRoute } from './lib/hashRoute.js'
import { PosterWall } from './components/PosterWall.js'
import { SeriesDetail } from './components/SeriesDetail.js'
import { History } from './components/History.js'
import { Parked } from './components/Parked.js'

export function App() {
  const route = useRoute()
  return (
    <div className="stage">
      {route.name === 'series' ? (
        <SeriesDetail id={route.id} />
      ) : route.name === 'history' ? (
        <History />
      ) : route.name === 'parked' ? (
        <Parked />
      ) : (
        <PosterWall />
      )}
    </div>
  )
}
