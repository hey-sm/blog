import nextra from 'nextra'

const withNextra = nextra({
  search: {
    codeblocks: false
  }
})

export default withNextra({
  reactStrictMode: true,
  devIndicators: false,
  experimental: {
    // 让 next build 把 Turbopack 编译缓存落盘到 .next/cache，
    // 内容大多不变时复用缓存，二次构建大幅提速（默认 false）
    turbopackFileSystemCacheForBuild: true
  }
})
