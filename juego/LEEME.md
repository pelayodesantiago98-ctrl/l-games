# La página del juego

Lo que se sirve en `/juego`: el armazón del noVNC y el mando de pantalla para
móvil y tablet.

**Esto es una copia.** Lo que corre de verdad está en
`/var/lib/juegos/web/index.html`, dentro del HOME del usuario que ejecuta Wine.
No se sirve desde aquí: si se toca este fichero hay que copiarlo allí, y al
revés.

Vive en el repositorio porque es código del proyecto y en aquella carpeta no
había nada que lo respaldara — allí solo hay logs, el prefijo de Wine y la
configuración de PulseAudio.

## El mando

Los botones de pantalla mandan las teclas que el juego espera:

| botón | tecla |
|---|---|
| A | C |
| B | Z |
| START | X |
| SELECT | Q |
| cruceta | flechas |
