import { useMDXComponents as getDocsMDXComponents } from 'nextra-theme-docs'

export const useMDXComponents: typeof getDocsMDXComponents = components => ({
  ...getDocsMDXComponents(components)
})
