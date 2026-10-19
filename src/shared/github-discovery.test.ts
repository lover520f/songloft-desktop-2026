import { describe, expect, it } from 'vitest'

import {
  applyGithubProxy,
  comparePluginVersions,
  discoveryInstallState,
  discoveryRowKey,
  discoverySearchQuery,
  discoverySearchUrl,
  githubUrlRepository,
  hostCompatibility,
  isRepositoryMetadataUrl,
  parseGithubPluginManifest,
  parseReleaseDownload,
  toGithubRepository,
  verifyRelease,
  type GithubDiscoveryPlugin,
  type GithubPluginManifest
} from './github-discovery'
import type { JSPlugin } from './plugin'

/**
 * 这批用例锁的是「发现」的两块判定，都是**看起来怎么写都对**的那一类纯函数：
 *   1. 仓库/清单/release 的校验 —— 松一格就会把连不上或没发布的东西列进商店，
 *      而症状（点安装才失败）出现在离这里很远的地方；
 *   2. 卡片该显示哪个按钮 —— 判错的后果是「明明装着却提示覆盖安装」，用户会以为
 *      自己点坏了什么。
 */

const REPO = {
  id: 42,
  fullName: 'someone/songloft-plugin-radio',
  defaultBranch: 'main',
  stars: 7,
  updatedAt: '2026-10-01T00:00:00Z'
}

function manifest(extra: Partial<GithubPluginManifest> = {}): GithubPluginManifest {
  return {
    name: '电台时光机',
    version: '1.2.3',
    entryPath: 'radio-time',
    main: 'main.js',
    permissions: ['network'],
    entryHash: '',
    zipHash: '',
    description: '',
    author: 'someone',
    homepage: '',
    minHostVersion: '',
    renderEngine: '',
    download_url: '',
    updateUrl: '',
    ...extra
  }
}

function discovery(extra: Partial<GithubDiscoveryPlugin> = {}): GithubDiscoveryPlugin {
  return {
    repository: REPO,
    manifest: manifest(),
    downloadUrl:
      'https://github.com/someone/songloft-plugin-radio/releases/download/v1.2.3/radio-time.jsplugin.zip',
    releaseUrl: 'https://github.com/someone/songloft-plugin-radio/releases/tag/v1.2.3',
    publishedAt: '2026-10-01T00:00:00Z',
    ...extra
  }
}

function installed(extra: Partial<JSPlugin> = {}): JSPlugin {
  return {
    id: 1,
    name: '电台时光机',
    version: '1.0.0',
    description: '',
    author: 'someone',
    homepage: '',
    license: '',
    entryPath: 'radio-time',
    main: 'main.js',
    minHostVersion: '',
    permissions: [],
    icon: '',
    updateUrl: '',
    downloadUrl: '',
    renderEngine: '',
    status: 'active',
    filePath: '',
    createdAt: '',
    updatedAt: '',
    ...extra
  }
}

describe('parseGithubPluginManifest', () => {
  it('补齐可选字段，并保留线格式里的 snake_case', () => {
    const parsed = parseGithubPluginManifest({
      name: '电台时光机',
      version: '1.0.0',
      entryPath: 'radio-time',
      main: 'main.js',
      permissions: ['network'],
      download_url: 'https://github.com/a/b/releases/download/v1/x.jsplugin.zip',
      updateUrl: 'https://raw.githubusercontent.com/a/b/main/update.json'
    })
    expect(parsed.entryHash).toBe('')
    expect(parsed.renderEngine).toBe('')
    expect(parsed.download_url).toContain('.jsplugin.zip')
    expect(parsed.updateUrl).toContain('/main/update.json')
  })

  it('拒绝越界的 main、非法版本、非法 entryPath 与坏 hash', () => {
    const base = {
      name: '插件名',
      version: '1.0.0',
      entryPath: 'ok',
      main: 'main.js',
      permissions: []
    }
    expect(() => parseGithubPluginManifest({ ...base, main: '../evil.js' })).toThrow()
    expect(() => parseGithubPluginManifest({ ...base, main: 'main.css' })).toThrow()
    expect(() => parseGithubPluginManifest({ ...base, version: 'v1.0.0' })).toThrow()
    expect(() => parseGithubPluginManifest({ ...base, entryPath: 'Radio Time' })).toThrow()
    expect(() => parseGithubPluginManifest({ ...base, zipHash: 'abc' })).toThrow()
    expect(() => parseGithubPluginManifest({ ...base, permissions: 'network' })).toThrow()
    expect(() => parseGithubPluginManifest(null)).toThrow()
  })

  it('名字按 UTF-8 字节限 2..50', () => {
    const base = { version: '1.0.0', entryPath: 'ok', main: 'main.js', permissions: [] }
    expect(() => parseGithubPluginManifest({ ...base, name: 'a' })).toThrow()
    expect(() => parseGithubPluginManifest({ ...base, name: '一'.repeat(17) })).toThrow()
    expect(parseGithubPluginManifest({ ...base, name: '一'.repeat(16) }).name).toHaveLength(16)
  })
})

describe('搜索', () => {
  it('关键词里的 GitHub 限定符标点会被剔掉，owner/repo 保留', () => {
    expect(discoverySearchQuery('')).toBe('topic:songloft-plugin archived:false fork:false')
    expect(discoverySearchQuery('owner/repo')).toContain('owner/repo in:name,description,readme')
    // 冒号属于 GitHub 的限定符语法，会被剔掉（于是 `user:evil` 只剩一个普通关键词）
    expect(discoverySearchQuery('user:evil')).toBe(
      'topic:songloft-plugin archived:false fork:false userevil in:name,description,readme'
    )
    expect(discoverySearchQuery('电台')).toContain('电台 in:name,description,readme')
  })

  it('搜索地址带上排序与翻页', () => {
    const url = discoverySearchUrl({ page: 2, search: '', sort: 'stars' })
    expect(url).toContain('sort=stars')
    expect(url).toContain('page=2')
    expect(url).toContain('per_page=20')
  })
})

describe('URL 解析', () => {
  it('只认 https 的 github 域名', () => {
    expect(githubUrlRepository('https://github.com/a/b/releases/tag/v1')).toBe('a/b')
    expect(githubUrlRepository('http://github.com/a/b')).toBeNull()
    expect(githubUrlRepository('https://evil.example/a/b')).toBeNull()
    expect(githubUrlRepository('https://github.com/a/%2e%2e/c')).toBeNull()
  })

  it('清单地址必须属于这个仓库自己', () => {
    expect(
      isRepositoryMetadataUrl('https://raw.githubusercontent.com/a/b/main/plugin.json', 'a/b')
    ).toBe(true)
    expect(isRepositoryMetadataUrl('https://github.com/a/b/raw/main/plugin.json', 'a/b')).toBe(true)
    expect(
      isRepositoryMetadataUrl('https://raw.githubusercontent.com/c/d/main/plugin.json', 'a/b')
    ).toBe(false)
    expect(
      isRepositoryMetadataUrl('https://raw.githubusercontent.com/a/b/main/x.json', 'a/b')
    ).toBe(true)
  })

  it('release 下载地址只认 .jsplugin.zip', () => {
    expect(
      parseReleaseDownload('https://github.com/a/b/releases/download/v1.0.0/p.jsplugin.zip')
    ).toEqual({ repository: 'a/b', tag: 'v1.0.0', file: 'p.jsplugin.zip' })
    expect(
      parseReleaseDownload('https://github.com/a/b/releases/download/v1.0.0/source.tar.gz')
    ).toBeNull()
    expect(parseReleaseDownload('https://github.com/a/b/releases/tag/v1.0.0')).toBeNull()
  })
})

describe('版本', () => {
  it('插件版本允许第四段', () => {
    expect(comparePluginVersions('1.2.3', '1.2.4')).toBe(-1)
    expect(comparePluginVersions('1.2.3.1', '1.2.3')).toBe(1)
    expect(comparePluginVersions('1.2.3.5', '1.2.3.4')).toBe(1)
    expect(comparePluginVersions('v1.2.3', '1.2.3')).toBe(0)
    expect(comparePluginVersions('dev', '1.0.0')).toBeNull()
  })

  it('服务器版本不够时判不兼容；拿不到版本时不拦', () => {
    expect(hostCompatibility('1.2.0', '1.1.9')).toBe('incompatible')
    expect(hostCompatibility('1.2.0', '1.2.0')).toBe('compatible')
    expect(hostCompatibility('1.2.0', '')).toBe('unknown')
    expect(hostCompatibility('', '1.0.0')).toBe('compatible')
    expect(hostCompatibility('1.2.0', 'dev')).toBe('compatible')
    expect(hostCompatibility('1.2.0', 'mock-2026.10.12')).toBe('unknown')
  })
})

describe('已装状态', () => {
  it('没装过 → 安装', () => {
    expect(
      discoveryInstallState({
        plugin: discovery(),
        installed: [],
        hostVersion: '1.0.0',
        session: {}
      }).action
    ).toBe('install')
  })

  it('updateUrl 指回同一个仓库 → 同源，且能判出可更新 / 已最新', () => {
    const occupant = installed({
      updateUrl: 'https://raw.githubusercontent.com/someone/songloft-plugin-radio/main/plugin.json'
    })
    expect(
      discoveryInstallState({
        plugin: discovery(),
        installed: [occupant],
        hostVersion: '1.0.0',
        session: {}
      }).action
    ).toBe('update')
    expect(
      discoveryInstallState({
        plugin: discovery({ manifest: manifest({ version: '1.0.0' }) }),
        installed: [occupant],
        hostVersion: '1.0.0',
        session: {}
      }).action
    ).toBe('reinstall')
  })

  it('同一个 entryPath 但认不出来源 → 覆盖安装', () => {
    const state = discoveryInstallState({
      plugin: discovery(),
      installed: [installed({ author: '另一个作者' })],
      hostVersion: '1.0.0',
      session: {}
    })
    expect(state.action).toBe('overwrite')
    expect(state.occupant?.author).toBe('另一个作者')
  })

  it('本次会话装过的算同源（插件包里的清单往往没有下载地址）', () => {
    const state = discoveryInstallState({
      plugin: discovery(),
      installed: [installed({ version: '1.2.3' })],
      hostVersion: '1.0.0',
      session: { 'radio-time': { repositoryId: REPO.id, version: '1.2.3' } }
    })
    expect(state.action).toBe('reinstall')
    expect(state.installedVersion).toBe('1.2.3')
  })

  it('服务器版本不够 → 拦住（优先于撞名）', () => {
    const state = discoveryInstallState({
      plugin: discovery({ manifest: manifest({ minHostVersion: '2.0.0' }) }),
      installed: [installed({ author: '另一个作者' })],
      hostVersion: '1.9.0',
      session: {}
    })
    expect(state.action).toBe('blocked')
    expect(state.incompatible).toBe(true)
  })

  it('行 key 带上仓库，避免两个仓库的同名插件互相顶掉', () => {
    const other = discovery({ repository: { ...REPO, id: 7 } })
    expect(discoveryRowKey(discovery())).not.toBe(discoveryRowKey(other))
  })
})

describe('release 校验', () => {
  const download = { tag: 'v1.2.3', file: 'radio-time.jsplugin.zip' }
  const url =
    'https://github.com/someone/songloft-plugin-radio/releases/download/v1.2.3/radio-time.jsplugin.zip'

  function release(extra: Record<string, unknown> = {}): unknown {
    return {
      tag_name: 'v1.2.3',
      published_at: '2026-10-01T00:00:00Z',
      draft: false,
      prerelease: false,
      assets: [
        {
          name: 'radio-time.jsplugin.zip',
          browser_download_url: url,
          size: 1024,
          state: 'uploaded'
        }
      ],
      ...extra
    }
  }

  it('资产确实挂着 → 通过', () => {
    expect(verifyRelease(release(), download, url)).toEqual({
      ok: true,
      publishedAt: '2026-10-01T00:00:00Z'
    })
  })

  it('草稿 / 预发布 / tag 对不上 → invalidRelease', () => {
    expect(verifyRelease(release({ draft: true }), download, url)).toEqual({
      ok: false,
      failure: 'invalidRelease'
    })
    expect(verifyRelease(release({ prerelease: true }), download, url)).toEqual({
      ok: false,
      failure: 'invalidRelease'
    })
    expect(verifyRelease(release({ tag_name: 'v9.9.9' }), download, url)).toEqual({
      ok: false,
      failure: 'invalidRelease'
    })
    expect(verifyRelease({ nope: true }, download, url)).toEqual({
      ok: false,
      failure: 'invalidRelease'
    })
  })

  it('资产不在 / 地址不同 / 大小为 0 → unpublished', () => {
    expect(verifyRelease(release({ assets: [] }), download, url)).toEqual({
      ok: false,
      failure: 'unpublished'
    })
    const other = 'https://github.com/other/repo/releases/download/v1/x.jsplugin.zip'
    expect(verifyRelease(release(), download, other)).toEqual({
      ok: false,
      failure: 'unpublished'
    })
    expect(
      verifyRelease(
        release({
          assets: [{ name: download.file, browser_download_url: url, size: 0, state: 'uploaded' }]
        }),
        download,
        url
      )
    ).toEqual({ ok: false, failure: 'unpublished' })
  })
})

describe('仓库过滤', () => {
  const base = {
    id: 1,
    full_name: 'a/b',
    default_branch: 'main',
    archived: false,
    fork: false,
    private: false,
    topics: ['songloft-plugin'],
    stargazers_count: 3,
    updated_at: '2026-10-01T00:00:00Z'
  }

  it('认得出正常仓库', () => {
    expect(toGithubRepository(base)).toEqual({
      id: 1,
      fullName: 'a/b',
      defaultBranch: 'main',
      stars: 3,
      updatedAt: '2026-10-01T00:00:00Z'
    })
  })

  it('归档 / fork / 私有 / 缺 topic 的都丢掉', () => {
    expect(toGithubRepository({ ...base, archived: true })).toBeNull()
    expect(toGithubRepository({ ...base, fork: true })).toBeNull()
    expect(toGithubRepository({ ...base, private: true })).toBeNull()
    expect(toGithubRepository({ ...base, topics: ['other'] })).toBeNull()
    expect(toGithubRepository({ ...base, default_branch: '' })).toBeNull()
    expect(toGithubRepository({ ...base, full_name: 'no-slash' })).toBeNull()
    expect(toGithubRepository(null)).toBeNull()
  })
})

describe('applyGithubProxy', () => {
  it('只在 GitHub 域名上套前缀，并把结尾的斜杠补齐', () => {
    expect(
      applyGithubProxy(
        'https://raw.githubusercontent.com/a/b/main/plugin.json',
        'https://ghfast.top'
      )
    ).toBe('https://ghfast.top/https://raw.githubusercontent.com/a/b/main/plugin.json')
    expect(
      applyGithubProxy('https://api.github.com/search/repositories', 'https://ghfast.top/')
    ).toBe('https://ghfast.top/https://api.github.com/search/repositories')
  })

  it('空代理、不像前缀的写法、非 GitHub 地址一律原样返回', () => {
    const url = 'https://raw.githubusercontent.com/a/b/main/plugin.json'
    expect(applyGithubProxy(url, '')).toBe(url)
    expect(applyGithubProxy(url, 'http://192.168.1.1:7890')).toBe(
      'http://192.168.1.1:7890/https://raw.githubusercontent.com/a/b/main/plugin.json'
    )
    expect(applyGithubProxy(url, 'not a url')).toBe(url)
    expect(applyGithubProxy('https://example.com/x.json', 'https://ghfast.top/')).toBe(
      'https://example.com/x.json'
    )
  })
})
