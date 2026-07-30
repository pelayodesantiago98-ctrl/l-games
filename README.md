# L-games

Emuladores de consola en el navegador, con acceso restringido. Envuelve
[EmulatorJS](https://emulatorjs.org) (cores de libretro compilados a
WebAssembly) en una app Express con login.

En producción: `l-games.lepayimio.es`. La configuración del servidor vive en el
repositorio **lepayimio-infra**.

## ROMs y partidas

Las ROMs se alojan en el servidor, en `roms/<sistema>/`, y se suben desde la
propia web. La subida va por `PUT` en streaming directo a disco: el fichero no
pasa por memoria, así que una imagen de CD de 700 MB no infla el proceso. Se
escribe a un temporal y se renombra al terminar, de modo que una subida cortada
nunca deja un fichero a medias.

**Las ROMs son compartidas entre usuarios; las partidas no.** Cada usuario tiene
las suyas en `saves/<usuario>/<sistema>/<juego>.srm`.

### Cómo se guardan las partidas

La SRAM se sincroniza con el servidor en tres momentos: cada 30 segundos, al
ocultarse la pestaña y al cerrarla. Se calcula una huella barata del contenido
para no subir nada si la partida no ha cambiado.

Al arrancar un juego se recupera la partida del servidor y se inyecta en el
emulador:

```js
gameManager.saveSaveFiles();                              // asegura la ruta
gameManager.FS.writeFile(gameManager.getSaveFilePath(), datos);
gameManager.loadSaveFiles();
```

También se puede **exportar** el `.srm` a disco e **importar** uno externo, que
se sube al servidor y se inyecta en la partida en curso sin recargar.

El botón nativo de guardado de EmulatorJS queda interceptado mediante
`EJS_onSaveSave`: cuando ese evento tiene algún listener, la librería cancela su
descarga a disco, y aprovechamos para guardar en el servidor.

### Seguridad de las rutas

Ni las ROMs ni las partidas se localizan concatenando lo que manda el cliente.
Se lista el directorio y se busca una coincidencia **exacta**; si no aparece,
404. Aunque el saneador de nombres fallara, no hay forma de salir del directorio.

Un detalle que costó un bug: `express.urlencoded` **no** puede montarse global.
Los clientes que suben un fichero sin `Content-Type` caen por defecto en
`application/x-www-form-urlencoded`, y el parser rechazaría la ROM por tamaño
antes de llegar al handler. Va montado solo en la ruta de login.

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
