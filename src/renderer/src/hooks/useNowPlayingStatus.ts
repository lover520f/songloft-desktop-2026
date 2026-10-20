/**
 * 「正在播放」那块界面上，歌手那一行此刻该说什么。
 *
 * 底栏（components/PlayerBar）与满窗播放（components/FullPlayer）都要说这句话 ——
 * 满窗时底栏被整个盖住，只在底栏说等于「开着满窗就什么都看不到」。两处共用一个 hook，
 * 而不是各写一遍三元表达式：**优先级就是这份行为**，分头写必然漂（一处改了另一处忘）。
 *
 * 优先级：
 *   1. `error` —— 放不出来 / 正在重新获取音源。最要紧的事，压过其他一切；
 *   2. 「正在获取音源…」那几句 —— 请求已经发出、还没出声（见下面的 WAITING_STAGES）；
 *   3. 「正在获取歌曲信息…」—— 正在补齐元数据，且标题/歌手确实还空着。**必须带上后半个条件**：
 *      库里绝大多数歌的信息是齐的，补齐不会为它们发请求，若无条件显示这句话，
 *      每次起播都会白闪一下（见 state/song-metadata）。
 *   4. `null` —— 一切正常，调用方显示歌手名。
 *
 * ★ 第 2 条为什么必须分档：换一个音源可能要后端重新解析、甚至跑到插件里联网找源，
 *   这段时间里界面**什么都不说**，用户只看到一个不动的播放条，分不清「在加载」还是「卡死了」。
 *   说清「在等什么」比省下这一行字重要得多，所以按等待时长逐档说细一点。
 */

import { useEffect, useState } from 'react'

import type { Song } from '@shared/types'
import { filled } from '@shared/metadata'
import { useSongMetadata } from '@/state/song-metadata'
import { usePlayer } from '@/state/usePlayer'

/**
 * 「还没出声」时按等待时长换的几句话。`after` 是「等满这么多毫秒之后改说这一句」。
 *
 * ★ 第一档故意晚 600ms：缓存命中 / 本地文件是毫秒级的事，立刻写一句提示只会变成闪烁。
 * ★ 后面两档是**给慢的看**：音源直链过期要后端重新解析（几秒），插件音源失效还会在后台
 *   跨插件联网找源（预算几十秒）。这两件事都不是用户能加速的，但用户该知道它在做哪一件。
 */
const WAITING_STAGES: { after: number; text: string }[] = [
  { after: 600, text: '正在获取音源…' },
  { after: 3000, text: '音源响应较慢，仍在获取…' },
  { after: 8000, text: '音源暂不可用，正在联网搜索其他音源…' }
]

/**
 * 已经出过声、又卡住了（缓冲）。这时换的是**同一首歌的下一段数据**，与「找音源」是两回事，
 * 所以说法也不一样；同样给它一点延迟，短促的抖动不该在界面上留痕。
 */
const STALL_STAGE = { after: 1500, text: '缓冲中…' }

export function useNowPlayingStatus(song: Song | null, error: string | null): string | null {
  const patching = useSongMetadata(
    (state) => state.patching && (song ? state.patchingSongId === song.id : false)
  )

  /*
   * 「在等音源」= 有加载态、还没开声、而且一点进度都没有。用 currentTime 区分两件事：
   * 前者是「一个字节都还没来」（要从头找源），后者是「播到一半没数据了」（缓冲）。
   * ★ 暂停会把 buffering 一起清掉（见 player-core 的 pause 事件），所以暂停时这里不成立 ——
   *   否则用户自己按了暂停，界面却还在说「正在获取音源」。
   */
  const waiting = usePlayer((state) => state.buffering && !state.playing && state.currentTime === 0)
  const stalled = usePlayer((state) => state.buffering && !state.playing && state.currentTime > 0)

  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    setNotice(null)
    const stages = waiting ? WAITING_STAGES : stalled ? [STALL_STAGE] : []
    const timers = stages.map((stage) =>
      window.setTimeout(() => setNotice(stage.text), stage.after)
    )
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [waiting, stalled, song?.id])

  if (error) return error
  if (notice) return notice
  if (song && patching && (!filled(song.title) || !filled(song.artist))) {
    return '正在获取歌曲信息…'
  }
  return null
}
