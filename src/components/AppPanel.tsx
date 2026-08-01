import React from 'react'

/**
 * The component Signal K's admin UI loads via Module Federation and mounts
 * inline at /admin/#/e/signalk-wetty (see webpack.config.js). It stays this
 * thin deliberately: the actual terminal UI — status polling, the SSH
 * warning panel, the node-pty rebuild button, the terminal itself — already
 * lives in public/index.html, tested independently in test/webapp.test.js,
 * and works whether reached this way or as a direct page. Framing it here
 * avoids maintaining the same logic twice in two different UI toolkits.
 */

// Height in pixels of the Signal K admin UI's own top navigation bar; the
// panel fills the remaining viewport height below it.
const ADMIN_HEADER_HEIGHT = 64

const AppPanel: React.FC = () => (
  <iframe
    src="/signalk-wetty/"
    title="WeTTY Terminal"
    style={{
      width: '100%',
      height: `calc(100vh - ${ADMIN_HEADER_HEIGHT}px)`,
      border: 0
    }}
    allow="clipboard-read; clipboard-write"
  />
)

export default AppPanel
