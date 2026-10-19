/**
 * 「GitHub 发现」的网络动作。
 *
 * 放在主进程的理由与 release.ts 那一条相同：渲染层不直连第三方，而且主进程这边没有
 * CORS / `User-Agent` 这两个浏览器侧改不动的限制（GitHub API 要求带 UA）。
 *
 * 一次发现 = 1 次搜索 + 每个仓库 2 次读取（清单 + release 资产核对）。所以：
 *   * **逐条校验**（不是拿到搜索结果就直接列出来）—— 列出来的东西点安装必然装得上，
 *     这是这一页唯一的价值；
 *   * 清单按「仓库 + 分支 + 代理 + Token 版本」缓存 1 小时，翻页与搜索重复命中同一批仓库时
 *     不必重拉；
 *   * 匿名访问每小时只有 60 次，一页 20 个仓库就会撞上限 —— 所以限流要单独报出来，
 *     并且**已有的结果不动**（界面上就是「部分结果」）。
 *
 * IPC 契约见 shared/github-discovery.ts；这里只负责发请求与把失败翻译成 reason。
 */

import { app, net } from 'electron'

import {
  applyGithubProxy,
  discoverySearchUrl,
  githubUrlRepository,
  isRepositoryMetadataUrl,
  parseGithubPluginManifest,
  parseReleaseDownload,
  toGithubRepository,
  utf8Size,
  verifyRelease,
  DISCOVERY_MAX_RESULTS,
  DISCOVERY_PAGE_SIZE,
  type DiscoveryFailure,
  type GithubDiscoveryPage,
  type GithubDiscoveryPlugin,
  type GithubDiscoveryRequest,
  type GithubDiscoveryResult,
  type GithubRepository
} from '@shared/github-discovery'

/** 单次请求的上限。GitHub 连不上时默认要等很久，界面会一直停在「正在检查」 */
const TIMEOUT_MS = 15_000
/** 一份 JSON 的上限：搜索页最大，2MB 已经远超正常值（超了只可能是被代理塞了别的东西） */
const MAX_BODY_BYTES = 2 * 1024 * 1024
/** 清单核对结果的缓存时长。GitHub 上插件不是每分钟都在发版 */
const CACHE_TTL_MS = 60 * 60 * 1000
const CACHE_LIMIT = 500
/**
 * 同时核对几个仓库。
 *
 * 3 是「别把 GitHub 打疼」与「一页 20 个不要等一分钟」之间的折中：每个仓库两次串行请求，
 * 3 路并行时一页大约 14 个来回。
 */
const WORKER_LIMIT = 3

class DiscoveryError extends Error {
  constructor(
    readonly reason: DiscoveryFailure,
    readonly retryAt?: number
  ) {
    super(reason)
  }
}

/** 每一条失败原因对应的一句话。界面只展示它，不自己拼文案 */
const FAILURE_TEXT: Record<DiscoveryFailure, string> = {
  invalidManifest: '仓库里的 plugin.json 不符合格式',
  unpublished: '仓库还没有发布可用的插件包',
  invalidRelease: '清单声明的 Release 与仓库里的对不上',
  unavailable: '连不上 GitHub：检查网络或 GitHub 加速代理后重试',
  rateLimited: '已达到 GitHub 请求限额，稍后再试（配置 Token 后每小时可查 5000 次）',
  invalidToken: 'GitHub Token 无效或已过期，请修改或清除'
}

/* ───────────────────────────── 缓存 ───────────────────────────── */

interface CacheEntry {
  until: number
  plugin: GithubDiscoveryPlugin
}

const cache = new Map<string, CacheEntry>()
/**
 * Token 的「版本号」。
 *
 * 它在本模块里只做两件事：换 Token 时把缓存整份作废（同一份清单在不同身份下未必一样），
 * 以及让缓存键不必把 Token 本身拼进去（一个明文凭据不该躺在缓存键里）。
 */
let credential = ''
let credentialRevision = 0

function noteCredential(token: string): number {
  if (token !== credential) {
    credential = token
    credentialRevision += 1
    cache.clear()
  }
  return credentialRevision
}

function remember(key: string, plugin: GithubDiscoveryPlugin): void {
  cache.set(key, { until: Date.now() + CACHE_TTL_MS, plugin })
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest) cache.delete(oldest)
  }
}

/* ───────────────────────────── HTTP ───────────────────────────── */

function record(
  value: unknown,
  failure: DiscoveryFailure = 'unavailable'
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DiscoveryError(failure)
  }
  return value as Record<string, unknown>
}

interface GetOptions {
  proxy: string
  token: string
  /** 解析失败时记成哪种原因（清单是 invalidManifest，其它是 unavailable） */
  invalidData?: DiscoveryFailure
}

/**
 * 带「代理失败则直连」的 GET。
 *
 * 认证请求**不走代理**：前缀式加速代理会把 Authorization 头丢掉（更糟的是转给第三方），
 * 所以带 Token 时只直连，且不允许重定向（凭据不该跟着 302 跑到别的主机上）。
 */
async function getJson(address: string, options: GetOptions): Promise<unknown> {
  const { proxy, token, invalidData = 'unavailable' } = options
  const authenticated = address.startsWith('https://api.github.com/') && token.length > 0
  const target = authenticated ? address : applyGithubProxy(address, proxy)

  const send = async (url: string): Promise<unknown> => {
    let response: Awaited<ReturnType<typeof net.fetch>>
    try {
      response = await net.fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': `songloft-desktop/${app.getVersion()}`,
          ...(authenticated ? { Authorization: `Bearer ${token}` } : {})
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        ...(authenticated ? { redirect: 'error' as const } : {})
      })
    } catch {
      // 连不上（DNS / TLS / 代理 / 超时）一律归为不可达：调用方会看到「检查网络或代理」
      throw new DiscoveryError('unavailable')
    }

    const body = await response.text()
    if (!response.ok) throw statusError(response.status, response.headers, body, authenticated)
    if (utf8Size(body) > MAX_BODY_BYTES) throw new DiscoveryError(invalidData)
    try {
      return JSON.parse(body) as unknown
    } catch {
      throw new DiscoveryError(invalidData)
    }
  }

  try {
    return await send(target)
  } catch (error) {
    // 只有「套了代理」才降级，而且限流不降级：换个路径重试只会再吃一次配额
    if (target === address || (error instanceof DiscoveryError && error.reason === 'rateLimited')) {
      throw error
    }
    return send(address)
  }
}

/**
 * 状态码 → 失败原因。
 *
 * GitHub 的限流有两种写法：新的 `429` + `retry-after`，以及老的 `403` + 剩余配额为 0 /
 * 正文里写着 rate limit。只看状态码会把「Token 权限不足」与「查得太快」混成同一件事 ——
 * 而它们下一步做的事完全不同。
 */
function statusError(
  status: number,
  headers: Headers,
  body: string,
  authenticated: boolean
): DiscoveryError {
  if (status === 401 && authenticated) return new DiscoveryError('invalidToken')
  const remaining = headers.get('x-ratelimit-remaining')
  const retryAfter = Number(headers.get('retry-after'))
  const reset = Number(headers.get('x-ratelimit-reset'))
  const limited =
    status === 429 ||
    (status === 403 && (remaining === '0' || retryAfter > 0 || /rate limit/i.test(body)))
  if (limited) {
    const retryAt =
      retryAfter > 0 ? Date.now() + retryAfter * 1000 : reset > 0 ? reset * 1000 : undefined
    return new DiscoveryError('rateLimited', retryAt)
  }
  if (status === 404) return new DiscoveryError('unpublished')
  return new DiscoveryError('unavailable')
}

/* ───────────────────────────── 校验 ───────────────────────────── */

/**
 * 把一个仓库核对成一条可安装的插件。
 *
 * 走法与上游 Lynx 客户端一致：清单 → （旧式）更新元数据 → release 资产。旧式那一层是给
 * 「plugin.json 里没有 download_url、只留一个 updateUrl」的老插件用的，最多跟两层。
 */
async function verify(input: {
  repository: GithubRepository
  proxy: string
  token: string
  revision: number
  force: boolean
}): Promise<GithubDiscoveryPlugin> {
  const { repository, proxy, token, revision, force } = input
  const key = `${repository.fullName}|${repository.defaultBranch}|${proxy}|${revision}`
  const cached = cache.get(key)
  if (!force && cached && cached.until > Date.now()) {
    return { ...cached.plugin, repository }
  }

  const address = `https://raw.githubusercontent.com/${repository.fullName}/${encodeURIComponent(
    repository.defaultBranch
  )}/plugin.json`
  const visited = new Set([address])
  let manifest
  try {
    manifest = parseGithubPluginManifest(
      await getJson(address, { proxy, token, invalidData: 'invalidManifest' })
    )
  } catch (error) {
    throw error instanceof DiscoveryError ? error : new DiscoveryError('invalidManifest')
  }

  // 只在「清单里没有 download_url」时才用到它（旧式插件的更新元数据地址）
  let metadata: string
  for (let depth = 0; !manifest.download_url && depth < 2; depth += 1) {
    metadata = manifest.updateUrl
    if (!metadata) throw new DiscoveryError('unpublished')
    // 跟着走之前先确认它确实是一份仓库内的清单地址：否则清单可以把客户端指到任意主机
    if (
      visited.has(metadata) ||
      !isRepositoryMetadataUrl(metadata, githubUrlRepository(metadata) ?? '')
    ) {
      throw new DiscoveryError('invalidManifest')
    }
    visited.add(metadata)
    const update = record(
      await getJson(metadata, { proxy, token, invalidData: 'invalidManifest' }),
      'invalidManifest'
    )
    if (
      update.version !== manifest.version ||
      (update.entryPath != null && update.entryPath !== manifest.entryPath)
    ) {
      throw new DiscoveryError('invalidRelease')
    }
    if (typeof update.download_url === 'string' && update.download_url) {
      manifest = { ...manifest, download_url: update.download_url }
    } else if (typeof update.updateUrl === 'string') {
      manifest = { ...manifest, updateUrl: update.updateUrl }
    } else {
      throw new DiscoveryError('unpublished')
    }
  }

  if (!manifest.download_url) throw new DiscoveryError('invalidManifest')
  const download = parseReleaseDownload(manifest.download_url)
  if (!download) throw new DiscoveryError('invalidRelease')

  const release = await getJson(
    `https://api.github.com/repos/${download.repository}/releases/tags/${encodeURIComponent(
      download.tag
    )}`,
    { proxy, token }
  )
  const verified = verifyRelease(release, download, manifest.download_url)
  if (!verified.ok) throw new DiscoveryError(verified.failure)

  const plugin: GithubDiscoveryPlugin = {
    repository,
    manifest,
    downloadUrl: manifest.download_url,
    releaseUrl: `https://github.com/${download.repository}/releases/tag/${encodeURIComponent(
      download.tag
    )}`,
    publishedAt: verified.publishedAt
  }
  remember(key, plugin)
  return plugin
}

/* ───────────────────────────── 入口 ───────────────────────────── */

/**
 * 发现一页。
 *
 * 失败一律以 `{ ok: false, reason }` 回来（跨 IPC 抛异常只剩一句 message，分不清
 * 「Token 过期」与「网络不通」，而这两件事下一步完全不同）。
 */
export async function discoverGithubPlugins(
  request: GithubDiscoveryRequest
): Promise<GithubDiscoveryResult> {
  const token = request.token.trim()
  const revision = noteCredential(token)
  const proxy = request.proxy.trim()

  try {
    const page = await discoverPage({ ...request, token, proxy }, revision)
    return { ok: true, page }
  } catch (error) {
    const failure = error instanceof DiscoveryError ? error : new DiscoveryError('unavailable')
    return {
      ok: false,
      reason: failure.reason,
      message: FAILURE_TEXT[failure.reason],
      retryAt: failure.retryAt
    }
  }
}

async function discoverPage(
  request: GithubDiscoveryRequest,
  revision: number
): Promise<GithubDiscoveryPage> {
  const search = record(
    await getJson(discoverySearchUrl(request), {
      proxy: request.proxy,
      token: request.token
    })
  )
  const total = search.total_count
  if (!Array.isArray(search.items) || typeof total !== 'number') {
    throw new DiscoveryError('unavailable')
  }

  const repositories = search.items
    .map(toGithubRepository)
    .filter((repo): repo is GithubRepository => repo !== null)

  const plugins: Array<GithubDiscoveryPlugin | undefined> = new Array(repositories.length)
  const failures: Partial<Record<DiscoveryFailure, number>> = {}
  let cursor = 0
  let checked = 0
  /** 因为限流 / Token 失效而停下来（两者都不该继续烧配额） */
  let stopped = false
  let retryAt: number | undefined
  let fatal: DiscoveryError | null = null

  const workers = Array.from({ length: Math.min(WORKER_LIMIT, repositories.length) }, async () => {
    while (cursor < repositories.length && !stopped) {
      const index = cursor
      cursor += 1
      const repository = repositories[index]!
      try {
        plugins[index] = await verify({
          repository,
          proxy: request.proxy,
          token: request.token,
          revision,
          force: request.force
        })
      } catch (error) {
        const failure = error instanceof DiscoveryError ? error : new DiscoveryError('unavailable')
        failures[failure.reason] = (failures[failure.reason] ?? 0) + 1
        if (failure.reason === 'invalidToken') {
          fatal = failure
          stopped = true
        } else if (failure.reason === 'rateLimited') {
          stopped = true
          retryAt = failure.retryAt
        }
      }
      checked += 1
    }
  })
  await Promise.all(workers)

  if (fatal) throw fatal

  const page: GithubDiscoveryPage = {
    plugins: plugins.filter((plugin): plugin is GithubDiscoveryPlugin => plugin != null),
    checked,
    failures,
    retryAt,
    // 被限流时不再往下翻：下一页只会再撞一次限流，界面上也会多出一页空结果
    nextPage:
      !stopped && request.page * DISCOVERY_PAGE_SIZE < Math.min(DISCOVERY_MAX_RESULTS, total)
        ? request.page + 1
        : undefined,
    incomplete: stopped || search.incomplete_results === true,
    total
  }
  return page
}
