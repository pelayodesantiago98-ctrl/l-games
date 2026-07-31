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

/*
 * Clave compartida para darse de alta. Vive en .env y no en el código: aquí
 * acabaría en el repositorio y en su historial para siempre. Si falta, el
 * registro queda cerrado en vez de quedarse abierto sin protección.
 */
const CLAVE_REGISTRO = process.env.CLAVE_REGISTRO || '';

if (!SECRET) {
  console.error('Falta SESSION_SECRET en el entorno. Abortando.');
  process.exit(1);
}

const CONFIG_DIR = path.join(__dirname, 'config');
const SYSTEMS_FILE = path.join(CONFIG_DIR, 'systems.json');
const USERS_FILE = path.join(CONFIG_DIR, 'users.json');
const ROMS_DIR = path.join(__dirname, 'roms');
const SAVES_DIR = path.join(__dirname, 'saves');
const MEDIA_ROOT = path.join(__dirname, 'media');
const JUEGOS_FILE = path.join(CONFIG_DIR, 'juegos.json');

// Portada fija y animación al pasar el ratón, una de cada por consola y juego.
const EXT_IMAGEN = ['.jpg', '.jpeg', '.png', '.webp', '.avif'];
const EXT_ANIMADA = ['.gif', '.webp', '.mp4', '.webm'];
const MAX_MEDIA_BYTES = 24 * 1024 * 1024;

/*
 * Versión de la aplicación, tomada de package.json para no tenerla en dos
 * sitios. Se lee una vez al arrancar: cambiarla exige reiniciar el servicio,
 * igual que en L-notes.
 */
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

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

/*
 * Un estado guarda la maquina entera —RAM, VRAM, registros, audio—, no solo la
 * memoria de la partida, asi que no cabe en el tope de la SRAM: en PSX o N64 un
 * solo estado ronda los 10 MB. La miniatura es la captura que acompaña a cada
 * ranura en el panel.
 */
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const MAX_MINIATURA_BYTES = 4 * 1024 * 1024;
const SLOTS_ESTADO = 9;   // las mismas nueve ranuras que ofrece EmulatorJS

// ─── utilidades ──────────────────────────────────────────────────────────────

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);

/*
 * Texto comparable: minúsculas y sin acentos, para que buscar "pokemon"
 * encuentre "Pokémon" y "mario" encuentre "MARIO". La misma función se usa en
 * el servidor al generar el índice y en el navegador al teclear, así que las
 * dos partes comparan exactamente lo mismo.
 */
const normaliza = (t) => String(t == null ? '' : t)
  .toLowerCase()
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '');

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

/*
 * Los ficheros se guardan como <base>.<ext> y <base>-anim.<ext>, así que
 * localizarlos es probar qué extensión admitida existe. Se devuelve el mtime
 * para versionar la URL: sin eso un cambio de imagen no se vería, porque se
 * sirven con caché de un año.
 */
/*
 * Índice de nombres por directorio, cacheado y revalidado con el mtime de la
 * carpeta. Antes cada búsqueda probaba extensión por extensión con statSync:
 * hasta cinco llamadas por imagen y treinta y ocho para pintar el índice de
 * catorce consolas. Con doscientos juegos serían más de quinientas. Ahora es
 * un readdir por carpeta y una consulta en memoria.
 */
const cacheDirs = new Map();

function ficherosDe(subdir) {
  const dir = path.join(MEDIA_ROOT, subdir);
  try {
    const mtime = fs.statSync(dir).mtimeMs;
    const guardado = cacheDirs.get(subdir);
    if (guardado && guardado.mtime === mtime) return guardado.nombres;
    const nombres = new Set(fs.readdirSync(dir));
    cacheDirs.set(subdir, { mtime, nombres });
    return nombres;
  } catch {
    cacheDirs.delete(subdir);
    return new Set();
  }
}

function buscarMedia(subdir, base, sufijo, extensiones) {
  const nombre = safeName(base) + sufijo;
  const hay = ficherosDe(subdir);
  for (const ext of extensiones) {
    if (!hay.has(nombre + ext)) continue;
    const rel = subdir ? `${subdir}/${nombre}${ext}` : `${nombre}${ext}`;
    try {
      // Un solo stat, y solo del fichero que existe: hace falta su mtime para
      // versionar la URL, porque se sirve con caché de un año.
      const st = fs.statSync(path.join(MEDIA_ROOT, rel));
      return { archivo: nombre + ext, rel, ext, url: `/media/${rel}?v=${Math.floor(st.mtimeMs)}` };
    } catch { /* desapareció entre el listado y el stat */ }
  }
  return null;
}

const portadaDe = (id) => buscarMedia('consolas', id, '', EXT_IMAGEN);
const animacionDe = (id) => buscarMedia('consolas', id, '-anim', EXT_ANIMADA);

const dirJuego = (systemId) => `juegos/${safeName(systemId)}`;
const portadaJuego = (sys, rom) => buscarMedia(dirJuego(sys), romBase(rom), '', EXT_IMAGEN);
const animacionJuego = (sys, rom) => buscarMedia(dirJuego(sys), romBase(rom), '-anim', EXT_ANIMADA);
// Segunda animación: la que se ve dentro de la ventana de detalle, distinta de
// la que aparece al pasar el ratón por la tarjeta.
const animacion2Juego = (sys, rom) => buscarMedia(dirJuego(sys), romBase(rom), '-anim2', EXT_ANIMADA);

// Cada tipo de fichero gráfico: qué sufijo lleva y qué extensiones admite.
const TIPOS_MEDIA = {
  portada:    { sufijo: '',       extensiones: EXT_IMAGEN },
  animacion:  { sufijo: '-anim',  extensiones: EXT_ANIMADA },
  animacion2: { sufijo: '-anim2', extensiones: EXT_ANIMADA },
};

// ─── metadatos de los juegos ─────────────────────────────────────────────────

const loadJuegos = () => readJson(JUEGOS_FILE, {});
const claveJuego = (systemId, rom) => `${safeName(systemId)}/${safeName(rom)}`;

function metaJuego(systemId, rom) {
  const m = loadJuegos()[claveJuego(systemId, rom)] || {};
  return { nombre: m.nombre || romBase(rom), descripcion: m.descripcion || '' };
}

async function guardarMetaJuego(systemId, rom, datos) {
  const todos = loadJuegos();
  const clave = claveJuego(systemId, rom);
  const actual = todos[clave] || {};
  if (datos.nombre !== undefined) actual.nombre = String(datos.nombre).slice(0, 120).trim();
  if (datos.descripcion !== undefined) actual.descripcion = String(datos.descripcion).slice(0, 400).trim();
  todos[clave] = actual;
  await fsp.mkdir(CONFIG_DIR, { recursive: true });
  const temporal = `${JUEGOS_FILE}.tmp`;
  await fsp.writeFile(temporal, JSON.stringify(todos, null, 2) + '\n');
  await fsp.rename(temporal, JUEGOS_FILE);
}

// ─── estadísticas de uso ─────────────────────────────────────────────────────

const ESTADISTICAS_FILE = path.join(CONFIG_DIR, 'estadisticas.json');
const loadEstadisticas = () => readJson(ESTADISTICAS_FILE, {});

/*
 * Las escrituras se encadenan en una única promesa. Sin esto, dos latidos que
 * llegaran a la vez harían leer-modificar-escribir en paralelo y uno pisaría al
 * otro, perdiendo tiempo contabilizado.
 */
let colaEstadisticas = Promise.resolve();

function anotarUso(usuario, systemId, rom, { veces = 0, segundos = 0 }) {
  colaEstadisticas = colaEstadisticas.then(async () => {
    const todas = loadEstadisticas();
    const mio = todas[usuario] || (todas[usuario] = {});
    const clave = claveJuego(systemId, rom);
    const e = mio[clave] || (mio[clave] = { veces: 0, segundos: 0, ultima: null });
    e.veces += veces;
    e.segundos += segundos;
    if (veces > 0 || segundos > 0) e.ultima = new Date().toISOString();

    await fsp.mkdir(CONFIG_DIR, { recursive: true });
    const temporal = `${ESTADISTICAS_FILE}.tmp`;
    await fsp.writeFile(temporal, JSON.stringify(todas, null, 2) + '\n');
    await fsp.rename(temporal, ESTADISTICAS_FILE);
  }).catch((err) => console.error(`Anotando uso: ${err.message}`));
  return colaEstadisticas;
}

// Devuelve el uso del usuario ya resuelto a nombres legibles y agregado por
// consola, listo para pintar.
function resumenDe(usuario) {
  const mio = loadEstadisticas()[usuario] || {};
  const sistemas = loadSystems();
  const juegos = [];
  const porConsola = new Map();

  for (const [clave, datos] of Object.entries(mio)) {
    const corte = clave.indexOf('/');
    if (corte < 0) continue;
    const sysId = clave.slice(0, corte);
    const rom = clave.slice(corte + 1);
    const sistema = sistemas.find((s) => s.id === sysId);
    if (!sistema) continue;                      // consola retirada de la config

    juegos.push({
      sistema: sistema.name,
      sistemaId: sysId,
      rom,
      nombre: metaJuego(sysId, rom).nombre,
      veces: datos.veces || 0,
      segundos: datos.segundos || 0,
      ultima: datos.ultima || null,
    });

    const acc = porConsola.get(sysId) || { nombre: sistema.name, veces: 0, segundos: 0, juegos: 0 };
    acc.veces += datos.veces || 0;
    acc.segundos += datos.segundos || 0;
    acc.juegos += 1;
    porConsola.set(sysId, acc);
  }

  const porTiempo = (a, b) => b.segundos - a.segundos || b.veces - a.veces;
  return {
    juegos: juegos.sort(porTiempo),
    consolas: [...porConsola.values()].sort(porTiempo),
    totalSegundos: juegos.reduce((s, j) => s + j.segundos, 0),
    totalVeces: juegos.reduce((s, j) => s + j.veces, 0),
  };
}

function duracion(segundos) {
  if (!segundos) return '—';
  const h = Math.floor(segundos / 3600);
  const m = Math.round((segundos % 3600) / 60);
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} h`;
  if (m) return `${m} min`;
  return `${segundos} s`;
}

// ─── perfiles ────────────────────────────────────────────────────────────────

const fotoDe = (usuario) => buscarMedia('perfiles', usuario, '', EXT_IMAGEN);

// Iniciales para cuando no hay foto: "Ana Ruiz Gil" -> "AR", "lepayo" -> "L".
function inicialesDe(usuario) {
  const u = loadUsers()[usuario] || {};
  const base = (u.nombre || usuario).trim();
  const partes = base.split(/\s+/).filter(Boolean);
  const letras = partes.length > 1
    ? partes[0][0] + partes[1][0]
    : base.slice(0, 2);
  return letras.toUpperCase();
}

// Nombres de usuario acotados: forman rutas de directorio de partidas y de foto.
const USUARIO_VALIDO = /^[a-zA-Z0-9._-]{3,24}$/;

async function guardarUsuarios(users) {
  await fsp.mkdir(CONFIG_DIR, { recursive: true });
  const temporal = `${USERS_FILE}.tmp`;
  await fsp.writeFile(temporal, JSON.stringify(users, null, 2) + '\n', { mode: 0o640 });
  await fsp.rename(temporal, USERS_FILE);
}

function nuevoHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPassword(password, salt) };
}

/*
 * Renombrar arrastra todo lo que se indexa por nombre de usuario: la carpeta de
 * partidas, la foto y las estadísticas. Se mueven los ficheros ANTES de tocar
 * users.json, para que un fallo a medias deje la cuenta intacta con el nombre
 * viejo en vez de apuntando a rutas que ya no existen.
 */
async function renombrarUsuario(viejo, nuevo) {
  const saveViejo = path.join(SAVES_DIR, safeName(viejo));
  const saveNuevo = path.join(SAVES_DIR, safeName(nuevo));
  if (fs.existsSync(saveViejo)) await fsp.rename(saveViejo, saveNuevo);

  const foto = fotoDe(viejo);
  if (foto) {
    await fsp.rename(
      path.join(MEDIA_ROOT, foto.rel),
      path.join(MEDIA_ROOT, 'perfiles', safeName(nuevo) + foto.ext)
    );
  }

  const stats = loadEstadisticas();
  if (stats[viejo]) {
    stats[nuevo] = stats[viejo];
    delete stats[viejo];
    const tmp = `${ESTADISTICAS_FILE}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(stats, null, 2) + '\n');
    await fsp.rename(tmp, ESTADISTICAS_FILE);
  }
}

const cuentaAdmins = (users) =>
  Object.values(users).filter((u) => u.rol === 'admin').length;

// ─── roles ───────────────────────────────────────────────────────────────────

const esAdmin = (usuario) => (loadUsers()[usuario] || {}).rol === 'admin';

function requireAdmin(req, res, next) {
  if (!esAdmin(req.user)) {
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ error: 'hace falta ser administrador' });
    }
    return res.redirect('/');
  }
  next();
}

function savePath(user, systemId, romName) {
  return path.join(
    SAVES_DIR, safeName(user), safeName(systemId), `${safeName(romBase(romName))}.srm`
  );
}

/*
 * Los estados van en su propio subdirectorio para no mezclarlos con las SRAM:
 * asi el listado de ranuras no tiene que filtrar por extension y borrar todos
 * los estados de un usuario es tirar una carpeta.
 */
const estadosDir = (user, systemId) =>
  path.join(SAVES_DIR, safeName(user), safeName(systemId), 'estados');

function statePath(user, systemId, romName, slot, ext = 'state') {
  return path.join(estadosDir(user, systemId), `${safeName(romBase(romName))}.${slot}.${ext}`);
}

// Ranura valida: entero de 1 a SLOTS_ESTADO. Cualquier otra cosa es null y el
// handler responde 400 en vez de construir una ruta con basura.
function parseSlot(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n >= 1 && n <= SLOTS_ESTADO ? n : null;
}

async function listarEstados(user, systemId, romName) {
  const estados = [];
  for (let slot = 1; slot <= SLOTS_ESTADO; slot++) {
    let stat;
    try {
      stat = await fsp.stat(statePath(user, systemId, romName, slot));
    } catch {
      continue;
    }
    estados.push({
      slot,
      bytes: stat.size,
      fecha: Math.round(stat.mtimeMs),
      miniatura: fs.existsSync(statePath(user, systemId, romName, slot, 'png')),
    });
  }
  return estados;
}

/*
 * Una memoria de partida recien inicializada es un bloque uniforme: 0xFF en la
 * flash de GBA, 0x00 en la SRAM de casi todo lo demas. Distinguirla importa
 * porque es lo que devuelve el emulador cuando arranca sin haber restaurado
 * nada, y subirla encima de una partida buena la destruye sin dejar rastro.
 */
function partidaVacia(buf) {
  if (!buf || !buf.length) return true;
  const primero = buf[0];
  if (primero !== 0x00 && primero !== 0xff) return false;
  for (let i = 1; i < buf.length; i++) {
    if (buf[i] !== primero) return false;
  }
  return true;
}

/*
 * Escritura atomica: si el navegador muere a mitad de la subida, la partida
 * previa sobrevive intacta en vez de quedarse a medias.
 */
async function escribirAtomico(file, datos) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporal = `${file}.tmp`;
  await fsp.writeFile(temporal, datos);
  await fsp.rename(temporal, file);
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
  const foto = user ? fotoDe(user) : null;
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
    <a class="brand" href="/">L-games<span class="version">v${esc(VERSION)}</span></a>
    ${user ? `<nav class="menu-usuario">
      <button class="avatar" id="btn-avatar" type="button"
              aria-haspopup="true" aria-expanded="false" aria-controls="menu-desplegable"
              aria-label="Menú de ${esc(user)}">
        ${foto
          ? `<img src="${esc(foto.url)}" alt="">`
          : `<span class="avatar-iniciales">${esc(inicialesDe(user))}</span>`}
      </button>
      <div class="desplegable" id="menu-desplegable" hidden>
        <span class="desplegable-quien">
          <b>${esc((loadUsers()[user] || {}).nombre || user)}</b>
          <small>${esc(user)}</small>
        </span>
        <a href="/perfil">Editar perfil</a>
        <a href="/estadisticas">Estadísticas</a>
        <a href="/controles">Controles</a>
        ${esAdmin(user) ? '<a href="/gestion">Gestión</a>' : ''}
        <form method="post" action="/logout">
          <button type="submit">Desconectarse</button>
        </form>
      </div>
    </nav>` : ''}
  </header>
  <main class="${wide ? 'wrap wrap-wide' : 'wrap'}">
${body}
  </main>
${user ? `  <script>
    (function () {
      var btn = document.getElementById('btn-avatar');
      var menu = document.getElementById('menu-desplegable');
      if (!btn || !menu) return;

      function abrir(v) {
        menu.hidden = !v;
        btn.setAttribute('aria-expanded', v ? 'true' : 'false');
      }
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        abrir(menu.hidden);
      });
      // Un clic fuera o Escape lo cierran; dentro no, para poder pulsar opciones.
      document.addEventListener('click', function (e) {
        if (!menu.hidden && !menu.contains(e.target)) abrir(false);
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !menu.hidden) { abrir(false); btn.focus(); }
      });
    })();
  </script>
` : ''}</body>
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
      <p class="login-pie"><a href="/registro">Crear una cuenta</a></p>
    </div>`,
  });
}

function registroPage(error, datos) {
  const d = datos || {};
  return layout({
    title: 'Crear cuenta — L-games',
    body: `    <div class="login-box">
      <h1>Crear cuenta</h1>
      <p class="sub">Necesitas la clave que da el administrador</p>
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      <form method="post" action="/registro" autocomplete="on">
        <label for="n">Nombre y apellidos</label>
        <input id="n" name="nombre" type="text" required autofocus maxlength="80"
               value="${esc(d.nombre || '')}" autocomplete="name">

        <label for="u">Usuario</label>
        <input id="u" name="username" type="text" required maxlength="24"
               value="${esc(d.username || '')}" autocapitalize="none" autocomplete="username">
        <span class="ayuda">Entre 3 y 24 caracteres: letras, números, punto, guion o guion bajo.</span>

        <label for="p">Contraseña</label>
        <input id="p" name="password" type="password" required autocomplete="new-password">
        <span class="ayuda">Mínimo 8 caracteres.</span>

        <label for="p2">Confirmar contraseña</label>
        <input id="p2" name="password2" type="password" required autocomplete="new-password">

        <label for="a">Contraseña de administrador</label>
        <input id="a" name="clave" type="password" required autocomplete="off">

        <button class="btn" type="submit">Crear cuenta</button>
      </form>
      <p class="login-pie"><a href="/login">Ya tengo cuenta</a></p>
    </div>`,
  });
}

function perfilPage(user, aviso, error) {
  const u = loadUsers()[user] || {};
  const foto = fotoDe(user);
  return layout({
    title: 'Mi perfil — L-games',
    user,
    body: `    <div class="head">
      <h1 class="title">Mi perfil</h1>
      <p class="subtitle">${esc(u.rol === 'admin' ? 'Administrador' : 'Usuario')}</p>
    </div>
    ${aviso ? `<p class="aviso">${esc(aviso)}</p>` : ''}
    ${error ? `<p class="error">${esc(error)}</p>` : ''}

    <section class="panel">
      <h2 class="panel-titulo">Foto de perfil</h2>
      <div class="perfil-foto">
        <span class="avatar avatar-grande">
          ${foto ? `<img src="${esc(foto.url)}" alt="">`
                 : `<span class="avatar-iniciales">${esc(inicialesDe(user))}</span>`}
        </span>
        <div>
          <label class="btn file-btn" for="foto">${foto ? 'Cambiar foto' : 'Subir foto'}</label>
          <input id="foto" type="file" accept="${esc(EXT_IMAGEN.join(','))}" hidden>
          <p class="campo-nota">${esc(EXT_IMAGEN.join(' '))} · máximo 24 MB. Se recorta en círculo.</p>
        </div>
      </div>
      <div id="prog-foto" class="progress" hidden><div id="bar-foto" class="bar"></div><span id="txt-foto" class="ptext"></span></div>
    </section>

    <section class="panel">
      <h2 class="panel-titulo">Datos de la cuenta</h2>
      <form method="post" action="/perfil/datos">
        <div class="campo">
          <label for="nombre">Nombre y apellidos</label>
          <input id="nombre" name="nombre" type="text" maxlength="80" value="${esc(u.nombre || '')}">
        </div>
        <div class="campo">
          <label for="usuario">Usuario</label>
          <input id="usuario" name="usuario" type="text" maxlength="24" value="${esc(user)}" autocapitalize="none">
          <span class="ayuda">Si lo cambias se moverán tus partidas y tendrás que usar el nuevo para entrar.</span>
        </div>
        <button class="btn" type="submit">Guardar</button>
      </form>
    </section>

    <section class="panel">
      <h2 class="panel-titulo">Contraseña</h2>
      <form method="post" action="/perfil/clave" autocomplete="off">
        <div class="campo">
          <label for="actual">Contraseña actual</label>
          <input id="actual" name="actual" type="password" required autocomplete="current-password">
        </div>
        <div class="campo">
          <label for="nueva">Contraseña nueva</label>
          <input id="nueva" name="nueva" type="password" required autocomplete="new-password">
          <span class="ayuda">Mínimo 8 caracteres.</span>
        </div>
        <div class="campo">
          <label for="nueva2">Confirmar contraseña nueva</label>
          <input id="nueva2" name="nueva2" type="password" required autocomplete="new-password">
        </div>
        <button class="btn" type="submit">Cambiar contraseña</button>
      </form>
    </section>

    <script>
      (function () {
        var el = document.getElementById('foto');
        var box = document.getElementById('prog-foto');
        var bar = document.getElementById('bar-foto');
        var txt = document.getElementById('txt-foto');
        if (!el) return;
        el.addEventListener('change', function () {
          var f = el.files && el.files[0];
          if (!f) return;
          box.hidden = false;
          bar.style.background = '';
          var xhr = new XMLHttpRequest();
          xhr.open('PUT', '/api/foto/' + encodeURIComponent(f.name));
          xhr.upload.onprogress = function (e) {
            if (!e.lengthComputable) return;
            var pct = Math.round((e.loaded / e.total) * 100);
            bar.style.width = pct + '%';
            txt.textContent = pct + '%';
          };
          xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 300) { location.reload(); return; }
            var msg = xhr.responseText;
            try { msg = JSON.parse(xhr.responseText).error || msg; } catch (e) {}
            txt.textContent = 'Error: ' + msg;
            bar.style.background = 'var(--danger)';
          };
          xhr.onerror = function () {
            txt.textContent = 'Error de red';
            bar.style.background = 'var(--danger)';
          };
          xhr.send(f);
        });
      })();
    </script>`,
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

function gestionPage(user) {
  const users = loadUsers();
  const fecha = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${d.toLocaleDateString('es-ES')} ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
  };

  const filas = Object.entries(users)
    .sort((a, b) => a[0].localeCompare(b[0], 'es'))
    .map(([nombre, d]) => {
      // El buscador filtra en cliente sobre este atributo, así no hay que ir al
      // servidor por cada tecla y funciona con la lista ya pintada.
      const busca = `${nombre} ${d.nombre || ''} ${d.rol || 'usuario'}`.toLowerCase();
      return `          <tr class="fila-usuario" tabindex="0" role="button" data-busca="${esc(busca)}"
              data-usuario="${esc(nombre)}" data-nombre="${esc(d.nombre || '')}" data-rol="${esc(d.rol || 'usuario')}">
            <td><b>${esc(nombre)}</b></td>
            <td>${esc(d.nombre || '—')}</td>
            <td><span class="etiqueta-rol ${d.rol === 'admin' ? 'es-admin' : ''}">${esc(d.rol || 'usuario')}</span></td>
            <td class="nota">${esc(fecha(d.creado))}</td>
            <td class="nota">${esc(fecha(d.ultimoAcceso))}</td>
          </tr>`;
    }).join('\n');

  const total = Object.keys(users).length;
  const admins = Object.values(users).filter((u) => u.rol === 'admin').length;

  return layout({
    title: 'Gestión — L-games',
    user,
    body: `    <div class="head">
      <h1 class="title">Gestión</h1>
      <p class="subtitle">${total} ${total === 1 ? 'usuario registrado' : 'usuarios registrados'} · ${admins} ${admins === 1 ? 'administrador' : 'administradores'}</p>
    </div>

    <div class="campo">
      <label for="buscar">Buscar</label>
      <input id="buscar" type="text" placeholder="Usuario, nombre o rol" autocomplete="off">
    </div>

    <div class="tabla-scroll">
      <table class="tabla" id="tabla-usuarios">
        <thead><tr><th>Usuario</th><th>Nombre real</th><th>Rol</th><th>Registro</th><th>Último acceso</th></tr></thead>
        <tbody>
${filas}
        </tbody>
      </table>
    </div>
    <p id="sin-resultados" class="empty" hidden>Ningún usuario coincide.</p>
    <p class="campo-nota">Pulsa un usuario para editarlo.</p>

    <div id="ficha" class="modal" hidden>
      <div class="modal-fondo"></div>
      <div class="modal-caja modal-estrecho" role="dialog" aria-modal="true">
        <div class="modal-cabecera">
          <h2 id="ficha-titulo">Usuario</h2>
          <button id="ficha-cerrar" class="link-btn" type="button">Cerrar</button>
        </div>
        <div class="modal-cuerpo">
          <p id="ficha-error" class="error" hidden></p>
          <div class="campo">
            <label for="f-usuario">Nombre de usuario</label>
            <input id="f-usuario" type="text" maxlength="24" autocapitalize="none">
            <span class="ayuda">Cambiarlo mueve sus partidas, su foto y sus estadísticas.</span>
          </div>
          <div class="campo">
            <label for="f-nombre">Nombre real</label>
            <input id="f-nombre" type="text" maxlength="80">
          </div>
          <div class="campo">
            <label for="f-rol">Rol</label>
            <select id="f-rol">
              <option value="usuario">usuario</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <div class="campo">
            <label for="f-clave">Contraseña nueva</label>
            <input id="f-clave" type="password" autocomplete="new-password">
            <span class="ayuda">Déjala vacía para no cambiarla. Mínimo 8 caracteres.</span>
          </div>
          <div class="campo">
            <label for="f-clave2">Confirmar contraseña</label>
            <input id="f-clave2" type="password" autocomplete="new-password">
          </div>
          <button id="ficha-guardar" class="btn" type="button">Guardar</button>
        </div>
      </div>
    </div>

    <script>
      (function () {
        var caja = document.getElementById('buscar');
        var filas = Array.from(document.querySelectorAll('#tabla-usuarios tbody tr'));
        var aviso = document.getElementById('sin-resultados');
        caja.addEventListener('input', function () {
          var q = caja.value.trim().toLowerCase();
          var visibles = 0;
          filas.forEach(function (f) {
            var ok = !q || f.dataset.busca.indexOf(q) !== -1;
            f.hidden = !ok;
            if (ok) visibles++;
          });
          aviso.hidden = visibles > 0;
        });

        // ── Ficha del usuario ──────────────────────────────────────────────
        var modal  = document.getElementById('ficha');
        var error  = document.getElementById('ficha-error');
        var actual = null;

        function mostrar(v) {
          modal.hidden = !v;
          document.body.style.overflow = v ? 'hidden' : '';
        }

        function abrirFicha(fila) {
          actual = fila.dataset.usuario;
          document.getElementById('ficha-titulo').textContent = actual;
          document.getElementById('f-usuario').value = actual;
          document.getElementById('f-nombre').value = fila.dataset.nombre || '';
          document.getElementById('f-rol').value = fila.dataset.rol || 'usuario';
          document.getElementById('f-clave').value = '';
          document.getElementById('f-clave2').value = '';
          error.hidden = true;
          mostrar(true);
        }

        filas.forEach(function (f) {
          f.addEventListener('click', function () { abrirFicha(f); });
          f.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrirFicha(f); }
          });
        });

        document.getElementById('ficha-cerrar').addEventListener('click', function () { mostrar(false); });
        modal.querySelector('.modal-fondo').addEventListener('click', function () { mostrar(false); });
        document.addEventListener('keydown', function (e) {
          if (e.key === 'Escape' && !modal.hidden) mostrar(false);
        });

        document.getElementById('ficha-guardar').addEventListener('click', async function () {
          var boton = this;
          var clave = document.getElementById('f-clave').value;
          var clave2 = document.getElementById('f-clave2').value;

          if (clave && clave !== clave2) {
            error.textContent = 'Las dos contraseñas no coinciden.';
            error.hidden = false;
            return;
          }

          boton.disabled = true;
          error.hidden = true;
          try {
            var res = await fetch('/api/usuario/' + encodeURIComponent(actual), {
              method: 'PUT',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                usuario: document.getElementById('f-usuario').value.trim(),
                nombre: document.getElementById('f-nombre').value.trim(),
                rol: document.getElementById('f-rol').value,
                password: clave || undefined,
                password2: clave ? clave2 : undefined,
              }),
            });
            var datos = await res.json();
            if (!res.ok) throw new Error(datos.error || ('HTTP ' + res.status));
            location.reload();
          } catch (err) {
            error.textContent = err.message;
            error.hidden = false;
            boton.disabled = false;
          }
        });
      })();
    </script>`,
  });
}

function estadisticasPage(user) {
  const r = resumenDe(user);

  const podio = (lista, etiqueta) => lista.length
    ? `      <ol class="podio">
${lista.slice(0, 3).map((x, i) => `        <li class="podio-item">
          <span class="podio-puesto">${i + 1}</span>
          <span class="podio-datos">
            <span class="podio-nombre">${esc(x.nombre)}</span>
            <span class="podio-detalle">${esc(duracion(x.segundos))} · ${x.veces} ${x.veces === 1 ? 'vez' : 'veces'}${x.sistema ? ` · ${esc(x.sistema)}` : ''}</span>
          </span>
        </li>`).join('\n')}
      </ol>`
    : `      <p class="empty">Todavía no hay ${etiqueta}.</p>`;

  const filaJuego = (j) => `          <tr>
            <td>${esc(j.nombre)}</td>
            <td class="nota">${esc(j.sistema)}</td>
            <td>${esc(duracion(j.segundos))}</td>
            <td>${j.veces}</td>
            <td class="nota">${j.ultima ? esc(new Date(j.ultima).toLocaleDateString('es-ES')) : '—'}</td>
          </tr>`;

  const filaConsola = (c) => `          <tr>
            <td>${esc(c.nombre)}</td>
            <td class="nota">${c.juegos} ${c.juegos === 1 ? 'juego' : 'juegos'}</td>
            <td>${esc(duracion(c.segundos))}</td>
            <td>${c.veces}</td>
          </tr>`;

  return layout({
    title: 'Estadísticas — L-games',
    user,
    body: `    <div class="head">
      <h1 class="title">Estadísticas</h1>
      <p class="subtitle">${esc(duracion(r.totalSegundos))} en total · ${r.totalVeces} ${r.totalVeces === 1 ? 'partida' : 'partidas'}</p>
    </div>

    <section class="panel">
      <h2 class="panel-titulo">Juegos más usados</h2>
${podio(r.juegos, 'partidas registradas')}
    </section>

    <section class="panel">
      <h2 class="panel-titulo">Consolas más usadas</h2>
${podio(r.consolas, 'consolas usadas')}
    </section>

    <p><button id="btn-detalles" class="btn" type="button">Más detalles</button></p>

    <div id="detalles" class="modal" hidden>
      <div class="modal-fondo"></div>
      <div class="modal-caja" role="dialog" aria-modal="true" aria-label="Detalle de estadísticas">
        <div class="modal-cabecera">
          <h2>Detalle completo</h2>
          <button id="cerrar-detalles" class="link-btn" type="button">Cerrar</button>
        </div>
        <div class="modal-cuerpo">
          <h3 class="sec">Por consola</h3>
          ${r.consolas.length ? `<div class="tabla-scroll"><table class="tabla">
            <thead><tr><th>Consola</th><th>Juegos</th><th>Tiempo</th><th>Veces</th></tr></thead>
            <tbody>
${r.consolas.map(filaConsola).join('\n')}
            </tbody>
          </table></div>` : '<p class="empty">Sin datos.</p>'}

          <h3 class="sec">Por juego</h3>
          ${r.juegos.length ? `<div class="tabla-scroll"><table class="tabla">
            <thead><tr><th>Juego</th><th>Consola</th><th>Tiempo</th><th>Veces</th><th>Última vez</th></tr></thead>
            <tbody>
${r.juegos.map(filaJuego).join('\n')}
            </tbody>
          </table></div>` : '<p class="empty">Sin datos.</p>'}
        </div>
      </div>
    </div>

    <script>
      (function () {
        var modal = document.getElementById('detalles');
        var abrir = document.getElementById('btn-detalles');
        var cerrar = document.getElementById('cerrar-detalles');
        function mostrar(v) {
          modal.hidden = !v;
          document.body.style.overflow = v ? 'hidden' : '';
        }
        abrir.addEventListener('click', function () { mostrar(true); });
        cerrar.addEventListener('click', function () { mostrar(false); });
        modal.querySelector('.modal-fondo').addEventListener('click', function () { mostrar(false); });
        document.addEventListener('keydown', function (e) {
          if (e.key === 'Escape' && !modal.hidden) mostrar(false);
        });
      })();
    </script>`,
  });
}

const esVideoMedia = (m) => !!m && (m.ext === '.mp4' || m.ext === '.webm');

/*
 * Buscador que filtra en el navegador sobre lo ya pintado, comparando contra el
 * atributo data-busca que el servidor deja normalizado. No hace falta ir al
 * servidor por cada tecla, y el catálogo cabe de sobra en la página.
 */
function buscadorHTML({ selector, etiqueta, vacio }) {
  const id = 'buscador';
  return `    <div class="buscador">
      <input id="${id}" type="search" placeholder="${esc(etiqueta)}" autocomplete="off" aria-label="${esc(etiqueta)}">
      <span id="${id}-cuenta" class="buscador-cuenta"></span>
    </div>
    <p id="${id}-vacio" class="empty" hidden>${esc(vacio)}</p>
    <script>
      (function () {
        var caja = document.getElementById('${id}');
        var cuenta = document.getElementById('${id}-cuenta');
        var vacio = document.getElementById('${id}-vacio');
        var elementos = [];
        var total = 0;

        function normaliza(t) {
          return String(t || '').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '');
        }

        function filtrar() {
          var q = normaliza(caja.value.trim());
          var visibles = 0;
          elementos.forEach(function (el) {
            var ok = !q || (el.dataset.busca || '').indexOf(q) !== -1;
            el.hidden = !ok;
            if (ok) visibles++;
          });
          vacio.hidden = visibles > 0;
          cuenta.textContent = q ? visibles + ' de ' + total : '';
        }

        /*
         * La rejilla se pinta DESPUÉS de este bloque, así que buscarla ahora
         * daría una lista vacía y el filtro no ocultaría nada. Se recoge cuando
         * el documento está completo.
         */
        function preparar() {
          elementos = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
          total = elementos.length;
          if (caja.value) filtrar();          // por si el navegador la restauró
        }

        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', preparar);
        } else {
          preparar();
        }

        caja.addEventListener('input', filtrar);
        // Escape limpia la búsqueda sin tener que borrar a mano.
        caja.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') { caja.value = ''; filtrar(); }
        });
      })();
    </script>`;
}

/*
 * Consolas y juegos pintan la misma tarjeta: imagen de fondo, animación en
 * hover y un bloque de texto. Estaba duplicada en dos sitios y cualquier
 * retoque había que hacerlo dos veces, con el riesgo de que se separaran.
 */
/*
 * Selector de fichero.
 *
 * El control nativo dibuja su propio botón y su propio "ningún archivo
 * seleccionado" con el texto del navegador, que va en el idioma del sistema y
 * al que CSS no llega: en la página quedaba un trozo con otra tipografía y
 * otras palabras. Aquí el input se esconde —sin display:none, para que siga
 * recibiendo el foco del teclado— y el botón y el nombre del fichero elegido
 * los escribimos nosotros. El id no cambia, así que el JS que lee .files[0]
 * sigue igual.
 */
function campoFichero({ id, etiqueta, accept, vacio = 'Ningún fichero elegido', pie = '' }) {
  return `      <div class="campo">
        <label for="${id}">${etiqueta}</label>
        <div class="fichero">
          <input id="${id}" type="file" accept="${esc(accept)}">
          <label class="fichero-btn" for="${id}" aria-hidden="true">Elegir fichero</label>
          <span class="fichero-nombre" data-vacio="${esc(vacio)}">${esc(vacio)}</span>
        </div>${pie}
      </div>`;
}

function tarjetaHTML({ href, clases = [], portada, anim, esquina, cuerpo, datos = {} }) {
  const esVideo = esVideoMedia(anim);

  // La animación va en una variable CSS que solo se usa dentro de :hover, así
  // el navegador no descarga el GIF hasta que hace falta.
  const vars = [
    portada ? `--portada:url('${esc(portada.url)}')` : '',
    anim && !esVideo ? `--anim:url('${esc(anim.url)}')` : '',
  ].filter(Boolean).join(';');

  const capaAnim = esVideo
    ? `<video class="card-anim" muted loop playsinline preload="none" aria-hidden="true">
            <source src="${esc(anim.url)}" type="video/${anim.ext.slice(1)}">
          </video>`
    : (anim ? '<span class="card-anim" aria-hidden="true"></span>' : '');

  const todas = ['card', ...clases];
  if (portada) todas.push('con-portada');
  if (anim) todas.push('con-anim');

  const attrs = Object.entries(datos)
    .map(([k, v]) => `\n           data-${k}="${esc(v == null ? '' : v)}"`)
    .join('');

  return `        <a class="${todas.join(' ')}" href="${esc(href)}"${vars ? ` style="${vars}"` : ''}${attrs}>
          ${portada ? '<span class="card-fondo" aria-hidden="true"></span>' : ''}
          ${capaAnim}
          ${esquina ? `<span class="card-year">${esc(esquina)}</span>` : ''}
          <span class="card-texto">
${cuerpo}
          </span>
        </a>`;
}

function indexPage(user, systems, counts, juegos) {
  const card = (s) => tarjetaHTML({
    href: `/system/${s.id}`,
    portada: portadaDe(s.id),
    anim: animacionDe(s.id),
    esquina: s.year || '',
    cuerpo: `            <h2 class="card-title">${esc(s.name)}</h2>
            <p class="card-sub">${esc(s.fullName || '')}</p>
            <span class="card-count">${counts[s.id] || 0} ${counts[s.id] === 1 ? 'juego' : 'juegos'}</span>`,
  });

  // Tarjeta de juego para los resultados de la búsqueda: mismo aspecto que en
  // la página de su consola, pero indicando a cuál pertenece.
  const cardJuego = (j) => tarjetaHTML({
    href: `/play/${j.sistemaId}/${encodeURIComponent(j.rom)}`,
    clases: ['card-juego'],
    portada: j.portada,
    anim: j.anim,
    cuerpo: `            <h2 class="card-title">${esc(j.nombre)}</h2>
            <p class="card-sub">${esc(j.sistema)}</p>`,
    datos: { busca: normaliza(`${j.nombre} ${j.rom} ${j.sistema}`) },
  });
  return layout({
    title: 'L-games',
    user,
    body: `    <div class="head">
      <h1 class="title">Consolas</h1>
      <p class="subtitle">${systems.length} sistemas · ${juegos.length} ${juegos.length === 1 ? 'juego' : 'juegos'}</p>
    </div>

    <div class="buscador">
      <input id="buscador" type="search" placeholder="Buscar un juego" autocomplete="off" aria-label="Buscar un juego">
      <span id="buscador-cuenta" class="buscador-cuenta"></span>
    </div>
    <p id="buscador-vacio" class="empty" hidden>Ningún juego coincide.</p>

    <div id="rejilla-consolas" class="grid">
${systems.map(card).join('\n')}
    </div>

    <div id="rejilla-juegos" class="grid grid-juegos" hidden>
${juegos.map(cardJuego).join('\n')}
    </div>

    <script>
      (function () {
        var caja      = document.getElementById('buscador');
        var cuenta    = document.getElementById('buscador-cuenta');
        var vacio     = document.getElementById('buscador-vacio');
        var consolas  = document.getElementById('rejilla-consolas');
        var rejilla   = document.getElementById('rejilla-juegos');
        var juegos    = [];

        function normaliza(t) {
          return String(t || '').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '');
        }

        function filtrar() {
          var q = normaliza(caja.value.trim());

          // Sin texto se vuelve al índice de consolas, que es la vista normal.
          if (!q) {
            consolas.hidden = false;
            rejilla.hidden = true;
            vacio.hidden = true;
            cuenta.textContent = '';
            return;
          }

          var visibles = 0;
          juegos.forEach(function (el) {
            var ok = (el.dataset.busca || '').indexOf(q) !== -1;
            el.hidden = !ok;
            if (ok) visibles++;
          });
          consolas.hidden = true;
          rejilla.hidden = false;
          vacio.hidden = visibles > 0;
          cuenta.textContent = visibles + ' de ' + juegos.length;
        }

        /*
         * Las rejillas se pintan después de este bloque, así que buscarlas
         * ahora daría una lista vacía y el filtro no ocultaría nada.
         */
        function preparar() {
          juegos = Array.from(document.querySelectorAll('#rejilla-juegos > .card'));
          if (caja.value) filtrar();
        }
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', preparar);
        } else {
          preparar();
        }

        caja.addEventListener('input', filtrar);
        caja.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') { caja.value = ''; filtrar(); }
        });
      })();
    </script>

    <script>
      /*
       * Los vídeos van con preload="none" para no descargarlos al cargar la
       * página: solo empiezan cuando el ratón entra en la tarjeta. Al salir se
       * pausan y se rebobinan, para que la próxima vez arranquen desde el
       * principio en vez de desde donde se quedaron.
       */
      document.querySelectorAll('.card.con-anim').forEach(function (card) {
        var v = card.querySelector('video.card-anim');
        if (!v) return;
        card.addEventListener('mouseenter', function () {
          var p = v.play();
          if (p && p.catch) p.catch(function () { /* el navegador puede negarse */ });
        });
        card.addEventListener('mouseleave', function () {
          v.pause();
          try { v.currentTime = 0; } catch (e) {}
        });
      });
    </script>`,
  });
}

function systemPage(user, system, roms, admin) {
  const portada = portadaDe(system.id);
  const anim = animacionDe(system.id);

  // Mismo tratamiento que las tarjetas de consola: imagen fija, animación en
  // hover y carga diferida de esta última.
  /*
   * Sigue siendo un enlace de verdad: sin JavaScript lleva directo a jugar.
   * El detalle se abre interceptando el clic, no sustituyéndolo.
   */
  const tarjetaJuego = (r) => {
    const meta = metaJuego(system.id, r.name);
    const mov = animacionJuego(system.id, r.name);       // al pasar el ratón
    const mov2 = animacion2Juego(system.id, r.name);     // dentro del detalle
    const img = portadaJuego(system.id, r.name);

    return tarjetaHTML({
      href: `/play/${system.id}/${encodeURIComponent(r.name)}`,
      clases: ['card-juego'],
      portada: img,
      anim: mov,
      cuerpo: `            <h2 class="card-title">${esc(meta.nombre)}</h2>`,
      datos: {
        // El buscador filtra sobre esto, sin distinguir mayúsculas ni acentos.
        busca: normaliza(`${meta.nombre} ${r.name} ${meta.descripcion}`),
        nombre: meta.nombre,
        descripcion: meta.descripcion,
        rom: r.name,
        anim: mov ? mov.url : '',
        'anim-video': esVideoMedia(mov) ? '1' : '',
        anim2: mov2 ? mov2.url : '',
        'anim2-video': esVideoMedia(mov2) ? '1' : '',
        portada: img ? img.url : '',
        peso: humanSize(r.size),
      },
    });
  };

  const lista = roms.length
    ? `${buscadorHTML({ selector: '.grid-juegos > .card', etiqueta: 'Buscar juego', vacio: 'Ningún juego coincide.' })}
    <div class="grid grid-juegos">\n${roms.map(tarjetaJuego).join('\n')}\n    </div>

    <div id="detalle" class="modal" hidden>
      <div class="modal-fondo"></div>
      <div id="detalle-caja" class="detalle-caja" role="dialog" aria-modal="true">
        <div id="detalle-media" class="detalle-media"></div>
        <div id="detalle-vista" class="detalle-cuerpo">
          <h2 id="detalle-nombre" class="detalle-nombre"></h2>
          <p id="detalle-desc" class="detalle-desc"></p>
          <p id="detalle-peso" class="detalle-peso"></p>
          <a id="detalle-jugar" class="btn btn-jugar" href="#">JUGAR</a>
          <span class="detalle-pie">
            ${admin ? '<button id="detalle-editar" class="link-btn" type="button">Editar</button>' : ''}
            <button id="detalle-cerrar" class="link-btn" type="button">Cerrar</button>
          </span>
        </div>
${admin ? `
        <div id="detalle-edicion" class="detalle-cuerpo" hidden>
          <h2 class="detalle-nombre">Editar juego</h2>
          <div class="campo">
            <label for="ed-nombre">Nombre</label>
            <input id="ed-nombre" type="text" maxlength="120">
          </div>
          <div class="campo">
            <label for="ed-desc">Descripción</label>
            <textarea id="ed-desc" rows="2" maxlength="400"></textarea>
          </div>
${campoFichero({ id: 'ed-img', etiqueta: 'Imagen', accept: EXT_IMAGEN.join(',') })}
${campoFichero({ id: 'ed-anim', etiqueta: 'Animación 1 <small>(al pasar el ratón)</small>', accept: EXT_ANIMADA.join(',') })}
${campoFichero({ id: 'ed-anim2', etiqueta: 'Animación 2 <small>(en esta ventana)</small>', accept: EXT_ANIMADA.join(',') })}
${campoFichero({ id: 'ed-rom', etiqueta: 'Cambiar la ROM', accept: (system.extensions || []).join(','),
        pie: '<span class="ayuda">Si el fichero se llama distinto, se moverán sus datos, imágenes y partidas al nombre nuevo.</span>' })}
          <div id="ed-progreso" class="progress" hidden><div id="ed-bar" class="bar"></div><span id="ed-txt" class="ptext"></span></div>
          <button id="ed-guardar" class="btn" type="button">Guardar cambios</button>
          <span class="detalle-pie">
            <button id="ed-cancelar" class="link-btn" type="button">Cancelar</button>
          </span>
        </div>` : ''}
      </div>
    </div>`
    : `    <p class="empty">No hay juegos para esta consola todavía.${admin ? ' Súbelos con el botón <b>Subir juego</b>.' : ''}</p>`;

  return layout({
    title: `${system.name} — L-games`,
    user,
    body: `    <div class="play-head">
      <a class="back" href="/">← Consolas</a>
      <h1 class="play-title">${esc(system.name)}</h1>
      ${admin ? `<span class="acciones-esquina">
        <button class="btn-esquina" type="button" data-panel="panel-subir">Subir juego</button>
        <button class="btn-esquina" type="button" data-panel="panel-editar">Editar</button>
      </span>` : ''}
    </div>
    ${system.note ? `<p class="sys-note">${esc(system.note)}</p>` : ''}
${admin ? `
    <section id="panel-subir" class="panel" hidden>
      <h2 class="panel-titulo">Subir juego</h2>
${campoFichero({ id: 'rom', etiqueta: 'Fichero de la ROM', accept: (system.extensions || []).join(','),
        vacio: 'Ninguna ROM elegida',
        pie: `<span class="campo-nota">${esc((system.extensions || []).join('  '))}</span>` })}
      <div class="campo">
        <label for="nombre">Nombre</label>
        <input id="nombre" type="text" maxlength="120" placeholder="Si lo dejas vacío se usa el del fichero">
      </div>
      <div class="campo">
        <label for="descripcion">Descripción</label>
        <textarea id="descripcion" rows="2" maxlength="400" placeholder="Opcional"></textarea>
      </div>
${campoFichero({ id: 'j-img', etiqueta: 'Imagen', accept: EXT_IMAGEN.join(',') })}
      <div class="campo-doble">
${campoFichero({ id: 'j-gif', etiqueta: 'Animación 1 <small>(al pasar el ratón)</small>', accept: EXT_ANIMADA.join(',') })}
${campoFichero({ id: 'j-gif2', etiqueta: 'Animación 2 <small>(en la ventana de detalle)</small>', accept: EXT_ANIMADA.join(',') })}
      </div>
      <p class="campo-nota">
        La imagen se ve siempre. Máximo 24 MB cada fichero.
        Un <code>.mp4</code> pesa mucho menos que un GIF equivalente.
      </p>
      <button id="btn-subir" class="btn" type="button">Subir</button>
      <div id="progress" class="progress" hidden><div id="bar" class="bar"></div><span id="ptext" class="ptext"></span></div>
    </section>

    <section id="panel-editar" class="panel" hidden>
      <h2 class="panel-titulo">Apariencia de ${esc(system.name)}</h2>
      <p class="campo-nota">
        Es la tarjeta de esta consola en el índice. La imagen se ve siempre; la
        animación solo al pasar el ratón.
        ${portada ? '<b>Imagen puesta.</b>' : 'Sin imagen todavía.'}
        ${anim ? '<b>Animación puesta.</b>' : 'Sin animación todavía.'}
      </p>
      <div class="apariencia-acciones">
        <label class="btn file-btn" for="img">${portada ? 'Cambiar imagen' : 'Subir imagen'}</label>
        <input id="img" type="file" accept="${esc(EXT_IMAGEN.join(','))}" hidden>
        <label class="btn file-btn" for="anim">${anim ? 'Cambiar animación' : 'Subir animación'}</label>
        <input id="anim" type="file" accept="${esc(EXT_ANIMADA.join(','))}" hidden>
      </div>
      <div id="prog-media" class="progress" hidden><div id="bar-media" class="bar"></div><span id="txt-media" class="ptext"></span></div>
    </section>` : ''}

${lista}

    <script>
      (function () {
        var sistema = ${JSON.stringify(system.id)};

        // ── Paneles: un botón de esquina abre el suyo y cierra el otro ─────
        document.querySelectorAll('.btn-esquina').forEach(function (b) {
          b.addEventListener('click', function () {
            var destino = document.getElementById(b.dataset.panel);
            var abrir = destino.hidden;
            document.querySelectorAll('.panel').forEach(function (p) { p.hidden = true; });
            document.querySelectorAll('.btn-esquina').forEach(function (o) { o.classList.remove('activo'); });
            destino.hidden = !abrir;
            b.classList.toggle('activo', abrir);
            if (abrir) destino.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          });
        });

        // Envío genérico con barra de progreso; devuelve el error del servidor
        // en claro cuando lo hay, en vez de un "HTTP 400" pelado.
        function enviar(url, cuerpo, bar, txt, etiqueta) {
          return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('PUT', url);
            xhr.upload.onprogress = function (e) {
              if (!e.lengthComputable) return;
              var pct = Math.round((e.loaded / e.total) * 100);
              bar.style.width = pct + '%';
              txt.textContent = etiqueta + ' — ' + pct + '%';
            };
            xhr.onload = function () {
              if (xhr.status >= 200 && xhr.status < 300) return resolve();
              var msg = xhr.responseText;
              try { msg = JSON.parse(xhr.responseText).error || msg; } catch (e) {}
              reject(new Error(msg));
            };
            xhr.onerror = function () { reject(new Error('fallo de red')); };
            xhr.send(cuerpo);
          });
        }

        // ── Subir juego: ROM, metadatos e imágenes en una sola operación ───
        var btn  = document.getElementById('btn-subir');
        var box  = document.getElementById('progress');
        var bar  = document.getElementById('bar');
        var txt  = document.getElementById('ptext');

        // El nombre del fichero elegido lo escribimos nosotros: el input real
        // está oculto. Un solo oyente delegado sirve para los del panel de
        // subir y para los de la ventana de editar, que se crea después.
        document.addEventListener('change', function (e) {
          var campo = e.target;
          if (!campo.matches || !campo.matches('.fichero input[type="file"]')) return;
          var span = campo.parentNode.querySelector('.fichero-nombre');
          var elegido = campo.files && campo.files[0];
          span.textContent = elegido ? elegido.name : span.dataset.vacio;
          span.classList.toggle('con-fichero', !!elegido);
        });

        if (btn) btn.addEventListener('click', async function () {
          var rom  = document.getElementById('rom').files[0];
          var img  = document.getElementById('j-img').files[0];
          var gif  = document.getElementById('j-gif').files[0];
          var gif2 = document.getElementById('j-gif2').files[0];
          var nom  = document.getElementById('nombre').value.trim();
          var desc = document.getElementById('descripcion').value.trim();

          if (!rom) { alert('Elige el fichero de la ROM.'); return; }

          box.hidden = false;
          bar.style.background = '';
          btn.disabled = true;

          try {
            // La ROM primero: los metadatos y las imágenes cuelgan de ella y el
            // servidor los rechaza si el juego todavía no existe.
            bar.style.width = '0%';
            await enviar('/api/rom/' + encodeURIComponent(sistema) + '/' + encodeURIComponent(rom.name),
                         rom, bar, txt, rom.name);

            if (nom || desc) {
              txt.textContent = 'Guardando nombre y descripción…';
              await enviar('/api/juego-meta/' + encodeURIComponent(sistema) + '/' + encodeURIComponent(rom.name),
                           new Blob([JSON.stringify({ nombre: nom, descripcion: desc })],
                                    { type: 'application/json' }), bar, txt, 'datos');
            }
            if (img) {
              bar.style.width = '0%';
              await enviar('/api/juego-media/' + encodeURIComponent(sistema) + '/' + encodeURIComponent(rom.name) +
                           '/portada/' + encodeURIComponent(img.name), img, bar, txt, img.name);
            }
            if (gif) {
              bar.style.width = '0%';
              await enviar('/api/juego-media/' + encodeURIComponent(sistema) + '/' + encodeURIComponent(rom.name) +
                           '/animacion/' + encodeURIComponent(gif.name), gif, bar, txt, gif.name);
            }
            if (gif2) {
              bar.style.width = '0%';
              await enviar('/api/juego-media/' + encodeURIComponent(sistema) + '/' + encodeURIComponent(rom.name) +
                           '/animacion2/' + encodeURIComponent(gif2.name), gif2, bar, txt, gif2.name);
            }

            txt.textContent = 'Listo, recargando…';
            location.reload();
          } catch (err) {
            txt.textContent = 'Error: ' + err.message;
            bar.style.background = 'var(--danger)';
            btn.disabled = false;
          }
        });

        // ── Apariencia de la consola ───────────────────────────────────────
        var boxM = document.getElementById('prog-media');
        var barM = document.getElementById('bar-media');
        var txtM = document.getElementById('txt-media');

        [['img', 'portada'], ['anim', 'animacion']].forEach(function (par) {
          var el = document.getElementById(par[0]);
          if (!el) return;
          el.addEventListener('change', async function () {
            var f = el.files && el.files[0];
            if (!f) return;
            boxM.hidden = false;
            barM.style.background = '';
            try {
              await enviar('/api/media/' + encodeURIComponent(sistema) + '/' + par[1] +
                           '/' + encodeURIComponent(f.name), f, barM, txtM, f.name);
              txtM.textContent = 'Listo, recargando…';
              location.reload();
            } catch (err) {
              txtM.textContent = 'Error: ' + err.message;
              barM.style.background = 'var(--danger)';
            }
          });
        });

        // Vídeos de las tarjetas de juego: arrancan al entrar el ratón.
        document.querySelectorAll('.card.con-anim').forEach(function (card) {
          var v = card.querySelector('video.card-anim');
          if (!v) return;
          card.addEventListener('mouseenter', function () {
            var p = v.play();
            if (p && p.catch) p.catch(function () {});
          });
          card.addEventListener('mouseleave', function () {
            v.pause();
            try { v.currentTime = 0; } catch (e) {}
          });
        });

        // ── Detalle del juego ──────────────────────────────────────────────
        var modal = document.getElementById('detalle');
        if (modal) {
          var caja   = document.getElementById('detalle-caja');
          var media  = document.getElementById('detalle-media');
          var origen = null;   // tarjeta desde la que se abrió, para cerrar hacia ella

          var editando = false;

          // En modo edición la ventana necesita más sitio: el formulario tiene
          // seis campos. Se recalcula aquí para que crecer y encoger reutilicen
          // la misma transición que la apertura.
          function medidaDestino() {
            var ancho = Math.min(editando ? 500 : 440, window.innerWidth - 32);
            var alto  = Math.min(editando ? 740 : 600, window.innerHeight - 32);
            return {
              left: (window.innerWidth - ancho) / 2,
              top: (window.innerHeight - alto) / 2,
              width: ancho, height: alto,
            };
          }

          function colocar(r) {
            caja.style.left = r.left + 'px';
            caja.style.top = r.top + 'px';
            caja.style.width = r.width + 'px';
            caja.style.height = r.height + 'px';
          }

          function abrir(card) {
            origen = card;
            // Siempre se abre en la vista normal, aunque se cerrara editando.
            editando = false;
            caja.classList.remove('editando');
            var v0 = document.getElementById('detalle-vista');
            var e0 = document.getElementById('detalle-edicion');
            if (e0) { v0.hidden = false; e0.hidden = true; }
            document.getElementById('detalle-nombre').textContent = card.dataset.nombre || '';
            var desc = document.getElementById('detalle-desc');
            desc.textContent = card.dataset.descripcion || '';
            desc.hidden = !card.dataset.descripcion;
            document.getElementById('detalle-peso').textContent = card.dataset.peso || '';
            document.getElementById('detalle-jugar').href = card.getAttribute('href');

            /*
             * Aquí va la animación 2, la propia de esta ventana. Si no existe
             * se recurre a la imagen fija, NO a la animación 1: repetir la del
             * hover haría que ambas se vieran iguales, que es justo lo que se
             * quiere evitar. Sin ninguna de las dos se oculta la franja en vez
             * de dejar un rectángulo negro ocupando media ventana.
             */
            media.innerHTML = '';
            media.style.backgroundImage = '';
            var fondo = card.dataset.anim2 || card.dataset.portada;
            var esVid = card.dataset.anim2 ? card.dataset.anim2Video : '';
            media.hidden = !fondo;
            if (esVid && fondo) {
              var v = document.createElement('video');
              v.src = fondo;
              v.autoplay = true; v.loop = true; v.muted = true; v.playsInline = true;
              media.appendChild(v);
            } else if (fondo) {
              media.style.backgroundImage = "url('" + fondo + "')";
            }

            modal.hidden = false;
            document.body.style.overflow = 'hidden';

            /*
             * La caja nace con la posición y el tamaño exactos de la tarjeta y
             * crece hasta el centro: de ahí la sensación de que se despliega
             * desde la propia imagen. La transición se desactiva para colocarla
             * en el origen, o animaría también ese salto.
             */
            var r = card.getBoundingClientRect();
            caja.style.transition = 'none';
            colocar({ left: r.left, top: r.top, width: r.width, height: r.height });
            caja.classList.remove('abierto');
            void caja.offsetWidth;                    // fuerza el reflujo
            caja.style.transition = '';
            requestAnimationFrame(function () {
              caja.classList.add('abierto');
              colocar(medidaDestino());
            });
          }

          function cerrar() {
            caja.classList.remove('abierto');
            if (origen) {
              var r = origen.getBoundingClientRect();
              colocar({ left: r.left, top: r.top, width: r.width, height: r.height });
            }
            setTimeout(function () {
              modal.hidden = true;
              media.innerHTML = '';
              document.body.style.overflow = '';
            }, 280);
          }

          document.querySelectorAll('.card-juego').forEach(function (card) {
            card.addEventListener('click', function (e) {
              // Con Ctrl o rueda del ratón, que siga funcionando como enlace.
              if (e.metaKey || e.ctrlKey || e.button !== 0) return;
              e.preventDefault();
              abrir(card);
            });
          });

          document.getElementById('detalle-cerrar').addEventListener('click', cerrar);
          modal.querySelector('.modal-fondo').addEventListener('click', cerrar);
          document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && !modal.hidden) cerrar();
          });
          window.addEventListener('resize', function () {
            if (!modal.hidden) colocar(medidaDestino());
          });

          // ── Edición del juego (solo admin) ───────────────────────────────
          var vista   = document.getElementById('detalle-vista');
          var edicion = document.getElementById('detalle-edicion');
          var btnEditar = document.getElementById('detalle-editar');

          if (edicion && btnEditar) {
            var edBar = document.getElementById('ed-bar');
            var edTxt = document.getElementById('ed-txt');
            var edBox = document.getElementById('ed-progreso');

            function verEdicion(v) {
              editando = v;
              caja.classList.toggle('editando', v);
              // Primero crece la caja y después entra el formulario, para que
              // no se vea el contenido reflowing mientras la ventana se mueve.
              colocar(medidaDestino());
              setTimeout(function () {
                vista.hidden = v;
                edicion.hidden = !v;
              }, v ? 130 : 0);
              if (v) {
                document.getElementById('ed-nombre').value = origen.dataset.nombre || '';
                document.getElementById('ed-desc').value = origen.dataset.descripcion || '';
                ['ed-img', 'ed-anim', 'ed-anim2', 'ed-rom'].forEach(function (id) {
                  var campo = document.getElementById(id);
                  campo.value = '';
                  // Vaciar el input no dispara change, y el nombre escrito
                  // antes se quedaría puesto al reabrir la ventana.
                  campo.dispatchEvent(new Event('change', { bubbles: true }));
                });
                edBox.hidden = true;
                edBar.style.width = '0%';
                edBar.style.background = '';
              }
            }

            btnEditar.addEventListener('click', function () { verEdicion(true); });
            document.getElementById('ed-cancelar').addEventListener('click', function () { verEdicion(false); });

            document.getElementById('ed-guardar').addEventListener('click', async function () {
              var boton = this;
              var sis = encodeURIComponent(sistema);
              var rom = encodeURIComponent(origen.dataset.rom);
              var nom = document.getElementById('ed-nombre').value.trim();
              var des = document.getElementById('ed-desc').value.trim();
              var fImg  = document.getElementById('ed-img').files[0];
              var fAn1  = document.getElementById('ed-anim').files[0];
              var fAn2  = document.getElementById('ed-anim2').files[0];
              var fRom  = document.getElementById('ed-rom').files[0];

              boton.disabled = true;
              edBox.hidden = false;
              edBar.style.background = '';

              try {
                edTxt.textContent = 'Guardando datos…';
                await enviar('/api/juego-meta/' + sis + '/' + rom,
                  new Blob([JSON.stringify({ nombre: nom, descripcion: des })],
                           { type: 'application/json' }), edBar, edTxt, 'datos');

                var subidas = [[fImg, 'portada'], [fAn1, 'animacion'], [fAn2, 'animacion2']];
                for (var i = 0; i < subidas.length; i++) {
                  var f = subidas[i][0];
                  if (!f) continue;
                  edBar.style.width = '0%';
                  await enviar('/api/juego-media/' + sis + '/' + rom + '/' + subidas[i][1] +
                               '/' + encodeURIComponent(f.name), f, edBar, edTxt, f.name);
                }

                // La ROM va la última: si cambia de nombre, el resto de rutas
                // se migran, y hacerlo antes dejaría las subidas en el sitio viejo.
                if (fRom) {
                  edBar.style.width = '0%';
                  await enviar('/api/rom-reemplazar/' + sis + '/' + rom + '/' + encodeURIComponent(fRom.name),
                               fRom, edBar, edTxt, fRom.name);
                }

                edTxt.textContent = 'Listo, recargando…';
                location.reload();
              } catch (err) {
                edTxt.textContent = 'Error: ' + err.message;
                edBar.style.background = 'var(--danger)';
                boton.disabled = false;
              }
            });
          }
        }
      })();
    </script>`,
  });
}

function playPage(user, system, rom, tieneSave, estados, saveFecha) {
  const url = `/api/rom/${encodeURIComponent(system.id)}/${encodeURIComponent(rom.name)}`;
  const saveUrl = `/api/save/${encodeURIComponent(system.id)}/${encodeURIComponent(rom.name)}`;
  const estadosUrl = `/api/estados/${encodeURIComponent(system.id)}/${encodeURIComponent(rom.name)}`;
  const estadoUrl = `/api/estado/${encodeURIComponent(system.id)}/${encodeURIComponent(rom.name)}`;
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
        <button id="estados-btn" class="link-btn" type="button" aria-expanded="false">Estados</button>
        <a class="link-btn" href="${saveUrl}?descarga=1" download>Exportar partida</a>
        <label class="link-btn" for="import-save">Importar partida</label>
        <input id="import-save" type="file" accept=".srm,.sav,.sra,.fla,.bin" hidden>
      </span>
    </div>

    <div id="estados-panel" class="estados-panel" hidden>
      <div class="estados-cab">
        <strong>Estados guardados</strong>
        <span class="estados-ayuda">Una foto exacta del momento, aparte del guardado del juego.</span>
        <button id="estados-cerrar" class="link-btn" type="button">Cerrar</button>
      </div>
      <div id="estados-rejilla" class="estados-rejilla"></div>
    </div>

    <div id="game-wrap">
      <div id="game"></div>
      <button id="ajustes" class="ajustes-btn" type="button" aria-label="Abrir ajustes del emulador">Ajustes</button>
    </div>

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
        var ESTADOS_URL = ${JSON.stringify(estadosUrl)};
        var ESTADO_URL  = ${JSON.stringify(estadoUrl)};
        var SLOTS = ${SLOTS_ESTADO};
        var ESTADOS = ${JSON.stringify(estados || [])};
        var SAVE_FECHA = ${Number(saveFecha) || 0};
        var STATS_ABRIR  = ${JSON.stringify(`/api/stats/abrir/${encodeURIComponent(system.id)}/${encodeURIComponent(rom.name)}`)};
        var STATS_TIEMPO = ${JSON.stringify(`/api/stats/tiempo/${encodeURIComponent(system.id)}/${encodeURIComponent(rom.name)}`)};
        var estado   = document.getElementById('save-status');

        // ── Registro de uso ────────────────────────────────────────────────
        var yaContado = false;
        var acumulado = 0;

        function contabilizarApertura() {
          if (yaContado) return;
          yaContado = true;
          fetch(STATS_ABRIR, { method: 'POST', credentials: 'same-origin' })
            .catch(function () { /* las estadísticas nunca deben estorbar */ });
        }

        function enviarTiempo(seg, conBeacon) {
          if (!seg) return;
          var cuerpo = JSON.stringify({ segundos: seg });
          if (conBeacon && navigator.sendBeacon) {
            // Al cerrar la pestaña un fetch normal se cancela; sendBeacon no.
            navigator.sendBeacon(STATS_TIEMPO, new Blob([cuerpo], { type: 'application/json' }));
            return;
          }
          fetch(STATS_TIEMPO, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' }, body: cuerpo,
          }).catch(function () {});
        }

        // Se suma en tramos de 20 s y se envía cada minuto: si el emulador está
        // pausado o aún no arrancó, ese tramo no cuenta.
        setInterval(function () {
          var e = window.EJS_emulator;
          if (!e || !e.started || e.paused) return;
          acumulado += 20;
          if (acumulado >= 60) { enviarTiempo(acumulado); acumulado = 0; }
        }, 20000);
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

        /*
         * Una memoria de partida sin estrenar es un bloque uniforme: 0xFF en la
         * flash de GBA, 0x00 en casi todo lo demas. Es exactamente lo que
         * devuelve el emulador cuando arranca sin haber restaurado nada, y
         * subirlo borraba la partida buena del servidor. Nunca se sube.
         */
        function vacia(bytes) {
          if (!bytes || !bytes.length) return true;
          var primero = bytes[0];
          if (primero !== 0 && primero !== 255) return false;
          for (var i = 1; i < bytes.length; i++) {
            if (bytes[i] !== primero) return false;
          }
          return true;
        }

        function iguales(a, b) {
          if (!a || !b || a.length !== b.length) return false;
          for (var i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
          }
          return true;
        }

        /*
         * La partida del servidor se descarga ANTES de arrancar el emulador y se
         * mete en su disco virtual en cuanto este montado, porque el core lee la
         * memoria de partida al cargar la ROM y ya no vuelve a mirarla. Inyectarla
         * despues —como se hacia— llegaba tarde: el juego ya habia arrancado sin
         * partida y decia que no habia ninguna.
         */
        var sramServidor = null;
        var listo = false;   // hasta que la restauracion no se resuelve, no se sube nada

        async function descargarSram() {
          try {
            var res = await fetch(SAVE_URL, { credentials: 'same-origin' });
            if (!res.ok) return null;                  // 404 = aun no hay partida
            var datos = new Uint8Array(await res.arrayBuffer());
            return datos.length ? datos : null;
          } catch (err) {
            console.error('No se pudo descargar la partida:', err);
            return null;
          }
        }

        // Escribe respetando el metodo del propio EmulatorJS: crea el arbol de
        // directorios y borra el fichero previo antes de escribir.
        function escribirEnEmulador(ruta, datos) {
          var g = gm();
          if (!g) return false;
          var partes = ruta.split('/');
          var actual = '';
          for (var i = 0; i < partes.length - 1; i++) {
            if (partes[i] === '') continue;
            actual += '/' + partes[i];
            if (!g.FS.analyzePath(actual).exists) g.FS.mkdir(actual);
          }
          if (g.FS.analyzePath(ruta).exists) g.FS.unlink(ruta);
          g.FS.writeFile(ruta, datos);
          return true;
        }

        /*
         * Primera oportunidad: el disco de partidas ya esta montado y la ROM aun
         * no se ha cargado, asi que el core encontrara la partida al arrancar y
         * no hara falta reiniciarlo. La ruta se deduce igual que la deduce
         * RetroArch —directorio fijo y nombre del contenido—, y si no acertamos,
         * el repaso de "start" lo arregla.
         */
        function inyectarAntesDeArrancar() {
          if (!sramServidor) return;
          try {
            var e = window.EJS_emulator;
            var base = e.getBaseFileName(true) || 'game';
            base = base.replace(/\\.[^.]+$/, '');
            escribirEnEmulador('/data/saves/' + base + '.srm', sramServidor);
          } catch (err) {
            console.warn('No se pudo precargar la partida:', err);
          }
        }

        /*
         * Repaso con el juego ya en marcha, cuando el emulador si sabe decir la
         * ruta real de la memoria de partida. Aqui se decide quien manda:
         *
         *  - Si el servidor tiene partida y no coincide con la del emulador, se
         *    inyecta y se reinicia el core para que la lea de verdad.
         *  - Si el servidor no tiene nada y el navegador si, gana el navegador y
         *    se sube. EmulatorJS guarda una copia local en el propio navegador,
         *    asi que por aqui se recupera una partida que el servidor perdio.
         */
        async function resolverPartida() {
          var g = gm();
          if (!g) { listo = true; return; }

          var local = null;
          try { local = g.getSaveFile(false); } catch (err) { /* aun no existe */ }

          if (sramServidor && !vacia(sramServidor)) {
            if (iguales(local, sramServidor)) {
              ultimo = huella(sramServidor);
              marcar('Partida restaurada');
            } else {
              try {
                escribirEnEmulador(g.getSaveFilePath(), sramServidor);
                g.loadSaveFiles();
                // El core ya habia leido la memoria vieja al cargar la ROM;
                // reiniciarlo es la unica forma segura de que lea esta.
                g.restart();
                ultimo = huella(sramServidor);
                marcar('Partida restaurada');
              } catch (err) {
                console.error('No se pudo restaurar la partida:', err);
                marcar('No se pudo restaurar la partida');
              }
            }
          } else if (local && !vacia(local)) {
            marcar('Partida encontrada en este navegador, subiendola…');
            await subir(local);
          }

          listo = true;
        }

        async function subir(datos) {
          try {
            var res = await fetch(SAVE_URL, {
              method: 'PUT',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: datos,
            });
            if (res.ok) {
              ultimo = huella(datos);
              marcar('Guardado ' + new Date().toLocaleTimeString('es-ES'));
              return true;
            }
            if (res.status === 409) return false;      // el servidor protegio la partida
            marcar('El servidor rechazo el guardado');
          } catch (err) {
            console.error('No se pudo guardar:', err);
          }
          return false;
        }

        async function guardar(motivo) {
          if (guardando || !listo) return;
          var g = gm();
          if (!g) return;
          var datos;
          try { datos = g.getSaveFile(); } catch (err) { return; }
          if (!datos || !datos.length) return;

          // Sin esto, abrir un juego y no llegar a guardar borraba la partida
          // del servidor a los treinta segundos.
          if (vacia(datos)) return;

          var h = huella(datos);
          if (h === ultimo) return;                     // nada ha cambiado

          guardando = true;
          try {
            await subir(datos);
          } finally {
            guardando = false;
          }
        }

        /*
         * Al cerrar la pestaña un fetch se cancela a medias y el ultimo guardado
         * se pierde. sendBeacon sobrevive a la pagina, pero solo sabe hacer POST.
         */
        function guardarAlSalir() {
          if (!listo || !navigator.sendBeacon) return;
          var g = gm();
          if (!g) return;
          var datos;
          try { datos = g.getSaveFile(); } catch (err) { return; }
          if (!datos || !datos.length || vacia(datos)) return;
          if (huella(datos) === ultimo) return;
          navigator.sendBeacon(
            SAVE_URL, new Blob([datos], { type: 'application/octet-stream' })
          );
        }

        /*
         * Boton "Ajustes" para tactil. La barra de EmulatorJS aparece al mover
         * el raton y se esconde sola a los 3 segundos, algo inservible sin raton.
         * menu.open(true) la abre y el "true" desactiva ese autoocultado.
         * Ahi dentro estan guardar/cargar estado, captura, ajustes y pantalla
         * completa, asi que no hace falta reimplementar ninguna.
         */
        var btnAjustes = document.getElementById('ajustes');
        var menuPermitido = false;

        /*
         * En táctil la barra se abría sola al jugar. EmulatorJS ignora los
         * eventos "click" de tipo touch, pero su listener de "mousemove" no:
         * un toque genera un mousemove sintético y, si cae cerca del borde
         * inferior —justo donde está el mando virtual—, dispara show().
         *
         * En vez de pelearse con sus listeners internos, se vigila la clase que
         * controla la visibilidad y se vuelve a ocultar si nadie pulsó Ajustes.
         * Así da igual por qué camino intente abrirse.
         */
        function vigilarMenu() {
          if (!window.matchMedia('(hover: none)').matches) return;  // con ratón, comportamiento normal
          var e = window.EJS_emulator;
          if (!e || !e.elements || !e.elements.menu) return;
          var barra = e.elements.menu;

          new MutationObserver(function () {
            var oculta = barra.classList.contains('ejs_menu_bar_hidden');
            if (oculta) {
              menuPermitido = false;          // se cerró: vuelta a empezar
            } else if (!menuPermitido) {
              barra.classList.add('ejs_menu_bar_hidden');
            }
          }).observe(barra, { attributes: true, attributeFilter: ['class'] });
        }

        if (btnAjustes) {
          btnAjustes.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var e = window.EJS_emulator;
            if (!e || !e.menu || !e.elements || !e.elements.menu) return;
            var oculto = e.elements.menu.classList.contains('ejs_menu_bar_hidden');
            if (oculto) {
              menuPermitido = true;
              e.menu.open(true);
            } else {
              menuPermitido = false;
              e.menu.close();
            }
          });
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

        /*
         * ── Estados guardados ─────────────────────────────────────────────
         * Nueve ranuras por juego y usuario, cada una con su captura. Van al
         * servidor, no al navegador: es lo que permite retomar la partida desde
         * otro dispositivo. El guardado del propio juego (la SRAM de arriba)
         * sigue siendo independiente de esto.
         */
        var panel      = document.getElementById('estados-panel');
        var rejilla    = document.getElementById('estados-rejilla');
        var btnEstados = document.getElementById('estados-btn');
        var slotActivo = 1;

        function fechaCorta(ms) {
          var d = new Date(ms);
          return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' }) + ' ' +
                 d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
        }

        function estadoDe(slot) {
          for (var i = 0; i < ESTADOS.length; i++) {
            if (ESTADOS[i].slot === slot) return ESTADOS[i];
          }
          return null;
        }

        function masReciente() {
          var mejor = null;
          for (var i = 0; i < ESTADOS.length; i++) {
            if (!mejor || ESTADOS[i].fecha > mejor.fecha) mejor = ESTADOS[i];
          }
          return mejor;
        }

        function pintarEstados() {
          if (!rejilla) return;
          rejilla.textContent = '';
          for (var slot = 1; slot <= SLOTS; slot++) {
            var info = estadoDe(slot);
            var caja = document.createElement('div');
            caja.className = 'ranura' + (info ? ' ocupada' : '') +
                             (slot === slotActivo ? ' activa' : '');

            var cab = document.createElement('div');
            cab.className = 'ranura-num';
            cab.textContent = 'Ranura ' + slot;
            caja.appendChild(cab);

            var vista = document.createElement('div');
            vista.className = 'ranura-vista';
            if (info && info.miniatura) {
              var img = document.createElement('img');
              // La fecha en la URL evita que el navegador enseñe la captura vieja.
              img.src = ESTADO_URL + '/' + slot + '/miniatura?t=' + info.fecha;
              img.alt = 'Captura de la ranura ' + slot;
              img.loading = 'lazy';
              vista.appendChild(img);
            } else {
              vista.textContent = info ? 'Sin captura' : 'Vacía';
            }
            caja.appendChild(vista);

            var pie = document.createElement('div');
            pie.className = 'ranura-fecha';
            pie.textContent = info ? fechaCorta(info.fecha) : '—';
            caja.appendChild(pie);

            var acciones = document.createElement('div');
            acciones.className = 'ranura-acciones';
            var botones = [['guardar', 'Guardar']];
            if (info) botones.push(['cargar', 'Cargar'], ['borrar', 'Borrar']);
            for (var b = 0; b < botones.length; b++) {
              var btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'link-btn';
              btn.dataset.accion = botones[b][0];
              btn.dataset.slot = String(slot);
              btn.textContent = botones[b][1];
              acciones.appendChild(btn);
            }
            caja.appendChild(acciones);
            rejilla.appendChild(caja);
          }
        }

        async function refrescarEstados() {
          try {
            var res = await fetch(ESTADOS_URL, { credentials: 'same-origin' });
            if (!res.ok) return;
            var datos = await res.json();
            ESTADOS = datos.estados || [];
            pintarEstados();
          } catch (err) {
            console.error('No se pudo leer la lista de estados:', err);
          }
        }

        async function guardarEstado(slot, evento) {
          var g = gm();
          if (!g) return;

          var datos = evento && evento.state;
          if (!datos) {
            try { datos = g.getState(); } catch (err) { datos = null; }
          }
          if (!datos || !datos.length) {
            marcar('Este núcleo no permite guardar estados');
            return;
          }

          marcar('Guardando estado ' + slot + '…');
          try {
            var res = await fetch(ESTADO_URL + '/' + slot, {
              method: 'PUT',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: datos,
            });
            if (!res.ok) throw new Error('el servidor rechazo el estado');

            // La captura es un extra: si falla, la ranura queda sin imagen pero
            // el estado ya esta a salvo.
            var foto = evento && evento.screenshot;
            if (!foto) {
              try {
                var e = window.EJS_emulator;
                var hecho = await e.takeScreenshot(
                  e.capture.photo.source, e.capture.photo.format, e.capture.photo.upscale
                );
                foto = hecho && hecho.screenshot;
              } catch (err) { foto = null; }
            }
            if (foto && foto.length && foto[0] === 0x89) {
              try {
                await fetch(ESTADO_URL + '/' + slot + '/miniatura', {
                  method: 'PUT',
                  credentials: 'same-origin',
                  headers: { 'Content-Type': 'image/png' },
                  body: foto,
                });
              } catch (err) { /* la ranura se vera sin captura */ }
            }

            slotActivo = slot;
            await refrescarEstados();
            marcar('Estado ' + slot + ' guardado');
          } catch (err) {
            console.error('No se pudo guardar el estado:', err);
            marcar('No se pudo guardar el estado');
          }
        }

        async function cargarEstado(slot, silencioso) {
          try {
            var res = await fetch(ESTADO_URL + '/' + slot, { credentials: 'same-origin' });
            if (!res.ok) {
              if (!silencioso) marcar('Esa ranura está vacía');
              return false;
            }
            var datos = new Uint8Array(await res.arrayBuffer());
            var g = gm();
            if (!g || !datos.length) return false;
            g.loadState(datos);
            slotActivo = slot;
            pintarEstados();
            marcar('Estado ' + slot + ' cargado');
            return true;
          } catch (err) {
            console.error('No se pudo cargar el estado:', err);
            if (!silencioso) marcar('No se pudo cargar el estado');
            return false;
          }
        }

        async function borrarEstado(slot) {
          if (!window.confirm('¿Borrar el estado de la ranura ' + slot + '?')) return;
          try {
            await fetch(ESTADO_URL + '/' + slot, {
              method: 'DELETE', credentials: 'same-origin',
            });
            await refrescarEstados();
            marcar('Estado ' + slot + ' borrado');
          } catch (err) {
            console.error('No se pudo borrar el estado:', err);
          }
        }

        if (rejilla) {
          rejilla.addEventListener('click', function (ev) {
            var btn = ev.target.closest('button[data-accion]');
            if (!btn) return;
            var slot = Number(btn.dataset.slot);
            if (btn.dataset.accion === 'guardar') guardarEstado(slot);
            else if (btn.dataset.accion === 'cargar') cargarEstado(slot);
            else if (btn.dataset.accion === 'borrar') borrarEstado(slot);
          });
        }

        function alternarPanel(abrir) {
          if (!panel || !btnEstados) return;
          var mostrar = abrir === undefined ? panel.hidden : abrir;
          panel.hidden = !mostrar;
          btnEstados.setAttribute('aria-expanded', String(mostrar));
        }

        if (btnEstados) btnEstados.addEventListener('click', function () { alternarPanel(); });
        var cerrarEstados = document.getElementById('estados-cerrar');
        if (cerrarEstados) cerrarEstados.addEventListener('click', function () { alternarPanel(false); });

        /*
         * Los botones de guardar y cargar estado de la barra de EmulatorJS: al
         * haber un listener, el emulador cancela su descarga o su selector de
         * fichero y el estado viaja al servidor, a la ranura activa.
         */
        window.EJS_onSaveState = function (evento) { guardarEstado(slotActivo, evento); };
        window.EJS_onLoadState = function () { cargarEstado(slotActivo); };

        // El boton propio de EmulatorJS: al haber listener, cancela su descarga
        // y guardamos en el servidor.
        window.EJS_onSaveSave = function () { guardar('boton'); };

        window.EJS_onGameStart = function () {
          vigilarMenu();
          contabilizarApertura();
          (async function () {
            await resolverPartida();
            /*
             * Retomar donde se dejo: se carga la ranura mas reciente. Solo si es
             * posterior al guardado del propio juego, porque si no, quien haya
             * guardado dentro del juego y no en un estado veria su avance
             * sustituido por una foto vieja al volver a entrar.
             */
            var reciente = masReciente();
            if (reciente && reciente.fecha >= SAVE_FECHA) {
              await new Promise(function (r) { setTimeout(r, 400); });
              await cargarEstado(reciente.slot, true);
            }
          })();
        };

        setInterval(function () { guardar('periodico'); }, 30000);

        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'hidden') guardar('oculto');
        });

        window.addEventListener('pagehide', function () {
          guardarAlSalir();
          enviarTiempo(acumulado, true);
          acumulado = 0;
        });

        /*
         * Arranque: primero se trae la partida del servidor y solo despues se
         * carga el emulador, para que su disco de partidas ya tenga la memoria
         * puesta cuando monte el sistema de ficheros. Cargar loader.js antes
         * seria volver a la carrera que hacia perder partidas.
         */
        var enganchado = false;
        function engancharDisco() {
          if (enganchado) return;
          var e = window.EJS_emulator;
          if (!e || typeof e.on !== 'function') return;
          enganchado = true;
          e.on('saveDatabaseLoaded', inyectarAntesDeArrancar);
        }
        window.EJS_ready = engancharDisco;

        (async function arrancar() {
          pintarEstados();
          sramServidor = await descargarSram();

          // "ready" deberia llegar mucho antes de que el disco se monte, pero el
          // margen depende de lo que tarde en descargarse el core: este sondeo
          // asegura el enganche pase lo que pase.
          var espera = setInterval(function () {
            engancharDisco();
            if (enganchado) clearInterval(espera);
          }, 10);

          var s = document.createElement('script');
          s.src = '/data/loader.js';
          document.body.appendChild(s);
        })();
      })();
    </script>`,
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

// Para las rutas que reciben JSON pequeño (metadatos, estadísticas, usuarios).
// Declarado aquí y no junto a su primera ruta: las rutas se registran en orden
// al cargar el módulo, y una const posterior aún estaría sin inicializar.
const jsonPequeno = express.json({ limit: '2kb' });

/*
 * Los cores de EmulatorJS pesan cientos de KB cada uno y no cambian nunca
 * dentro de una misma versión: un año e immutable ahorra volver a bajarlos.
 */
app.use('/data', express.static(path.join(__dirname, 'data'), {
  maxAge: '1y',
  immutable: true,
  setHeaders: (res) => res.setHeader('Cross-Origin-Resource-Policy', 'same-origin'),
}));

// Sirve con ?v=<mtime>, así que también puede cachearse un año.
app.use('/static', express.static(path.join(__dirname, 'public'), {
  maxAge: '1y',
  immutable: true,
}));

// Portadas y animaciones de consolas y juegos. También versionadas por mtime.
app.use('/media', express.static(MEDIA_ROOT, {
  maxAge: '1y',
  immutable: true,
  setHeaders: (res) => res.setHeader('Cross-Origin-Resource-Policy', 'same-origin'),
}));

/*
 * Todo el HTML de aquí es de un usuario concreto: listados de sus partidas,
 * su nombre en la cabecera. No debe quedarse en ninguna caché intermedia,
 * y menos en la de Cloudflare.
 */
app.use((req, res, next) => {
  if (!req.path.startsWith('/data/') && !req.path.startsWith('/static/')) {
    res.set('Cache-Control', 'private, no-store');
  }
  next();
});

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

  // Se anota el acceso para que la pantalla de gestión pueda mostrarlo.
  const todos = loadUsers();
  if (todos[nombre]) {
    todos[nombre].ultimoAcceso = new Date().toISOString();
    guardarUsuarios(todos).catch((err) => console.error(`Anotando acceso: ${err.message}`));
  }

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

// ─── alta de usuarios ────────────────────────────────────────────────────────

const ponerSesion = (res, usuario) => res.cookie(COOKIE, createSession(usuario), {
  httpOnly: true, secure: true, sameSite: 'lax', maxAge: SESSION_DAYS * 864e5, path: '/',
});

app.get('/registro', (req, res) => {
  if (readSession(req)) return res.redirect('/');
  res.type('html').send(registroPage(null, null));
});

app.post('/registro', formulario, async (req, res) => {
  const ip = req.headers['x-real-ip'] || req.ip || 'desconocida';
  const enviado = {
    nombre: String((req.body || {}).nombre || '').trim(),
    username: String((req.body || {}).username || '').trim(),
  };
  const fallo = (msg, codigo) => res.status(codigo || 400).type('html')
    .send(registroPage(msg, enviado));

  if (!CLAVE_REGISTRO) {
    return fallo('El registro está cerrado: falta configurar la clave en el servidor.', 503);
  }
  // El mismo freno que el login: la clave compartida es adivinable a fuerza bruta.
  if (tooManyAttempts(ip)) {
    return fallo('Demasiados intentos fallidos. Espera unos minutos.', 429);
  }

  const password = String((req.body || {}).password || '');
  const clave = String((req.body || {}).clave || '');

  const esperada = Buffer.from(CLAVE_REGISTRO);
  const recibida = Buffer.from(clave);
  const claveOk = esperada.length === recibida.length &&
                  crypto.timingSafeEqual(esperada, recibida);
  if (!claveOk) {
    noteAttempt(ip);
    return fallo('La contraseña de administrador no es correcta.', 401);
  }

  if (!enviado.nombre) return fallo('Pon tu nombre y apellidos.');
  if (!USUARIO_VALIDO.test(enviado.username)) {
    return fallo('El usuario debe tener entre 3 y 24 caracteres: letras, números, punto, guion o guion bajo.');
  }
  if (password.length < 8) return fallo('La contraseña debe tener al menos 8 caracteres.');
  if (password !== String((req.body || {}).password2 || '')) {
    return fallo('Las dos contraseñas no coinciden.');
  }

  const users = loadUsers();
  // Sin distinguir mayúsculas: "Ana" y "ana" serían dos rutas distintas en disco
  // pero la misma persona a ojos de cualquiera.
  const existe = Object.keys(users).some((u) => u.toLowerCase() === enviado.username.toLowerCase());
  if (existe) return fallo('Ese usuario ya está cogido.');

  users[enviado.username] = {
    ...nuevoHash(password),
    nombre: enviado.nombre,
    rol: 'usuario',
    creado: new Date().toISOString(),
  };
  await guardarUsuarios(users);
  attempts.delete(ip);

  ponerSesion(res, enviado.username);
  res.redirect('/');
});

// ─── perfil ──────────────────────────────────────────────────────────────────

app.get('/perfil', requireAuth, (req, res) => {
  res.type('html').send(perfilPage(req.user, req.query.ok ? 'Cambios guardados.' : null, null));
});

app.post('/perfil/datos', requireAuth, formulario, async (req, res) => {
  const users = loadUsers();
  const actual = req.user;
  const nombre = String((req.body || {}).nombre || '').trim().slice(0, 80);
  const nuevo = String((req.body || {}).usuario || '').trim();

  if (nuevo !== actual) {
    if (!USUARIO_VALIDO.test(nuevo)) {
      return res.status(400).type('html').send(
        perfilPage(actual, null, 'El usuario debe tener entre 3 y 24 caracteres: letras, números, punto, guion o guion bajo.')
      );
    }
    const chocan = Object.keys(users).some((u) => u.toLowerCase() === nuevo.toLowerCase());
    if (chocan) {
      return res.status(400).type('html').send(perfilPage(actual, null, 'Ese usuario ya está cogido.'));
    }

    /*
     * El nombre de usuario forma parte de rutas en disco, así que renombrarlo
     * arrastra sus partidas y su foto. Se mueve todo antes de tocar users.json:
     * si algo falla a medias, el usuario sigue existiendo con su nombre viejo
     * y sus datos intactos.
     */
    try {
      await renombrarUsuario(actual, nuevo);
    } catch (err) {
      console.error(`Renombrando ${actual} -> ${nuevo}: ${err.message}`);
      return res.status(500).type('html').send(
        perfilPage(actual, null, 'No se pudieron mover tus datos; no se ha cambiado nada.')
      );
    }

    users[nuevo] = { ...users[actual], nombre: nombre || users[actual].nombre };
    delete users[actual];
    await guardarUsuarios(users);

    // La sesión lleva el nombre dentro: hay que reemitirla o quedaría huérfana.
    ponerSesion(res, nuevo);
    return res.redirect('/perfil?ok=1');
  }

  users[actual] = { ...users[actual], nombre };
  await guardarUsuarios(users);
  res.redirect('/perfil?ok=1');
});

app.post('/perfil/clave', requireAuth, formulario, async (req, res) => {
  const users = loadUsers();
  const yo = users[req.user];
  const actual = String((req.body || {}).actual || '');
  const nueva = String((req.body || {}).nueva || '');

  if (!verifyPassword(actual, yo)) {
    return res.status(401).type('html').send(
      perfilPage(req.user, null, 'La contraseña actual no es correcta.')
    );
  }
  if (nueva.length < 8) {
    return res.status(400).type('html').send(
      perfilPage(req.user, null, 'La contraseña nueva debe tener al menos 8 caracteres.')
    );
  }
  if (nueva !== String((req.body || {}).nueva2 || '')) {
    return res.status(400).type('html').send(
      perfilPage(req.user, null, 'Las dos contraseñas nuevas no coinciden.')
    );
  }

  users[req.user] = { ...yo, ...nuevoHash(nueva) };
  await guardarUsuarios(users);
  res.redirect('/perfil?ok=1');
});

app.put('/api/foto/:archivo', requireAuth, async (req, res) => {
  await recibirMedia(req, res, { subdir: 'perfiles', base: req.user, tipo: 'portada' });
});

// ─── API: gestión de usuarios (admin) ────────────────────────────────────────

app.put('/api/usuario/:nombre', requireAuth, requireAdmin, jsonPequeno, async (req, res) => {
  const users = loadUsers();
  const actual = req.params.nombre;
  if (!users[actual]) return res.status(404).json({ error: 'ese usuario no existe' });

  const { rol, usuario, nombre, password, password2 } = req.body || {};
  const destino = String(usuario || actual).trim();
  const rolNuevo = rol === 'admin' ? 'admin' : 'usuario';

  const rolViejo = users[actual].rol === 'admin' ? 'admin' : 'usuario';

  /*
   * Nadie se quita a sí mismo el rol de administrador. Sonaría inofensivo con
   * otro admin existiendo, pero el efecto es inmediato: la siguiente petición
   * ya sería un 403 y habría que entrar con la otra cuenta para deshacerlo.
   * Que lo haga otro administrador.
   */
  if (actual === req.user && rolNuevo !== rolViejo) {
    return res.status(409).json({ error: 'no puedes cambiar tu propio rol; que lo haga otro administrador' });
  }

  /*
   * Y si este era el último administrador, degradarle dejaría el sitio sin
   * nadie capaz de gestionar: ni roles, ni juegos, ni imágenes.
   */
  if (rolViejo === 'admin' && rolNuevo !== 'admin' && cuentaAdmins(users) === 1) {
    return res.status(409).json({ error: 'es el último administrador; asciende antes a otro' });
  }

  if (destino !== actual) {
    if (!USUARIO_VALIDO.test(destino)) {
      return res.status(400).json({ error: 'el usuario debe tener entre 3 y 24 caracteres: letras, números, punto, guion o guion bajo' });
    }
    if (Object.keys(users).some((u) => u.toLowerCase() === destino.toLowerCase())) {
      return res.status(409).json({ error: 'ese nombre de usuario ya está cogido' });
    }
  }

  let credenciales = null;
  if (password) {
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'la contraseña debe tener al menos 8 caracteres' });
    }
    if (password2 !== undefined && password !== password2) {
      return res.status(400).json({ error: 'las dos contraseñas no coinciden' });
    }
    credenciales = nuevoHash(String(password));
  }

  if (destino !== actual) {
    try {
      await renombrarUsuario(actual, destino);
    } catch (err) {
      console.error(`Renombrando ${actual} -> ${destino}: ${err.message}`);
      return res.status(500).json({ error: 'no se pudieron mover sus datos; no se ha cambiado nada' });
    }
  }

  const ficha = { ...users[actual], rol: rolNuevo };
  if (nombre !== undefined) ficha.nombre = String(nombre).slice(0, 80).trim();
  if (credenciales) Object.assign(ficha, credenciales);

  delete users[actual];
  users[destino] = ficha;
  await guardarUsuarios(users);

  // Si un admin se renombra a sí mismo, su cookie lleva el nombre viejo dentro
  // y dejaría de valer en la siguiente petición.
  const eraYo = actual === req.user;
  if (eraYo && destino !== actual) ponerSesion(res, destino);

  res.json({ ok: true, usuario: destino, rol: rolNuevo, sesionRenovada: eraYo && destino !== actual });
});

app.get('/', requireAuth, async (req, res) => {
  const systems = loadSystems();
  const counts = {};
  const juegos = [];

  // Se recorre una sola vez: de aquí salen el contador de cada consola y el
  // catálogo completo que alimenta el buscador.
  for (const s of systems) {
    const roms = await listRoms(s.id);
    counts[s.id] = roms.length;
    for (const r of roms) {
      juegos.push({
        sistemaId: s.id,
        sistema: s.name,
        rom: r.name,
        nombre: metaJuego(s.id, r.name).nombre,
        portada: portadaJuego(s.id, r.name),
        anim: animacionJuego(s.id, r.name),
      });
    }
  }
  juegos.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

  res.type('html').send(indexPage(req.user, systems, counts, juegos));
});

app.get('/controles', requireAuth, (req, res) => {
  res.type('html').send(controlsPage(req.user));
});

app.get('/estadisticas', requireAuth, (req, res) => {
  res.type('html').send(estadisticasPage(req.user));
});

app.get('/gestion', requireAuth, requireAdmin, (req, res) => {
  res.type('html').send(gestionPage(req.user));
});

// ─── API: registro de uso ────────────────────────────────────────────────────

app.post('/api/stats/abrir/:id/:rom', requireAuth, async (req, res) => {
  const system = findSystem(req.params.id);
  if (!system) return res.status(404).json({ error: 'sistema desconocido' });
  const rom = await resolveRom(system.id, req.params.rom);
  if (!rom) return res.status(404).json({ error: 'juego desconocido' });
  await anotarUso(req.user, system.id, rom.name, { veces: 1 });
  res.json({ ok: true });
});

app.post('/api/stats/tiempo/:id/:rom', requireAuth, jsonPequeno, async (req, res) => {
  const system = findSystem(req.params.id);
  if (!system) return res.status(404).json({ error: 'sistema desconocido' });
  const rom = await resolveRom(system.id, req.params.rom);
  if (!rom) return res.status(404).json({ error: 'juego desconocido' });

  // Tope defensivo: un cliente manipulado no debe poder inflar el contador.
  const segundos = Math.max(0, Math.min(300, Number((req.body || {}).segundos) || 0));
  if (segundos > 0) await anotarUso(req.user, system.id, rom.name, { segundos });
  res.json({ ok: true, segundos });
});

app.get('/system/:id', requireAuth, async (req, res) => {
  const system = findSystem(req.params.id);
  if (!system) return res.redirect('/');
  res.type('html').send(
    systemPage(req.user, system, await listRoms(system.id), esAdmin(req.user))
  );
});

app.get('/play/:id/:rom', requireAuth, async (req, res) => {
  const system = findSystem(req.params.id);
  if (!system) return res.redirect('/');
  const rom = await resolveRom(system.id, req.params.rom);
  if (!rom) return res.redirect(`/system/${encodeURIComponent(system.id)}`);
  /*
   * Un .srm en blanco no cuenta como partida: anunciarlo confunde, porque el
   * juego arrancaria igualmente sin nada que continuar. Quedan del fallo que
   * subia la memoria virgen encima de la buena.
   */
  let saveFecha = 0;
  try {
    const file = savePath(req.user, system.id, rom.name);
    const stat = await fsp.stat(file);
    if (!partidaVacia(await fsp.readFile(file))) saveFecha = Math.round(stat.mtimeMs);
  } catch { /* aun no hay partida */ }
  const estados = await listarEstados(req.user, system.id, rom.name);
  res.type('html').send(playPage(req.user, system, rom, saveFecha > 0, estados, saveFecha));
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
app.put('/api/rom/:id/:rom', requireAuth, requireAdmin, async (req, res) => {
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

// ─── API: apariencia de consolas y juegos ────────────────────────────────────

/*
 * Consolas y juegos guardan su imagen igual, solo cambia el directorio y el
 * nombre base, así que comparten esta función.
 */
async function recibirMedia(req, res, { subdir, base, tipo }) {
  const spec = TIPOS_MEDIA[tipo];
  if (!spec) {
    return res.status(400).json({ error: `tipo debe ser uno de: ${Object.keys(TIPOS_MEDIA).join(', ')}` });
  }

  const permitidas = spec.extensiones;
  const ext = path.extname(safeName(req.params.archivo)).toLowerCase();
  if (!permitidas.includes(ext)) {
    return res.status(400).json({ error: `${ext || 'sin extension'} no vale aqui; admitidas: ${permitidas.join(' ')}` });
  }

  const largo = Number(req.headers['content-length'] || 0);
  if (largo > MAX_MEDIA_BYTES) {
    return res.status(413).json({ error: `maximo ${Math.round(MAX_MEDIA_BYTES / 1048576)} MB` });
  }

  const dir = path.join(MEDIA_ROOT, subdir);
  await fsp.mkdir(dir, { recursive: true });

  /*
   * Solo puede haber una portada y una animación de cada cosa. Si antes había
   * un .png y ahora llega un .jpg hay que retirar el viejo: si no quedarían los
   * dos y buscarMedia elegiría el primero de la lista, no el recién subido.
   */
  const nombre = safeName(base) + spec.sufijo;
  for (const e of permitidas) {
    if (e === ext) continue;
    try { await fsp.unlink(path.join(dir, nombre + e)); } catch { /* no existia */ }
  }

  const destino = path.join(dir, nombre + ext);
  const temporal = `${destino}.subiendo`;
  const salida = fs.createWriteStream(temporal);
  req.pipe(salida);

  salida.on('error', async (err) => {
    try { await fsp.unlink(temporal); } catch {}
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });

  salida.on('finish', async () => {
    try {
      await fsp.rename(temporal, destino);
      const st = await fsp.stat(destino);
      res.json({ ok: true, archivo: nombre + ext, bytes: st.size });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

app.put('/api/media/:id/:tipo/:archivo', requireAuth, requireAdmin, async (req, res) => {
  const system = findSystem(req.params.id);
  if (!system) return res.status(404).json({ error: 'sistema desconocido' });
  await recibirMedia(req, res, { subdir: 'consolas', base: system.id, tipo: req.params.tipo });
});

app.put('/api/juego-media/:id/:rom/:tipo/:archivo', requireAuth, requireAdmin, async (req, res) => {
  const system = findSystem(req.params.id);
  if (!system) return res.status(404).json({ error: 'sistema desconocido' });
  const rom = await resolveRom(system.id, req.params.rom);
  if (!rom) return res.status(404).json({ error: 'sube antes la ROM' });
  await recibirMedia(req, res, {
    subdir: dirJuego(system.id),
    base: romBase(rom.name),
    tipo: req.params.tipo,
  });
});

// ─── API: reemplazar la ROM de un juego ──────────────────────────────────────

/*
 * Si el fichero nuevo se llama distinto, el juego cambia de identidad: su clave
 * es <sistema>/<fichero>. Hay que arrastrar metadatos, estadísticas, imágenes y
 * las partidas de TODOS los usuarios, o quedarían huérfanas apuntando a un
 * nombre que ya no existe.
 */
async function migrarJuego(systemId, viejo, nuevo) {
  if (viejo === nuevo) return;
  const baseViejo = romBase(viejo);
  const baseNuevo = romBase(nuevo);

  const juegos = loadJuegos();
  const cv = claveJuego(systemId, viejo);
  const cn = claveJuego(systemId, nuevo);
  if (juegos[cv]) {
    juegos[cn] = juegos[cv];
    delete juegos[cv];
    const tmp = `${JUEGOS_FILE}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(juegos, null, 2) + '\n');
    await fsp.rename(tmp, JUEGOS_FILE);
  }

  const stats = loadEstadisticas();
  let tocado = false;
  for (const usuario of Object.keys(stats)) {
    if (stats[usuario][cv]) {
      stats[usuario][cn] = stats[usuario][cv];
      delete stats[usuario][cv];
      tocado = true;
    }
  }
  if (tocado) {
    const tmp = `${ESTADISTICAS_FILE}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(stats, null, 2) + '\n');
    await fsp.rename(tmp, ESTADISTICAS_FILE);
  }

  const dirMedia = path.join(MEDIA_ROOT, dirJuego(systemId));
  for (const spec of Object.values(TIPOS_MEDIA)) {
    for (const ext of spec.extensiones) {
      const origen = path.join(dirMedia, baseViejo + spec.sufijo + ext);
      if (fs.existsSync(origen)) {
        await fsp.rename(origen, path.join(dirMedia, baseNuevo + spec.sufijo + ext));
      }
    }
  }

  // Las partidas viven bajo cada usuario, así que hay que recorrerlos todos.
  // Se mueven la SRAM, su copia de seguridad y las nueve ranuras de estado con
  // sus miniaturas: lo que se quede atrás deja de encontrarse para siempre.
  try {
    for (const usuario of await fsp.readdir(SAVES_DIR)) {
      const dir = path.join(SAVES_DIR, usuario, safeName(systemId));
      const mover = async (carpeta, viejoRel, nuevoRel) => {
        const origen = path.join(carpeta, viejoRel);
        if (fs.existsSync(origen)) {
          await fsp.mkdir(carpeta, { recursive: true });
          await fsp.rename(origen, path.join(carpeta, nuevoRel));
        }
      };

      await mover(dir, `${baseViejo}.srm`, `${baseNuevo}.srm`);
      await mover(dir, `${baseViejo}.srm.bak`, `${baseNuevo}.srm.bak`);

      const dirEstados = path.join(dir, 'estados');
      for (let slot = 1; slot <= SLOTS_ESTADO; slot++) {
        for (const ext of ['state', 'png']) {
          await mover(dirEstados, `${baseViejo}.${slot}.${ext}`, `${baseNuevo}.${slot}.${ext}`);
        }
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

app.put('/api/rom-reemplazar/:id/:rom/:archivo', requireAuth, requireAdmin, async (req, res) => {
  const system = findSystem(req.params.id);
  if (!system) return res.status(404).json({ error: 'sistema desconocido' });
  const viejo = await resolveRom(system.id, req.params.rom);
  if (!viejo) return res.status(404).json({ error: 'juego desconocido' });

  const nombre = safeName(req.params.archivo);
  const ext = path.extname(nombre).toLowerCase();
  const permitidas = (system.extensions || []).map((e) => e.toLowerCase());
  if (permitidas.length && !permitidas.includes(ext)) {
    return res.status(400).json({ error: `extension ${ext} no admitida por ${system.name}` });
  }
  if (nombre !== viejo.name) {
    const yaHay = await resolveRom(system.id, nombre);
    if (yaHay) return res.status(409).json({ error: 'ya existe otro juego con ese nombre de fichero' });
  }

  const dir = path.join(ROMS_DIR, safeName(system.id));
  const destino = path.join(dir, nombre);
  const temporal = `${destino}.subiendo`;
  const salida = fs.createWriteStream(temporal);
  req.pipe(salida);

  salida.on('error', async (err) => {
    try { await fsp.unlink(temporal); } catch {}
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });

  salida.on('finish', async () => {
    try {
      await fsp.rename(temporal, destino);
      if (nombre !== viejo.name) {
        await migrarJuego(system.id, viejo.name, nombre);
        await fsp.unlink(viejo.path);      // la ROM antigua ya no pinta nada
      }
      res.json({ ok: true, name: nombre, renombrado: nombre !== viejo.name });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
});

// ─── API: nombre y descripción de un juego ───────────────────────────────────

app.put('/api/juego-meta/:id/:rom',
  requireAuth,
  requireAdmin,
  express.json({ limit: '8kb' }),
  async (req, res) => {
    const system = findSystem(req.params.id);
    if (!system) return res.status(404).json({ error: 'sistema desconocido' });
    const rom = await resolveRom(system.id, req.params.rom);
    if (!rom) return res.status(404).json({ error: 'juego desconocido' });

    const { nombre, descripcion } = req.body || {};
    await guardarMetaJuego(system.id, rom.name, { nombre, descripcion });
    res.json({ ok: true, ...metaJuego(system.id, rom.name) });
  }
);

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

/*
 * Guardar la SRAM. Con dos redes de seguridad, aprendidas por las malas: se
 * perdieron partidas porque el emulador subia su memoria en blanco encima de
 * una buena cada vez que arrancaba sin haber restaurado.
 *
 *  1. Nunca se sobrescribe una partida con contenido por una vacia. El cliente
 *     ya evita mandarla, pero la guardia vive aqui porque es el ultimo sitio
 *     donde todavia se puede salvar el fichero.
 *  2. La version anterior queda en un .bak antes de cada sobrescritura, asi que
 *     una partida pisada por error siempre se puede recuperar.
 */
async function guardarSram(req, res) {
  const system = findSystem(req.params.id);
  if (!system) return res.status(404).json({ error: 'sistema desconocido' });
  const rom = await resolveRom(system.id, req.params.rom);
  if (!rom) return res.status(404).json({ error: 'juego desconocido' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error: 'cuerpo vacio' });
  }

  const file = savePath(req.user, system.id, rom.name);
  let previa = null;
  try { previa = await fsp.readFile(file); } catch { /* aun no habia partida */ }

  if (previa && partidaVacia(req.body) && !partidaVacia(previa)) {
    console.warn(
      `Rechazada partida en blanco de ${req.user} para ${system.id}/${rom.name}`
    );
    return res.status(409).json({ error: 'la partida recibida esta en blanco' });
  }

  if (previa && !previa.equals(req.body)) {
    await fsp.writeFile(`${file}.bak`, previa);
  }
  await escribirAtomico(file, req.body);

  res.json({ ok: true, bytes: req.body.length });
}

app.put('/api/save/:id/:rom',
  requireAuth,
  express.raw({ type: '*/*', limit: MAX_SAVE_BYTES }),
  guardarSram
);

/*
 * Mismo handler por POST: al cerrar la pestaña un fetch se cancela a medias y
 * el ultimo guardado se pierde. sendBeacon sobrevive a la pagina, pero solo
 * sabe hacer POST.
 */
app.post('/api/save/:id/:rom',
  requireAuth,
  express.raw({ type: '*/*', limit: MAX_SAVE_BYTES }),
  guardarSram
);

// ─── API: estados guardados ──────────────────────────────────────────────────

app.get('/api/estados/:id/:rom', requireAuth, async (req, res) => {
  const system = findSystem(req.params.id);
  if (!system) return res.status(404).json({ error: 'sistema desconocido' });
  const rom = await resolveRom(system.id, req.params.rom);
  if (!rom) return res.status(404).json({ error: 'juego desconocido' });
  res.set('Cache-Control', 'no-store');
  res.json({ slots: SLOTS_ESTADO, estados: await listarEstados(req.user, system.id, rom.name) });
});

app.get('/api/estado/:id/:rom/:slot', requireAuth, async (req, res) => {
  const system = findSystem(req.params.id);
  if (!system) return res.status(404).end();
  const rom = await resolveRom(system.id, req.params.rom);
  if (!rom) return res.status(404).end();
  const slot = parseSlot(req.params.slot);
  if (!slot) return res.status(400).json({ error: 'ranura invalida' });

  const file = statePath(req.user, system.id, rom.name, slot);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'ranura vacia' });

  if (req.query.descarga) {
    return res.download(file, `${romBase(rom.name)}.${slot}.state`);
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(file);
});

app.get('/api/estado/:id/:rom/:slot/miniatura', requireAuth, async (req, res) => {
  const system = findSystem(req.params.id);
  if (!system) return res.status(404).end();
  const rom = await resolveRom(system.id, req.params.rom);
  if (!rom) return res.status(404).end();
  const slot = parseSlot(req.params.slot);
  if (!slot) return res.status(400).end();

  const file = statePath(req.user, system.id, rom.name, slot, 'png');
  if (!fs.existsSync(file)) return res.status(404).end();
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(file);
});

app.put('/api/estado/:id/:rom/:slot',
  requireAuth,
  express.raw({ type: '*/*', limit: MAX_STATE_BYTES }),
  async (req, res) => {
    const system = findSystem(req.params.id);
    if (!system) return res.status(404).json({ error: 'sistema desconocido' });
    const rom = await resolveRom(system.id, req.params.rom);
    if (!rom) return res.status(404).json({ error: 'juego desconocido' });
    const slot = parseSlot(req.params.slot);
    if (!slot) return res.status(400).json({ error: 'ranura invalida' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: 'cuerpo vacio' });
    }

    await escribirAtomico(statePath(req.user, system.id, rom.name, slot), req.body);
    res.json({ ok: true, slot, bytes: req.body.length, fecha: Date.now() });
  }
);

/*
 * La miniatura viaja aparte del estado: son dos binarios y mezclarlos en una
 * sola peticion obligaria a un multipart que aqui no aporta nada. Si falla, el
 * estado sigue siendo valido y la ranura se ve sin imagen.
 */
app.put('/api/estado/:id/:rom/:slot/miniatura',
  requireAuth,
  express.raw({ type: '*/*', limit: MAX_MINIATURA_BYTES }),
  async (req, res) => {
    const system = findSystem(req.params.id);
    if (!system) return res.status(404).json({ error: 'sistema desconocido' });
    const rom = await resolveRom(system.id, req.params.rom);
    if (!rom) return res.status(404).json({ error: 'juego desconocido' });
    const slot = parseSlot(req.params.slot);
    if (!slot) return res.status(400).json({ error: 'ranura invalida' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: 'cuerpo vacio' });
    }
    // Solo PNG: es lo que produce la captura de EmulatorJS y evita servir como
    // imagen cualquier cosa que llegue por esta ruta.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    if (!req.body.subarray(0, 4).equals(png)) {
      return res.status(400).json({ error: 'la miniatura debe ser PNG' });
    }

    await escribirAtomico(statePath(req.user, system.id, rom.name, slot, 'png'), req.body);
    res.json({ ok: true, slot });
  }
);

app.delete('/api/estado/:id/:rom/:slot', requireAuth, async (req, res) => {
  const system = findSystem(req.params.id);
  if (!system) return res.status(404).json({ error: 'sistema desconocido' });
  const rom = await resolveRom(system.id, req.params.rom);
  if (!rom) return res.status(404).json({ error: 'juego desconocido' });
  const slot = parseSlot(req.params.slot);
  if (!slot) return res.status(400).json({ error: 'ranura invalida' });

  for (const ext of ['state', 'png']) {
    try {
      await fsp.unlink(statePath(req.user, system.id, rom.name, slot, ext));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  res.json({ ok: true, slot });
});

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
