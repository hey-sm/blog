import { Footer, Layout, Navbar } from 'nextra-theme-docs'
import { getPageMap } from 'nextra/page-map'
import 'nextra-theme-docs/style.css'
import './globals.css'

export const metadata = {
  title: {
    default: 'fluxp blog',
    template: '%s | fluxp blog'
  },
  description: '基于 Nextra 搭建的文档知识库'
}


const navbar = (
  <Navbar
    logo={
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
        <img src="/icon.svg" alt="fluxp" width={24} height={24} />
        <b>fluxp</b>
      </span>
    }
  />
)


export default async function RootLayout({
  children
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="zh-CN" dir="ltr" suppressHydrationWarning>
      <body>
        <Layout
          navbar={navbar}
          pageMap={await getPageMap()}
          docsRepositoryBase="https://github.com/hey-sm/blog/tree/main/content"
          sidebar={{ defaultMenuCollapseLevel: 1 }}
          editLink={null}
          feedback={{ content: null }}
        >
          {children}
        </Layout>
      </body>
    </html>
  )
}
