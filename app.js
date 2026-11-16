// KneeAngle Web-App - Oberflaeche
'use strict';
(function () {
  const P = window.KneeProto;
  const APP_VERSION = '2.0.0';
  const $ = (id) => document.getElementById(id);
  const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v)) ? '–' : v.toFixed(d).replace('-', '−');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let dev = null, demo = false;
  let live = null, status = null, settings = null, edit = null, cal = null, diag = null;
  let auth = { authed: false, windowOpen: false, ownerSet: false };
  let conn = 'disconnected';
  const prefs = { phoneAlarm: true, wake: false };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem('knee.prefs') || '{}')); } catch (e) { /* Standardwerte */ }
  const savePrefs = () => { try { localStorage.setItem('knee.prefs', JSON.stringify(prefs)); } catch (e) { /* egal */ } };

  // ---------------------------------------------------------------------------
  //  Navigation
  // ---------------------------------------------------------------------------
  const views = ['welcome', 'live', 'cal', 'alarm', 'log', 'more'];
  let curView = 'welcome';
  function show(v) {
    curView = v;
    views.forEach((n) => { $('view-' + n).hidden = n !== v; });
    document.querySelectorAll('#tabs button').forEach((b) => { if (b.dataset.tab === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    const inApp = v !== 'welcome';
    $('tabs').hidden = !inApp; $('top').hidden = !inApp;
    if (v === 'log') drawChart();
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));

  // ---------------------------------------------------------------------------
  //  Verbindung
  // ---------------------------------------------------------------------------
  function attach(d) {
    dev = d;
    d.on('conn', (s) => { conn = s; if (s === 'connected') { $('devName').textContent = d.name; } renderConn(); renderBanners(); if (s !== 'connected') { live = null; renderLive(); stopPhoneAlarm(); } });
    d.on('live', (l) => { live = l; onLive(l); });
    d.on('status', (s) => { status = s; renderStatus(); renderBanners(); });
    d.on('settings', (s) => { settings = s; if (!edit || !isDirty()) { edit = { ...s }; fillForm(); } renderLive(); });
    d.on('cal', (c) => { cal = c; wizardOnCal(c); });
    d.on('auth', (a) => { auth = a; renderPair(); renderBanners(); });
    d.on('diag', (x) => { diag = x; renderDiag(); });
    d.on('msg', (t) => { const c = $('console'); c.textContent = (c.textContent + t).slice(-6000); c.scrollTop = c.scrollHeight; });
    d.on('log', onLogPacket);
  }
  async function connectReal() {
    if (!window.KneeDevice.supported) { $('noBle').hidden = false; return; }
    demo = false; attach(new window.KneeDevice());
    try { ensureAudio(); await dev.connect(); show('live'); }
    catch (e) { if (e && e.name !== 'NotFoundError') toast('Verbindung fehlgeschlagen' + (e && e.name === 'StepError' ? ' – ' + e.message : '. Ist das Gerät eingeschaltet und in der Nähe?'), true); conn = 'disconnected'; renderConn(); }
  }
  $('btnStart').addEventListener('click', connectReal);
  $('btnDemo').addEventListener('click', async () => { demo = true; attach(new window.DemoDevice()); ensureAudio(); await dev.connect(); show('live'); });
  $('btnConn').addEventListener('click', () => {
    if (conn === 'connected' || conn === 'reconnecting' || conn === 'connecting') { dev.disconnect(); if (demo) { show('welcome'); } }
    else if (demo) { show('welcome'); } else connectReal();
  });
  function renderConn() {
    const map = { connected: ['on', 'verbunden', 'Trennen'], connecting: ['wait', 'verbinde …', 'Abbrechen'], reconnecting: ['wait', 'Verbindung verloren, suche Gerät …', 'Abbrechen'], disconnected: ['off', 'nicht verbunden', 'Verbinden'] };
    const m = map[conn] || map.disconnected;
    $('connDot').dataset.s = m[0]; $('connText').textContent = m[1] + (demo && conn === 'connected' ? ' (Demo)' : ''); $('btnConn').textContent = m[2];
  }
  const canWrite = () => conn === 'connected' && auth.authed;
  let toastTimer = null;
  function toast(text, err) {
    let t = $('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'banner'; t.style.cssText = 'position:fixed;left:14px;right:14px;bottom:calc(var(--tab-h) + 18px);z-index:30;box-shadow:0 6px 20px rgba(31,42,51,.25)'; document.body.appendChild(t); }
    t.className = 'banner' + (err ? ' err' : ''); t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, err ? 12000 : 4000);
  }
  async function act(fn, okText) {
    if (conn !== 'connected') { toast('Nicht verbunden.', true); return false; }
    if (!auth.authed) { toast('Dieses Handy ist nicht gekoppelt. Siehe „Mehr“.', true); return false; }
    try { await fn(); if (okText) toast(okText); return true; } catch (e) { toast('Das hat nicht geklappt. Verbindung prüfen.', true); return false; }
  }

  // ---------------------------------------------------------------------------
  //  Hinweise oben
  // ---------------------------------------------------------------------------
  function renderBanners() {
    const b = [];
    if (conn === 'connected' && status) {
      if (status.proto !== P.PROTO_VERSION) b.push(['err', 'App und Gerät passen nicht zusammen', `Das Gerät spricht Protokoll ${status.proto}, die App ${P.PROTO_VERSION}. Bitte App oder Firmware aktualisieren.`]);
      if (!auth.authed) b.push(['', 'Nur Ansicht', auth.windowOpen ? 'Dieses Handy ist nicht gekoppelt. Unter „Mehr“ jetzt koppeln.' : 'Zum Koppeln das Gerät aus- und einschalten und innert 60 Sekunden verbinden.']);
      if (!(status.hwBits & P.HB.S1) || !(status.hwBits & P.HB.S2)) b.push(['err', 'Sensor nicht erreichbar', 'Kabel zum Unterschenkel-Sensor prüfen. Der Alarm arbeitet so lange nicht.']);
      if (!(status.hwBits & P.HB.MOTOR)) b.push(['err', 'Vibrationsmotor nicht gefunden', 'Das Gerät kann nicht vibrieren. Verkabelung des Motor-Bausteins prüfen.']);
      if (live && (live.aflags & P.AF.BATT_CRIT)) b.push(['err', 'Akku fast leer', 'Der Alarm fällt bald aus. Bitte jetzt laden.']);
      else if (live && (live.aflags & P.AF.BATT_LOW)) b.push(['', 'Akku schwach', 'Bitte bald laden.']);
      if (!(status.calBits & P.CB.ACC1) || !(status.calBits & P.CB.ACC2)) b.push(['', 'Sensoren noch nicht kalibriert', 'Ohne Schritt 1 unter „Kalibrieren“ kann der Winkel um mehrere Grad falsch sein.']);
    }
    $('banners').innerHTML = b.map((x) => `<div class="banner ${x[0]}"><b>${esc(x[1])}</b>${esc(x[2])}</div>`).join('');
  }

  // ---------------------------------------------------------------------------
  //  Messen
  // ---------------------------------------------------------------------------
  const G = { cx: 150, cy: 96, r: 112, a0: -20, a1: 120 };
  const pt = (deg, r) => [G.cx + r * Math.cos(deg * Math.PI / 180), G.cy + r * Math.sin(deg * Math.PI / 180)];
  function arc(a0, a1, r) {
    a0 = Math.max(G.a0, Math.min(G.a1, a0)); a1 = Math.max(G.a0, Math.min(G.a1, a1));
    if (a1 - a0 < 0.2) return '';
    const p0 = pt(a0, r), p1 = pt(a1, r);
    return `M${p0[0].toFixed(1)} ${p0[1].toFixed(1)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${p1[0].toFixed(1)} ${p1[1].toFixed(1)}`;
  }
  (function initGauge() {
    $('gScale').setAttribute('d', arc(G.a0, G.a1, G.r));
    const t0 = pt(0, G.r + 12), t90 = pt(90, G.r + 20);
    $('gT0').setAttribute('x', t0[0]); $('gT0').setAttribute('y', t0[1] + 4);
    $('gT90').setAttribute('x', t90[0]); $('gT90').setAttribute('y', t90[1]);
  })();
  let lastZoneKey = '', rafPending = false, lastPhoneState = -1;
  function onLive(l) {
    pushChart(l); recordRow(l); phoneAlarm(l);
    if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; renderLive(); }); }
  }
  function invalidReason() {
    if (!status) return 'Kein Winkel';
    if (!(status.hwBits & P.HB.S1) || !(status.hwBits & P.HB.S2)) return 'Sensor nicht erreichbar';
    if (!(status.calBits & P.CB.JOINT)) return 'Noch nicht kalibriert';
    if (!(status.calBits & P.CB.ZERO)) return 'Nullpunkt fehlt';
    if (live && (live.sysFlags & P.SF.BIAS)) return 'Kurz ruhig halten';
    return 'Kein gültiger Winkel';
  }
  function renderLive() {
    const body = document.body;
    if (conn !== 'connected' || !live) {
      body.dataset.state = 'off'; $('angle').textContent = '–';
      $('stateLine').textContent = conn === 'reconnecting' ? 'Verbindung verloren' : (conn === 'connecting' ? 'Verbinde …' : 'Nicht verbunden');
      $('subLine').textContent = conn === 'reconnecting' ? 'Das Gerät misst und warnt selbständig weiter.' : '';
      $('silBar').hidden = true; return;
    }
    const l = live, lim = l.effLimit, zone = settings ? settings.zone : 10;
    const key = lim.toFixed(1) + '|' + zone + '|' + (settings && settings.approachOn);
    if (key !== lastZoneKey) {
      lastZoneKey = key;
      $('gOver').setAttribute('d', arc(G.a0, lim, G.r));
      $('gApp').setAttribute('d', settings && settings.approachOn ? arc(lim, lim + zone, G.r) : '');
      const a = pt(lim, 62), b = pt(lim, G.r + 8);
      const L = $('gLimit'); L.setAttribute('x1', a[0]); L.setAttribute('y1', a[1]); L.setAttribute('x2', b[0]); L.setAttribute('y2', b[1]);
    }
    let st = 'ok', text = 'Im sicheren Bereich';
    if (l.state === P.STATE.CAL) { st = 'invalid'; text = 'Kalibrierung läuft'; }
    else if (l.angle === null || l.state === P.STATE.INVALID) { st = 'invalid'; text = invalidReason(); }
    else if (l.state === P.STATE.OVER) { st = 'over'; text = (l.aflags & P.AF.PREDICTED) ? 'Achtung, Grenze!' : 'Überstreckt'; }
    else if (l.state === P.STATE.APPROACH) { st = 'approach'; text = 'Nahe an der Grenze'; }
    body.dataset.state = st;
    if (l.angle === null) { $('angle').textContent = '–'; }
    else {
      $('angle').innerHTML = esc(fmt(l.angle, 1)) + '<sup>°</sup>';
      const ang = Math.max(G.a0, Math.min(G.a1 + 15, l.angle)), e = pt(ang, 100);
      const s = $('gShank'); s.setAttribute('x2', e[0].toFixed(1)); s.setAttribute('y2', e[1].toFixed(1));
    }
    $('stateLine').textContent = text;
    let sub = '';
    if (l.angle !== null && l.state !== P.STATE.CAL) {
      if (l.aflags & P.AF.UNRELIABLE) sub = `Messung unsicher (±${fmt(l.sigma, 1)}°). Bein kurz ruhig halten.`;
      else sub = `Grenze bei ${fmt(lim, 1)}°, Genauigkeit ±${fmt(Math.max(0.1, l.sigma), 1)}°`;
      if (l.sysFlags & P.SF.VERT) sub += ' (Seitenlage: weniger genau)';
    }
    $('subLine').textContent = sub;
    // Stumm / Aus deutlich zeigen
    const sb = $('silBar');
    if (l.silence === P.SILENCE.OFF) { sb.hidden = false; $('silText').textContent = 'Alarm ist ausgeschaltet'; }
    else if (l.silence === P.SILENCE.MUTED) { const r = status ? status.muteRemainS : 0; sb.hidden = false; $('silText').textContent = `Stumm, noch ${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')} min`; }
    else sb.hidden = true;
    $('muteBtns').hidden = l.silence !== P.SILENCE.NONE;
  }
  function renderStatus() {
    if (!status) return;
    $('fMin').textContent = status.min === null ? '–' : fmt(status.min, 0) + '°';
    $('fMax').textContent = status.max === null ? '–' : fmt(status.max, 0) + '°';
    $('fOver').textContent = status.overCount; $('lOver').textContent = status.overCount; $('lWarn').textContent = status.warnCount; $('lApp').textContent = status.approachCount;
    const bt = $('batt');
    if ((status.hwBits & P.HB.BATT) && status.battMv > 0) {
      const pct = Math.max(0, Math.min(100, Math.round((status.battMv - 3300) / (4150 - 3300) * 100)));
      bt.hidden = false; bt.textContent = `Akku ${pct} %`; bt.dataset.low = status.battMv < 3500 ? '1' : '0';
    } else bt.hidden = true;
    const ok = (id, good, t1, t0) => { const e = $(id); e.dataset.ok = good ? '1' : '0'; e.textContent = good ? t1 : t0; };
    ok('stSensor', (status.calBits & P.CB.ACC1) && (status.calBits & P.CB.ACC2), 'erledigt', 'noch nicht gemacht');
    ok('stJoint', status.calBits & P.CB.JOINT, 'erledigt', 'noch nicht gemacht');
    ok('stZero', status.calBits & P.CB.ZERO, 'gesetzt', 'fehlt');
    const kv = [['Firmware', status.fw], ['Sensor Oberschenkel', (status.hwBits & P.HB.S1) ? `ok, ${status.rateS1} Hz` : 'Fehler'], ['Sensor Unterschenkel', (status.hwBits & P.HB.S2) ? `ok, ${status.rateS2} Hz` : 'Fehler'],
      ['Vibrationsmotor', (status.hwBits & P.HB.MOTOR) ? ((status.calBits & P.CB.MOTORCAL) ? 'ok, eingemessen' : 'ok') : 'nicht gefunden'],
      ['Akku', (status.hwBits & P.HB.BATT) ? (status.battMv / 1000).toFixed(2) + ' V' : 'nicht gemessen']];
    $('devInfo').innerHTML = kv.map((x) => `<dt>${esc(x[0])}</dt><dd>${esc(x[1])}</dd>`).join('');
    if (live) renderLive();
  }
  document.querySelectorAll('#muteBtns button').forEach((b) => b.addEventListener('click', () => act(() => dev.send(P.cmd.mute(+b.dataset.mute)), `Alarm ${b.dataset.mute} Minuten stumm`)));
  $('btnArm').addEventListener('click', () => {
    if (live && live.silence === P.SILENCE.OFF) act(() => dev.writeSettings({ ...settings, alarmEnabled: true }), 'Alarm eingeschaltet');
    else act(() => dev.send(P.cmd.mute(0)), 'Alarm wieder aktiv');
  });

  // ---- Ton und Vibration am Handy ---------------------------------------------
  let audio = null, beepTimer = null;
  function ensureAudio() { try { if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === 'suspended') audio.resume(); } catch (e) { audio = null; } }
  function beep() {
    if (audio) { const o = audio.createOscillator(), g = audio.createGain(); o.frequency.value = 880; o.connect(g); g.connect(audio.destination); g.gain.setValueAtTime(0.25, audio.currentTime); g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.18); o.start(); o.stop(audio.currentTime + 0.2); }
    if (navigator.vibrate) navigator.vibrate(180);
  }
  function stopPhoneAlarm() { if (beepTimer) { clearInterval(beepTimer); beepTimer = null; } lastPhoneState = -1; }
  function phoneAlarm(l) {
    const on = prefs.phoneAlarm && l.state === P.STATE.OVER && l.silence === P.SILENCE.NONE;
    if (on && !beepTimer) { beep(); beepTimer = setInterval(beep, 350); }
    else if (!on && beepTimer) stopPhoneAlarm();
  }

  // ---------------------------------------------------------------------------
  //  Kalibrier-Assistent
  // ---------------------------------------------------------------------------
  const wz = { kind: null, phase: null, startSeq: 0, timer: null, ref: 0 };
  const PICT = {
    table: '<svg class="pict" viewBox="0 0 320 130"><rect class="sf" x="20" y="96" width="280" height="10" rx="5"/><rect class="dev" x="110" y="62" width="100" height="34" rx="6"/><path class="ar" d="M232 60a46 46 0 0 0-40-38"/><path class="ar" d="M192 22l12-6M192 22l6 12"/></svg>',
    hold: '<svg class="pict" viewBox="0 0 320 130"><path class="ln" d="M40 60h110l110 0"/><circle class="dev" cx="150" cy="60" r="12"/><path class="ar" d="M90 100h140"/></svg>',
    move: '<svg class="pict" viewBox="0 0 320 130"><path class="ln" d="M40 44h110l56 70"/><circle class="dev" cx="150" cy="44" r="12"/><path class="ar" d="M250 50a80 80 0 0 1-30 62"/><path class="ar" d="M220 112l14-2M220 112l4-14"/><path class="ar" d="M60 20c20-14 50-14 70 0"/><path class="ar" d="M130 20l-12-2M130 20l-3-12"/></svg>',
    straight: '<svg class="pict" viewBox="0 0 320 130"><rect class="sf" x="20" y="92" width="280" height="10" rx="5"/><path class="ln" d="M44 78h112l112 0"/><circle class="dev" cx="156" cy="78" r="12"/></svg>',
    flex: '<svg class="pict" viewBox="0 0 320 130"><path class="ln" d="M44 40h112l0 80"/><circle class="dev" cx="156" cy="40" r="12"/><path class="ar" d="M226 40a70 70 0 0 1-22 50"/></svg>'
  };
  const INTRO = {
    sensor: { title: 'Sensoren kalibrieren', pict: 'table', todo: ['Gerät noch <b>nicht</b> am Bein. Beide Teile auf den Tisch legen.', 'Nacheinander in viele verschiedene Lagen drehen: jede Seite einmal nach oben, dazu schräg angelehnt.', 'Jede Lage etwa 2 Sekunden ruhig liegen lassen, bis das Gerät kurz vibriert. Dann weiterdrehen.'], go: 'Kalibrierung starten' },
    joint: { title: 'Gelenk kalibrieren', pict: 'move', todo: ['Gerät am Bein fest anlegen. Am besten sitzen, das Bein kann frei schwingen.', 'Erst kurz ruhig halten.', 'Dann etwa 25 Sekunden lang das Knie beugen und strecken und dabei den Oberschenkel bewegen: Bein anheben, zur Seite drehen, aufstehen und hinsetzen.', 'Zum Schluss einmal gestreckt und einmal gebeugt ruhig halten.'], go: 'Kalibrierung starten' },
    zero: { title: 'Nullpunkt setzen', pict: 'straight', todo: ['Auf den Boden oder eine feste Liege setzen, Bein flach ausstrecken.', 'Kniekehle Richtung Unterlage sinken lassen, Fuss locker, Zehen zeigen nach oben. Muskeln entspannen.', 'So ruhig bleiben, bis das Gerät vibriert.'], go: 'Diese Haltung ist 0°' }
  };
  const HINTS = {
    1: { 1: ['hold', 'Ruhig liegen lassen …'], 2: ['go', 'Erfasst. Jetzt in eine neue Lage drehen.'], 3: ['go', 'In eine neue Lage drehen, dann loslassen.'], 11: ['hold', 'Wird berechnet …'] },
    2: { 1: ['hold', 'Ruhig halten …'], 4: ['go', 'Knie beugen und strecken, Bein dabei in alle Richtungen bewegen.'], 5: ['fix', 'Oberschenkel mehr bewegen: Bein anheben und zur Seite drehen.'], 6: ['fix', 'Unterschenkel mehr bewegen: Knie weiter beugen und strecken.'], 7: ['fix', 'Zwischendurch 1 Sekunde stillhalten, dann weiter.'], 13: ['go', 'Sehr gut, weiter so.'], 11: ['hold', 'Wird berechnet …'], 8: ['hold', 'Bein gestreckt ruhig halten.'], 10: ['fix', 'Bitte aufrecht sitzen oder stehen, nicht auf der Seite liegen.'], 9: ['go', 'Knie etwa rechtwinklig beugen und halten.'], 12: ['go', 'Noch etwas weiter beugen.'] },
    3: { 1: ['hold', 'Ruhig halten …'], 8: ['hold', 'So bleiben, nicht bewegen.'], 10: ['fix', 'Bitte aufrecht sitzen, nicht auf der Seite liegen.'] }
  };
  const RESULTS = {
    1: ['Geschafft', ''], 2: ['Teilweise geschafft', 'Die Lagesensoren sind kalibriert. Für die Drehsensoren fehlten Drehungen um alle Achsen; die Messung funktioniert trotzdem. Bei Gelegenheit wiederholen.'],
    3: ['Abgebrochen', 'Es wurde nichts geändert.'], 4: ['Das war zu unruhig', 'Die Lagen müssen ganz ruhig liegen. Am besten jede Lage auf dem Tisch ablegen und loslassen.'],
    5: ['Zu wenig Bewegung', 'Während der Aufnahme das Knie mehrmals ganz beugen und strecken.'], 6: ['Oberschenkel zu wenig bewegt', 'Das Bein während der Aufnahme auch anheben und zur Seite drehen.'],
    7: ['Unterschenkel zu wenig bewegt', 'Das Knie während der Aufnahme weiter beugen und strecken.'], 8: ['Richtung nicht eindeutig', 'Zwischendurch zwei- bis dreimal in verschiedenen Haltungen kurz stillhalten.'],
    9: ['Keine Ruhe erkannt', 'Das Bein muss kurz ganz ruhig sein. Am besten abstützen.'], 10: ['Zu lange gewartet', 'Bitte noch einmal starten.'], 11: ['Zu wenige Lagen', 'Bitte noch einmal starten und mehr Lagen erfassen.'], 12: ['Zuerst das Gelenk kalibrieren', 'Der Nullpunkt braucht Schritt 2.']
  };
  document.querySelectorAll('[data-cal]').forEach((b) => b.addEventListener('click', () => {
    if (conn !== 'connected') { toast('Nicht verbunden.', true); return; }
    if (!auth.authed) { toast('Dieses Handy ist nicht gekoppelt. Siehe „Mehr“.', true); return; }
    openWizard(b.dataset.cal);
  }));
  function openWizard(kind) { wz.kind = kind; wz.phase = 'intro'; wz.ref = 0; $('wizard').hidden = false; renderIntro(); }
  function closeWizard() { clearTimeout(wz.timer); $('wizard').hidden = true; wz.kind = null; wz.phase = null; }
  $('wzClose').addEventListener('click', () => { if (wz.phase === 'run' && dev) dev.send(P.cmd.char('x')).catch(() => {}); closeWizard(); });
  function renderIntro() {
    const I = INTRO[wz.kind];
    $('wzTitle').textContent = I.title; $('wzClose').textContent = 'Schliessen';
    let extra = '';
    if (wz.kind === 'zero') extra = '<div class="block"><h3>Winkel mit einem Winkelmesser gemessen?</h3><p class="muted">Dann die Haltung beibehalten und den gemessenen Winkel eintragen. Überstreckung als negative Zahl.</p><div class="row"><input type="number" id="wzRef" step="0.5" min="-30" max="30" value="0" inputmode="decimal"><span>Grad</span><button class="btn sec small grow" id="wzGoRef">Mit diesem Winkel setzen</button></div></div>';
    $('wzBody').innerHTML = PICT[I.pict] + '<ol class="todo">' + I.todo.map((t) => `<li>${t}</li>`).join('') + '</ol>' + extra;
    $('wzFoot').innerHTML = `<button class="btn" id="wzGo">${esc(I.go)}</button>`;
    $('wzGo').addEventListener('click', () => startCal(null));
    if (wz.kind === 'zero') $('wzGoRef').addEventListener('click', () => { const v = parseFloat($('wzRef').value); if (Number.isNaN(v) || v < -30 || v > 30) { toast('Bitte einen Winkel zwischen −30 und 30 eintragen.', true); return; } startCal(v); });
  }
  async function startCal(ref) {
    wz.startSeq = cal ? cal.resultSeq : 0; wz.phase = 'run'; wz.ref = ref || 0;
    $('wzClose').textContent = 'Abbrechen';
    $('wzBody').innerHTML = '<div class="hint" data-tone="hold">Starte …</div>'; $('wzFoot').innerHTML = '';
    const bytes = wz.kind === 'sensor' ? P.cmd.char('s') : wz.kind === 'joint' ? P.cmd.char('a') : (ref === null ? P.cmd.char('z') : P.cmd.zeroRef(ref));
    try { await dev.send(bytes); } catch (e) { toast('Start fehlgeschlagen.', true); renderIntro(); wz.phase = 'intro'; return; }
    wz.timer = setTimeout(() => { if (wz.phase === 'run' && (!cal || cal.mode === 0) && cal && cal.resultSeq === wz.startSeq) { toast('Das Gerät hat nicht gestartet. Läuft schon eine Kalibrierung?', true); wz.phase = 'intro'; renderIntro(); } }, 3000);
  }
  const SECTOR_POS = (() => { const p = []; for (let s = 0; s < 26; s++) { const i = s >= 13 ? s + 1 : s; p.push([i % 3 - 1, Math.floor(i / 3) % 3 - 1, Math.floor(i / 9) - 1]); } return p; })();
  function sectorSvg(c) {
    let h = '<svg class="pict sectors" viewBox="0 0 320 120" aria-label="Erfasste Richtungen">';
    [0, 1, 2].forEach((g) => { h += `<rect class="disc" x="${14 + g * 102}" y="8" width="88" height="104" rx="14"/>`; });
    SECTOR_POS.forEach((q, s) => {
      const gx = 58 + (q[2] + 1) * 102 + q[0] * 28, gy = 60 + q[1] * 32;
      const st = (c.curSector === s) ? 'cur' : '';
      const done = (c.sectorMask >>> s) & 1;
      h += `<circle cx="${gx}" cy="${gy}" r="10" data-s="${done ? 'done' : ''}"/>` + (st ? `<circle cx="${gx}" cy="${gy}" r="14" data-s="cur" style="fill:none"/>` : '');
    });
    return h + '</svg>';
  }
  function wizardOnCal(c) {
    if (!wz.kind || wz.phase !== 'run') return;
    const mode = { sensor: 1, joint: 2, zero: 3 }[wz.kind];
    if (c.mode === 0) { if (c.resultSeq !== wz.startSeq) { clearTimeout(wz.timer); renderResult(c); } return; }
    if (c.mode !== mode) return;
    clearTimeout(wz.timer);
    const hint = (HINTS[mode][c.hint]) || ['hold', ''];
    let h = '';
    if (mode === 2) h += '<div class="steps">' + [0, 1, 2, 3].map((i) => `<i data-s="${i < c.step ? 'done' : (i === c.step ? 'now' : '')}"></i>`).join('') + '</div>';
    if (mode === 1) h += sectorSvg(c);
    else if (mode === 2) h += PICT[['hold', 'move', 'straight', 'flex'][c.step]];
    else h += PICT.straight;
    h += `<div class="hint" data-tone="${hint[0]}" aria-live="polite">${esc(hint[1])}</div><div class="bar"><i style="width:${c.progress}%"></i></div>`;
    if (mode === 1) {
      const n = Math.min(c.a[0], c.a[1]), cov = Math.min(c.a[2], c.a[3]);
      h += `<div class="meters"><div data-ok="${n >= 14 ? 1 : 0}"><b>${n}</b><span>Lagen, Ziel 14</span></div><div data-ok="${cov >= 45 ? 1 : 0}"><b>${cov} %</b><span>Abdeckung, Ziel 45</span></div><div data-ok="${Math.min(c.a[4], c.a[5]) >= 10 ? 1 : 0}"><b>${Math.min(c.a[4], c.a[5])}</b><span>Drehungen, Ziel 10</span></div></div>`;
      h += '<p class="muted" style="margin-top:10px">Jeder Punkt ist eine Richtung. Der umrandete Punkt zeigt, wohin das Gerät gerade zeigt. Möglichst viele Punkte füllen.</p>';
    } else if (mode === 2 && c.step === 1) {
      h += `<div class="meters"><div data-ok="${c.a[0] >= 60 ? 1 : 0}"><b>${Math.round(c.a[0])} %</b><span>Oberschenkel</span></div><div data-ok="${c.a[1] >= 60 ? 1 : 0}"><b>${Math.round(c.a[1])} %</b><span>Unterschenkel</span></div><div data-ok="${c.a[2] >= 2 ? 1 : 0}"><b>${c.a[2]}</b><span>Pausen, Ziel 2</span></div></div>`;
    }
    $('wzBody').innerHTML = h;
    const early = (mode === 1 && Math.min(c.a[0], c.a[1]) >= 10 && c.hint !== 11) || (mode === 2 && c.step === 1 && c.a[3] >= 12 && c.hint !== 11);
    const foot = $('wzFoot');
    if (early && !$('wzEarly')) { foot.innerHTML = '<button class="btn sec" id="wzEarly">Jetzt abschliessen</button>'; $('wzEarly').addEventListener('click', () => dev.send(P.cmd.char('f')).catch(() => {})); }
    else if (!early) foot.innerHTML = '';
  }
  function renderResult(c) {
    wz.phase = 'result';
    const ok = c.result === 1 || c.result === 2;
    const R = RESULTS[c.result] || ['Unbekanntes Ergebnis', ''];
    let detail = R[1];
    if (c.result === 1 && c.resultMode === 1) detail = `Restfehler ${fmt(c.q1 / 100, 1)} mg${c.q1 <= 200 ? ' (sehr gut)' : (c.q1 <= 500 ? ' (gut)' : ' (mässig, ruhiger ablegen bringt mehr)')}. Wird dauerhaft gespeichert.`;
    if (c.resultMode === 2 && ok) detail = `Gelenkachse auf ±${fmt(c.q1 / 100, 1)}° bestimmt, Übereinstimmung ${fmt(c.q2 / 100, 1)}°${c.q2 <= 100 ? ' (gut)' : ' (mässig: sitzt das Gerät fest?)'}. Als Nächstes den Nullpunkt in der Standardhaltung setzen.`;
    if (c.resultMode === 3 && ok) detail = `Diese Haltung zeigt jetzt ${fmt(c.q2 / 100, 1)}°. Vorher waren es ${fmt(c.q1 / 100, 1)}°.`;
    $('wzClose').textContent = 'Schliessen';
    $('wzBody').innerHTML = `<div class="result" data-ok="${ok ? 1 : 0}"><div class="mark">${ok ? '✓' : '!'}</div><h2>${esc(R[0])}</h2><p>${esc(detail)}</p></div>`;
    const next = ok && c.resultMode === 1 ? ['joint', 'Weiter: Gelenk kalibrieren'] : (ok && c.resultMode === 2 ? ['zero', 'Weiter: Nullpunkt setzen'] : null);
    $('wzFoot').innerHTML = (ok ? '' : '<button class="btn" id="wzAgain">Noch einmal</button>') + (next ? `<button class="btn" id="wzNext">${esc(next[1])}</button>` : '') + '<button class="btn sec" id="wzDone">Fertig</button>';
    $('wzDone').addEventListener('click', closeWizard);
    if (!ok) $('wzAgain').addEventListener('click', () => openWizard(wz.kind));
    if (next) $('wzNext').addEventListener('click', () => openWizard(next[0]));
  }

  // ---------------------------------------------------------------------------
  //  Alarm-Einstellungen
  // ---------------------------------------------------------------------------
  const F = [['sLimit', 'limit', 'oLimit', (v) => fmt(v, 1) + '°'], ['sZone', 'zone', 'oZone', (v) => fmt(v, 0) + '° vorher'], ['sAppStr', 'approachStrength', 'oAppStr', (v) => v + ' %'],
    ['sAlStr', 'alarmStrength', 'oAlStr', (v) => v + ' %'], ['sHyst', 'hyst', 'oHyst', (v) => fmt(v, 1) + '°'], ['sRateMin', 'rateMin', 'oRateMin', (v) => fmt(v, 1)],
    ['sRateMax', 'rateMax', 'oRateMax', (v) => fmt(v, 1)], ['sPredict', 'predictMs', 'oPredict', (v) => (v ? v + ' ms' : 'aus')]];
  const C = [['sEnabled', 'alarmEnabled'], ['sAppOn', 'approachOn'], ['sMoveOnly', 'approachMoveOnly'], ['sCautious', 'cautiousOn'], ['sBatt', 'batteryPresent']];
  function isDirty() { return !!(edit && settings && JSON.stringify(edit) !== JSON.stringify(settings)); }
  function fillForm() {
    if (!edit) return;
    F.forEach(([id, k, o, f]) => { $(id).value = edit[k]; $(o).textContent = f(edit[k]); });
    C.forEach(([id, k]) => { $(id).checked = !!edit[k]; });
    $('hZone').textContent = `Leichte Pulse ab ${fmt(edit.limit + edit.zone, 1)}°, starke Vibration ab ${fmt(edit.limit, 1)}°.`;
    $('saveBar').hidden = !isDirty();
    const errs = P.validateSettings(edit); const el = $('setErr');
    el.hidden = errs.length === 0; el.innerHTML = errs.map((e) => `<li>${esc(e)}</li>`).join('');
    $('btnSave').disabled = errs.length > 0;
  }
  F.forEach(([id, k]) => $(id).addEventListener('input', () => { if (!edit) return; edit[k] = parseFloat($(id).value); fillForm(); }));
  C.forEach(([id, k]) => $(id).addEventListener('change', () => { if (!edit) return; edit[k] = $(id).checked; fillForm(); }));
  document.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
    const inp = $(b.dataset.step); const v = Math.max(+inp.min, Math.min(+inp.max, parseFloat(inp.value) + parseFloat(b.dataset.d)));
    inp.value = v; inp.dispatchEvent(new Event('input'));
  }));
  $('btnRevert').addEventListener('click', () => { edit = settings ? { ...settings } : null; fillForm(); });
  $('btnSave').addEventListener('click', () => act(async () => { const back = await dev.writeSettings(edit); if (back) { settings = back; edit = { ...back }; fillForm(); } }, 'Gespeichert. Das Gerät hat zur Bestätigung vibriert.'));
  $('btnTestApp').addEventListener('click', () => { if (isDirty()) { toast('Zuerst speichern, dann testen.', true); return; } act(() => dev.send(P.cmd.vibTest(1))); });
  $('btnTestAl').addEventListener('click', () => { if (isDirty()) { toast('Zuerst speichern, dann testen.', true); return; } act(() => dev.send(P.cmd.vibTest(2))); });

  // ---------------------------------------------------------------------------
  //  Verlauf: Protokoll, Grafik, Aufzeichnung
  // ---------------------------------------------------------------------------
  let logRows = [], logLoading = false;
  const when = (r) => r.timeValid ? new Date(r.time * 1000).toLocaleString('de-CH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : `nach ${Math.floor(r.time / 60)} min Betrieb`;
  function onLogPacket(r) {
    if (!logLoading) return;
    if (r.end) { logLoading = false; renderLog(r.count); return; }
    if (r.type === 1) logRows.push(r);
  }
  function renderLog(total) {
    const real = logRows.filter((r) => !r.predictedOnly), warn = logRows.length - real.length;
    $('logInfo').textContent = total === 0 ? 'Noch keine Überstreckung gespeichert.' : `${real.length} Überstreckungen${warn ? ` und ${warn} Vorwarnungen` : ''} im Gerät gespeichert.`;
    const tb = $('logTable').querySelector('tbody');
    tb.innerHTML = logRows.slice().reverse().map((r) => `<tr><td>${esc(when(r))}${r.predictedOnly ? '<br><span class="muted">nur Vorwarnung</span>' : ''}${r.silenced ? '<br><span class="muted">Alarm war stumm</span>' : ''}</td><td class="num">${fmt(r.extreme, 1)}°</td><td class="num">${fmt(r.limit, 1)}°</td><td class="num">${fmt(r.durS, 1)} s</td></tr>`).join('');
    $('logTable').hidden = logRows.length === 0; $('btnLogCsv').disabled = logRows.length === 0;
  }
  $('btnLogLoad').addEventListener('click', async () => {
    if (conn !== 'connected') { toast('Nicht verbunden.', true); return; }
    logRows = []; logLoading = true; $('logInfo').textContent = 'Lade …';
    try { await dev.send(P.cmd.logRead(0)); } catch (e) { logLoading = false; toast('Laden fehlgeschlagen.', true); }
    setTimeout(() => { if (logLoading) { logLoading = false; renderLog(logRows.length); } }, 15000);
  });
  $('btnLogClear').addEventListener('click', () => { if (confirm('Alle gespeicherten Überstreckungen im Gerät löschen?')) act(async () => { await dev.send(P.cmd.logClear()); logRows = []; renderLog(0); }, 'Gelöscht'); });
  $('btnStatsReset').addEventListener('click', () => act(() => dev.send(P.cmd.statsReset()), 'Zähler zurückgesetzt'));
  function download(name, text) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv' })); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  $('btnLogCsv').addEventListener('click', () => download(`kneeangle-ueberstreckungen-${stamp()}.csv`, 'zeit;winkel_grad;grenze_grad;dauer_s;nur_vorwarnung;stumm\n' + logRows.map((r) => [r.timeValid ? new Date(r.time * 1000).toISOString() : 'betrieb+' + r.time + 's', r.extreme, r.limit, r.durS, r.predictedOnly ? 1 : 0, r.silenced ? 1 : 0].join(';')).join('\n')));

  const chartBuf = []; let lastChartT = 0;
  function pushChart(l) {
    const now = performance.now();
    if (now - lastChartT < 100) return;
    lastChartT = now; chartBuf.push([now, l.angle, l.effLimit]);
    while (chartBuf.length && now - chartBuf[0][0] > 60000) chartBuf.shift();
    if (curView === 'log') drawChart();
  }
  function drawChart() {
    const cv = $('chart'), dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (!w) return;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const vals = chartBuf.filter((p) => p[1] !== null);
    let lo = -10, hi = 30;
    vals.forEach((p) => { lo = Math.min(lo, p[1] - 5); hi = Math.max(hi, p[1] + 5); });
    const now = performance.now(), X = (t) => w - (now - t) / 60000 * w, Y = (a) => h - 8 - (a - lo) / (hi - lo) * (h - 16);
    g.font = '13px Barlow, sans-serif'; g.fillStyle = '#5b6b76'; g.strokeStyle = '#cfd8dc'; g.lineWidth = 1;
    const stepDeg = (hi - lo) > 80 ? 30 : 10;
    for (let a = Math.ceil(lo / stepDeg) * stepDeg; a <= hi; a += stepDeg) { g.beginPath(); g.moveTo(0, Y(a)); g.lineTo(w, Y(a)); g.stroke(); g.fillText(a + '°', 4, Y(a) - 3); }
    if (vals.length) { const lim = vals[vals.length - 1][2]; g.strokeStyle = '#d0342c'; g.setLineDash([6, 4]); g.beginPath(); g.moveTo(0, Y(lim)); g.lineTo(w, Y(lim)); g.stroke(); g.setLineDash([]); }
    g.strokeStyle = '#0e6e73'; g.lineWidth = 2.5; g.beginPath();
    let pen = false; chartBuf.forEach((p) => { if (p[1] === null) { pen = false; return; } if (!pen) { g.moveTo(X(p[0]), Y(p[1])); pen = true; } else g.lineTo(X(p[0]), Y(p[1])); });
    g.stroke();
  }
  let rec = null;
  function recordRow(l) { if (rec && rec.rows.length < 180000) rec.rows.push([((performance.now() - rec.t0) / 1000).toFixed(3), l.angle === null ? '' : l.angle, l.state, l.effLimit]); }
  $('btnRec').addEventListener('click', () => {
    if (rec && rec.on) { rec.on = false; const r = rec; rec = null; $('btnRec').textContent = 'Aufzeichnen'; $('btnRecCsv').disabled = r.rows.length === 0; $('btnRecCsv').onclick = () => download(`kneeangle-messung-${stamp()}.csv`, 't_s;winkel_grad;zustand;grenze_grad\n' + r.rows.map((x) => x.join(';')).join('\n')); $('recInfo').textContent = `${r.rows.length} Messwerte aufgezeichnet.`; }
    else { rec = { on: true, t0: performance.now(), rows: [] }; $('btnRec').textContent = 'Aufzeichnung beenden'; $('recInfo').textContent = 'Aufzeichnung läuft. Die App muss dabei geöffnet bleiben.'; }
  });

  // ---------------------------------------------------------------------------
  //  Mehr
  // ---------------------------------------------------------------------------
  function renderPair() {
    const t = $('pairText'), bp = $('btnPair'), bf = $('btnForget');
    if (conn !== 'connected') { t.textContent = 'Nicht verbunden.'; bp.hidden = bf.hidden = true; return; }
    if (auth.authed) { t.textContent = 'Dieses Handy ist gekoppelt und darf Einstellungen ändern. Andere Handys können nur zusehen.'; bp.hidden = true; bf.hidden = false; }
    else if (auth.windowOpen) { t.textContent = auth.ownerSet ? 'Ein anderes Handy ist gekoppelt. Koppeln ersetzt es durch dieses Handy.' : 'Noch kein Handy gekoppelt.'; bp.hidden = false; bf.hidden = true; }
    else { t.textContent = 'Koppeln ist nur in den ersten 60 Sekunden nach dem Einschalten möglich: Gerät aus- und einschalten, sofort verbinden, dann hier koppeln.'; bp.hidden = bf.hidden = true; }
  }
  $('btnPair').addEventListener('click', async () => { try { const ok = await dev.pair(); toast(ok ? 'Gekoppelt. Das Gerät hat zur Bestätigung vibriert.' : 'Koppeln nicht möglich. Das Zeitfenster ist abgelaufen.', !ok); } catch (e) { toast('Koppeln fehlgeschlagen.', true); } });
  $('btnForget').addEventListener('click', () => { if (confirm('Kopplung löschen? Danach kann dieses Handy nur noch zusehen.')) act(() => dev.forget(), 'Kopplung gelöscht'); });
  $('btnMotorCal').addEventListener('click', () => act(() => dev.send(P.cmd.motorCal()), 'Der Motor läuft jetzt etwa 1 Sekunde.'));
  $('btnInfo').addEventListener('click', () => { if (conn === 'connected') dev.send(P.cmd.info()).catch(() => {}); });
  function renderDiag() {
    if (!diag) return;
    const kv = [['Mess-Schleife, längster Durchlauf', diag.rtLoopMaxUs + ' µs'], ['Messwert bis Motorbefehl, zuletzt', fmt(diag.latLastMs, 2) + ' ms'], ['Messwert bis Motorbefehl, maximal', fmt(diag.latMaxMs, 2) + ' ms'],
      ['Hauptschleife, längster Durchlauf', diag.mainLoopMaxMs + ' ms'], ['Temperatur Sensor 1 / 2', `${diag.tempS1} / ${diag.tempS2} °C`], ['Lücken in den Messwerten 1 / 2', `${diag.gaps1} / ${diag.gaps2}`],
      ['Verlorene Messwerte', diag.lost], ['I2C-Fehler', diag.i2cErr], ['Verworfene Korrekturen', diag.kfRejects], ['Funksignal', diag.rssi + ' dBm']];
    if (live) kv.push(['Winkelgeschwindigkeit', fmt(live.rate, 0) + ' °/s'], ['Status-Bits', '0x' + live.sysFlags.toString(16)]);
    $('diagInfo').innerHTML = kv.map((x) => `<dt>${esc(x[0])}</dt><dd>${esc(x[1])}</dd>`).join('');
  }
  $('pPhoneAlarm').checked = prefs.phoneAlarm; $('pWake').checked = prefs.wake;
  $('pPhoneAlarm').addEventListener('change', (e) => { prefs.phoneAlarm = e.target.checked; savePrefs(); if (prefs.phoneAlarm) ensureAudio(); else stopPhoneAlarm(); });
  let wakeLock = null;
  async function applyWake() { try { if (prefs.wake && navigator.wakeLock && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); else if (wakeLock) { await wakeLock.release(); wakeLock = null; } } catch (e) { /* nicht unterstuetzt */ } }
  $('pWake').addEventListener('change', (e) => { prefs.wake = e.target.checked; savePrefs(); applyWake(); });
  document.addEventListener('visibilitychange', applyWake);
  $('appVer').textContent = APP_VERSION;

  // ---------------------------------------------------------------------------
  //  Start
  // ---------------------------------------------------------------------------
  if (!window.KneeDevice.supported) { $('noBle').hidden = false; $('btnStart').disabled = true; }
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  renderConn(); renderPair(); applyWake();
  // Zum Testen der Oberflaeche:  index.html?demo  bzw.  ?demo&view=alarm
  const qs = new URLSearchParams(location.search);
  if (qs.has('demo')) { demo = true; attach(new window.DemoDevice()); dev.connect().then(() => { show(qs.get('view') || 'live'); if (qs.get('wizard')) { openWizard(qs.get('wizard')); if (qs.has('run')) startCal(null); } }); }
  window.KneeApp = { show, openWizard };
})();
