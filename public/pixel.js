/*
 * pixel.js — el paso de la portada a la animación, por píxeles.
 *
 * Antes las dos capas de la tarjeta se fundían con un opacity de 0.3s. Ahora
 * una cuadrícula de bloques se enciende en desorden hasta tapar la tarjeta
 * entera, el cambio de capa ocurre debajo mientras no se ve nada, y los
 * bloques se apagan igual de desordenados dejando ver la animación. Es el
 * PixelTransition de React Bits, aquí sin React y sin gsap —el proyecto no
 * tiene ni lo uno ni lo otro y no compensa traerlos por esto—: un solo
 * requestAnimationFrame por tarjeta y display block/none, que es lo que hacía
 * la librería.
 *
 * Solo de ida. Al retirar el ratón la animación se apaga en seco y se vuelve a
 * la portada, como se hacía antes de que esto existiera: la cuadrícula es la
 * forma de ENTRAR en la animación, y repetirla para salir la convertía en un
 * peaje de seiscientos milisegundos cada vez que el puntero cruzaba por encima
 * de una fila de tarjetas. La librería sí la hace en los dos sentidos.
 *
 * El trato es el mismo que en mejoras.js: si este fichero no llega a cargarse,
 * la página se ve exactamente como antes. Todo lo que hace es AÑADIR la clase
 * .pix-activa y marcar <html data-pixeles>, y las reglas de la hoja de estilo
 * solo apagan el fundido de siempre cuando esa marca está puesta.
 *
 * Los estilos se escriben con style.setProperty y nunca con
 * setAttribute('style', …), por lo mismo que allí: lo primero es CSSOM y una
 * CSP estricta no lo mira, lo segundo es un atributo en línea.
 */
(function () {
  'use strict';

  var raiz = document.documentElement;
  var puedeHover = window.matchMedia('(hover: hover)');
  var quieto = window.matchMedia('(prefers-reduced-motion: reduce)');

  /*
   * Ocho columnas y las filas que hagan falta. Fijar también las filas —como
   * hace la librería, que pide un gridSize y dibuja un cuadrado— deforma los
   * bloques en cuanto la tarjeta no es cuadrada, y estas son más anchas que
   * altas. Contando las filas a partir del alto real, los píxeles salen
   * cuadrados en la tarjeta de una consola y también en la de un juego.
   */
  var COLUMNAS = 8;

  /* Milisegundos de cada mitad: tapar y destapar. El total es el doble. */
  var PASO = 320;

  /* El estado de cada tarjeta: sus bloques, en qué orden se encienden y
     cuántos están encendidos ahora mismo. En un WeakMap para que una tarjeta
     que desaparezca del DOM se lleve el suyo por delante. */
  var estados = new WeakMap();

  /*
   * Quién manda. Sin puntero que pueda posarse no hay hover que valga —en
   * táctil la hoja de estilo ya esconde la animación— y con el sistema
   * pidiendo menos movimiento, una tormenta de bloques es justo lo que no se
   * ha pedido. En los dos casos el guion se aparta y vuelve a mandar el
   * fundido.
   */
  function manda() {
    return puedeHover.matches && !quieto.matches;
  }

  function marcar() {
    if (manda()) raiz.dataset.pixeles = 'si';
    else delete raiz.dataset.pixeles;
  }

  /* Un ratón enchufado a una tablet, o el ajuste de movimiento cambiado con la
     página abierta, mueven estas condiciones sin recargar. */
  function vigilar(mq) {
    if (mq.addEventListener) mq.addEventListener('change', marcar);
    else if (mq.addListener) mq.addListener(marcar);
  }
  vigilar(puedeHover);
  vigilar(quieto);
  marcar();

  /*
   * La cuadrícula se dibuja la primera vez que el puntero llega a la tarjeta,
   * no al cargar la página: son medio centenar de nodos por tarjeta y en el
   * índice hay quince. Casi ninguna se llega a tocar en una visita.
   */
  function preparar(card) {
    var est = estados.get(card);
    if (est) return est;

    var caja = card.getBoundingClientRect();
    if (!caja.width || !caja.height) return null;

    var filas = Math.max(3, Math.round(COLUMNAS * caja.height / caja.width));
    var ancho = 100 / COLUMNAS;
    var alto = 100 / filas;

    var capa = document.createElement('span');
    capa.className = 'card-pixeles';
    capa.setAttribute('aria-hidden', 'true');

    var pixeles = [];
    for (var f = 0; f < filas; f++) {
      for (var c = 0; c < COLUMNAS; c++) {
        var p = document.createElement('span');
        p.className = 'card-pixel';
        /* Un pelo de más de ancho y de alto: con porcentajes exactos el
           redondeo del navegador deja costuras de medio píxel entre bloques y
           la tarjeta nunca queda tapada del todo. Lo que sobra por el borde lo
           recorta el overflow de la tarjeta. */
        p.style.setProperty('width', (ancho + 0.2) + '%');
        p.style.setProperty('height', (alto + 0.2) + '%');
        p.style.setProperty('left', (c * ancho) + '%');
        p.style.setProperty('top', (f * alto) + '%');
        capa.appendChild(p);
        pixeles.push(p);
      }
    }

    card.appendChild(capa);

    est = {
      pixeles: pixeles,
      orden: pixeles.slice(),   /* el mismo juego de bloques, barajado */
      mostrados: 0,             /* orden[0 … mostrados-1] están encendidos */
      raf: 0,
      activa: false,
    };
    estados.set(card, est);
    return est;
  }

  function barajar(lista) {
    for (var i = lista.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = lista[i];
      lista[i] = lista[j];
      lista[j] = t;
    }
  }

  /*
   * Encender o apagar hasta dejar exactamente k bloques a la vista. Solo toca
   * los que cambian, no los sesenta: en un fotograma suelen ser dos o tres.
   */
  function pinta(est, k) {
    if (k < 0) k = 0;
    if (k > est.pixeles.length) k = est.pixeles.length;
    while (est.mostrados < k) est.orden[est.mostrados++].style.setProperty('display', 'block');
    while (est.mostrados > k) est.orden[--est.mostrados].style.setProperty('display', 'none');
  }

  /*
   * El cambio de capa. Con .pix-activa puesta, la hoja de estilo le asigna a
   * la animación su background-image —que hasta ahora no se había pedido— y la
   * sube a opaca sin transición.
   *
   * Al encender, esto ocurre en el instante en que los bloques lo tapan todo,
   * así que el corte no se ve. Al apagar se ve, y es lo que se busca: la
   * vuelta a la portada es seca.
   */
  function conmutar(card, entra) {
    card.classList.toggle('pix-activa', entra);

    /* Las animaciones en .mp4 son un <video preload="none"> sin autoplay: sin
       este empujón no se descargan ni se mueven. */
    var video = card.querySelector('video.card-anim');
    if (!video) return;
    if (entra) {
      var promesa = video.play();
      if (promesa && promesa.catch) promesa.catch(function () {});
    } else {
      video.pause();
      try { video.currentTime = 0; } catch (e) { /* aún sin metadatos */ }
    }
  }

  /*
   * Llevar los bloques encendidos de los que hay ahora a los que se piden, en
   * el tiempo que se diga. Cualquier movimiento anterior de esa tarjeta se
   * cancela: manda siempre el último.
   */
  function mover(est, hasta, dur, luego) {
    if (est.raf) cancelAnimationFrame(est.raf);

    var desde = est.mostrados;
    if (dur <= 0 || desde === hasta) {
      pinta(est, hasta);
      est.raf = 0;
      if (luego) luego();
      return;
    }

    var inicio = 0;
    function paso(ahora) {
      if (!inicio) inicio = ahora;
      var u = (ahora - inicio) / dur;
      if (u >= 1) {
        pinta(est, hasta);
        est.raf = 0;
        if (luego) luego();
        return;
      }
      pinta(est, desde + Math.round((hasta - desde) * u));
      est.raf = requestAnimationFrame(paso);
    }
    est.raf = requestAnimationFrame(paso);
  }

  /* La ida: tapar, cambiar de capa y destapar. */
  function entrada(card) {
    var est = preparar(card);
    if (!est) return;
    est.activa = true;

    var n = est.pixeles.length;
    /* Barajar con bloques encendidos movería los ya pintados. Solo se hace
       cuando no se ve ninguno —aquí— y cuando se ven todos, más abajo. */
    if (est.mostrados === 0) barajar(est.orden);

    /*
     * Si la tarjeta venía medio tapada —el ratón ha entrado, salido y vuelto a
     * entrar sin darle tiempo a terminar— se sigue desde donde estaba y esta
     * mitad dura solo lo que le falte. Volver a empezar de cero se vería como
     * un salto hacia atrás.
     */
    mover(est, n, PASO * (n - est.mostrados) / n, function () {
      conmutar(card, true);
      barajar(est.orden);          /* el destape no repite el dibujo del tapado */
      mover(est, 0, PASO);
    });
  }

  /*
   * La vuelta no es la ida al revés: la animación se apaga en el acto y lo
   * único que queda por hacer es retirar los bloques que hubiera puestos, en
   * lo que les quede de camino. Si el ratón se va con la tarjeta ya destapada
   * —el caso normal— no hay ninguno y aquí no se mueve nada.
   */
  function salida(card) {
    var est = estados.get(card);
    if (!est) return;
    est.activa = false;
    conmutar(card, false);
    mover(est, 0, PASO * est.mostrados / est.pixeles.length);
  }

  /*
   * pointerover y pointerout se propagan —pointerenter y pointerleave no— así
   * que basta un par de escuchas en el documento para todas las tarjetas de
   * cualquier página, incluidas las de la rejilla de búsqueda. A cambio hay
   * que descartar los saltos de la tarjeta a un hijo suyo, que también los
   * disparan: si el puntero venía de dentro, no es ni una entrada ni una
   * salida.
   */
  function tarjetaDe(ev) {
    var destino = ev.target;
    if (!destino || !destino.closest) return null;
    var card = destino.closest('.card.con-anim');
    if (!card) return null;
    if (ev.relatedTarget && card.contains(ev.relatedTarget)) return null;
    return card;
  }

  function entrar(ev) {
    if (!manda()) return;
    var card = tarjetaDe(ev);
    if (!card) return;
    var est = estados.get(card);
    if (est && est.activa) return;
    entrada(card);
  }

  function salir(ev) {
    var card = tarjetaDe(ev);
    if (!card) return;
    var est = estados.get(card);
    if (!est || !est.activa) return;
    salida(card);
  }

  document.addEventListener('pointerover', function (ev) {
    /* Un dedo en un híbrido con ratón: el toque no debe disparar nada, que
       para eso la animación en táctil ni se descarga. */
    if (ev.pointerType === 'touch') return;
    entrar(ev);
  });
  document.addEventListener('pointerout', function (ev) {
    if (ev.pointerType === 'touch') return;
    salir(ev);
  });

  /* Y lo mismo con el teclado, que llega a las tarjetas tabulando. */
  document.addEventListener('focusin', entrar);
  document.addEventListener('focusout', salir);
})();
