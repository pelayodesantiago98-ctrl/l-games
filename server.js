'use strict';

const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
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
const ROMS_DIR = path.join(__dirname, 'roms');
const SAVES_DIR = path.join(__dirname, 'saves');

/*
 * Versión de los estáticos a partir de la fecha del fichero. Sin esto, el CSS
 * se queda cacheado una hora en el navegador y los cambios de maquetación no
 * llegan al usuario hasta que vacía la caché a mano.
 */
function versionEstaticos() {
  try {
    return String(Math.floor(fs.statSync(path.join(__dirname, 'public', 'styles.css')).mtimeMs));
  } catch {
    return '0';
  }
}

const COOKIE = 'lgames_session';
const SESSION_DAYS = 30;
const MAX_SAVE_BYTES = 16 * 1024 * 1024; // holgado: la SRAM mayor ronda 8 MB

// ─── utilidades ──────────────────────────────────────────────────────────────

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`No se pudo leer ${file}: ${err.message}`);
    return fallback;
  }
}

const loadSystems = () => {
  const s = readJson(SYSTEMS_FILE, []);
  return Array.isArray(s) ? s : [];
};
const loadUsers = () => readJson(USERS_FILE, {});
const findSystem = (id) => loadSystems().find((s) => s.id === id) || null;

// Un solo saneador para todo lo que acabe formando parte de una ruta.
// Nada de "..", barras ni caracteres de control: solo un nombre plano.
const safeName = (value) =>
  String(value || '').replace(/[/\\]/g, '').replace(/^\.+/, '').slice(0, 200);

/*
 * Resolución de ROM por LISTA BLANCA: no construimos la ruta con lo que manda
 * el cliente, sino que listamos el directorio y buscamos una coincidencia
 * exacta. Aunque el saneador fallara, aquí no hay forma de salir del directorio.
 */
async function listRoms(systemId) {
  const dir = path.join(ROMS_DIR, safeName(systemId));
  try {
    const files = await fsp.readdir(dir, { withFileTypes: true });
    const roms = [];
    for (const f of files) {
      if (!f.isFile() || f.name.startsWith('.')) continue;
      const stat = await fsp.stat(path.join(dir, f.name));
      roms.push({ name: f.name, size: stat.size });
    }
    return roms.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Leyendo ${dir}: ${err.message}`);
    return [];
  }
}

async function resolveRom(systemId, romName) {
  const roms = await listRoms(systemId);
  const hit = roms.find((r) => r.name === romName);
  if (!hit) return null;
  return { ...hit, path: path.join(ROMS_DIR, safeName(systemId), hit.name) };
}

const romBase = (name) => name.replace(/\.[^.]+$/, '');

function savePath(user, systemId, romName) {
  return path.join(
    SAVES_DIR, safeName(user), safeName(systemId), `${safeName(romBase(romName))}.srm`
  );
}

const humanSize = (bytes) => {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${Math.round(bytes / 1048576)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
};

// ─── contraseñas y sesión ────────────────────────────────────────────────────

const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');

function verifyPassword(password, user) {
  if (!user || !user.salt || !user.hash) return false;
  const candidate = Buffer.from(hashPassword(password, user.salt), 'hex');
  const stored = Buffer.from(user.hash, 'hex');
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

const sign = (payload) =>
  crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');

function createSession(username) {
  const payload = Buffer.from(
    JSON.stringify({ u: username, e: Date.now() + SESSION_DAYS * 864e5 })
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readSession(req) {
  const jar = Object.fromEntries(
    (req.headers.cookie || '').split(';').map((c) => {
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
    if (!loadUsers()[data.u]) return null;
    return data.u;
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const user = readSession(req);
  if (!user) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'no autenticado' });
    return res.redirect('/login');
  }
  req.user = user;
  next();
}

const attempts = new Map();
function tooManyAttempts(ip) {
  const e = attempts.get(ip);
  if (!e) return false;
  if (Date.now() - e.first > 15 * 60e3) { attempts.delete(ip); return false; }
  return e.count >= 10;
}
function noteAttempt(ip) {
  const e = attempts.get(ip) || { count: 0, first: Date.now() };
  e.count += 1;
  attempts.set(ip, e);
}

// ─── plantillas ──────────────────────────────────────────────────────────────

function layout({ title, body, user, wide, fija }) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1, user-scalable=no">
  <title>${esc(title)}</title>
  <link rel="stylesheet" href="/static/styles.css?v=${versionEstaticos()}">
</head>
<body class="${fija ? 'fija' : ''}">
  <header class="topbar">
    <a class="brand" href="/">L-games</a>
    ${user ? `<nav class="topnav">
      <a class="link-btn" href="/controles">Controles</a>
      <form class="logout" method="post" action="/logout">
        <span class="who">${esc(user)}</span>
        <button class="link-btn" type="submit">Salir</button>
      </form>
    </nav>` : ''}
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

/*
 * Mapeo por defecto leido de data/src/emulator.js (this.defaultControllers).
 * EmulatorJS usa el estandar RetroPad: cada consola llama a sus botones de una
 * forma distinta, pero por debajo son siempre los mismos cuatro.
 */
const TECLADO = [
  ['Cruceta / dirección', '↑ ↓ ← →', 'Flechas del teclado'],
  ['Botón inferior', 'Z', 'B en Nintendo, ✕ en PlayStation'],
  ['Botón derecho', 'X', 'A en Nintendo, ○ en PlayStation'],
  ['Botón izquierdo', 'A', 'Y en SNES, □ en PlayStation'],
  ['Botón superior', 'S', 'X en SNES, △ en PlayStation'],
  ['Gatillo izquierdo (L)', 'Q', 'L1 en PlayStation'],
  ['Gatillo derecho (R)', 'E', 'R1 en PlayStation'],
  ['Gatillo inferior izq. (L2)', 'Tab', ''],
  ['Gatillo inferior der. (R2)', 'R', ''],
  ['Start', 'Enter', ''],
  ['Select', 'V', ''],
  ['Stick analógico', 'F H T G', 'izquierda, derecha, arriba, abajo'],
];

const POR_CONSOLA = [
  ['NES, Master System', 'Solo dos botones: <b>Z</b> y <b>X</b>.'],
  ['SNES', 'Los cuatro botones más los gatillos: <b>Z</b>=B, <b>X</b>=A, <b>A</b>=Y, <b>S</b>=X, <b>Q</b>=L, <b>E</b>=R.'],
  ['Game Boy, GB Color', 'Dos botones: <b>Z</b>=B, <b>X</b>=A.'],
  ['Game Boy Advance', 'Como Game Boy más los gatillos <b>Q</b> y <b>E</b>.'],
  ['Mega Drive, Game Gear', 'Tres botones en la fila inferior. Si el juego usa seis, la segunda fila cae en <b>A</b> y <b>S</b>.'],
  ['PlayStation', '<b>Z</b>=✕, <b>X</b>=○, <b>A</b>=□, <b>S</b>=△. Gatillos en <b>Q E Tab R</b>.'],
  ['Nintendo DS', 'La pantalla táctil se maneja con el ratón o el dedo directamente sobre ella.'],
  ['Nintendo 64', 'El stick va en <b>F H T G</b>. Los botones C suelen quedar en los gatillos.'],
  ['Arcade', 'Depende de la placa. Casi siempre <b>V</b> mete moneda y <b>Enter</b> empieza la partida.'],
];

function controlsPage(user) {
  const filas = TECLADO.map(([accion, tecla, nota]) => `        <tr>
          <td>${accion}</td>
          <td><kbd>${esc(tecla)}</kbd></td>
          <td class="nota">${nota}</td>
        </tr>`).join('\n');

  const consolas = POR_CONSOLA.map(([nombre, texto]) => `      <li><b>${esc(nombre)}:</b> ${texto}</li>`).join('\n');

  return layout({
    title: 'Controles — L-games',
    user,
    body: `    <div class="head">
      <h1 class="title">Controles</h1>
      <p class="subtitle">Mapeo por defecto. Todo es reconfigurable desde el propio emulador.</p>
    </div>

    <h2 class="sec">Teclado</h2>
    <div class="tabla-scroll">
      <table class="tabla">
        <thead><tr><th>Acción</th><th>Tecla</th><th>Equivale a</th></tr></thead>
        <tbody>
${filas}
        </tbody>
      </table>
    </div>

    <h2 class="sec">Según la consola</h2>
    <ul class="lista">
${consolas}
    </ul>

    <h2 class="sec">Mando</h2>
    <p>Conecta un mando por USB o Bluetooth <b>antes</b> de abrir el juego y se detecta solo:
    no hay que configurar nada. Si lo conectas con la partida ya empezada, pulsa cualquier
    botón para que el navegador lo reconozca.</p>

    <h2 class="sec">Móvil y tablet</h2>
    <p>Aparece un mando virtual en pantalla. En horizontal se ve mejor: la cruceta
    queda a la izquierda y los botones a la derecha. En Nintendo DS puedes tocar
    directamente la pantalla inferior.</p>

    <h2 class="sec">Cambiar las teclas</h2>
    <p>Dentro del juego, mueve el ratón sobre la imagen para que salga la barra del
    emulador y entra en el icono de ajustes. Ahí puedes reasignar cada botón, tanto de
    teclado como de mando, y los cambios se recuerdan.</p>

    <h2 class="sec">Guardado</h2>
    <p>La partida se guarda sola en el servidor cada 30 segundos y al salir, y es
    <b>distinta para cada usuario</b>. Con los botones de la cabecera del juego puedes
    exportar tu partida a un fichero o importar una que tengas.</p>

    <p class="volver"><a class="btn" href="/">Volver a las consolas</a></p>`,
  });
}

function indexPage(user, systems, counts) {
  const card = (s) => `        <a class="card" href="/system/${esc(s.id)}">
          <span class="card-year">${esc(s.year || '')}</span>
          <h2 class="card-title">${esc(s.name)}</h2>
          <p class="card-sub">${esc(s.fullName || '')}</p>
          <span class="card-count">${counts[s.id] || 0} ${counts[s.id] === 1 ? 'juego' : 'juegos'}</span>
        </a>`;
  return layout({
    title: 'L-games',
    user,
    body: `    <div class="head">
      <h1 class="title">Consolas</h1>
      <p class="subtitle">${systems.length} sistemas disponibles.</p>
    </div>
    <div class="grid">
${systems.map(card).join('\n')}
    </div>`,
  });
}

function systemPage(user, system, roms) {
  const lista = roms.length
    ? `    <ul class="rom-list">
${roms.map((r) => `      <li class="rom">
        <a class="rom-link" href="/play/${esc(system.id)}/${encodeURIComponent(r.name)}">
          <span class="rom-name">${esc(romBase(r.name))}</span>
          <span class="rom-size">${esc(humanSize(r.size))}</span>
        </a>
      </li>`).join('\n')}
    </ul>`
    : `    <p class="empty">No hay juegos para esta consola todavía. Sube uno con el botón de arriba.</p>`;

  return layout({
    title: `${system.name} — L-games`,
    user,
    body: `    <div class="play-head">
      <a class="back" href="/">← Consolas</a>
      <h1 class="play-title">${esc(system.name)}</h1>
    </div>
    ${system.note ? `<p class="sys-note">${esc(system.note)}</p>` : ''}

    <div class="upload-bar">
      <label class="btn file-btn" for="up">Subir juego</label>
      <input id="up" type="file" multiple accept="${esc((system.extensions || []).join(','))}" hidden>
      <span class="upload-hint">Formatos: ${esc((system.extensions || []).join('  '))}</span>
    </div>
    <div id="progress" class="progress" hidden><div id="bar" class="bar"></div><span id="ptext" class="ptext"></span></div>

${lista}

    <script>
      (function () {
        var input = document.getElementById('up');
        var box   = document.getElementById('progress');
        var bar   = document.getElementById('bar');
        var text  = document.getElementById('ptext');
        var sistema = ${JSON.stringify(system.id)};

        function subir(file) {
          return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('PUT', '/api/rom/' + encodeURIComponent(sistema) + '/' + encodeURIComponent(file.name));
            xhr.upload.onprogress = function (e) {
              if (!e.lengthComputable) return;
              var pct = Math.round((e.loaded / e.total) * 100);
              bar.style.width = pct + '%';
              text.textContent = file.name + ' — ' + pct + '%';
            };
            xhr.onload = function () {
              if (xhr.status >= 200 && xhr.status < 300) resolve();
              else reject(new Error(xhr.responseText || ('HTTP ' + xhr.status)));
            };
            xhr.onerror = function () { reject(new Error('fallo de red')); };
            xhr.send(file);
          });
        }

        input.addEventListener('change', async function () {
          var files = Array.prototype.slice.call(input.files || []);
          if (!files.length) return;
          box.hidden = false;
          try {
            for (var i = 0; i < files.length; i++) {
              bar.style.width = '0%';
              await subir(files[i]);
            }
            text.textContent = 'Listo, recargando…';
            location.reload();
          } catch (err) {
            text.textContent = 'Error: ' + err.message;
            bar.style.background = 'var(--danger)';
          }
        });
      })();
    </script>`,
  });
}

function playPage(user, system, rom, tieneSave) {
  const url = `/api/rom/${encodeURIComponent(system.id)}/${encodeURIComponent(rom.name)}`;
  const saveUrl = `/api/save/${encodeURIComponent(system.id)}/${encodeURIComponent(rom.name)}`;
  return layout({
    title: `${romBase(rom.name)} — L-games`,
    wide: true,
    fija: true,
    user,
    body: `    <div class="play-head">
      <a class="back" href="/system/${esc(system.id)}">← ${esc(system.name)}</a>
      <h1 class="play-title">${esc(romBase(rom.name))}</h1>
      <span id="save-status" class="save-status">${tieneSave ? 'Partida guardada encontrada' : 'Sin partida guardada'}</span>
      <span class="save-actions">
        <a class="link-btn" href="${saveUrl}?descarga=1" download>Exportar partida</a>
        <label class="link-btn" for="import-save">Importar partida</label>
        <input id="import-save" type="file" accept=".srm,.sav,.sra,.fla,.bin" hidden>
      </span>
    </div>

    <div id="game-wrap"><div id="game"></div></div>

    <script>
      window.EJS_player       = '#game';
      window.EJS_core         = ${JSON.stringify(system.core)};
      window.EJS_gameUrl      = ${JSON.stringify(url)};
      window.EJS_gameName     = ${JSON.stringify(romBase(rom.name))};
      window.EJS_gameID       = ${JSON.stringify(system.id + '/' + rom.name)};
      window.EJS_pathtodata   = '/data/';
      window.EJS_startOnLoaded = true;
      window.EJS_color        = '#5fae85';
      window.EJS_language     = 'es-ES';

      (function () {
        var SAVE_URL = ${JSON.stringify(saveUrl)};
        var estado   = document.getElementById('save-status');
        var ultimo   = null;   // huella del ultimo save subido, para no repetir
        var guardando = false;

        function marcar(txt) { if (estado) estado.textContent = txt; }

        function huella(bytes) {
          // Suficiente para detectar cambios sin coste: longitud + muestreo.
          var h = bytes.length;
          for (var i = 0; i < bytes.length; i += 997) h = (h * 31 + bytes[i]) >>> 0;
          return h;
        }

        function gm() {
          return window.EJS_emulator && window.EJS_emulator.gameManager;
        }

        async function restaurar() {
          try {
            var res = await fetch(SAVE_URL, { credentials: 'same-origin' });
            if (!res.ok) return;                       // 404 = aun no hay partida
            var datos = new Uint8Array(await res.arrayBuffer());
            if (!datos.length) return;

            var g = gm();
            if (!g) return;
            g.saveSaveFiles();                          // asegura que exista la ruta
            g.FS.writeFile(g.getSaveFilePath(), datos);
            g.loadSaveFiles();
            ultimo = huella(datos);
            marcar('Partida restaurada');
          } catch (err) {
            console.error('No se pudo restaurar la partida:', err);
          }
        }

        async function guardar(motivo) {
          if (guardando) return;
          var g = gm();
          if (!g) return;
          var datos;
          try { datos = g.getSaveFile(); } catch (err) { return; }
          if (!datos || !datos.length) return;

          var h = huella(datos);
          if (h === ultimo) return;                     // nada ha cambiado

          guardando = true;
          try {
            var res = await fetch(SAVE_URL, {
              method: 'PUT',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: datos,
            });
            if (res.ok) {
              ultimo = h;
              marcar('Guardado ' + new Date().toLocaleTimeString('es-ES'));
            }
          } catch (err) {
            console.error('No se pudo guardar:', err);
          } finally {
            guardando = false;
          }
        }

        // Importar una partida desde un fichero del dispositivo: se sube al
        // servidor y se inyecta en el emulador que ya esta corriendo.
        var importador = document.getElementById('import-save');
        if (importador) {
          importador.addEventListener('change', async function () {
            var file = importador.files && importador.files[0];
            if (!file) return;
            importador.value = '';

            if (file.size > ${MAX_SAVE_BYTES}) {
              marcar('El fichero es demasiado grande');
              return;
            }

            try {
              marcar('Importando…');
              var datos = new Uint8Array(await file.arrayBuffer());

              var res = await fetch(SAVE_URL, {
                method: 'PUT',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: datos,
              });
              if (!res.ok) throw new Error('el servidor rechazo la partida');

              var g = gm();
              if (g) {
                g.saveSaveFiles();
                g.FS.writeFile(g.getSaveFilePath(), datos);
                g.loadSaveFiles();
              }
              // Evita que el autoguardado pise lo recien importado.
              ultimo = huella(datos);
              marcar('Partida importada' + (g ? '' : ' (recarga para aplicarla)'));
            } catch (err) {
              console.error('Import fallido:', err);
              marcar('No se pudo importar: ' + err.message);
            }
          });
        }

        // El boton propio de EmulatorJS: al haber listener, cancela su descarga
        // y guardamos en el servidor.
        window.EJS_onSaveSave = function () { guardar('boton'); };
        window.EJS_onGameStart = function () { setTimeout(restaurar, 600); };

        setInterval(function () { guardar('periodico'); }, 30000);

        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'hidden') guardar('oculto');
        });

        // sendBeacon no sirve: necesitamos leer la SRAM antes de que muera la
        // pagina, asi que guardamos de forma sincrona en la medida de lo posible.
        window.addEventListener('pagehide', function () { guardar('salida'); });
      })();
    </script>
    <script src="/data/loader.js"></script>`,
  });
}

// ─── rutas ───────────────────────────────────────────────────────────────────

app.disable('x-powered-by');

/*
 * OJO: el parser de formularios va SOLO en la ruta de login, nunca global.
 * Montado con app.use() intentaria procesar tambien las subidas de ROMs —los
 * clientes que no mandan Content-Type caen por defecto en urlencoded— y las
 * rechazaria por tamaño antes de llegar al handler que las escribe en disco.
 */
const formulario = express.urlencoded({ extended: false, limit: '10kb' });

app.use('/data', express.static(path.join(__dirname, 'data'), {
  maxAge: '30d',
  setHeaders: (res) => res.setHeader('Cross-Origin-Resource-Policy', 'same-origin'),
}));
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.get('/login', (req, res) => {
  if (readSession(req)) return res.redirect('/');
  res.type('html').send(loginPage(null));
});

app.post('/login', formulario, (req, res) => {
  const ip = req.headers['x-real-ip'] || req.ip || 'desconocida';
  if (tooManyAttempts(ip)) {
    return res.status(429).type('html')
      .send(loginPage('Demasiados intentos fallidos. Espera unos minutos.'));
  }
  const { username, password } = req.body || {};
  const nombre = String(username || '').trim();
  const user = loadUsers()[nombre];

  if (!user || !verifyPassword(String(password || ''), user)) {
    noteAttempt(ip);
    return res.status(401).type('html').send(loginPage('Usuario o contraseña incorrectos.'));
  }
  attempts.delete(ip);
  res.cookie(COOKIE, createSession(nombre), {
    httpOnly: true, secure: true, sameSite: 'lax',
    maxAge: SESSION_DAYS * 864e5, path: '/',
  });
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.redirect('/login');
});

app.get('/', requireAuth, async (req, res) => {
  const systems = loadSystems();
  const counts = {};
  for (const s of systems) counts[s.id] = (await listRoms(s.id)).length;
  res.type('html').send(indexPage(req.user, systems, counts));
});

app.get('/controles', requireAuth, (req, res) => {
  res.type('html').send(controlsPage(req.user));
});

app.get('/system/:id', requireAuth, async (req, res) => {
  const system = findSystem(req.params.id);
  if (!system) return res.redirect('/');
  res.type('html').send(systemPage(req.user, system, await listRoms(system.id)));
});

app.get('/play/:id/:rom', requireAuth, async (req, res) => {
  const system = findSystem(req.params.id);
  if (!system) return res.redirect('/');
  const rom = await resolveRom(system.id, req.params.rom);
  if (!rom) return res.redirect(`/system/${encodeURIComponent(system.id)}`);
  const tiene = fs.existsSync(savePath(req.user, system.id, rom.name));
  res.type('html').send(playPage(req.user, system, rom, tiene));
});

// ─── API: ROMs ───────────────────────────────────────────────────────────────

app.get('/api/rom/:id/:rom', requireAuth, async (req, res) => {
  const system = findSystem(req.params.id);
  if (!system) return res.status(404).end();
  const rom = await resolveRom(system.id, req.params.rom);
  if (!rom) return res.status(404).end();
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.sendFile(rom.path);
});

// Subida por streaming: el cuerpo va directo a disco, sin pasar por memoria.
app.put('/api/rom/:id/:rom', requireAuth, async (req, res) => {
  const system = findSystem(req.params.id);
  if (!system) return res.status(404).json({ error: 'sistema desconocido' });

  const nombre = safeName(req.params.rom);
  if (!nombre) return res.status(400).json({ error: 'nombre invalido' });

  const permitidas = (system.extensions || []).map((e) => e.toLowerCase());
  const ext = path.extname(nombre).toLowerCase();
  if (permitidas.length && !permitidas.includes(ext)) {
    return res.status(400).json({ error: `extension ${ext} no admitida por ${system.name}` });
  }

  const dir = path.join(ROMS_DIR, safeName(system.id));
  await fsp.mkdir(dir, { recursive: true });

  const destino = path.join(dir, nombre);
  const temporal = `${destino}.subiendo`;

  const salida = fs.createWriteStream(temporal);
  req.pipe(salida);

  salida.on('error', async (err) => {
    console.error(`Subida fallida (${nombre}): ${err.message}`);
    try { await fsp.unlink(temporal); } catch {}
    if (!res.headersSent) res.status(500).json({ error: 'no se pudo escribir' });
  });

  salida.on('finish', async () => {
    try {
      await fsp.rename(temporal, destino);   // atómico: nunca queda a medias
      const stat = await fsp.stat(destino);
      res.json({ ok: true, name: nombre, size: stat.size });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
});

// ─── API: partidas guardadas ─────────────────────────────────────────────────

app.get('/api/save/:id/:rom', requireAuth, async (req, res) => {
  const system = findSystem(req.params.id);
  if (!system) return res.status(404).end();
  const rom = await resolveRom(system.id, req.params.rom);
  if (!rom) return res.status(404).end();

  const file = savePath(req.user, system.id, rom.name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'sin partida guardada' });

  if (req.query.descarga) {
    return res.download(file, `${romBase(rom.name)}.srm`);
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(file);
});

app.put('/api/save/:id/:rom',
  requireAuth,
  express.raw({ type: '*/*', limit: MAX_SAVE_BYTES }),
  async (req, res) => {
    const system = findSystem(req.params.id);
    if (!system) return res.status(404).json({ error: 'sistema desconocido' });
    const rom = await resolveRom(system.id, req.params.rom);
    if (!rom) return res.status(404).json({ error: 'juego desconocido' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: 'cuerpo vacio' });
    }

    const file = savePath(req.user, system.id, rom.name);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // Escritura atómica: si el navegador muere a mitad, la partida previa sobrevive.
    const temporal = `${file}.tmp`;
    await fsp.writeFile(temporal, req.body);
    await fsp.rename(temporal, file);

    res.json({ ok: true, bytes: req.body.length });
  }
);

app.get('/health', (req, res) => res.json({ ok: true, systems: loadSystems().length }));

app.use((req, res) => {
  res.status(404).type('html').send(layout({
    title: '404 — L-games',
    user: readSession(req),
    body: '    <div class="head"><h1 class="title">404</h1><p class="subtitle">Esa página no existe.</p></div>\n    <p><a class="btn" href="/">Volver</a></p>',
  }));
});

app.listen(PORT, HOST, () => {
  console.log(`L-games escuchando en http://${HOST}:${PORT}`);
});
