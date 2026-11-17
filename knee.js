// KneeAngle Web-App - Zeichnungen
//  gauge(): Anzeige auf "Messen" und auf der Startseite (Oberschenkel als Strich, Unterschenkel als
//           farbiger Strich, Gelenk als Kreis, Skala als Bogen - wie in App 2.x)
//  pict():  Bilder im Kalibrier-Assistenten, fuer Bein und Testgelenk dieselben
'use strict';
(function () {
  const rad = (d) => d * Math.PI / 180;
  const f1 = (v) => v.toFixed(1);

  // ---- Anzeige --------------------------------------------------------------------------
  const G = { cx: 150, cy: 96, r: 112, a0: -20, a1: 120, shank: 100 };
  const pt = (deg, r) => [G.cx + r * Math.cos(rad(deg)), G.cy + r * Math.sin(rad(deg))];
  function arc(a0, a1, r) {
    a0 = Math.max(G.a0, Math.min(G.a1, a0)); a1 = Math.max(G.a0, Math.min(G.a1, a1));
    if (a1 - a0 < 0.2) return '';
    const p0 = pt(a0, r), p1 = pt(a1, r);
    return `M${f1(p0[0])} ${f1(p0[1])}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${f1(p1[0])} ${f1(p1[1])}`;
  }
  function gauge(svg) {
    const t0 = pt(0, G.r + 12), t90 = pt(90, G.r + 20);
    // Ausschnitt eng um die Zeichnung (x 20…292, y 50…232), damit sie in der Kachel mittig sitzt
    svg.setAttribute('viewBox', '12 44 288 192');
    svg.innerHTML = `<path class="g-scale" d="${arc(G.a0, G.a1, G.r)}"/><path class="g-app" d=""/><path class="g-over" d=""/>
      <line class="g-limit" x1="0" y1="0" x2="0" y2="0"/>
      <text class="g-lbl" x="${f1(t0[0])}" y="${f1(t0[1] + 4)}">0°</text><text class="g-lbl" x="${f1(t90[0])}" y="${f1(t90[1])}" text-anchor="middle">90°</text>
      <line class="g-bone" x1="28" y1="96" x2="150" y2="96"/><line class="g-bone g-shank" x1="150" y1="96" x2="250" y2="96"/>
      <circle class="g-joint" cx="150" cy="96" r="11"/>`;
    const q = (s) => svg.querySelector(s);
    const e = { app: q('.g-app'), over: q('.g-over'), lim: q('.g-limit'), shank: q('.g-shank') };
    let key = '';
    return {
      set(angle, limit, zone, approachOn, state) {
        const k = limit.toFixed(1) + '|' + zone + '|' + approachOn;
        if (k !== key) {
          key = k;
          e.over.setAttribute('d', arc(G.a0, limit, G.r));
          e.app.setAttribute('d', approachOn ? arc(limit, limit + zone, G.r) : '');
          const a = pt(limit, 62), b = pt(limit, G.r + 8);
          e.lim.setAttribute('x1', f1(a[0])); e.lim.setAttribute('y1', f1(a[1])); e.lim.setAttribute('x2', f1(b[0])); e.lim.setAttribute('y2', f1(b[1]));
        }
        svg.dataset.state = state;
        svg.dataset.noangle = angle === null ? '1' : '0';
        if (angle === null) return;
        const p = pt(Math.max(G.a0, Math.min(G.a1 + 15, angle)), G.shank);
        e.shank.setAttribute('x2', f1(p[0])); e.shank.setAttribute('y2', f1(p[1]));
      }
    };
  }

  // ---- Bilder im Assistenten -----------------------------------------------------------------
  // Gelenk bei (150, 62); Oberschenkel nach links, Unterschenkel mit dem Winkel (0 = gestreckt, 90 = gebeugt).
  // Alles liegt innerhalb des Bildes 320 x 196 (auch der Hilfsbogen), damit nichts aus der Kachel ragt.
  const J = [150, 62], L = 104;
  const end = (deg) => [J[0] + L * Math.cos(rad(deg)), J[1] + L * Math.sin(rad(deg))];
  function seg(deg, cls) {
    const e = end(deg);
    // Sensor am Unterschenkel: auf 58 % der Laenge, quer zum Strich
    const s = [J[0] + 0.58 * L * Math.cos(rad(deg)), J[1] + 0.58 * L * Math.sin(rad(deg))];
    return `<g class="${cls || ''}"><path class="p-shank" d="M${J[0]} ${J[1]}L${f1(e[0])} ${f1(e[1])}"/>
      <rect class="p-dev" x="-14" y="-7" width="28" height="14" rx="4" transform="translate(${f1(s[0])} ${f1(s[1])}) rotate(${deg})"/></g>`;
  }
  const THIGH = `<path class="p-thigh" d="M42 ${J[1]}H${J[0]}"/><rect class="p-dev" x="70" y="${J[1] - 9}" width="40" height="18" rx="5"/><circle class="p-led" cx="102" cy="${J[1]}" r="3"/>`;
  const JOINT = `<circle class="p-joint" cx="${J[0]}" cy="${J[1]}" r="10"/>`;
  const GUIDE = `<path class="p-guide" d="M${J[0] + 122} ${J[1]}A122 122 0 0 1 ${J[0]} ${J[1] + 122}"/>`;
  const SV = (body) => `<svg class="pict" viewBox="0 0 320 196" aria-hidden="true">${body}</svg>`;
  const lead = (x1, y1, x2, y2, tx, ty, t) => `<path class="p-lead" d="M${x1} ${y1}L${x2} ${y2}"/><text class="p-lbl" x="${tx}" y="${ty}">${t}</text>`;
  function pict(key) {
    switch (key) {
      case 'place': return SV(GUIDE + THIGH + seg(90) + JOINT + lead(90, 52, 90, 26, 96, 22, 'Arduino') + lead(166, 123, 196, 123, 202, 128, 'Sensor'));
      case 'rest': return SV(GUIDE + THIGH + seg(90) + JOINT + '<path class="p-calm" d="M246 22v26M262 22v26"/>');
      case 'exFlex': return SV(GUIDE + THIGH + seg(90, 'p-anim p-flex') + JOINT + '<path class="p-ar" d="M244 98a96 96 0 0 0 12-62"/><path class="p-ar" d="M256 36l-9 10M256 36l5 12"/>');
      case 'exTilt': return SV(`<g class="p-anim p-rock">${THIGH}${seg(60, 'p-anim p-flexs')}${JOINT}</g><path class="p-ar" d="M268 26a20 20 0 1 1-20 20"/><path class="p-ar" d="M248 46l-6-10M248 46l8-8"/>`);
      case 'tilt': return SV(`<text class="p-lbl b" x="18" y="24">Gelenkachse</text><text class="p-lbl" x="18" y="44">schräg halten</text><path class="p-guide" d="M60 120H280"/><g transform="rotate(-28 170 120)"><path class="p-axis" d="M86 120H254"/></g><circle class="p-joint" cx="170" cy="120" r="10"/><path class="p-ar" d="M272 120a102 102 0 0 0-13-50"/><path class="p-ar" d="M259 70l-1 13M259 70l11 6"/><text class="p-lbl big" x="276" y="102">≥ 15°</text>`);
      case 'straight': return SV(THIGH + seg(0) + JOINT + `<path class="p-guide" d="M42 ${J[1] + 30}H270"/><text class="p-lbl big" x="${J[0] + 4}" y="${J[1] + 64}">0°</text>`);
      case 'flexHold': return SV(GUIDE + THIGH + seg(90) + JOINT + '<path class="p-ar" d="M246 70a96 96 0 0 1-60 86"/><path class="p-ar" d="M186 156l13 1M186 156l7-11"/>');
      case 'poses': return SV('<path class="p-guide" d="M30 170H290"/><g class="p-anim p-pose"><rect class="p-box" x="100" y="62" width="120" height="54" rx="12"/><rect class="p-dev" x="114" y="76" width="32" height="15" rx="4"/><rect class="p-dev" x="176" y="88" width="32" height="15" rx="4"/></g>');
      case 'compute': return SV('<circle class="p-spin-bg" cx="160" cy="92" r="44"/><circle class="p-spin" cx="160" cy="92" r="44"/>');
      default: return '';
    }
  }

  // Startseite: ruhige Bewegung der Anzeige
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function tick(now) {
    document.querySelectorAll('[data-kanim="hero"]').forEach((e) => {
      if (!e.__g || e.offsetParent === null) return;
      const a = 38 + 46 * Math.cos(now / 1000 * 0.8);
      e.__g.set(a, -5, 10, true, a <= -5 ? 'over' : a <= 5 ? 'approach' : 'ok');
    });
    if (!reduce) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  window.KneeArt = { gauge, pict };
})();
