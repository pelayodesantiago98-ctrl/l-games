# Mover las ROMs fuera del VPS

Las ROMs son lo único de L-games que crece sin techo. Los cores son 300 MB fijos
y las portadas unas decenas de megas, pero un catálogo de ROMs se come el disco
entero: un set de GBA ronda los 25 GB y uno de PS1 pasa de 400.

Por eso el directorio de ROMs es configurable y todo lo demás no.

## Qué se mueve y qué no

| | Dónde | Por qué |
|---|---|---|
| ROMs | Fuera | Grandes y se leen enteras, de una vez |
| Cores (`data/`) | **Local** | Se piden en cada arranque de juego; en red retrasan cada partida |
| Portadas (`media/`) | **Local** | Muchas peticiones pequeñas al pintar la rejilla |
| Partidas y estados (`saves/`) | **Local** | Escrituras pequeñas y constantes: lo peor para un montaje de red |
| `config/` | **Local** | Usuarios y metadatos; se leen en cada petición |

La regla: a la red va lo grande que se lee de principio a fin. Se queda aquí lo
pequeño, lo que se pide mucho y todo lo que escribe.

## Montar el almacenamiento

Con una Storage Box, por SSHFS. El montaje se declara en systemd para que el
servicio no arranque antes de tenerlo listo:

```ini
# /etc/systemd/system/mnt-roms.mount
[Unit]
Description=ROMs en la Storage Box
After=network-online.target
Wants=network-online.target

[Mount]
What=<usuario>@<usuario>.your-storagebox.de:/home/roms
Where=/mnt/roms
Type=fuse.sshfs
# reconnect y los ServerAlive son lo que evita que un corte de red deje el
# montaje colgado para siempre en vez de recuperarse solo
Options=_netdev,allow_other,reconnect,ServerAliveInterval=15,ServerAliveCountMax=3,IdentityFile=/root/.ssh/storagebox,uid=<uid>,gid=<gid>,ro
TimeoutSec=30

[Install]
WantedBy=multi-user.target
```

Montado en **solo lectura** (`ro`) a propósito: subir ROMs nuevas se hace contra
el almacenamiento directamente, y así un fallo del servicio no puede borrar el
catálogo.

Después, apuntar el servicio ahí:

```ini
# /etc/systemd/system/l-games.service.d/roms.conf
[Service]
Environment=L_GAMES_ROMS=/mnt/roms
```

```sh
systemctl daemon-reload
systemctl enable --now mnt-roms.mount
systemctl restart l-games
```

## Variables

| Variable | Por defecto | Para qué |
|---|---|---|
| `L_GAMES_ROMS` | `<raíz>/roms` | Dónde están las ROMs |
| `L_GAMES_MAX_ROM` | `1073741824` (1 GB) | Tope por ROM al subir |

## Qué pasa si el montaje se cae

El listado devuelve vacío y las consolas aparecen sin juegos. **No se borra
nada** y no hay que restaurar: cuando el montaje vuelve, los juegos vuelven. Un
`stat` fallido de la carpeta invalida la caché, así que no se queda enseñando un
listado viejo de ficheros que ya no puede servir.

## Lo que se preparó para que esto no fuera lento

- **El listado se cachea** y se revalida con la fecha de la carpeta. Antes se
  hacía un `stat` por fichero en cada visita a una consola: en disco local no se
  nota, pero por red son doscientas idas y vueltas para doscientos juegos.
- **La ROM se cachea un año en el navegador**, con `?v=<fecha>` en la URL para
  que reemplazarla siga llegando al momento. Sin esto se descargaba entera cada
  vez que se abría el juego, que con las ROMs en red es pagar el viaje una y
  otra vez por la misma partida. Es caché *privada*: del navegador, no de
  Cloudflare.
- **Hay tope al subir.** Antes no había ninguno: el cuerpo de la petición se
  escribía hasta que se acabara, así que una subida despistada podía llenar la
  partición y llevarse por delante a los demás servicios del VPS. Se comprueba
  la cabecera —lo que evita transferir un fichero que se va a rechazar— y además
  se cuentan los bytes según llegan, porque la cabecera puede no venir o venir
  mentida.
