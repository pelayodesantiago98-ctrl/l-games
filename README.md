# L-games

Emuladores de consola en el navegador, con acceso restringido. Envuelve
[EmulatorJS](https://emulatorjs.org) (cores de libretro compilados a
WebAssembly) en una app Express con login.

En producción: `l-games.lepayimio.es`. La configuración del servidor vive en el
repositorio **lepayimio-infra**.

## No se alojan ROMs

Cada consola abre un selector de fichero y el juego se carga desde el
dispositivo del usuario como un blob local. **Nada se sube al servidor.** Es una
decisión deliberada: mantiene el proyecto limpio legalmente y evita almacenar
gigabytes.

## Sistemas

Los 14 sistemas están definidos en `config/systems.json`. Añadir uno es añadir
un objeto al array:

```json
{
  "id": "gba",
  "name": "Game Boy Advance",
  "fullName": "Nintendo Game Boy Advance",
  "core": "gba",
  "year": "2001",
  "extensions": [".gba", ".zip"],
  "note": ""
}
```

El fichero se relee en cada petición: **no hace falta reiniciar el servicio**.

- Los identificadores válidos de `core` se pueden verificar buscándolos dentro
  de `data/emulator.min.js`.
- El mapeo entre core y extensiones soportadas está en `data/cores/cores.json`.

## Acceso

Login con sesión por cookie firmada (HMAC-SHA256) y contraseñas con `scrypt`,
ambas del módulo `crypto` de Node — sin dependencias externas para la parte
sensible. No hay registro público.

```bash
node adduser.js <usuario> <contraseña>
chown www-data:www-data config/users.json
```

Los usuarios se releen en cada petición. Para invalidar todas las sesiones
abiertas hay que rotar `SESSION_SECRET` en `.env`.

Hay un freno de fuerza bruta de 10 intentos por IP cada 15 minutos. Detrás de
Cloudflare, nginx debe pasar la IP real en `X-Real-IP` desde `CF-Connecting-IP`;
si se pasa `$remote_addr` el límite agrupa a todos los visitantes en unas pocas
IPs del edge y deja de servir.

## Los cores no están en el repositorio

Pesan 296 MB. Se obtienen de la release oficial de EmulatorJS:

```bash
curl -fL -o ejs.7z https://github.com/EmulatorJS/EmulatorJS/releases/download/v4.2.3/4.2.3.7z
7z x ejs.7z
cp -r data /var/www/l-games/data
```

## Cabeceras obligatorias

La página necesita `Cross-Origin-Opener-Policy: same-origin` y
`Cross-Origin-Embedder-Policy: require-corp`. Sin ellas el navegador no expone
`SharedArrayBuffer` y **los cores con hilos fallan sin mensaje claro**.

Efecto secundario: bajo ese aislamiento no se puede cargar ningún recurso de
otro origen que no envíe `Cross-Origin-Resource-Policy`. Los ficheros propios se
sirven con esa cabecera desde Express.

## Puesta en marcha

```bash
npm install --omit=dev
printf 'SESSION_SECRET=%s\n' "$(head -c 48 /dev/urandom | base64 | tr -d '\n')" > .env
chmod 600 .env
node adduser.js <usuario> <contraseña>
node server.js          # escucha en 127.0.0.1:3001
```

Variables de entorno: `SESSION_SECRET` (obligatoria), `HOST` y `PORT`.
