// KneeAngle Web-App - Oberflaeche
'use strict';
(function () {
  const P = window.KneeProto;
  const APP_VERSION = '3.0.1';
  const $ = (id) => document.getElementById(id);
  const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v)) ? '–' : v.toFixed(d).replace('-', '−');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let dev = null, demo = false;
  let live = null, status = null, settings = null, edit = null, cal = null, diag = null, devTimes;
  let auth = { authed: false, windowOpen: false, ownerSet: false };
  let conn = 'disconnected';
  const prefs = { phoneSound: true, phoneVib: true, wake: false };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem('knee.prefs') || '{}')); } catch (e) { /* Standardwerte */ }
  if (prefs.phoneAlarm === false) { prefs.phoneSound = false; prefs.phoneVib = false; }   // Einstellung der alten Version uebernehmen
  delete prefs.phoneAlarm;
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
    if (v === 'log') drawChart($('chart'), chartSpan * 1000);
    if (v === 'live') drawChart($('spark'), 120000);
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));

  // ---------------------------------------------------------------------------
  //  Verbindung
  // ---------------------------------------------------------------------------
  function attach(d) {
    dev = d;
    d.on('conn', (s) => { conn = s; if (s === 'connected') { $('devName').textContent = d.name; } renderConn(); renderBanners(); renderCalTab(); renderWzConn(); if (s !== 'connected') { live = null; renderLive(); stopPhoneAlarm(); } });
    d.on('live', (l) => { live = l; onLive(l); });
    d.on('status', (s) => { status = s; renderStatus(); renderBanners(); });
    d.on('settings', (s) => { settings = s; if (!edit || !isDirty()) { edit = { ...s }; fillForm(); } renderLive(); renderBanners(); });
    d.on('cal', onCal);
    d.on('auth', (a) => { auth = a; renderPair(); renderBanners(); });
    d.on('diag', (x) => { diag = x; renderDiag(); });
    devTimes = undefined;
    d.on('caltimes', (t) => { devTimes = t ? { sensor: t.sensor * 1000, joint: t.joint * 1000, zero: t.zero * 1000 } : null; renderCalTab(); });
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
  async function disconnectAsk() {
    if (!dev) { show('welcome'); return; }
    if (conn === 'connected' && !await ask(demo ? 'Ansicht ohne Gerät beenden?' : 'Verbindung zum Gerät trennen? Das Gerät misst und warnt weiter.', 'Trennen', 'Abbrechen')) return;
    dev.disconnect(); if (demo) show('welcome');
  }
  $('btnConn').addEventListener('click', () => {
    if (conn === 'connected' || conn === 'reconnecting' || conn === 'connecting') disconnectAsk();
    else if (demo) { show('welcome'); } else connectReal();
  });
  $('btnDisc').addEventListener('click', disconnectAsk);
  function renderConn() {
    const map = { connected: ['on', demo ? 'Ansicht ohne Gerät' : 'verbunden', demo ? 'Demo' : 'Verbunden'], connecting: ['wait', 'verbinde …', 'Verbinde …'], reconnecting: ['wait', 'Verbindung verloren, suche Gerät …', 'Suche …'], disconnected: ['off', 'nicht verbunden', 'Verbinden'] };
    const m = map[conn] || map.disconnected;
    $('connDot').dataset.s = m[0]; $('btnConn').dataset.s = m[0]; $('connText').textContent = m[1]; $('connBtn').textContent = m[2];
    $('btnDisc').hidden = conn !== 'connected';
    if (typeof renderPair === 'function') renderPair();
    if (typeof renderBanners === 'function') renderBanners();
  }
  const canWrite = () => conn === 'connected' && auth.authed;
  let toastTimer = null;
  function toast(text, err) {
    let t = $('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
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
      if (status.proto < P.PROTO_VERSION) b.push(['err', 'Firmware zu alt', `Auf dem Gerät läuft Firmware ${status.fw}. Messen und Alarm funktionieren, für die Kalibrierung bitte Firmware 2.1 aufspielen.`]);
      else if (status.proto > P.PROTO_VERSION) b.push(['err', 'App zu alt', 'Das Gerät hat eine neuere Firmware. Bitte die App neu laden (aktualisieren).']);
      if (cal && cal.mode && !wz.kind) b.push(['run', 'Kalibrierung läuft', `Auf dem Gerät läuft «${TITLE[MODE_KIND[cal.mode]]}». Der Alarm ist so lange aus.`]);
      if (!auth.authed) b.push(['', 'Nur Ansicht', auth.windowOpen ? 'Dieses Handy ist nicht gekoppelt. Unter „Mehr“ jetzt koppeln.' : 'Zum Koppeln das Gerät aus- und einschalten und innert 60 Sekunden verbinden.']);
      if (!(status.hwBits & P.HB.S1) || !(status.hwBits & P.HB.S2)) b.push(['err', 'Sensor nicht erreichbar', 'Kabel zum Unterschenkel-Sensor prüfen. Der Alarm arbeitet so lange nicht.']);
      if (settings && settings.motorOn === false) b.push(['', 'Vibration am Gerät ist aus', 'Bei Überstreckung warnt nur das Handy, und nur solange die App offen ist. Einschalten unter „Alarm“.']);
      if (!(status.hwBits & P.HB.MOTOR)) b.push(['err', 'Vibrationsmotor nicht gefunden', 'Das Gerät kann nicht vibrieren. Verkabelung des Motor-Bausteins prüfen.']);
      if (live && (live.aflags & P.AF.BATT_CRIT)) b.push(['err', 'Akku fast leer', 'Der Alarm fällt bald aus. Bitte jetzt laden.']);
      else if (live && (live.aflags & P.AF.BATT_LOW)) b.push(['', 'Akku schwach', 'Bitte bald laden.']);
      if (!(status.calBits & P.CB.ACC1) || !(status.calBits & P.CB.ACC2)) b.push(['', 'Sensoren noch nicht eingemessen', 'Unter «Kalibrieren» einmalig «Sensoren einmessen». Ohne kann der Winkel um mehrere Grad falsch sein.']);
    }
    $('banners').innerHTML = b.map((x) => `<div class="banner ${x[0]}"><b>${esc(x[1])}</b>${esc(x[2])}${x[0] === 'run' ? '<button class="btn small" id="btnResume">Anzeigen</button>' : ''}</div>`).join('');
    const br = $('btnResume'); if (br) br.addEventListener('click', () => { if (cal && cal.mode) wzResume(cal); });
  }

  // ---------------------------------------------------------------------------
  //  Messen
  // ---------------------------------------------------------------------------
  const kneeView = window.KneeArt.gauge($('knee'));
  const heroSvg = $('heroKnee'); heroSvg.__g = window.KneeArt.gauge(heroSvg); heroSvg.dataset.kanim = 'hero';
  let rafPending = false, lastPhoneState = -1;
  function onLive(l) {
    pushChart(l); recordRow(l); phoneAlarm(l); updCheck();
    if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; renderLive(); }); }
  }
  function invalidReason() {
    if (!status) return 'Kein Winkel';
    if (!(status.hwBits & P.HB.S1) || !(status.hwBits & P.HB.S2)) return 'Sensor nicht erreichbar';
    if (!(status.calBits & P.CB.JOINT) || !(status.calBits & P.CB.ZERO)) return 'Noch nicht angelegt';
    if (live && (live.sysFlags & P.SF.BIAS)) return 'Kurz ruhig halten';
    return 'Kein gültiger Winkel';
  }
  function renderLive() {
    const body = document.body;
    if (conn !== 'connected' || !live) {
      body.dataset.state = 'off'; $('angle').textContent = '–';
      kneeView.set(null, settings ? settings.limit : -5, settings ? settings.zone : 10, !settings || settings.approachOn, 'off');
      $('stateLine').textContent = conn === 'reconnecting' ? 'Verbindung verloren' : (conn === 'connecting' ? 'Verbinde …' : 'Nicht verbunden');
      $('subLine').textContent = conn === 'reconnecting' ? 'Das Gerät misst und warnt selbständig weiter.' : '';
      $('silBar').hidden = true; renderAlarmHead(); return;
    }
    const l = live, lim = l.effLimit, zone = settings ? settings.zone : 10;
    let st = 'ok', text = 'Im sicheren Bereich';
    if (l.state === P.STATE.CAL) { st = 'invalid'; text = 'Kalibrierung läuft'; }
    else if (l.angle === null || l.state === P.STATE.INVALID) { st = 'invalid'; text = invalidReason(); }
    else if (l.state === P.STATE.OVER) { st = 'over'; text = (l.aflags & P.AF.PREDICTED) ? 'Achtung, Grenze!' : 'Überstreckt'; }
    else if (l.state === P.STATE.APPROACH) { st = 'approach'; text = 'Nahe an der Grenze'; }
    body.dataset.state = st;
    kneeView.set(l.angle, lim, zone, !settings || settings.approachOn, st);
    if (l.angle === null) { $('angle').textContent = '–'; }
    else $('angle').innerHTML = esc(fmt(l.angle, 1)) + '<sup>°</sup>';
    $('stateLine').textContent = text;
    let sub = '';
    if (l.angle !== null && l.state !== P.STATE.CAL) {
      if (l.aflags & P.AF.UNRELIABLE) sub = `Messung unsicher (±${fmt(l.sigma, 1)}°). Bein kurz ruhig halten.`;
      else sub = `Grenze ${fmt(lim, 1)}° · Genauigkeit ±${fmt(Math.max(0.1, l.sigma), 1)}°`;
      if (l.sysFlags & P.SF.VERT) sub += ' (Seitenlage: weniger genau)';
    }
    $('subLine').textContent = sub;
    // Stumm / Aus deutlich zeigen
    const sb = $('silBar');
    if (l.silence === P.SILENCE.OFF) { sb.hidden = false; $('silText').textContent = 'Alarm ist ausgeschaltet'; }
    else if (l.silence === P.SILENCE.MUTED) { const r = status ? status.muteRemainS : 0; sb.hidden = false; $('silText').textContent = `Stumm, noch ${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')} min`; }
    else sb.hidden = true;
    renderAlarmHead();
  }
  // Reiter Alarm: Kopf mit Zustand und Stummschaltung
  function renderAlarmHead() {
    const h = $('alarmHead'), l = live;
    let s = 'on', title = 'Alarm aktiv', sub = settings ? `Vibriert ab ${fmt(settings.limit, 1)}°` + (settings.approachOn ? `, leichte Pulse ab ${fmt(settings.limit + settings.zone, 1)}°` : '') : '–';
    if (conn !== 'connected') { s = 'off'; title = 'Nicht verbunden'; sub = 'Das Gerät warnt trotzdem selbständig.'; }
    else if (l && l.silence === P.SILENCE.OFF) { s = 'off'; title = 'Alarm ausgeschaltet'; sub = 'Das Gerät vibriert nicht.'; }
    else if (l && l.silence === P.SILENCE.MUTED) { const r = status ? status.muteRemainS : 0; s = 'muted'; title = 'Stumm'; sub = `Noch ${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')} min, dann wieder aktiv.`; }
    h.dataset.s = s; $('alarmTitle').textContent = title; $('muteState').textContent = sub;
    $('btnArm2').hidden = !(conn === 'connected' && l && l.silence !== P.SILENCE.NONE);
    $('muteBtns').hidden = conn !== 'connected' || (l && l.silence === P.SILENCE.OFF);
  }
  function renderStatus() {
    if (!status) return;
    $('fMin').textContent = status.min === null ? '–' : fmt(status.min, 0) + '°';
    $('fMax').textContent = status.max === null ? '–' : fmt(status.max, 0) + '°';
    $('fOver').textContent = status.overCount; $('lOver').textContent = status.overCount; $('lWarn').textContent = status.warnCount; $('lApp').textContent = status.approachCount;
    $('fOver').dataset.on = status.overCount > 0 ? '1' : '0'; $('lOver').dataset.on = status.overCount > 0 ? '1' : '0';
    $('lWarn').dataset.on = status.warnCount > 0 ? '1' : '0'; $('lApp').dataset.on = status.approachCount > 0 ? '1' : '0';
    const bt = $('batt');
    if ((status.hwBits & P.HB.BATT) && status.battMv > 0) {
      const pct = Math.max(0, Math.min(100, Math.round((status.battMv - 3300) / (4150 - 3300) * 100)));
      bt.hidden = false; bt.textContent = `Akku ${pct} %`; bt.dataset.low = status.battMv < 3500 ? '1' : '0';
    } else bt.hidden = true;
    renderCalTab();
    const kv = [['Firmware', status.fw], ['Sensor Oberschenkel', (status.hwBits & P.HB.S1) ? `ok, ${status.rateS1} Hz` : 'Fehler'], ['Sensor Unterschenkel', (status.hwBits & P.HB.S2) ? `ok, ${status.rateS2} Hz` : 'Fehler'],
      ['Vibrationsmotor', (status.hwBits & P.HB.MOTOR) ? ((status.calBits & P.CB.MOTORCAL) ? 'ok, eingemessen' : 'ok') : 'nicht gefunden'],
      ['Akku', (status.hwBits & P.HB.BATT) ? (status.battMv / 1000).toFixed(2) + ' V' : 'nicht gemessen']];
    $('devInfo').innerHTML = kv.map((x) => `<dt>${esc(x[0])}</dt><dd>${esc(x[1])}</dd>`).join('');
    if (live) renderLive();
  }
  document.querySelectorAll('#muteBtns button').forEach((b) => b.addEventListener('click', () => act(() => dev.send(P.cmd.mute(+b.dataset.mute)), `Alarm ${b.dataset.mute} Minuten stumm`)));
  const armAgain = () => {
    if (live && live.silence === P.SILENCE.OFF) act(() => dev.writeSettings({ ...settings, alarmEnabled: true }), 'Alarm eingeschaltet');
    else act(() => dev.send(P.cmd.mute(0)), 'Alarm wieder aktiv');
  };
  $('btnArm').addEventListener('click', armAgain);
  $('btnArm2').addEventListener('click', armAgain);

  // ---- Ton und Vibration am Handy ---------------------------------------------
  let audio = null, beepTimer = null;
  function ensureAudio() { try { if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === 'suspended') audio.resume(); } catch (e) { audio = null; } }
  function beep() {
    if (audio && prefs.phoneSound) { const o = audio.createOscillator(), g = audio.createGain(); o.frequency.value = 880; o.connect(g); g.connect(audio.destination); g.gain.setValueAtTime(0.25, audio.currentTime); g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.18); o.start(); o.stop(audio.currentTime + 0.2); }
    if (navigator.vibrate && prefs.phoneVib) navigator.vibrate(180);
  }
  function stopPhoneAlarm() { if (beepTimer) { clearInterval(beepTimer); beepTimer = null; } lastPhoneState = -1; }
  function phoneAlarm(l) {
    const on = (prefs.phoneSound || prefs.phoneVib) && l.state === P.STATE.OVER && l.silence === P.SILENCE.NONE;
    if (on && !beepTimer) { beep(); beepTimer = setInterval(beep, 350); }
    else if (!on && beepTimer) stopPhoneAlarm();
  }

  // ---------------------------------------------------------------------------
  //  Kalibrieren: drei Ablaeufe, vom Geraet Schritt fuer Schritt gefuehrt.
  //  Die App zeigt nur an, was das Geraet meldet (CAL-Paket), plus Einleitung,
  //  Ergebnis und Kontrolle. Das Geraet wartet bei jedem Schritt auf den Benutzer.
  // ---------------------------------------------------------------------------
  const HI = P.HINT, RS = P.RESULT, JS = P.JSTEP;
  if (prefs.rig !== 'rig') prefs.rig = 'leg';
  const onLeg = () => prefs.rig === 'leg';
  const KIND_MODE = { sensor: 1, joint: 2, zero: 3 };
  const MODE_KIND = { 1: 'sensor', 2: 'joint', 3: 'zero' };
  const TITLE = { sensor: 'Sensoren einmessen', joint: 'Anlegen', zero: 'Nullpunkt nachstellen' };
  const calProtoOk = () => !!status && status.proto >= 2;
  const isCalibrated = () => !!status && (status.calBits & P.CB.JOINT) && (status.calBits & P.CB.ZERO);
  const sensorsDone = () => !!status && (status.calBits & P.CB.ACC1) && (status.calBits & P.CB.ACC2);

  // ---- Bilder: fuer Bein und Testgelenk dieselben (knee.js) -------------------
  const pict = (key) => window.KneeArt.pict(key);

  // ---- Texte ------------------------------------------------------------------
  // [Ton, Ueberschrift, Erklaerung]; Ton: go = jetzt etwas tun, hold = ruhig, fix = korrigieren, ok = gezaehlt
  function say(mode, step, hint) {
    const leg = onLeg();
    if (hint === HI.COMPUTING) return ['hold', 'Wird berechnet …', leg ? 'Bein locker lassen. Einen Moment.' : 'Einen Moment.'];
    if (hint === HI.SENSOR) return ['fix', 'Sensor antwortet nicht', 'Kabel und Stecker zum unteren Sensor prüfen. Das Gerät versucht es von selbst weiter.'];
    if (hint === HI.SETTLE) return ['hold', 'Messung stellt sich ein …', leg ? 'Ruhig bleiben, Kniescheibe zeigt nach oben. Gleich geht es weiter.' : 'Ruhig halten. Die Gelenkachse muss waagrecht liegen – das Testgelenk nicht flach auf den Tisch legen.'];
    if (mode === 1) switch (hint) {
      case HI.PLACE: return ['go', 'Nächste Lage', 'Auf eine andere Seite oder Kante legen und loslassen.'];
      case HI.HOLD_STILL: return ['hold', 'Liegen lassen …', 'Nicht berühren, bis der Ring voll ist.'];
      case HI.POSE_DONE: return ['ok', 'Gezählt!', 'Jetzt in eine neue Lage drehen.'];
      case HI.POSE_SAME: return ['fix', 'Diese Lage hast du schon', 'Mindestens eine Vierteldrehung weiter drehen oder eine andere Seite nach unten legen.'];
      case HI.UNSTEADY: return ['fix', 'Zu unruhig', 'Ablegen und ganz loslassen. In der Hand gehalten ist es zu unruhig.'];
      case HI.OTHER_SIDES: return ['fix', 'Andere Seiten fehlen', 'Auch Seiten nach unten legen, die noch nie unten waren, auch auf den Kopf.'];
      default: return ['hold', '', ''];
    }
    if (mode === 3) switch (hint) {
      case HI.WAIT_REST: return ['fix', 'Ganz ruhig halten', 'Gestreckt bleiben und nicht bewegen.'];
      case HI.AXIS_VERTICAL: return ['fix', 'Anders halten', leg ? 'Bein nicht zur Seite drehen: Kniescheibe zeigt nach oben.' : 'So drehen, dass die Gelenkachse waagrecht liegt.'];
      default: return ['hold', 'Nicht bewegen', 'Gestreckt bleiben, bis der Ring voll ist.'];
    }
    switch (step) {
      case JS.REST: return hint === HI.WAIT_REST ? ['fix', 'Noch ruhiger halten', 'Das Gerät wartet, bis alles still ist.']
        : ['hold', 'Nicht bewegen', leg ? 'Bequem sitzen, Fuss am Boden, Bein locker.' : 'Testgelenk ruhig liegen lassen.'];
      case JS.MOVE: switch (hint) {
        case HI.EX_TILT: return ['go', 'Übung 2: kippen und drehen', leg ? 'Fuss leicht anheben und das ganze Bein in alle Richtungen bewegen: Knie nach aussen und innen kippen, Bein drehen, kleine Kreise.' : 'Die ganze Anordnung in der Luft in alle Richtungen kippen und drehen. Dabei weiter beugen.'];
        case HI.EX_BOTH: return ['go', 'Gut so, weiter bewegen', 'Beide Übungen abwechseln, bis alle Balken voll sind. Die Aufnahme endet von selbst.'];
        case HI.MORE_THIGH: return ['fix', 'Nachbessern: mehr kippen und drehen', leg ? 'Das ganze Bein mehr bewegen, nicht nur das Knie beugen.' : 'Den oberen Teil mehr in verschiedene Richtungen kippen und drehen.'];
        case HI.MORE_SHANK: return ['fix', 'Nachbessern: Unterschenkel mehr bewegen', 'Das Knie weiter beugen und strecken.'];
        case HI.MORE_RANGE: return ['fix', 'Nachbessern: weiter beugen', leg ? 'Ganz strecken und mindestens bis zum rechten Winkel beugen.' : 'Das Gelenk weiter auf- und zuklappen.'];
        default: return ['go', 'Übung 1: beugen und strecken', leg ? 'Fuss anheben und das Knie langsam ganz strecken und wieder beugen. Mehrmals.' : 'Das Gelenk mehrmals langsam ganz auf- und zuklappen.'];
      }
      case JS.TILT: switch (hint) {
        case HI.HOLD_STILL: return ['hold', 'So halten', 'Nicht bewegen, bis der Ring voll ist.'];
        case HI.WAIT_REST: return ['fix', 'Ruhiger halten', 'Schräg bleiben. Abstützen hilft.'];
        default: return ['go', 'Zusatzschritt: zur Seite kippen', leg ? 'Im Sitzen das Knie nach aussen fallen lassen, bis der Balken grün ist. Dann halten.' : 'Das Testgelenk seitlich ankippen, bis der Balken grün ist. Dann halten.'];
      }
      case JS.STRAIGHT: switch (hint) {
        case HI.HOLD_STILL: return ['hold', 'Nicht bewegen', 'Das Gerät misst die gestreckte Haltung.'];
        case HI.WAIT_REST: return ['fix', 'Ganz ruhig halten', 'Gestreckt bleiben, nicht bewegen.'];
        case HI.AXIS_VERTICAL: return ['fix', 'Anders halten', leg ? 'Bein nicht zur Seite drehen: Kniescheibe zeigt nach oben.' : 'So drehen, dass die Gelenkachse waagrecht liegt.'];
        default: return ['go', leg ? 'Bein ganz strecken' : 'Gelenk ganz strecken', leg ? 'Ferse auf einen zweiten Stuhl legen, Kniekehle frei hängen lassen, Muskeln locker. Wenn das Bein ganz gestreckt ist: unten tippen.' : 'Das Gelenk ganz gerade (0°) und aufrecht halten, Gelenkachse waagrecht (nicht flach hinlegen). Dann unten tippen.'];
      }
      case JS.FLEX: switch (hint) {
        case HI.HOLD_STILL: return ['hold', 'So halten', 'Nicht bewegen, bis der Ring voll ist.'];
        case HI.WAIT_REST: return ['fix', 'Ruhiger halten', 'Gebeugt bleiben, nicht bewegen.'];
        default: return ['go', 'Jetzt beugen und halten', leg ? 'Fuss zurück auf den Boden stellen, Knie etwa rechtwinklig. Dann ruhig halten.' : 'Das Gelenk etwa 90° beugen und ruhig halten, Gelenkachse weiterhin waagrecht.'];
      }
      default: return ['hold', '', ''];
    }
  }
  function pictFor(mode, step, hint) {
    if (hint === HI.COMPUTING) return 'compute';
    if (mode === 1) return 'poses';
    if (mode === 3) return 'straight';
    switch (step) {
      case JS.REST: return 'rest';
      case JS.MOVE: return (hint === HI.EX_TILT || hint === HI.EX_BOTH || hint === HI.MORE_THIGH) ? 'exTilt' : 'exFlex';
      case JS.COMPUTE: return 'compute';
      case JS.TILT: return 'tilt';
      case JS.STRAIGHT: return 'straight';
      case JS.FLEX: return 'flexHold';
      default: return '';
    }
  }
  const FAIL = {
    [RS.ABORTED]: ['Abgebrochen', 'Es wurde nichts geändert. Die bisherige Kalibrierung gilt weiter.'],
    [RS.ACC_FIT]: ['Lagen zu unruhig', 'Jede Lage ablegen und ganz loslassen, nicht in der Hand halten.'],
    [RS.TOO_LITTLE_MOTION]: ['Zu wenig Bewegung', 'Bei Übung 1 das Gelenk mehrmals ganz beugen und strecken.'],
    [RS.AXIS1]: ['Zu wenig gekippt und gedreht', 'Bei Übung 2 das Ganze mehr in alle Richtungen kippen und drehen, nicht nur beugen.'],
    [RS.AXIS2]: ['Unterschenkel zu wenig bewegt', 'Bei Übung 1 weiter beugen und strecken.'],
    [RS.SIGN]: ['Richtung nicht eindeutig', 'Beim Zusatzschritt deutlicher zur Seite kippen und ganz ruhig halten.'],
    [RS.NO_REST]: ['Keine Ruhe erkannt', 'Das Gerät braucht einen Moment Stillstand. Abstützen hilft.'],
    [RS.TIMEOUT]: ['Zu lange gewartet', 'Es wurde nichts geändert. Einfach noch einmal starten.'],
    [RS.TOO_FEW]: ['Zu viele gleiche Lagen', 'Noch einmal starten und die Lagen stärker wechseln.'],
    [RS.NEED_JOINT]: ['Zuerst anlegen', 'Der Nullpunkt kann erst nach «Anlegen» nachgestellt werden.'],
    [RS.RANGE]: ['Zu wenig gebeugt', 'Ganz strecken und mindestens rechtwinklig beugen.']
  };

  // ---- Kleine Bausteine -----------------------------------------------------------
  const ring = (id) => `<svg class="ring" id="${id}" viewBox="0 0 120 120" aria-hidden="true"><circle class="rbg" cx="60" cy="60" r="50"/><circle class="rfg" cx="60" cy="60" r="50" pathLength="100" stroke-dasharray="0 100" transform="rotate(-90 60 60)"/><path class="rok" d="M40 62l14 14 28-30"/></svg>`;
  function setRing(id, pct) { const r = $(id); if (!r) return; r.querySelector('.rfg').setAttribute('stroke-dasharray', `${Math.max(0, Math.min(100, pct))} 100`); r.dataset.full = pct >= 100 ? '1' : '0'; r.dataset.empty = pct <= 0 ? '1' : '0'; }
  const meter = (id, label) => `<div class="meter" id="${id}"><div class="mlab"><span>${esc(label)}</span><b>0 %</b></div><div class="bar"><i></i></div></div>`;
  function setMeter(id, pct, active) { const m = $(id); if (!m) return; m.querySelector('b').textContent = pct >= 100 ? 'erledigt' : Math.round(pct) + ' %'; m.querySelector('i').style.width = Math.min(100, pct) + '%'; m.dataset.ok = pct >= 100 ? '1' : '0'; m.dataset.now = active ? '1' : '0'; }
  const level = (id, unit) => `<div class="level" id="${id}"><div class="lval"><b>–</b><span>${esc(unit)}</span></div><div class="ltrack"><i></i><s></s></div></div>`;
  function setLevel(id, val, target, max) { const l = $(id); if (!l) return; l.querySelector('b').textContent = fmt(val, 0) + '°'; l.querySelector('i').style.width = Math.min(100, val / max * 100) + '%'; l.querySelector('s').style.left = (target / max * 100) + '%'; l.dataset.ok = val >= target ? '1' : '0'; }

  // ---- Rueckmeldung am Handy (kurz, nur wenn erlaubt) --------------------------------
  function fb(kind) {
    const pat = { pose: 35, step: 60, ok: [70, 90, 70], fail: [40, 70, 40, 70, 40] }[kind];
    if (prefs.phoneVib && navigator.vibrate && pat) navigator.vibrate(pat);
    if (prefs.phoneSound && audio && (kind === 'ok' || kind === 'step' || kind === 'pose')) {
      try { const o = audio.createOscillator(), g = audio.createGain(); o.frequency.value = kind === 'ok' ? 1046 : 1318; o.connect(g); g.connect(audio.destination); g.gain.setValueAtTime(0.12, audio.currentTime); g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.09); o.start(); o.stop(audio.currentTime + 0.1); } catch (e) { /* egal */ }
    }
  }

  // ---- Zeitpunkte der Kalibrierungen ------------------------------------------------------
  // Das Geraet speichert und meldet sie ab Firmware 2.2 (Merkmal CALTIME). Mit aelterer Firmware
  // merkt sich die App, wann sie eine Kalibrierung abgeschlossen hat (pro Geraet, auf diesem Handy).
  // Meldet das Geraet einen Zeitpunkt als unbekannt (0), gilt der auf dem Handy gemerkte.
  const timesKey = () => 'knee.caltimes.' + (dev && dev.name ? dev.name : 'x');
  function loadTimes() { try { return JSON.parse(localStorage.getItem(timesKey()) || '{}'); } catch (e) { return {}; } }
  function saveTimes(t) { try { localStorage.setItem(timesKey(), JSON.stringify(t)); } catch (e) { /* egal */ } }
  function calTimes() {
    const t = loadTimes();
    if (devTimes) ['sensor', 'joint', 'zero'].forEach((k) => { if (devTimes[k]) t[k] = devTimes[k]; });
    return t;
  }
  function noteCalDone(c) {
    if (devTimes) return;                                  // das Geraet fuehrt die Zeiten selbst (ab 2.2)
    const t = loadTimes(), now = Date.now();
    if (c.result === RS.UNDONE) { if (t.prev) { Object.assign(t, t.prev); delete t.prev; } saveTimes(t); return; }
    if (c.result !== RS.OK && c.result !== RS.OK_PARTIAL) return;
    t.prev = { joint: t.joint || 0, zero: t.zero || 0 };
    if (c.resultMode === 1) t.sensor = now;
    if (c.resultMode === 2) { t.joint = now; t.zero = now; }
    if (c.resultMode === 3) t.zero = now;
    saveTimes(t);
  }
  function whenText(ms) {
    if (!ms) return '';
    const d = new Date(ms), n = new Date(), hm = d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === n.toDateString()) return 'heute ' + hm;
    const y = new Date(n); y.setDate(n.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'gestern ' + hm;
    return d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ', ' + hm;
  }
  function ageText(ms) { const m = Math.round((Date.now() - ms) / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; }

  // ---- Reiter "Kalibrieren" ---------------------------------------------------------
  function renderCalTab() {
    const ready = conn === 'connected' && calProtoOk();
    const sens = sensorsDone(), joint = isCalibrated(), running = !!(cal && cal.mode);
    const t = calTimes();
    let tone = 'off', state, sub = '', next = null;
    if (conn !== 'connected') { state = 'Nicht verbunden'; sub = 'Zum Kalibrieren zuerst das Gerät verbinden.'; }
    else if (!calProtoOk()) { tone = 'todo'; state = 'Firmware zu alt'; sub = 'Für den Assistenten Firmware 2.1 oder neuer aufspielen.'; }
    else if (running) { tone = 'run'; state = `Läuft: ${TITLE[MODE_KIND[cal.mode]]}`; sub = 'Der Alarm ist so lange aus.'; next = MODE_KIND[cal.mode]; }
    else if (!sens) { tone = 'todo'; state = 'Sensoren noch nicht eingemessen'; sub = 'Einmalig, auf dem Tisch, etwa 3 Minuten.'; next = 'sensor'; }
    else if (!joint) { tone = 'todo'; state = 'Noch nicht angelegt'; sub = 'Etwa 1 Minute, die App führt dich.'; next = 'joint'; }
    else { tone = 'ok'; state = 'Bereit zum Messen'; sub = [t.joint ? 'Angelegt ' + whenText(t.joint) : 'Angelegt', t.zero && t.zero !== t.joint ? 'Nullpunkt ' + whenText(t.zero) : ''].filter(Boolean).join(' · '); }
    $('calStatus').dataset.tone = tone; $('calState').textContent = state; $('calStateSub').textContent = sub;
    const bn = $('btnCalNext');
    bn.hidden = !next || !ready;
    if (next) bn.textContent = running ? 'Anzeigen' : `${TITLE[next]} starten`;
    bn.dataset.kind = next || '';
    // Hinweis, wann der Nullpunkt geprueft werden sollte
    const ref = Math.max(t.joint || 0, t.zero || 0);
    const due = ready && joint && !running && ref && (Date.now() - ref) > 60 * 60000;
    $('calHint').hidden = !due;
    if (due) $('calHintText').innerHTML = `<b>Seit ${esc(ageText(ref))} nicht mehr nachgestellt.</b> Zeigt das gestreckte Bein nicht mehr etwa 0°: Nullpunkt nachstellen. Nach dem Ab- und wieder Anlegen: «Anlegen».`;
    const st = (id, mk, good, t1, t0) => { const e = $(id); e.dataset.ok = good ? '1' : '0'; e.textContent = good ? t1 : t0; $(mk).dataset.ok = good ? '1' : '0'; };
    if (status) {
      st('stSensor', 'mkSensor', sens, t.sensor ? 'Gespeichert ' + whenText(t.sensor) : 'Gespeichert', 'Noch nicht eingemessen');
      st('stJoint', 'mkJoint', joint, t.joint ? 'Gespeichert ' + whenText(t.joint) : 'Gespeichert', 'Noch nicht angelegt');
      st('stZero', 'mkZero', joint, t.zero ? 'Gespeichert ' + whenText(t.zero) : 'Gespeichert', 'Braucht zuerst «Anlegen»');
    }
    document.querySelector('[data-cal="joint"]').textContent = joint ? 'Neu anlegen' : 'Anlegen';
    document.querySelectorAll('[data-cal]').forEach((b) => { b.disabled = !ready || running || (b.dataset.cal === 'zero' && !joint); });
    $('pRig').checked = !onLeg();
    $('advSum').textContent = (onLeg() ? 'Am Bein' : 'Testgelenk') + (status && !sens ? ' · Sensoren fehlen' : ' · Sensoren');
    if (status && !sens) $('calAdv').open = true;
    const u = $('undoBlock');
    u.hidden = !(ready && cal && cal.undo && !running);
    if (!u.hidden) $('undoText').textContent = 'Letzte Änderung verwerfen und die vorherige Kalibrierung wieder verwenden.';
  }
  $('pRig').addEventListener('change', (e) => { prefs.rig = e.target.checked ? 'rig' : 'leg'; savePrefs(); renderCalTab(); });
  $('btnCalNext').addEventListener('click', () => { const k = $('btnCalNext').dataset.kind; if (!k) return; if (cal && cal.mode) wzResume(cal); else openWizard(k); });
  document.querySelectorAll('[data-cal]').forEach((b) => b.addEventListener('click', () => openWizard(b.dataset.cal)));
  $('btnUndo').addEventListener('click', async () => { if (await ask('Letzte Änderung rückgängig machen?', 'Rückgängig', 'Abbrechen')) undoLast(); });
  // Eigene Rückfrage im App-Design (statt der Browser-Meldung)
  function ask(text, yes = 'Ja', no = 'Nein') {
    return new Promise((resolve) => {
      const d = $('dlg');
      $('dlgText').textContent = text; $('dlgYes').textContent = yes; $('dlgNo').textContent = no;
      d.hidden = false; $('dlgNo').focus();
      const done = (v) => { d.hidden = true; $('dlgYes').onclick = $('dlgNo').onclick = null; resolve(v); };
      $('dlgYes').onclick = () => done(true); $('dlgNo').onclick = () => done(false);
    });
  }
  function undoLast() { wz.undoSeq = cal ? cal.resultSeq : -1; act(() => dev.send(P.cmd.char('U'))); }

  // ---- Assistent ---------------------------------------------------------------------
  const wz = { kind: null, phase: null, startSeq: 0, key: '', pictKey: '', lastHint: -1, lastStep: -1, tiltSeen: false, timer: null, muted: false, refOpen: false, undoSeq: -1, shown: null, res: null };
  function openWizard(kind) {
    if (conn !== 'connected') { toast('Nicht verbunden.', true); return; }
    if (!auth.authed) { toast('Dieses Handy ist nicht gekoppelt. Siehe «Mehr».', true); return; }
    if (!calProtoOk()) { toast('Die Firmware ist zu alt für die neue Kalibrierung (nötig: 2.1).', true); return; }
    Object.assign(wz, { kind, phase: 'intro', key: '', pictKey: '', lastHint: -1, lastStep: -1, tiltSeen: false, refOpen: false, res: null });
    $('wizard').hidden = false; document.body.classList.add('wz-open');
    wzIntro();
  }
  function wzResume(c) {
    Object.assign(wz, { kind: MODE_KIND[c.mode], phase: 'run', startSeq: c.resultSeq, key: '', pictKey: '', lastHint: -1, lastStep: -1, tiltSeen: c.step === JS.TILT, refOpen: false, res: null });
    $('wizard').hidden = false; document.body.classList.add('wz-open');
    $('wzTitle').textContent = TITLE[wz.kind]; $('wzClose').textContent = 'Abbrechen';
    wzRun(c);
  }
  function closeWizard() {
    clearTimeout(wz.timer);
    if (wz.muted) { wz.muted = false; if (dev && conn === 'connected') dev.send(P.cmd.mute(0)).catch(() => {}); }
    $('wizard').hidden = true; document.body.classList.remove('wz-open');
    wz.kind = null; wz.phase = null;
    renderCalTab(); renderBanners();
  }
  $('wzClose').addEventListener('click', async () => {
    if ((wz.phase === 'run' || wz.phase === 'starting') && cal && cal.mode) {
      if (!await ask('Kalibrierung abbrechen? Die bisherige Kalibrierung gilt dann weiter.', 'Abbrechen', 'Weitermachen')) return;
      if (!wz.kind) return;
      const seq = cal.resultSeq;
      try { await dev.send(P.cmd.char('x')); } catch (e) { /* unten behandelt */ }
      // Normalerweise meldet das Geraet "Abgebrochen". Kommt nichts, schliesst die App trotzdem.
      clearTimeout(wz.timer);
      wz.timer = setTimeout(() => {
        if (!wz.kind) return;
        const stillRunning = cal && cal.mode && cal.resultSeq === seq;
        closeWizard();
        if (stillRunning || conn !== 'connected') toast('Das Gerät hat nicht geantwortet. Gerät aus- und wieder einschalten.', true);
      }, 3000);
      return;
    }
    closeWizard();
  });

  function wzIntro() {
    const leg = onLeg(), k = wz.kind;
    $('wzTitle').textContent = TITLE[k]; $('wzClose').textContent = 'Schliessen';
    let pk, todo, go, extra = '';
    if (k === 'joint') {
      pk = 'place';
      todo = leg ? ['Arduino aussen am Oberschenkel, Sensor aussen am Schienbein anlegen. Gurte fest: nichts darf rutschen.', 'Auf einen Stuhl setzen, Fuss am Boden. Einen zweiten Stuhl oder Hocker vor dich stellen.', 'Das Gerät führt dich durch 4 kurze Schritte: ruhig halten, bewegen, strecken, beugen. Es wartet bei jedem Schritt auf dich.']
        : ['Beide Sensoren fest am Testgelenk. Nichts darf wackeln.', 'Testgelenk ruhig auf den Tisch legen.', 'Das Gerät führt dich durch 4 kurze Schritte: ruhig halten, bewegen, strecken, beugen. Es wartet bei jedem Schritt auf dich.'];
      go = 'Los geht’s';
    } else if (k === 'zero') {
      pk = 'straight';
      todo = leg ? ['Ferse auf einen Stuhl oder Hocker legen, Kniekehle frei hängen lassen.', 'Muskeln locker lassen, Kniescheibe zeigt nach oben.', 'Wenn das Bein ganz gestreckt ist: unten tippen und 2 Sekunden still halten.']
        : ['Das Gelenk ganz gerade (0°) halten, und zwar aufrecht wie ein Bein: die Gelenkachse waagrecht. Nicht flach auf den Tisch legen – dann sieht das Gerät die Schwerkraft nicht.', 'Abstützen hilft, z.B. an der Tischkante.', 'Wenn es ganz gestreckt ist: unten tippen und 2 Sekunden still halten.'];
      go = leg ? 'Bein ist gestreckt: 0° setzen' : 'Gelenk ist gestreckt: 0° setzen';
      extra = refBox('Mit diesem Winkel setzen');
    } else {
      pk = 'poses';
      todo = [leg ? 'Gerät <b>nicht</b> am Bein. Am besten am Testgelenk oder beide Sensoren fest miteinander verbinden.' : 'Beide Sensoren fest am Testgelenk, Gelenk gestreckt (z.B. mit Klebeband fixieren).',
        'Die Anordnung nacheinander in 14 verschiedene Lagen legen: jede Seite einmal nach unten, dazu auf die Kanten.', 'Jede Lage etwa 3 Sekunden ruhig liegen lassen. Das Gerät vibriert kurz, wenn die Lage gezählt ist.', 'Kein Zeitdruck. Etwa 3 Minuten.'];
      go = 'Starten';
    }
    $('wzBody').innerHTML = `<div class="wpict">${pict(pk)}</div><ol class="todo">${todo.map((t) => `<li>${t}</li>`).join('')}</ol>${extra}`;
    $('wzFoot').innerHTML = `<button class="btn" id="wzGo">${esc(go)}</button>`;
    $('wzGo').addEventListener('click', () => wzStart(null));
    bindRef((v) => wzStart(v));
  }
  function refBox(label) {
    return `<details class="block refbox"${wz.refOpen ? ' open' : ''}><summary>Winkel mit einem Winkelmesser gemessen?</summary><p class="muted">Haltung beibehalten und den gemessenen Winkel eintragen. Überstreckung als negative Zahl.</p><div class="row"><input type="number" id="wzRef" step="0.5" min="-30" max="30" value="0" inputmode="decimal"><span>Grad</span><button class="btn sec small grow" id="wzGoRef">${esc(label)}</button></div></details>`;
  }
  function bindRef(cb) {
    const b = $('wzGoRef'); if (!b) return;
    b.parentElement.parentElement.addEventListener('toggle', (e) => { wz.refOpen = e.target.open; });
    b.addEventListener('click', () => { const v = parseFloat($('wzRef').value); if (Number.isNaN(v) || v < -30 || v > 30) { toast('Bitte einen Winkel zwischen −30 und 30 eintragen.', true); return; } cb(v); });
  }

  async function wzStart(ref) {
    const k = wz.kind;
    wz.startSeq = cal ? cal.resultSeq : 0; wz.phase = 'starting';
    $('wzClose').textContent = 'Abbrechen';
    $('wzBody').innerHTML = `<div class="wpict">${pict('compute')}</div><div class="wsay"><div class="whint" data-tone="hold">Starte …</div></div>`; $('wzFoot').innerHTML = '';
    const bytes = k === 'sensor' ? P.cmd.char('s') : k === 'joint' ? P.cmd.char('a') : (ref === null ? P.cmd.char('z') : P.cmd.zeroRef(ref));
    try { await dev.send(bytes); } catch (e) { toast('Start fehlgeschlagen. Verbindung prüfen.', true); wz.phase = 'intro'; wzIntro(); return; }
    clearTimeout(wz.timer);
    wz.timer = setTimeout(() => {
      if (wz.phase === 'starting') { toast('Das Gerät hat nicht gestartet. Bitte noch einmal versuchen.', true); wz.phase = 'intro'; wzIntro(); }
    }, 9000);
  }

  // jedes CAL-Paket
  function onCal(c) {
    const prev = cal; cal = c;
    if (prev && c.resultSeq !== prev.resultSeq && !c.mode) noteCalDone(c);
    if (prev && c.resultSeq !== prev.resultSeq && c.result === RS.UNDONE && !c.mode) {
      toast('Rückgängig gemacht. Die vorherige Einstellung gilt wieder.'); fb('ok');
      if (wz.kind && (wz.phase === 'result' || wz.phase === 'check')) closeWizard();
    }
    renderCalTab(); renderBanners();
    if (!wz.kind) return;
    const mode = KIND_MODE[wz.kind];
    if (wz.phase === 'starting') {
      if (c.mode === mode) { clearTimeout(wz.timer); wz.phase = 'run'; fb('step'); }
      else if (!c.mode && c.resultSeq !== wz.startSeq) { clearTimeout(wz.timer); wzResult(c); return; }
      else return;
    }
    if (wz.phase !== 'run') return;
    if (!c.mode) { if (c.resultSeq !== wz.startSeq) wzResult(c); return; }
    if (c.mode !== mode) return;
    wzRun(c);
  }

  // Laufende Prozedur: Geruest nur beim Schrittwechsel neu bauen (Animationen laufen weiter)
  function wzRun(c) {
    const mode = c.mode, step = mode === 2 ? c.step : (mode === 1 ? (c.hint === HI.COMPUTING ? 9 : 0) : 0);
    const key = mode + ':' + step + ':' + onLeg();
    if (step === JS.TILT && mode === 2) wz.tiltSeen = true;
    if (key !== wz.key) {
      if (wz.key && wz.lastStep !== step) fb('step');
      wz.key = key; wz.pictKey = ''; wz.lastStep = step;
      let h = '';
      if (mode === 2) h += stepsBar(step);
      h += '<div class="wpict" id="wzPict"></div><div class="wsay" aria-live="polite"><div class="whint" id="wzHint"></div><div class="wsub" id="wzSub"></div></div><div id="wzWidget" class="wwidget"></div><p class="wtime" id="wzTime" hidden></p><div class="wconn" id="wzConn" hidden>Verbindung unterbrochen. Das Gerät wartet auf dich, die App verbindet neu …</div>';
      $('wzBody').innerHTML = h;
      $('wzWidget').innerHTML = widget(mode, step);
      $('wzFoot').innerHTML = '';
      wz.foot = '';
    }
    // Bild
    const pk = pictFor(mode, mode === 2 ? c.step : step, c.hint);
    if (pk !== wz.pictKey) { wz.pictKey = pk; $('wzPict').innerHTML = pict(pk); }
    // Text
    const t = say(mode, mode === 2 ? c.step : step, c.hint);
    const hEl = $('wzHint'); hEl.dataset.tone = t[0]; if (hEl.textContent !== t[1]) hEl.textContent = t[1];
    const sEl = $('wzSub'); if (sEl.textContent !== t[2]) sEl.textContent = t[2];
    if (mode === 1 && c.hint === HI.POSE_DONE && wz.lastHint !== HI.POSE_DONE) fb('pose');
    wz.lastHint = c.hint;
    updWidget(c, mode, step);
    // Frist (Sicherheitsnetz): erst in den letzten 30 s zeigen
    const te = $('wzTime');
    const showT = c.secLeft > 0 && c.secLeft <= 30 && c.hint !== HI.COMPUTING;
    te.hidden = !showT; if (showT) te.textContent = `Noch ${c.secLeft} s, sonst bricht das Gerät ab. Nichts wird geändert.`;
    // Knoepfe
    let foot = '';
    if (mode === 2 && c.step === JS.STRAIGHT && !c.a[0] && c.hint !== HI.COMPUTING) foot = 'straight';
    else if (mode === 1 && step === 0 && Math.min(c.a[0], c.a[1]) >= 10 && Math.min(c.a[2], c.a[3]) >= 45) foot = 'early:' + Math.min(c.a[0], c.a[1]);
    if (foot !== wz.foot) {
      wz.foot = foot;
      const f = $('wzFoot');
      if (foot === 'straight') {
        f.innerHTML = `<div class="footcol"><button class="btn" id="wzConfirm">${onLeg() ? 'Bein ist gestreckt' : 'Gelenk ist gestreckt'}</button>${refBox('Mit diesem Winkel bestätigen')}</div>`;
        $('wzConfirm').addEventListener('click', () => { dev.send(P.cmd.char('n')).catch(() => toast('Senden fehlgeschlagen.', true)); });
        bindRef((v) => dev.send(P.cmd.zeroRef(v)).catch(() => toast('Senden fehlgeschlagen.', true)));
      } else if (foot.startsWith('early')) {
        f.innerHTML = `<button class="btn sec" id="wzEarly">Mit ${foot.split(':')[1]} Lagen abschliessen</button>`;
        $('wzEarly').addEventListener('click', () => dev.send(P.cmd.char('f')).catch(() => {}));
      } else f.innerHTML = '';
    }
    renderWzConn();
  }
  function stepsBar(step) {
    const st = [['Ruhig', [0]], ['Bewegen', [1, 2]]];
    if (wz.tiltSeen) st.push(['Kippen', [3]]);
    st.push(['Strecken', [4]], ['Beugen', [5]], ['Prüfen', [9]]);
    const cur = st.findIndex((x) => x[1].includes(step));
    return '<ol class="wsteps">' + st.map((x, i) => `<li data-s="${i < cur ? 'done' : (i === cur ? 'now' : '')}">${x[0]}</li>`).join('') + '</ol>';
  }
  function widget(mode, step) {
    if (mode === 1 && step === 0) return `<div class="poses"><div class="pcount"><b id="wzN">0</b><span>von 14 Lagen</span></div>${ring('wzRing')}</div><div class="pdots" id="wzDots">${'<i></i>'.repeat(14)}</div><div class="chip" id="wzNew" hidden></div>${meter('wzCov', 'Seiten abgedeckt')}`;
    if (mode === 3) return `<div class="center">${ring('wzRing')}</div><p class="muted center" id="wzLiveTxt"></p>`;
    if (mode !== 2) return '';
    switch (step) {
      case JS.REST: return `<div class="center">${ring('wzRing')}</div>`;
      case JS.MOVE: return `<div id="wzM3w" hidden>${meter('wzM3', 'Nachbessern')}</div>${meter('wzM0', 'Übung 1: beugen und strecken')}${meter('wzM1', 'Übung 2: kippen und drehen')}${meter('wzM2', 'Bewegungszeit')}`;
      case JS.TILT: return `${level('wzLev', 'Neigung der Gelenkachse')}<div class="center">${ring('wzRing')}</div>`;
      case JS.STRAIGHT: return `<div class="center" id="wzArmed" hidden>${ring('wzRing')}</div>`;
      case JS.FLEX: return `${level('wzLev', 'Beugung')}<div class="center">${ring('wzRing')}</div>`;
      default: return '';
    }
  }
  function updWidget(c, mode, step) {
    if (mode === 1 && step === 0) {
      const n = Math.min(c.a[0], c.a[1]);
      $('wzN').textContent = n;
      $('wzDots').querySelectorAll('i').forEach((d, i) => { d.dataset.on = i < n ? '1' : '0'; });
      setRing('wzRing', c.hold);
      setMeter('wzCov', Math.min(100, Math.min(c.a[2], c.a[3]) / 45 * 100), false);
      const chip = $('wzNew');
      const any = c.live < 179;
      chip.hidden = !any || c.hint === HI.POSE_DONE;
      if (!chip.hidden) { const fresh = c.live >= 30; chip.dataset.ok = fresh ? '1' : '0'; chip.textContent = fresh ? 'Neue Lage' : `Zu ähnlich wie eine erfasste Lage (${fmt(c.live, 0)}°, nötig 30°)`; }
      return;
    }
    if (mode === 3) { setRing('wzRing', c.hold); $('wzLiveTxt').textContent = `Anzeige mit dem bisherigen Nullpunkt: ${fmt(c.live, 1)}°`; return; }
    if (mode !== 2) return;
    switch (c.step) {
      case JS.REST: setRing('wzRing', c.hold); break;
      case JS.MOVE: {
        const h = c.hint;
        setMeter('wzM0', c.a[0], h === HI.EX_FLEX || h === HI.MORE_SHANK || h === HI.MORE_RANGE);
        setMeter('wzM1', c.a[1], h === HI.EX_TILT || h === HI.MORE_THIGH);
        setMeter('wzM2', c.a[2], false);
        const retry = h === HI.MORE_THIGH || h === HI.MORE_SHANK || h === HI.MORE_RANGE;
        $('wzM3w').hidden = !retry; if (retry) setMeter('wzM3', c.hold, true);
        break;
      }
      case JS.TILT: setLevel('wzLev', c.live, c.a[0] || 15, Math.max(45, (c.a[0] || 15) * 2)); setRing('wzRing', c.hold); break;
      case JS.STRAIGHT: { const ar = $('wzArmed'); if (ar) { ar.hidden = !c.a[0]; setRing('wzRing', c.hold); } break; }
      case JS.FLEX: setLevel('wzLev', c.live, 30, 100); setRing('wzRing', c.hold); break;
      default: break;
    }
  }
  function renderWzConn() { const e = $('wzConn'); if (e) e.hidden = conn === 'connected'; }

  // ---- Ergebnis --------------------------------------------------------------------------
  function wzResult(c) {
    clearTimeout(wz.timer);
    wz.phase = 'result'; wz.res = c; wz.key = '';
    const ok = c.result === RS.OK || c.result === RS.OK_PARTIAL;
    fb(ok ? 'ok' : (c.result === RS.ABORTED ? 'step' : 'fail'));
    $('wzClose').textContent = 'Schliessen';
    if (ok && c.resultMode === 2) { wzCheck(c); return; }
    let title, detail, foot = '', warn = '';
    if (ok && c.resultMode === 1) {
      const mg = c.q1 / 100;
      title = c.result === RS.OK ? 'Sensoren eingemessen' : 'Sensoren teilweise eingemessen';
      detail = `Restfehler ${fmt(mg, 1)} mg (${mg <= 2 ? 'sehr gut' : mg <= 5 ? 'gut' : 'mässig: ruhiger ablegen bringt mehr'}). Dauerhaft gespeichert.` + (c.result === RS.OK_PARTIAL ? ' Für die Drehsensoren fehlten Drehungen um alle Achsen; die Messung funktioniert trotzdem.' : '') + ((c.a[4] || c.a[5]) ? ` ${Math.max(c.a[4], c.a[5])} unruhige Lage(n) wurden ignoriert.` : '');
      foot = `<button class="btn" id="wzNext">Weiter: Anlegen</button><button class="btn sec" id="wzDone">Fertig</button>`;
    } else if (ok && c.resultMode === 3) {
      const before = c.q1 / 100, ref = c.q2 / 100, shift = before - ref;
      title = 'Nullpunkt gesetzt';
      detail = `Diese Haltung zeigt jetzt ${fmt(ref, 1)}°. Vorher zeigte das Gerät hier ${fmt(before, 1)}°.`;
      if (Math.abs(shift) >= 10) warn = `Das ist eine grosse Änderung (${fmt(Math.abs(shift), 0)}°). Warst du wirklich ganz gestreckt? Wenn nicht: «Rückgängig» tippen.`;
      foot = (c.undo ? '<button class="btn sec" id="wzUndo">Rückgängig</button>' : '') + '<button class="btn" id="wzDone">Fertig</button>';
    } else {
      const f = FAIL[c.result] || ['Nicht geklappt', 'Bitte noch einmal versuchen.'];
      title = f[0]; detail = f[1];
      foot = (c.result === RS.ABORTED ? '' : `<button class="btn" id="wzAgain">Noch einmal</button>`) + '<button class="btn sec" id="wzDone">Schliessen</button>';
      if (c.result === RS.NEED_JOINT) foot = '<button class="btn" id="wzGoJoint">Anlegen starten</button><button class="btn sec" id="wzDone">Schliessen</button>';
    }
    const good = ok;
    $('wzBody').innerHTML = `<div class="result" data-ok="${good ? 1 : (c.result === RS.ABORTED ? 2 : 0)}"><div class="mark">${good ? '✓' : (c.result === RS.ABORTED ? '–' : '!')}</div><h2>${esc(title)}</h2><p>${esc(detail)}</p></div>` + (warn ? `<div class="banner warnbox"><b>Bitte prüfen</b>${esc(warn)}</div>` : '');
    $('wzFoot').innerHTML = foot;
    const on = (id, f) => { const e = $(id); if (e) e.addEventListener('click', f); };
    on('wzDone', closeWizard);
    on('wzAgain', () => openWizard(wz.kind));
    on('wzNext', () => openWizard('joint'));
    on('wzGoJoint', () => openWizard('joint'));
    on('wzUndo', undoLast);
  }

  // Nach "Anlegen": Kontrolle mit dem Live-Winkel. Der Alarm ist dabei kurz stumm.
  function wzCheck(c) {
    wz.phase = 'check';
    if (live && live.silence === P.SILENCE.NONE) { wz.muted = true; dev.send(P.cmd.mute(2)).catch(() => { wz.muted = false; }); }
    const leg = onLeg();
    const axis = c.q1 / 100, cons = c.q2 / 100, range = c.a[4] * 2;
    const qual = `Gelenkachse auf ±${fmt(axis, 1)}° bestimmt, Übereinstimmung ${fmt(cons, 1)}° (${cons <= 1.5 ? 'gut' : 'mässig: sitzen die Sensoren fest?'}), Bewegungsumfang ${range}°.`;
    $('wzBody').innerHTML = stepsBar(9) + `<div class="result small" data-ok="1"><div class="mark">✓</div><h2>Angelegt</h2><p class="muted">${esc(qual)}</p></div>
      <div class="block check"><h3>Kurz prüfen</h3><p>${leg ? 'Bein ganz strecken: die Anzeige sollte etwa 0° zeigen. Dann beugen: sie folgt.' : 'Gelenk ganz strecken: etwa 0°. Dann beugen: die Anzeige folgt.'}</p>
      <div class="checkangle" id="wzCheckAngle">–</div><p class="muted center" id="wzCheckNote">${wz.muted ? 'Der Alarm ist während der Kontrolle 2 Minuten stumm.' : ''}</p></div>
      <div id="wzWrong" hidden class="block"><h3>Was stimmt nicht?</h3><div class="col"><button class="btn sec" id="wzRedo">Nochmals anlegen</button><button class="btn sec" id="wzZero">Nur 0° neu setzen</button>${c.undo ? '<button class="btn sec" id="wzBack">Vorherige Kalibrierung zurück</button>' : ''}</div></div>`;
    $('wzFoot').innerHTML = '<button class="btn sec" id="wzNo">Stimmt nicht</button><button class="btn" id="wzYes">Passt</button>';
    $('wzYes').addEventListener('click', closeWizard);
    $('wzNo').addEventListener('click', () => { $('wzWrong').hidden = false; $('wzWrong').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
    $('wzRedo').addEventListener('click', () => { unmuteCheck(); openWizard('joint'); });
    $('wzZero').addEventListener('click', () => { unmuteCheck(); openWizard('zero'); });
    if ($('wzBack')) $('wzBack').addEventListener('click', () => { unmuteCheck(); undoLast(); });
    updCheck();
  }
  function unmuteCheck() { if (wz.muted) { wz.muted = false; dev.send(P.cmd.mute(0)).catch(() => {}); } }
  function updCheck() {
    if (wz.phase !== 'check') return;
    const e = $('wzCheckAngle'); if (!e) return;
    e.innerHTML = (live && live.angle !== null) ? esc(fmt(live.angle, 1)) + '<sup>°</sup>' : '–';
    const n = $('wzCheckNote'); if (!n) return;
    let why = '';
    if (!live) why = 'Keine Daten vom Gerät.';
    else if (live.angle === null) {
      if (live.sysFlags & P.SF.OFFLINE) why = 'Ein Sensor antwortet nicht: Kabel zum unteren Sensor prüfen.';
      else if (live.sysFlags & P.SF.VERT) why = onLeg() ? 'Kniescheibe nach oben drehen.' : 'Gelenkachse waagrecht halten (nicht flach hinlegen).';
      else why = 'Messung stellt sich ein: kurz ruhig halten.';
    }
    n.textContent = why || (wz.muted ? 'Der Alarm ist während der Kontrolle 2 Minuten stumm.' : '');
  }

  // ---------------------------------------------------------------------------
  //  Alarm-Einstellungen
  // ---------------------------------------------------------------------------
  const F = [['sLimit', 'limit', 'oLimit', (v) => fmt(v, 1) + '°'], ['sZone', 'zone', 'oZone', (v) => fmt(v, 0) + '° vorher'], ['sAppStr', 'approachStrength', 'oAppStr', (v) => v + ' %'],
    ['sAlStr', 'alarmStrength', 'oAlStr', (v) => v + ' %'], ['sHyst', 'hyst', 'oHyst', (v) => fmt(v, 1) + '°'], ['sRateMin', 'rateMin', 'oRateMin', (v) => fmt(v, 1)],
    ['sRateMax', 'rateMax', 'oRateMax', (v) => fmt(v, 1)], ['sPredict', 'predictMs', 'oPredict', (v) => (v ? v + ' ms' : 'aus')]];
  const C = [['sEnabled', 'alarmEnabled'], ['sAppOn', 'approachOn'], ['sMoveOnly', 'approachMoveOnly'], ['sCautious', 'cautiousOn'], ['sBatt', 'batteryPresent'], ['sMotorOn', 'motorOn']];
  function isDirty() { return !!(edit && settings && JSON.stringify(edit) !== JSON.stringify(settings)); }
  function fillForm() {
    if (!edit) return;
    F.forEach(([id, k, o, f]) => { $(id).value = edit[k]; $(o).textContent = f(edit[k]); });
    C.forEach(([id, k]) => { $(id).checked = !!edit[k]; });
    $('hZone').textContent = `Leichte Pulse ab ${fmt(edit.limit + edit.zone, 1)}°, starke Vibration ab ${fmt(edit.limit, 1)}°.`;
    $('sumLimit').textContent = fmt(edit.limit, 1) + '°' + (edit.alarmEnabled ? '' : ' · aus');
    $('sumApp').textContent = edit.approachOn ? `ab ${fmt(edit.limit + edit.zone, 1)}° · ${edit.approachStrength} %` : 'aus';
    $('sumAl').textContent = edit.motorOn === false ? 'nur Handy' : `${edit.alarmStrength} %`;
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
  $('btnLogClear').addEventListener('click', async () => { if (await ask('Alle gespeicherten Überstreckungen im Gerät löschen?', 'Löschen', 'Abbrechen')) act(async () => { await dev.send(P.cmd.logClear()); logRows = []; renderLog(0); }, 'Gelöscht'); });
  $('btnStatsReset').addEventListener('click', () => act(() => dev.send(P.cmd.statsReset()), 'Zähler zurückgesetzt'));
  function download(name, text) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv' })); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  $('btnLogCsv').addEventListener('click', () => download(`kneeangle-ueberstreckungen-${stamp()}.csv`, 'zeit;winkel_grad;grenze_grad;dauer_s;nur_vorwarnung;stumm\n' + logRows.map((r) => [r.timeValid ? new Date(r.time * 1000).toISOString() : 'betrieb+' + r.time + 's', r.extreme, r.limit, r.durS, r.predictedOnly ? 1 : 0, r.silenced ? 1 : 0].join(';')).join('\n')));

  // Kniewinkel ueber die Zeit: 5 Punkte pro Sekunde, 15 Minuten
  const chartBuf = []; let lastChartT = 0;
  const CH = { ok: '#2e8b57', approach: '#e8a20c', over: '#d0342c' };
  let chartSpan = 300;
  try { chartSpan = +(localStorage.getItem('knee.span') || 300); } catch (e) { /* Standard */ }
  function pushChart(l) {
    const now = performance.now();
    if (now - lastChartT < 200) return;
    lastChartT = now;
    let st = null;
    if (l.angle !== null && l.state !== P.STATE.CAL && l.state !== P.STATE.INVALID) st = l.state === P.STATE.OVER ? 'over' : (l.state === P.STATE.APPROACH ? 'approach' : 'ok');
    chartBuf.push([now, st ? l.angle : null, l.effLimit, st, settings && settings.approachOn ? settings.zone : 0]);
    while (chartBuf.length && now - chartBuf[0][0] > 900000) chartBuf.shift();
    if (curView === 'log') drawChart($('chart'), chartSpan * 1000);
    if (curView === 'live') drawChart($('spark'), 120000);
  }
  function drawChart(cvArg, spanArg) {
    const cv = cvArg || $('chart'), span = spanArg || chartSpan * 1000, dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (!w) return;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const now = performance.now();
    const pts = chartBuf.filter((p) => now - p[0] <= span), vals = pts.filter((p) => p[1] !== null);
    let lo = -10, hi = 30;
    vals.forEach((p) => { lo = Math.min(lo, p[1] - 5); hi = Math.max(hi, p[1] + 5); });
    const bot = h - 18, X = (t) => w - (now - t) / span * w, Y = (a) => bot - 4 - (a - lo) / (hi - lo) * (bot - 10);
    const last = pts.length ? pts[pts.length - 1] : null;
    const lim = last ? last[2] : (settings ? settings.limit : -5), zone = last ? last[4] : (settings && settings.approachOn ? settings.zone : 10);
    // Bereiche: unter der Grenze rot, Vorwarnung gelb
    g.fillStyle = 'rgba(208,52,44,.09)'; g.fillRect(0, Y(lim), w, bot - Y(lim));
    if (zone > 0) { g.fillStyle = 'rgba(232,162,12,.12)'; g.fillRect(0, Y(lim + zone), w, Y(lim) - Y(lim + zone)); }
    g.font = '12px Barlow, sans-serif'; g.fillStyle = '#5b6b76'; g.strokeStyle = '#e4eaed'; g.lineWidth = 1;
    const stepDeg = (hi - lo) > 80 ? 30 : 10;
    for (let a = Math.ceil(lo / stepDeg) * stepDeg; a <= hi; a += stepDeg) { g.beginPath(); g.moveTo(0, Y(a)); g.lineTo(w, Y(a)); g.stroke(); g.fillText(a + '°', 4, Y(a) - 3); }
    g.strokeStyle = '#d0342c'; g.setLineDash([6, 4]); g.beginPath(); g.moveTo(0, Y(lim)); g.lineTo(w, Y(lim)); g.stroke(); g.setLineDash([]);
    // Zeitachse
    const mins = span / 60000;
    g.fillStyle = '#5b6b76'; g.textAlign = 'left'; g.fillText(mins >= 1 ? `vor ${mins} min` : `vor ${span / 1000} s`, 4, h - 3);
    g.textAlign = 'right'; g.fillText('jetzt', w - 2, h - 3); g.textAlign = 'left';
    // Linie, je Abschnitt in der Farbe des Zustands
    g.lineWidth = 2.6; g.lineJoin = 'round'; g.lineCap = 'round';
    let prev = null;
    for (const p of pts) {
      if (p[1] === null) { prev = null; continue; }
      if (prev) { g.strokeStyle = CH[p[3]] || CH.ok; g.beginPath(); g.moveTo(X(prev[0]), Y(prev[1])); g.lineTo(X(p[0]), Y(p[1])); g.stroke(); }
      prev = p;
    }
    if (vals.length) { const p = vals[vals.length - 1]; g.fillStyle = CH[p[3]] || CH.ok; g.beginPath(); g.arc(X(p[0]), Y(p[1]), 4.5, 0, 6.3); g.fill(); }
  }
  function renderSpan() {
    document.querySelectorAll('#spanChips button').forEach((b) => b.setAttribute('aria-checked', +b.dataset.span === chartSpan ? 'true' : 'false'));
    $('chartTitle').textContent = `Kniewinkel, letzte ${chartSpan >= 60 ? chartSpan / 60 + ' min' : chartSpan + ' s'}`;
    if (curView === 'log') drawChart($('chart'), chartSpan * 1000);
  }
  document.querySelectorAll('#spanChips button').forEach((b) => b.addEventListener('click', () => { chartSpan = +b.dataset.span; try { localStorage.setItem('knee.span', chartSpan); } catch (e) { /* egal */ } renderSpan(); }));
  renderSpan();
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
  $('btnForget').addEventListener('click', async () => { if (await ask('Kopplung löschen? Danach kann dieses Handy nur noch zusehen.', 'Löschen', 'Abbrechen')) act(() => dev.forget(), 'Kopplung gelöscht'); });
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
  $('pPhoneSound').checked = prefs.phoneSound; $('pPhoneVib').checked = prefs.phoneVib; $('pWake').checked = prefs.wake;
  const renderPhoneSum = () => { $('sumPhone').textContent = [prefs.phoneSound ? 'Ton' : '', prefs.phoneVib ? 'Vibration' : ''].filter(Boolean).join(' · ') || 'aus'; };
  renderPhoneSum();
  const phonePrefChanged = () => { savePrefs(); renderPhoneSum(); if (prefs.phoneSound) ensureAudio(); if (!prefs.phoneSound && !prefs.phoneVib) stopPhoneAlarm(); };
  $('pPhoneSound').addEventListener('change', (e) => { prefs.phoneSound = e.target.checked; phonePrefChanged(); });
  $('pPhoneVib').addEventListener('change', (e) => { prefs.phoneVib = e.target.checked; phonePrefChanged(); });
  let wakeLock = null;
  async function applyWake() { try { if (prefs.wake && navigator.wakeLock && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); else if (wakeLock) { await wakeLock.release(); wakeLock = null; } } catch (e) { /* nicht unterstuetzt */ } }
  $('pWake').addEventListener('change', (e) => { prefs.wake = e.target.checked; savePrefs(); applyWake(); });
  document.addEventListener('visibilitychange', applyWake);
  $('appVer').textContent = APP_VERSION;

  // ---------------------------------------------------------------------------
  //  Start
  // ---------------------------------------------------------------------------
  if (!window.KneeDevice.supported) { $('noBle').hidden = false; $('btnStart').disabled = true; }
  if (window.KNEE_PREVIEW) { $('noBle').className = 'note'; $('noBle').textContent = 'Vorschau ohne Bluetooth: Tippe auf «Ohne Gerät ansehen».'; }
  if (!window.KNEE_PREVIEW && 'serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  renderConn(); renderPair(); applyWake();
  // Zum Testen der Oberflaeche:  index.html?demo  bzw.  ?demo&view=alarm
  const qs = new URLSearchParams(location.search);
  if (qs.has('rig')) { prefs.rig = qs.get('rig') === 'rig' ? 'rig' : 'leg'; }
  if (qs.has('demo')) {
    demo = true; attach(new window.DemoDevice({ tilt: qs.has('tilt'), oldfw: qs.has('oldfw'), uncal: qs.has('uncal') }));
    dev.connect().then(() => {
      show(qs.get('view') || 'live');
      if (qs.get('wizard')) { openWizard(qs.get('wizard')); if (qs.has('run')) { wzStart(qs.has('ref') ? parseFloat(qs.get('ref')) : null); if (qs.get('at')) setTimeout(() => dev.demoJump(qs.get('at')), 300); } }
    });
  }
  window.KneeApp = { show, openWizard, get dev() { return dev; } };
})();
