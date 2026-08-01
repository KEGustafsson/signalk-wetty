import type { IncomingMessage, ServerResponse } from 'node:http'

type HeaderValue = number | string | string[]

export interface PatchableHttpServer {
  prependListener?: (
    event: 'request',
    handler: (req: IncomingMessage, res: ServerResponse) => void
  ) => void
}

const directiveMatches = (directive: string, name: string): boolean =>
  new RegExp(`^${name}(\\s|$)`, 'i').test(directive)

/**
 * Removes the named directives from a CSP header value, leaving every other
 * directive untouched.
 */
export const stripCspDirectives = (csp: string, names: string[]): string =>
  csp
    .split(';')
    .map((directive) => directive.trim())
    .filter(
      (directive) =>
        directive.length > 0 &&
        !names.some((name) => directiveMatches(directive, name))
    )
    .join('; ')

/**
 * Helmet, which WeTTY uses internally, always adds a couple of CSP
 * directives that do not fit every deployment:
 *
 * - `frame-ancestors 'self'` blocks the Signal K admin UI from embedding the
 *   terminal whenever it runs on a different port than the server (the
 *   normal case, since the two cannot share a port). WeTTY's own
 *   `allowIframe` option does not help here — it only clears
 *   X-Frame-Options.
 * - `upgrade-insecure-requests` is sent unconditionally, including when
 *   WeTTY has no TLS certificate configured. A browser that honours it will
 *   upgrade a later same-page request to HTTPS against a server that only
 *   speaks plain HTTP, which fails outright rather than falling back.
 *
 * Both are patched here, ahead of WeTTY's own request handling (helmet
 * included), rather than left to WeTTY to expose a way to configure them.
 */
export const installCspPatch = (
  server: PatchableHttpServer,
  directivesToStrip: string[]
): void => {
  if (directivesToStrip.length === 0) {
    return
  }
  server.prependListener?.('request', (_req, res) => {
    const originalSetHeader = res.setHeader.bind(res)
    res.setHeader = ((name: string, value: HeaderValue) => {
      if (
        typeof value === 'string' &&
        /^content-security-policy$/i.test(name)
      ) {
        const stripped = stripCspDirectives(value, directivesToStrip)
        if (stripped) {
          return originalSetHeader(name, stripped)
        }
        return res
      }
      return originalSetHeader(name, value)
    }) as typeof res.setHeader
  })
}
