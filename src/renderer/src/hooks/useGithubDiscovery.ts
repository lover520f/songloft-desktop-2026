/**
 * 插件商店里「GitHub 发现」那一份来源的数据。
 *
 * 三件事都收在这里，界面只管画：
 *   1. **凭据**：Token 与 GitHub 代理都存在服务端（Token 是凭据、代理是前缀，两者互斥）。
 *      进页面先读一次 —— Token 决定「每小时 60 次」还是「5000 次」，也决定请求是否绕过代理；
 *   2. **翻页**：搜索 / 排序 / 刷新都会回到第 1 页，滚到底续下一页；被限流时不再往下翻；
 *   3. **失败**：主进程回的是 `{ ok: false, reason }`，这里原样留着 —— 界面按 reason 分派文案
 *      （Token 过期要人去改，限流等一会儿，网络问题去查代理）。
 *
 * ★ 为什么不在渲染层直接发请求：GitHub API 要 `User-Agent`（浏览器侧改不了的 forbidden
 *   header），而且一页要逐仓库核对清单与 release，几十个请求该由主进程那份缓存兜着。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  DiscoveryFailure,
  GithubDiscoveryPlugin,
  GithubDiscoveryResult
} from '@shared/github-discovery'
import { getGithubDiscoveryToken, getGithubProxy, setGithubDiscoveryToken } from '@/api/endpoints'
import { useAuth } from '@/state/useAuth'

export interface GithubDiscoveryError {
  reason: DiscoveryFailure
  message: string
  retryAt?: number
}

export interface GithubDiscovery {
  plugins: GithubDiscoveryPlugin[]
  /** 这一页看了几个仓库（含被过滤的），供「已检查 N 个仓库」 */
  checked: number
  failures: Partial<Record<DiscoveryFailure, number>>
  /** GitHub 报的匹配总数（最多只到 1000） */
  total: number
  /** 结果不完整（翻到 1000 条上限，或中途被限流） */
  incomplete: boolean
  /** 被限流时可以再试的时间 */
  retryAt?: number

  loading: boolean
  loadingMore: boolean
  error: GithubDiscoveryError | null

  hasMore: boolean
  loadMore: () => void
  /** 重新读 Token / 代理，再从第 1 页强制重拉（服务端那份 5 分钟缓存不是这里的事） */
  refresh: () => void

  /** 服务器上保存的 Token（空串 = 匿名） */
  token: string
  credentialLoading: boolean
  /** Token / 代理读失败的原因（不影响匿名发现，只是少了一份凭据） */
  credentialError: string | null
  saveToken: (token: string) => Promise<void>
}

interface Credential {
  token: string
  proxy: string
}

export function useGithubDiscovery(input: {
  /** 当前是不是选中了「GitHub 发现」这一份来源 —— 没选中时一个请求都不发 */
  active: boolean
  /** 已经防抖过的关键词（与订阅源那一份共用搜索框） */
  keyword: string
  sort: 'updated' | 'stars'
}): GithubDiscovery {
  const { active, keyword, sort } = input
  const client = useAuth((state) => state.client)

  const [credential, setCredential] = useState<Credential | null>(null)
  const [credentialLoading, setCredentialLoading] = useState(false)
  const [credentialError, setCredentialError] = useState<string | null>(null)
  /** 让人为地重读一次凭据（刷新按钮 / 切回发现页） */
  const [credentialNonce, setCredentialNonce] = useState(0)

  const [plugins, setPlugins] = useState<GithubDiscoveryPlugin[]>([])
  const [checked, setChecked] = useState(0)
  const [failures, setFailures] = useState<Partial<Record<DiscoveryFailure, number>>>({})
  const [total, setTotal] = useState(0)
  const [nextPage, setNextPage] = useState<number | undefined>(undefined)
  const [incomplete, setIncomplete] = useState(false)
  const [retryAt, setRetryAt] = useState<number | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<GithubDiscoveryError | null>(null)
  const [nonce, setNonce] = useState(0)

  /** 在途请求的序号：只认最新那一次（搜索词改得快时，后面的响应编号更大） */
  const generation = useRef(0)
  /** 只有点「刷新」这一次要越过主进程的清单缓存 */
  const forceRef = useRef(false)

  // ── 凭据 ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!active || !client) return
    let cancelled = false
    setCredentialLoading(true)
    setCredentialError(null)
    // 先清掉旧凭据：否则下面那次发现会先用旧 Token 发一遍，等新 Token 回来再发一遍
    setCredential(null)
    void Promise.all([
      getGithubDiscoveryToken(client),
      // 代理读不到照样能发现（直连）：它不是这一页的前置条件
      getGithubProxy(client).catch(() => '')
    ])
      .then(([token, proxy]) => {
        if (cancelled) return
        setCredential({ token, proxy })
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        setCredentialError(reason instanceof Error ? reason.message : '读取 GitHub Token 失败')
        // 读不到 Token 不必卡住整个发现：匿名也能查，只是配额少得多
        setCredential({ token: '', proxy: '' })
      })
      .finally(() => {
        if (!cancelled) setCredentialLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [active, client, credentialNonce])

  const applyPage = useCallback((result: GithubDiscoveryResult, append: boolean): void => {
    if (!result.ok) return
    const { plugins: pagePlugins, ...rest } = result.page
    setPlugins((previous) => (append ? [...previous, ...pagePlugins] : pagePlugins))
    setChecked((previous) => (append ? previous + rest.checked : rest.checked))
    setFailures((previous) => {
      if (!append) return rest.failures
      const merged = { ...previous }
      for (const [reason, count] of Object.entries(rest.failures)) {
        const key = reason as DiscoveryFailure
        merged[key] = (merged[key] ?? 0) + (count ?? 0)
      }
      return merged
    })
    setTotal(rest.total)
    setNextPage(rest.nextPage)
    setIncomplete(rest.incomplete)
    setRetryAt(rest.retryAt)
    setError(null)
  }, [])

  const report = useCallback((result: GithubDiscoveryResult): void => {
    if (result.ok) return
    // 限流与 Token 失效都要把时间带出来：一句「失败了，稍后再试」等于没说
    setError({ reason: result.reason, message: result.message, retryAt: result.retryAt })
    if (result.retryAt) setRetryAt(result.retryAt)
  }, [])

  // ── 第 1 页（搜索词 / 排序 / 刷新 / 凭据变化都会回到这里）─────────────
  useEffect(() => {
    // 序号先加：凭据被清空 / 切走这一页时也要把在途请求作废（否则它回来会盖住新一轮的空列表）
    const current = ++generation.current
    if (!active || !credential) return
    const force = forceRef.current
    forceRef.current = false
    setLoading(true)
    // 上一轮可能正卡在续页上；它已经被作废，那个「续页中」的闸必须松开，否则再也翻不动
    setLoadingMore(false)
    // 换了一轮搜索：先把上一轮清掉。留着的话「查不到」会被旧结果盖住，
    // 而旧结果与新关键词毫无关系 —— 比空着更误导
    setPlugins([])
    setChecked(0)
    setFailures({})
    setTotal(0)
    setNextPage(undefined)
    setIncomplete(false)
    setRetryAt(undefined)
    setError(null)

    void window.songloft.github
      .discover({
        page: 1,
        search: keyword,
        sort,
        proxy: credential.proxy,
        token: credential.token,
        force
      })
      .then((result) => {
        if (current !== generation.current) return
        report(result)
        applyPage(result, false)
      })
      .catch((reason: unknown) => {
        if (current !== generation.current) return
        setError({
          reason: 'unavailable',
          message: reason instanceof Error ? reason.message : '加载 GitHub 发现失败'
        })
      })
      .finally(() => {
        if (current === generation.current) setLoading(false)
      })
  }, [active, credential, keyword, sort, nonce, report, applyPage])

  // ── 续页 ────────────────────────────────────────────────────────────────
  const loadMore = useCallback((): void => {
    if (!credential || loading || loadingMore || !nextPage) return
    const current = generation.current
    setLoadingMore(true)
    void window.songloft.github
      .discover({
        page: nextPage,
        search: keyword,
        sort,
        proxy: credential.proxy,
        token: credential.token,
        force: false
      })
      .then((result) => {
        if (current !== generation.current) return
        report(result)
        applyPage(result, true)
      })
      .catch((reason: unknown) => {
        if (current !== generation.current) return
        setError({
          reason: 'unavailable',
          message: reason instanceof Error ? reason.message : '加载 GitHub 发现失败'
        })
      })
      .finally(() => {
        if (current === generation.current) setLoadingMore(false)
      })
  }, [applyPage, credential, keyword, loading, loadingMore, nextPage, report, sort])

  const refresh = useCallback((): void => {
    forceRef.current = true
    setCredentialNonce((value) => value + 1)
    setNonce((value) => value + 1)
  }, [])

  const saveToken = useCallback(
    async (next: string): Promise<void> => {
      if (!client) return
      const saved = await setGithubDiscoveryToken(client, next)
      // 只换 Token、不重读代理：代理那一半没变，再读一次只会慢一拍
      setCredential((previous) => ({ token: saved, proxy: previous?.proxy ?? '' }))
    },
    [client]
  )

  return {
    plugins,
    checked,
    failures,
    total,
    incomplete,
    retryAt,
    /**
     * ★ 把「读凭据」也算进 loading：切过来的第一帧凭据还没读回来，若这里报 false，
     *   界面会先闪一下「没有发现可用的社区扩展」，再变成骨架屏。
     */
    loading: loading || credentialLoading,
    loadingMore,
    error,
    hasMore: nextPage != null,
    loadMore,
    refresh,
    token: credential?.token ?? '',
    credentialLoading,
    credentialError,
    saveToken
  }
}
