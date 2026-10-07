/** Remove a single trailing slash, keeping the root path `/` intact. */
export function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}
