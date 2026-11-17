// KneeAngle - Verbindung zum Geraet (Web Bluetooth) und Demo-Geraet ohne Hardware
'use strict';
(function () {
  const P = window.KneeProto;

  class Emitter {
    constructor() { this._h = {}; }
    on(e, f) { (this._h[e] = this._h[e] || []).push(f); return this; }
    emit(e, d) { (this._h[e] || []).forEach((f) => { try { f(d); } catch (err) { console.error(err); } }); }
  }

  // ===========================================================================
  //  Echtes Geraet
  // ===========================================================================
  class KneeDevice extends Emitter {
    constructor() {
      super();
      this.dev = null; this.ch = {}; this.q = Promise.resolve();
      this.wantConnected = false; this.connected = false; this.retry = 0; this.authState = { authed: false, windowOpen: false, ownerSet: false };
      this.name = 'KneeAngle';
    }
    static get supported() { return !!(navigator.bluetooth && navigator.bluetooth.requestDevice); }

    // muss aus einem Tipp/Klick heraus aufgerufen werden
    async connect() {
      this.dev = await navigator.bluetooth.requestDevice({
        filters: [{ services: [P.UUID.service] }, { namePrefix: 'KneeAngle' }],
        optionalServices: [P.UUID.service]
      });
      this.name = this.dev.name || 'KneeAngle';
      this.dev.addEventListener('gattserverdisconnected', () => this._lost());
      this.wantConnected = true;
      try { await this._open(); }
      catch (e) {   // erster Aufbau gescheitert: nicht im Hintergrund weiterversuchen, Verbindung freigeben
        this.wantConnected = false;
        try { if (this.dev.gatt.connected) this.dev.gatt.disconnect(); } catch (e2) { /* egal */ }
        throw e;
      }
    }

    async _open() {
      this.emit('conn', 'connecting');
      const step = async (name, fn) => { try { return await fn(); } catch (e) { const err = new Error(name + ': ' + (e && (e.name + ' ' + e.message))); err.name = 'StepError'; throw err; } };
      const server = await step('Verbindungsaufbau', () => this.dev.gatt.connect());
      const svc = await step('Dienst suchen', () => server.getPrimaryService(P.UUID.service));
      for (const k of ['live', 'status', 'cal', 'msg', 'cmd', 'settings', 'log', 'auth', 'diag']) this.ch[k] = await step('Merkmal ' + k, () => svc.getCharacteristic(P.UUID[k]));
      const sub = async (k, fn) => {
        this.ch[k].addEventListener('characteristicvaluechanged', (e) => fn(e.target.value));
        // bis zu 3 Versuche: Android meldet beim ersten Einschalten gelegentlich einen GATT-Fehler
        await step('Benachrichtigung ' + k, async () => {
          for (let i = 0; ; i++) {
            try { return await this.ch[k].startNotifications(); }
            catch (e) { if (i >= 2 || !this.dev.gatt.connected) throw e; await new Promise((r) => setTimeout(r, 300)); }
          }
        });
      };
      await sub('status', (v) => { const s = P.decodeStatus(v); if (s) this.emit('status', s); });
      await sub('cal', (v) => { const c = P.decodeCal(v); if (c) this.emit('cal', c); });
      await sub('settings', (v) => { const s = P.decodeSettings(v); if (s) this.emit('settings', s); });
      await sub('auth', (v) => this._onAuth(P.decodeAuth(v)));
      await sub('log', (v) => { const r = P.decodeLog(v); if (r) this.emit('log', r); });
      await sub('msg', (v) => this.emit('msg', new TextDecoder().decode(v)));
      await sub('diag', (v) => { const d = P.decodeDiag(v); if (d) this.emit('diag', d); });
      // Anfangswerte
      const st = P.decodeStatus(await this.ch.status.readValue()); if (st) this.emit('status', st);
      const se = P.decodeSettings(await this.ch.settings.readValue()); if (se) this.emit('settings', se);
      const ca = P.decodeCal(await this.ch.cal.readValue()); if (ca) this.emit('cal', ca);
      await this._authenticate();
      await this.send(P.cmd.setTime(Math.floor(Date.now() / 1000)));
      await sub('live', (v) => { const l = P.decodeLive(v); if (l) this.emit('live', l); });
      this.connected = true; this.retry = 0;
      this.emit('conn', 'connected');
    }

    _tokenKey() { return 'knee.token.' + (this.dev ? this.dev.id : 'x'); }
    _loadToken() {
      try { const s = localStorage.getItem(this._tokenKey()); if (!s) return null; return Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16))); } catch (e) { return null; }
    }
    _storeToken(t) { try { localStorage.setItem(this._tokenKey(), Array.from(t).map((x) => x.toString(16).padStart(2, '0')).join('')); } catch (e) { /* ohne Speicher: Kopplung gilt nur bis zum Schliessen */ } this._token = t; }
    _onAuth(a) { if (!a) return; this.authState = { authed: a.authed, windowOpen: a.windowOpen, ownerSet: a.ownerSet }; this._nonce = a.nonce; this.emit('auth', this.authState); }

    async _authenticate() {
      this._onAuth(P.decodeAuth(await this.ch.auth.readValue()));
      const token = this._token || this._loadToken();
      if (token && this.authState.ownerSet) {
        const mac = await P.authMac(token, this._nonce);
        await this._write('auth', P.auth.prove(mac));
        this._onAuth(P.decodeAuth(await this.ch.auth.readValue()));
        if (this.authState.authed) { this._token = token; return; }
      }
      // fabrikneues Geraet im Kopplungsfenster: automatisch koppeln
      if (!this.authState.authed && this.authState.windowOpen && !this.authState.ownerSet) await this.pair();
    }
    // dieses Handy als Besitzer hinterlegen (nur im Kopplungsfenster moeglich)
    async pair() {
      const token = crypto.getRandomValues(new Uint8Array(16));
      await this._write('auth', P.auth.claim(token));
      this._onAuth(P.decodeAuth(await this.ch.auth.readValue()));
      if (this.authState.authed) this._storeToken(token);
      return this.authState.authed;
    }
    async forget() { await this.send(P.cmd.forget()); try { localStorage.removeItem(this._tokenKey()); } catch (e) { /* egal */ } this._token = null; this._onAuth(P.decodeAuth(await this.ch.auth.readValue())); }

    _write(k, bytes) {
      // GATT erlaubt nur einen Vorgang gleichzeitig -> Warteschlange
      const run = () => this.ch[k].writeValueWithResponse(bytes);
      this.q = this.q.then(run, run);
      return this.q;
    }
    send(bytes) { return this._write('cmd', bytes); }
    async writeSettings(s) { await this._write('settings', P.encodeSettings(s)); const v = P.decodeSettings(await this.ch.settings.readValue()); if (v) this.emit('settings', v); return v; }

    _lost() {
      this.connected = false;
      if (!this.wantConnected) { this.emit('conn', 'disconnected'); return; }
      this.emit('conn', 'reconnecting');
      const again = () => {
        if (!this.wantConnected) return;
        this.q = Promise.resolve();
        this._open().catch(() => { this.retry++; setTimeout(again, Math.min(10000, 1000 * Math.pow(1.6, this.retry))); });
      };
      setTimeout(again, 800);
    }
    disconnect() { this.wantConnected = false; if (this.dev && this.dev.gatt.connected) this.dev.gatt.disconnect(); else this.emit('conn', 'disconnected'); }
  }

  // ===========================================================================
  //  Demo-Geraet (zum Ausprobieren der App ohne Hardware)
  //  Spielt auch die Kalibrier-Ablaeufe der Firmware 2.1 nach (gleiche Schritte,
  //  Hinweise und Ergebnisse), inkl. Warten auf die Bestaetigung "gestreckt".
  //  Optionen: tilt (Zusatzschritt Kippen zeigen), oldfw (Firmware 2.0), uncal (nicht kalibriert)
  // ===========================================================================
  const H = P.HINT, R = P.RESULT, J = P.JSTEP;
  class DemoDevice extends Emitter {
    constructor(opts) {
      super();
      this.opts = opts || {};
      this.name = 'KneeAngle-DEMO'; this.connected = false; this.authState = { authed: true, windowOpen: true, ownerSet: true };
      this.set = { alarmEnabled: true, limit: -5, zone: 10, hyst: 2, approachOn: true, approachMoveOnly: true, rateMin: 1, rateMax: 5, approachStrength: 20, alarmStrength: 100, predictMs: 40, cautiousOn: true, kSigma: 2, batteryPresent: false, motorOn: true };
      this.t = 0; this.over = false; this.overCount = 0; this.approachCount = 0; this.zone = false; this.min = null; this.max = null;
      this.muteUntil = 0;
      this.calBits = P.CB.ACC1 | P.CB.ACC2 | P.CB.GYR1 | P.CB.GYR2 | P.CB.JOINT | P.CB.ZERO | P.CB.MOTORCAL;
      if (this.opts.uncal) this.calBits = P.CB.MOTORCAL;
      this.cal = { mode: 0, step: 0, resultMode: 0, undo: false, progress: 0, hint: 0, result: 0, resultSeq: 0, a: [0, 0, 0, 0, 0, 0], secLeft: 0, live: 0, q1: 0, q2: 0, hold: 0 };
      this.cs = null; this.undoMode = 0;
      this.log = []; this.seq = 0;
      const now = Math.floor(Date.now() / 1000);
      for (let i = 0; i < 6; i++) this.log.push({ index: i, type: 1, flags: 1, seq: i + 1, time: now - (6 - i) * 5400, timeValid: true, durS: 0.4 + i * 0.3, extreme: -6 - i * 0.7, limit: -5, predictedOnly: i === 2, silenced: false });
    }
    static get supported() { return true; }
    async connect() {
      this.connected = true; this.emit('conn', 'connected'); this.emit('auth', this.authState); this.emit('settings', { ...this.set }); this._emitCal();
      this.timer = setInterval(() => this._tick(), 50); this.slow = setInterval(() => this._status(), 1000); this._status();
    }
    disconnect() { clearInterval(this.timer); clearInterval(this.slow); this.connected = false; this.emit('conn', 'disconnected'); }
    async pair() { return true; }
    async forget() { }
    async writeSettings(s) { this.set = { ...s }; this.emit('settings', { ...this.set }); return this.set; }
    async send(b) {
      const d = new DataView(b.buffer);
      switch (b[0]) {
        case P.CMD.CHAR: { const c = String.fromCharCode(b[1]);
          if (c === 's') this._start(1); else if (c === 'a') this._start(2); else if (c === 'z') this._start(3, 0);
          else if (c === 'n') this._confirm(0); else if (c === 'f') this._early(); else if (c === 'x') { if (this.cal.mode) this._result(R.ABORTED); }
          else if (c === 'U') this._undo();
          break; }
        case P.CMD.ZERO_REF: { const ref = d.getInt16(1, true) / 100; if (this.cal.mode === 2) this._confirm(ref); else this._start(3, ref); break; }
        case P.CMD.MUTE: this.muteUntil = d.getUint16(1, true) ? Date.now() + d.getUint16(1, true) * 60000 : 0; this._status(); break;
        case P.CMD.LOG_READ: this.log.forEach((r, i) => setTimeout(() => this.emit('log', r), 30 * i)); setTimeout(() => this.emit('log', { end: true, count: this.log.length, deviceTime: Math.floor(Date.now() / 1000), timeValid: true }), 30 * this.log.length + 30); break;
        case P.CMD.LOG_CLEAR: this.log = []; break;
        case P.CMD.STATS_RESET: this.overCount = 0; this.approachCount = 0; this.min = this.max = null; this._status(); break;
        case P.CMD.INFO: this.emit('msg', '\n--- Demo-Geraet ---\nKeine echte Hardware verbunden.\n'); break;
        default: break;
      }
    }
    // ---- Kalibrierung ----
    _emitCal() { this.emit('cal', { ...this.cal, a: [...this.cal.a] }); }
    _start(mode, ref) {
      if (this.cal.mode) return;
      if (mode === 3 && !((this.calBits & P.CB.JOINT) && (this.calBits & P.CB.ZERO))) { this.cal.mode = 3; this._result(R.NEED_JOINT); return; }
      this.cs = { mode, t: 0, st: 0, n: 0, poseI: 0, armed: false, ref: ref || 0, retry: 0, tiltDone: false };
      Object.assign(this.cal, { mode, step: 0, progress: 0, hold: 0, hint: mode === 1 ? H.PLACE : H.HOLD_STILL, a: [0, 0, 0, 0, 0, 0], live: mode === 1 ? 180 : 0, secLeft: mode === 1 ? 300 : (mode === 2 ? 120 : 60) });
      this._emitCal();
    }
    _confirm(ref) { const c = this.cs; if (!c || c.mode !== 2 || this.cal.step !== J.STRAIGHT) return; c.armed = true; c.ref = ref; c.t = 0; this.cal.a[0] = 1; }
    _early() { const c = this.cs; if (!c) return; if (c.mode === 1 && c.n >= 10) { this.cal.step = 1; c.t = 0; } if (c.mode === 2 && this.cal.step === J.MOVE) this._step(J.COMPUTE); }
    _undo() { if (this.cal.mode || !this.cal.undo) return; this.cal.mode = this.undoMode; this._result(R.UNDONE); this.cal.undo = false; this._emitCal(); }
    _step(s) { Object.assign(this.cal, { step: s, progress: 0, hold: 0, live: 0, a: [0, 0, 0, 0, 0, 0] }); this.cs.t = 0; }
    _result(result, q1, q2) {
      const m = this.cal.mode;
      Object.assign(this.cal, { mode: 0, step: 0, resultMode: m, result, resultSeq: (this.cal.resultSeq + 1) & 255, hint: 0, progress: 0, hold: 0, secLeft: 0, live: 0, q1: q1 || 0, q2: q2 || 0 });
      this.cs = null; this._emitCal();
    }
    _calTick(dt) {
      const c = this.cs, k = this.cal;
      if (!c) return;
      c.t += dt; const t = c.t;
      if (c.mode === 1) {
        if (k.step === 1) { k.hint = H.COMPUTING; if (t > 1.5) { this.calBits |= P.CB.ACC1 | P.CB.ACC2 | P.CB.GYR1 | P.CB.GYR2; k.a[4] = 0; k.a[5] = 0; k.undo = false; this._result(R.OK, 42, 31); return; } }
        else {
          const cyc = 3.8, ph = t - c.poseI * cyc;
          const same = c.poseI % 4 === 3;
          if (ph < 1.4) { k.hint = H.PLACE; k.hold = 0; k.live = c.n ? 48 : 180; }
          else if (ph < 3.4) { k.hold = Math.min(100, (ph - 1.4) / 2 * 100); k.live = same ? 12 : 51; k.hint = same ? H.POSE_SAME : H.HOLD_STILL; }
          else if (ph < cyc) { if (!c.counted) { c.counted = true; if (!same) c.n++; } k.hint = same ? H.POSE_SAME : H.POSE_DONE; k.hold = 100; }
          else { c.poseI++; c.counted = false; }
          const n = c.n, cov = Math.min(100, n * 8);
          k.a = [n, n, cov, cov, Math.max(0, n - 1), Math.max(0, n - 1)];
          k.progress = Math.min(99, Math.round(n / 14 * 100)); k.secLeft = Math.max(1, Math.round(300 - (t - c.poseI * cyc)));
          if (n >= 14) { k.step = 1; c.t = 0; }
        }
      } else if (c.mode === 2) {
        switch (k.step) {
          case J.REST: k.hold = Math.min(100, t / 1.6 * 100); k.progress = k.hold; k.hint = H.HOLD_STILL; k.secLeft = Math.round(120 - t); if (t > 2) { this._step(J.MOVE); k.hint = H.EX_FLEX; } break;
          case J.MOVE: {
            const f = Math.min(100, t / 6 * 100), ti = t < 5 ? 0 : Math.min(100, (t - 5) / 7 * 100), tm = Math.min(100, t / 15 * 100);
            k.a = [Math.round(f), Math.round(ti), Math.round(tm), c.retry, Math.round(ti * 0.8), 0];
            k.progress = Math.round((f + ti + tm) / 3);
            k.hint = c.retryHint && t < 4 ? c.retryHint : (f < 100 ? H.EX_FLEX : (ti < 100 ? H.EX_TILT : H.EX_BOTH));
            k.hold = (c.retryHint && t < 4) ? Math.round(t / 4 * 100) : 0;
            k.secLeft = Math.round(240 - t);
            if (f >= 100 && ti >= 100 && tm >= 100) this._step(J.COMPUTE);
            break; }
          case J.COMPUTE: k.hint = H.COMPUTING; k.secLeft = 0; if (t > 1.6) { if (this.opts.tilt && !c.tiltDone) { this._step(J.TILT); k.hint = H.TILT; k.a[0] = 15; } else { this._step(J.STRAIGHT); k.hint = H.STRAIGHT_CONFIRM; } } break;
          case J.TILT: {
            k.a[0] = 15; k.secLeft = Math.round(180 - t);
            if (c.tiltHoldT === undefined) { k.live = Math.min(32, t / 3 * 32); k.hint = k.live >= 15 ? (t > 3 ? H.HOLD_STILL : H.WAIT_REST) : H.TILT; if (t > 3) c.tiltHoldT = 0; }
            else { c.tiltHoldT += dt; k.hold = Math.min(100, c.tiltHoldT / 1 * 100); k.hint = c.tiltHoldT < 1 ? H.HOLD_STILL : H.COMPUTING; if (c.tiltHoldT > 2) { c.tiltDone = true; c.tiltHoldT = undefined; this._step(J.STRAIGHT); k.hint = H.STRAIGHT_CONFIRM; } }
            break; }
          case J.STRAIGHT:
            if (!c.armed) { k.hint = H.STRAIGHT_CONFIRM; k.hold = 0; k.secLeft = Math.max(1, Math.round(180 - t)); }
            else { k.a[0] = 1; k.hint = t < 0.3 ? H.WAIT_REST : H.HOLD_STILL; k.hold = Math.min(100, Math.max(0, (t - 0.3) / 1.5 * 100)); k.progress = k.hold; k.secLeft = Math.round(60 - t); if (t > 2) { this._step(J.FLEX); k.hint = H.FLEX; } }
            break;
          case J.FLEX: {
            k.live = Math.min(85, t / 3 * 85); k.progress = Math.min(100, k.live / 30 * 100); k.secLeft = Math.round(180 - t);
            if (k.live < 30) { k.hint = H.FLEX; k.hold = 0; } else { c.fh = (c.fh || 0) + dt; k.hint = c.fh < 0.4 ? H.WAIT_REST : H.HOLD_STILL; k.hold = Math.min(100, Math.max(0, (c.fh - 0.4) / 1.0 * 100)); }
            if (c.fh > 1.5) { const had = (this.calBits & P.CB.JOINT) && (this.calBits & P.CB.ZERO); this.calBits |= P.CB.JOINT | P.CB.ZERO; k.a = [0, 0, 0, 0, 45, 1 | (c.tiltDone ? 2 : 0)]; k.undo = !!had; this.undoMode = 2; this._result(R.OK, 12, 64); return; }
            break; }
          default: break;
        }
      } else if (c.mode === 3) {
        k.hint = t < 0.4 ? H.WAIT_REST : H.HOLD_STILL; k.hold = Math.min(100, Math.max(0, (t - 0.4) / 1.5 * 100)); k.progress = k.hold; k.live = 3.4; k.secLeft = Math.round(60 - t);
        if (t > 2) { k.undo = true; this.undoMode = 3; this._result(R.OK, c.big ? 1530 : 340, Math.round(c.ref * 100)); return; }
      }
      this._emitCal();
    }
    // Zum Testen der Oberflaeche: direkt in einen Zustand springen (index.html?demo&wizard=joint&run&at=straight)
    demoJump(at) {
      const k = this.cal;
      const need = { rest: 2, move: 2, move1: 2, retry: 2, compute: 2, tilt: 2, straight: 2, armed: 2, flex: 2, check: 2, fail: 2, poses: 1, same: 1, sensorDone: 1, zero: 3, zeroDone: 3, bigshift: 3 }[at];
      if (!need) return;
      if (!this.cs || this.cs.mode !== need) { if (this.cal.mode) this._result(R.ABORTED); this._start(need, 0); }
      const c = this.cs;
      switch (at) {
        case 'rest': c.t = 0.7; break;
        case 'move1': this._step(J.MOVE); c.t = 2.5; break;
        case 'move': this._step(J.MOVE); c.t = 8; break;
        case 'retry': this._step(J.MOVE); c.t = 0.2; c.retry = 1; c.retryHint = H.MORE_THIGH; break;
        case 'compute': this._step(J.COMPUTE); c.t = 0; break;
        case 'tilt': this.opts.tilt = true; this._step(J.TILT); c.t = 1.2; break;
        case 'straight': this._step(J.STRAIGHT); c.t = 3; break;
        case 'armed': this._step(J.STRAIGHT); c.armed = true; c.t = 1.0; break;
        case 'flex': this._step(J.FLEX); c.t = 1.4; break;
        case 'check': this._step(J.FLEX); c.t = 3; c.fh = 1.6; break;
        case 'fail': this._result(R.AXIS1); return;
        case 'poses': c.n = 7; c.poseI = 8; c.t = 8 * 3.8 + 2.3; break;
        case 'same': c.n = 6; c.poseI = 7; c.t = 7 * 3.8 + 2.4; break;
        case 'sensorDone': c.n = 14; this.cal.step = 1; c.t = 1.4; break;
        case 'zero': c.t = 1.1; break;
        case 'zeroDone': c.t = 1.95; break;
        case 'bigshift': c.big = true; c.ref = 0; c.t = 1.95; break;
        default: break;
      }
      this._calTick(0.05);
      void k;
    }
    _tick() {
      this.t += 0.05; const t = this.t, s = this.set;
      if (this.cal.mode) this._calTick(0.05);
      // Bewegung: Kniebeugen, dazwischen Stehen mit gelegentlichem Durchstrecken
      const cyc = t % 24; let a;
      if (cyc < 12) a = 3 + 48 * (1 - Math.cos(cyc / 12 * 2 * Math.PI * 3)); else if (cyc < 18) a = 3 + 2 * Math.sin(t * 0.8);
      else a = 3 - 6 * (1 - Math.cos((cyc - 18) / 6 * 2 * Math.PI));
      const prev = this.a === undefined ? a : this.a; this.a = a; const rate = (a - prev) / 0.05;
      const sigma = 0.12 + 0.05 * Math.sin(t * 0.3);
      const eff = s.limit + (s.cautiousOn ? s.kSigma * sigma : 0);
      const calib = (this.calBits & P.CB.JOINT) && (this.calBits & P.CB.ZERO);
      const measuring = !this.cal.mode && calib;
      if (measuring) {
        if (!this.over && a <= eff) { this.over = true; this.overStart = Date.now(); this.ext = a; }
        else if (this.over) { this.ext = Math.min(this.ext, a); if (a > eff + s.hyst) { this.over = false; this.overCount++; this.log.push({ index: this.log.length, type: 1, flags: 1, seq: this.log.length + 1, time: Math.floor(this.overStart / 1000), timeValid: true, durS: (Date.now() - this.overStart) / 1000, extreme: this.ext, limit: eff, predictedOnly: false, silenced: false }); } }
        if (!this.zone && a <= eff + s.zone) { this.zone = true; if (!this.over) this.approachCount++; } else if (this.zone && a > eff + s.zone + s.hyst) this.zone = false;
        if (this.min === null || a < this.min) this.min = a; if (this.max === null || a > this.max) this.max = a;
      } else { this.over = false; this.zone = false; }
      const muted = this.muteUntil > Date.now();
      const state = this.cal.mode ? P.STATE.CAL : (!calib ? P.STATE.INVALID : (this.over ? P.STATE.OVER : (this.zone ? P.STATE.APPROACH : P.STATE.NORMAL)));
      const sil = !s.alarmEnabled ? P.SILENCE.OFF : (muted ? P.SILENCE.MUTED : P.SILENCE.NONE);
      this.emit('live', { angle: measuring ? Math.round(a * 100) / 100 : null, sigma, rate, state, silence: sil, aflags: (this.over && !sil) ? P.AF.MOTOR : 0, sysFlags: (Math.abs(rate) < 1 ? 3 | 4 : 4) | (calib ? 0 : P.SF.NOJOINT), effLimit: eff, seq: this.seq++ & 0xffff, ms: (t * 1000) & 0xffff });
    }
    _status() {
      const rem = Math.max(0, Math.round((this.muteUntil - Date.now()) / 1000));
      const old = !!this.opts.oldfw;
      this.emit('status', { proto: old ? 1 : 2, fw: old ? '2.0' : '2.1', calBits: this.calBits, hwBits: P.HB.S1 | P.HB.S2 | P.HB.MOTOR | P.HB.AUTHED | P.HB.OWNER | P.HB.TIME, battMv: 0, muteRemainS: rem, alarmOff: !this.set.alarmEnabled,
                            overCount: this.overCount, approachCount: this.approachCount, min: this.min, max: this.max, rateS1: 400, rateS2: 500, warnCount: 0 });
      this.emit('diag', { rtLoopMaxUs: 1180, latLastMs: 0.6, latMaxMs: 1.9, tempS1: 29, tempS2: 27, gaps1: 0, gaps2: 0, i2cErr: 0, rssi: -58, mainLoopMaxMs: 6, lost: 0, kfRejects: 0 });
    }
  }

  window.KneeDevice = KneeDevice;
  window.DemoDevice = DemoDevice;
})();
