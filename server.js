'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '127.0.0.1';
const SECRET = process.env.SESSION_SECRET;

if (!SECRET) {
  console.error('Falta SESSION_SECRET en el entorno. Abortando.');
  process.exit(1);
}

const CONFIG_DIR = path.join(__dirname, 'config');
const SYSTEMS_FILE = path.join(CONFIG_DIR, 'systems.json');
const USERS_FILE = path.join(CONFIG_DIR, 'users.json');

const COOKIE = 'lgames_session';
const SESSION_DAYS = 30;

// ─── utilidades ──────────────────────────────────────────────────────────────

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`No se pudo leer ${file}: ${err.message}`);
    return fallback;
  }
}

// Se releen en cada petición: añadir un sistema o un usuario no exige reiniciar.
const loadSystems = () => {
  const s = readJson(SYSTEMS_FILE, []);
  return Array.isArray(s) ? s : [];
};
const loadUsers = () => readJson(USERS_FILE, {});

// ─── contraseñas (scrypt) ────────────────────────────────────────────────────

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, user) {
  if (!user || !user.salt || !user.hash) return false;
  const candidate = Buffer.from(hashPassword(password, user.salt), 'hex');
  const stored = Buffer.from(user.hash, 'hex');
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

// ─── sesión: cookie firmada, sin estado en servidor ──────────────────────────

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function createSession(username) {
  const expires = Date.now() + SESSION_DAYS * 864e5;
  const payload = Buffer.from(JSON.stringify({ u: username, e: expires })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readSession(req) {
  const raw = req.headers.cookie || '';
  const jar = Object.fromEntries(
    raw.split(';').map((c) => {
      const i = c.indexOf('=');
      return i < 0 ? ['', ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
    })
  );
  const token = jar[COOKIE];
  if (!token) return null;

  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  const expected = Buffer.from(sign(payload));
  const got = Buffer.from(signature);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.e || data.e < Date.now()) return null;
    if (!loadUsers()[data.u]) return null; // usuario borrado -> sesión inválida
    return data.u;
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const user = readSession(req);
  if (!user) return res.redirect('/login');
  req.user = user;
  next();
}

// Freno básico de fuerza bruta, por IP.
const attempts = new Map();
function tooManyAttempts(ip) {
  const entry = attempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.first > 15 * 60e3) {
    attempts.delete(ip);
    return false;
  }
  return entry.count >= 10;
}
function noteAttempt(ip) {
  const entry = attempts.get(ip) || { count: 0, first: Date.now() };
  entry.count += 1;
  attempts.set(ip, entry);
}

// ─── plantillas ──────────────────────────────────────────────────────────────

function layout({ title, body, user, wide }) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${esc(title)}</title>
  <link rel="stylesheet" href="/static/styles.css">
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/">L-games</a>
    ${user ? `<form class="logout" method="post" action="/logout">
      <span class="who">${esc(user)}</span>
      <button class="link-btn" type="submit">Salir</button>
    </form>` : ''}
  </header>
  <main class="${wide ? 'wrap wrap-wide' : 'wrap'}">
${body}
  </main>
</body>
</html>
`;
}

function loginPage(error) {
  return layout({
    title: 'Entrar — L-games',
    body: `    <div class="login-box">
      <h1>L-games</h1>
      <p class="sub">Emuladores en el navegador</p>
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      <form method="post" action="/login" autocomplete="on">
        <label for="u">Usuario</label>
        <input id="u" name="username" type="text" required autofocus autocapitalize="none" autocomplete="username">
        <label for="p">Contraseña</label>
        <input id="p" name="password" type="password" required autocomplete="current-password">
        <button class="btn" type="submit">Entrar</button>
      </form>
    </div>`,
  });
}

function systemCard(s) {
  return `        <a class="card" href="/play/${esc(s.id)}">
          <span class="card-year">${esc(s.year || '')}</span>
          <h2 class="card-title">${esc(s.name)}</h2>
          <p class="card-sub">${esc(s.fullName || '')}</p>
          <span class="card-ext">${esc((s.extensions || []).slice(0, 3).join(' '))}</span>
        </a>`;
}

function indexPage(user, systems) {
  const body = systems.length
    ? `    <div class="head">
      <h1 class="title">Consolas</h1>
      <p class="subtitle">${systems.length} sistemas. Elige uno y carga tu ROM desde el dispositivo.</p>
    </div>
    <div class="grid">
${systems.map(systemCard).join('\n')}
    </div>`
    : `    <p class="empty">No hay sistemas configurados. Revisa <code>config/systems.json</code>.</p>`;
  return layout({ title: 'L-games', body, user });
}

function playPage(user, s) {
  const accept = (s.extensions || []).join(',');
  return layout({
    title: `${s.name} — L-games`,
    wide: true,
    user,
    body: `    <div class="play-head">
      <a class="back" href="/">← Consolas</a>
      <h1 class="play-title">${esc(s.name)}</h1>
    </div>

    <div id="picker" class="picker">
      <p class="picker-text">Selecciona la ROM que quieras jugar. El fichero <strong>no se sube a ningún servidor</strong>: se abre directamente en tu navegador.</p>
      <label class="btn file-btn" for="rom">Elegir ROM</label>
      <input id="rom" type="file" accept="${esc(accept)}" hidden>
      <p class="picker-ext">Formatos: ${esc((s.extensions || []).join('  '))}</p>
      ${s.note ? `<p class="picker-note">${esc(s.note)}</p>` : ''}
    </div>

    <div id="game-wrap" hidden><div id="game"></div></div>

    <script>
      (function () {
        var input  = document.getElementById('rom');
        var picker = document.getElementById('picker');
        var wrap   = document.getElementById('game-wrap');

        input.addEventListener('change', function () {
          var file = input.files && input.files[0];
          if (!file) return;

          picker.hidden = true;
          wrap.hidden = false;

          window.EJS_player      = '#game';
          window.EJS_core        = ${JSON.stringify(s.core)};
          window.EJS_gameUrl     = URL.createObjectURL(file);
          window.EJS_gameName    = file.name.replace(/\\.[^.]+$/, '');
          window.EJS_pathtoData  = '/data/';
          window.EJS_startOnLoaded = true;
          window.EJS_color       = '#5fae85';
          window.EJS_language    = 'es-ES';

          var script = document.createElement('script');
          script.src = '/data/loader.js';
          document.body.appendChild(script);
        });
      })();
    </script>`,
  });
}

// ─── rutas ───────────────────────────────────────────────────────────────────

app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

// Los cores de EmulatorJS son ficheros genéricos: se sirven sin sesión para que
// el navegador pueda cachearlos. No contienen nada del usuario.
app.use('/data', express.static(path.join(__dirname, 'data'), {
  maxAge: '30d',
  setHeaders: (res) => res.setHeader('Cross-Origin-Resource-Policy', 'same-origin'),
}));
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.get('/login', (req, res) => {
  if (readSession(req)) return res.redirect('/');
  res.type('html').send(loginPage(null));
});

app.post('/login', (req, res) => {
  const ip = req.headers['x-real-ip'] || req.ip || 'desconocida';
  if (tooManyAttempts(ip)) {
    return res.status(429).type('html').send(
      loginPage('Demasiados intentos fallidos. Espera unos minutos.')
    );
  }

  const { username, password } = req.body || {};
  const user = loadUsers()[String(username || '').trim()];

  if (!user || !verifyPassword(String(password || ''), user)) {
    noteAttempt(ip);
    return res.status(401).type('html').send(loginPage('Usuario o contraseña incorrectos.'));
  }

  attempts.delete(ip);
  res.cookie(COOKIE, createSession(String(username).trim()), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: SESSION_DAYS * 864e5,
    path: '/',
  });
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.redirect('/login');
});

app.get('/', requireAuth, (req, res) => {
  res.type('html').send(indexPage(req.user, loadSystems()));
});

app.get('/play/:id', requireAuth, (req, res) => {
  const system = loadSystems().find((s) => s.id === req.params.id);
  if (!system) return res.redirect('/');
  res.type('html').send(playPage(req.user, system));
});

app.get('/health', (req, res) => {
  res.json({ ok: true, systems: loadSystems().length });
});

app.use((req, res) => {
  res.status(404).type('html').send(
    layout({
      title: '404 — L-games',
      body: '    <div class="head"><h1 class="title">404</h1><p class="subtitle">Esa página no existe.</p></div>\n    <p><a class="btn" href="/">Volver</a></p>',
      user: readSession(req),
    })
  );
});

app.listen(PORT, HOST, () => {
  console.log(`L-games escuchando en http://${HOST}:${PORT}`);
});
