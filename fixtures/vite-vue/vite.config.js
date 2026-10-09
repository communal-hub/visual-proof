import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const vpDir = path.join(root, '.visual-proof')
const markerFile = path.join(vpDir, 'hot')
const tokenFile = path.join(vpDir, 'token')
const dataFile = path.join(root, 'server', 'data.json')

const readData = () => JSON.parse(fs.readFileSync(dataFile, 'utf8'))

function send(res, status, body, headers = {}) {
  if (body === undefined) {
    res.writeHead(status, headers)
    return res.end()
  }
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'))
      } catch {
        resolve({})
      }
    })
  })
}

// Two fixture users: the default admin and a finance user, the only one who sees the role-gated element.
const USERS = {
  'admin@example.test': { role: 'admin' },
  'finance@example.test': { role: 'finance' },
}

function sessionEmail(req) {
  const match = /(?:^|;\s*)vp_session=([^;]+)/.exec(req.headers.cookie || '')
  return match ? decodeURIComponent(match[1]) : null
}

// Dev-only "backend" + visual-proof test hooks.
function fixtureBackend() {
  return {
    name: 'fixture-backend',
    apply: 'serve',
    configureServer(server) {
      fs.mkdirSync(vpDir, { recursive: true })
      if (!fs.existsSync(tokenFile)) {
        fs.writeFileSync(tokenFile, randomBytes(24).toString('hex') + '\n')
      }

      const removeMarker = () => fs.rmSync(markerFile, { force: true })
      server.httpServer?.once('listening', () => {
        const url = server.resolvedUrls?.local?.[0] ?? ''
        fs.writeFileSync(markerFile, url.replace(/\/$/, '') + '\n')
      })
      server.httpServer?.once('close', removeMarker)
      process.once('exit', removeMarker)

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, 'http://localhost')
        const { pathname } = url

        if (req.method === 'GET' && pathname === '/api/flags') {
          return send(res, 200, readData().flags ?? {})
        }
        if (req.method === 'GET' && pathname === '/api/invoices') {
          return send(res, 200, readData().invoices)
        }
        // v0.8 discovery fixtures: a list that navigates by click handler (projects) and a nested list (clubs -> teams).
        if (req.method === 'GET' && pathname === '/api/projects') {
          return send(res, 200, readData().projects ?? [])
        }
        const project = /^\/api\/projects\/([^/]+)$/.exec(pathname)
        if (req.method === 'GET' && project) {
          const found = (readData().projects ?? []).find((p) => String(p.id) === project[1])
          return found ? send(res, 200, found) : send(res, 404, { error: 'not found' })
        }
        if (req.method === 'GET' && pathname === '/api/clubs') {
          return send(res, 200, (readData().clubs ?? []).map(({ teams, ...club }) => club))
        }
        const teams = /^\/api\/clubs\/([^/]+)\/teams(?:\/([^/]+))?$/.exec(pathname)
        if (req.method === 'GET' && teams) {
          const club = (readData().clubs ?? []).find((c) => String(c.id) === teams[1])
          if (!club) return send(res, 404, { error: 'not found' })
          if (!teams[2]) return send(res, 200, club.teams)
          const team = club.teams.find((t) => String(t.id) === teams[2])
          return team ? send(res, 200, { ...team, club: club.name }) : send(res, 404, { error: 'not found' })
        }
        const one = /^\/api\/invoices\/([^/]+)$/.exec(pathname)
        if (req.method === 'GET' && one) {
          const invoice = readData().invoices.find((i) => String(i.id) === one[1])
          return invoice ? send(res, 200, invoice) : send(res, 404, { error: 'not found' })
        }

        if (req.method === 'POST' && pathname === '/__playwright__/login') {
          const expected = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : null
          const given = req.headers['x-visual-proof-token']
          if (!expected || given !== expected) return send(res, 403, { error: 'forbidden' })
          const { email } = await readBody(req)
          if (!email) return send(res, 422, { error: 'email required' })
          if (!USERS[email]) return send(res, 403, { error: 'unknown user' })
          return send(res, 204, undefined, {
            'set-cookie': `vp_session=${email}; Path=/; HttpOnly; SameSite=Lax`,
          })
        }

        if (req.method === 'GET' && pathname === '/api/me') {
          const email = sessionEmail(req)
          return email ? send(res, 200, { email, role: USERS[email]?.role ?? 'unknown' }) : send(res, 401, { error: 'unauthenticated' })
        }

        next()
      })
    },
  }
}

export default defineConfig({
  // Tests that measure a cold start give each dev server its own dependency cache.
  cacheDir: process.env.VP_FIXTURE_CACHE_DIR || undefined,
  plugins: [vue(), fixtureBackend()],
  resolve: { alias: { '@': path.join(root, 'src') } },
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: false,
  },
})
