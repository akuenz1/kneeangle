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
      await this._open();
    }

    async _open() {
      this.emit('conn', 'connecting');
      const step = async (name, fn) => { try { return await fn(); } catch (e) { const err = new Error(name + ': ' + (e && (e.name + ' ' + e.message))); err.name = 'StepError'; throw err; } };
      const server = await step('Verbindungsaufbau', () => this.dev.gatt.connect());
      const svc = await step('Dienst suchen', () => server.getPrimaryService(P.UUID.service));
      for (const k of ['live', 'status', 'cal', 'msg', 'cmd', 'settings', 'log', 'auth', 'diag']) this.ch[k] = await step('Merkmal ' + k, () => svc.getCharacteristic(P.UUID[k]));
      const sub = async (k, fn) => {
        this.ch[k].addEventListener('characteristicvaluechanged', (e) => fn(e.target.value));
        await step('Benachrichtigung ' + k, () => this.ch[k].startNotifications());
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
  // ===========================================================================
  class DemoDevice extends Emitter {
    constructor() {
      super();
      this.name = 'KneeAngle-DEMO'; this.connected = false; this.authState = { authed: true, windowOpen: true, ownerSet: true };
      this.set = { alarmEnabled: true, limit: -5, zone: 10, hyst: 2, approachOn: true, approachMoveOnly: true, rateMin: 1, rateMax: 5, approachStrength: 20, alarmStrength: 100, predictMs: 40, cautiousOn: true, kSigma: 2, batteryPresent: false };
      this.t = 0; this.over = false; this.overCount = 0; this.approachCount = 0; this.zone = false; this.min = null; this.max = null;
      this.muteUntil = 0; this.calBits = P.CB.ACC1 | P.CB.ACC2 | P.CB.GYR1 | P.CB.GYR2 | P.CB.JOINT | P.CB.ZERO | P.CB.MOTORCAL;
      this.cal = { mode: 0, step: 0, resultMode: 0, progress: 0, hint: 0, result: 0, resultSeq: 0, a: [0, 0, 0, 0, 0, 0], sectorMask: 0, curSector: 31, q1: 0, q2: 0 };
      this.calT = 0; this.log = []; this.seq = 0; this.offset = 0;
      const now = Math.floor(Date.now() / 1000);
      for (let i = 0; i < 6; i++) this.log.push({ index: i, type: 1, flags: 1, seq: i + 1, time: now - (6 - i) * 5400, timeValid: true, durS: 0.4 + i * 0.3, extreme: -6 - i * 0.7, limit: -5, predictedOnly: i === 2, silenced: false });
    }
    static get supported() { return true; }
    async connect() {
      this.connected = true; this.emit('conn', 'connected'); this.emit('auth', this.authState); this.emit('settings', { ...this.set }); this.emit('cal', { ...this.cal });
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
          if (c === 's') this._startCal(1); else if (c === 'a') this._startCal(2); else if (c === 'z') this._startCal(3);
          else if (c === 'x') this._endCal(P.RESULT.ABORTED); else if (c === 'f' && this.cal.mode) this.calT = 1e6; break; }
        case P.CMD.ZERO_REF: this.zeroRef = d.getInt16(1, true) / 100; this._startCal(3); break;
        case P.CMD.MUTE: this.muteUntil = d.getUint16(1, true) ? Date.now() + d.getUint16(1, true) * 60000 : 0; this._status(); break;
        case P.CMD.LOG_READ: this.log.forEach((r, i) => setTimeout(() => this.emit('log', r), 30 * i)); setTimeout(() => this.emit('log', { end: true, count: this.log.length, deviceTime: Math.floor(Date.now() / 1000), timeValid: true }), 30 * this.log.length + 30); break;
        case P.CMD.LOG_CLEAR: this.log = []; break;
        case P.CMD.STATS_RESET: this.overCount = 0; this.approachCount = 0; this.min = this.max = null; this._status(); break;
        case P.CMD.INFO: this.emit('msg', '\n--- Demo-Geraet ---\nKeine echte Hardware verbunden.\n'); break;
        default: break;
      }
    }
    _startCal(mode) { this.cal = { ...this.cal, mode, step: 0, progress: 0, hint: mode === 1 ? P.HINT.HOLD_STILL : (mode === 3 ? P.HINT.STRAIGHT : P.HINT.HOLD_STILL), a: [0, 0, 0, 0, 0, 0], sectorMask: 0, curSector: 0 }; this.calT = 0; this.emit('cal', { ...this.cal }); }
    _endCal(result) {
      if (!this.cal.mode) return;
      const m = this.cal.mode;
      this.cal = { ...this.cal, mode: 0, resultMode: m, result, resultSeq: (this.cal.resultSeq + 1) & 255, hint: 0, progress: 0,
                   q1: m === 1 ? 110 : (m === 2 ? 32 : 180), q2: m === 1 ? 95 : (m === 2 ? 61 : Math.round((this.zeroRef || 0) * 100)) };
      if (result === P.RESULT.OK && m === 3) { this.offset = 0; } this.zeroRef = 0;
      this.emit('cal', { ...this.cal });
    }
    _calTick() {
      const c = this.cal; this.calT += 0.05; const t = this.calT;
      if (c.mode === 1) {
        const n = Math.min(16, Math.floor(t / 1.6)); const ph = (t % 1.6);
        c.a = [n, n, Math.min(100, n * 7), Math.min(100, n * 7), Math.max(0, n - 1), Math.max(0, n - 1)];
        c.sectorMask = 0; for (let i = 0; i < n; i++) c.sectorMask |= (1 << ((i * 7) % 26));
        c.curSector = (n * 7) % 26; c.progress = Math.min(99, Math.round(n / 14 * 100));
        c.hint = ph < 0.6 ? P.HINT.MOVING : (ph < 1.3 ? P.HINT.HOLD_STILL : P.HINT.NEW_POSE);
        if (n >= 14 || t > 1e5) { c.hint = P.HINT.COMPUTING; if (t > 1e5 || t > 14 * 1.6 + 1) { this.calBits |= P.CB.ACC1 | P.CB.ACC2 | P.CB.GYR1 | P.CB.GYR2; this._endCal(P.RESULT.OK); return; } }
      } else if (c.mode === 2) {
        if (c.step === 0) { c.hint = P.HINT.HOLD_STILL; c.progress = Math.round(Math.min(100, t / 2 * 100)); if (t > 2) { c.step = 1; this.calT = 0; } }
        else if (c.step === 1) {
          c.progress = Math.round(Math.min(100, t / 12 * 100)); c.a = [Math.round(Math.min(100, t * 12)), Math.round(Math.min(100, t * 9)), Math.floor(t / 4), Math.floor(t), 0, 0];
          c.hint = t < 3 ? P.HINT.MOVE : (t < 6 ? P.HINT.TILT_MORE_1 : (t < 8 ? P.HINT.PAUSE_SHORT : P.HINT.GOOD));
          if (t > 12) { c.hint = P.HINT.COMPUTING; } if (t > 13) { c.step = 2; this.calT = 0; c.a[4] = 55; c.q1 = 32; c.q2 = 61; }
        } else if (c.step === 2) { c.hint = P.HINT.STRAIGHT; c.progress = Math.min(100, t / 3 * 100); if (t > 3) { c.step = 3; this.calT = 0; } }
        else { c.hint = t < 1.5 ? P.HINT.FLEX : (t < 3 ? P.HINT.FLEX_MORE : P.HINT.GOOD); c.progress = Math.min(100, t / 4 * 100); if (t > 4) { this.calBits |= P.CB.JOINT | P.CB.ZERO; this._endCal(P.RESULT.OK); return; } }
      } else if (c.mode === 3) {
        c.hint = t < 1 ? P.HINT.HOLD_STILL : P.HINT.STRAIGHT; c.progress = Math.min(100, t / 3 * 100); if (t > 3) { this._endCal(P.RESULT.OK); return; }
      }
      this.emit('cal', { ...c, a: [...c.a] });
    }
    _tick() {
      this.t += 0.05; const t = this.t, s = this.set;
      if (this.cal.mode) this._calTick();
      // Bewegung: Kniebeugen, dazwischen Stehen mit gelegentlichem Durchstrecken
      const cyc = t % 24; let a;
      if (cyc < 12) a = 3 + 48 * (1 - Math.cos(cyc / 12 * 2 * Math.PI * 3)); else if (cyc < 18) a = 3 + 2 * Math.sin(t * 0.8);
      else a = 3 - 6 * (1 - Math.cos((cyc - 18) / 6 * 2 * Math.PI)) ;
      const prev = this.a === undefined ? a : this.a; this.a = a; const rate = (a - prev) / 0.05;
      const sigma = 0.12 + 0.05 * Math.sin(t * 0.3);
      const eff = s.limit + (s.cautiousOn ? s.kSigma * sigma : 0);
      if (!this.over && a <= eff) { this.over = true; this.overStart = Date.now(); this.ext = a; }
      else if (this.over) { this.ext = Math.min(this.ext, a); if (a > eff + s.hyst) { this.over = false; this.overCount++; this.log.push({ index: this.log.length, type: 1, flags: 1, seq: this.log.length + 1, time: Math.floor(this.overStart / 1000), timeValid: true, durS: (Date.now() - this.overStart) / 1000, extreme: this.ext, limit: eff, predictedOnly: false, silenced: false }); } }
      if (!this.zone && a <= eff + s.zone) { this.zone = true; if (!this.over) this.approachCount++; } else if (this.zone && a > eff + s.zone + s.hyst) this.zone = false;
      if (this.min === null || a < this.min) this.min = a; if (this.max === null || a > this.max) this.max = a;
      const muted = this.muteUntil > Date.now();
      const state = this.cal.mode ? P.STATE.CAL : (this.over ? P.STATE.OVER : (this.zone ? P.STATE.APPROACH : P.STATE.NORMAL));
      const sil = !s.alarmEnabled ? P.SILENCE.OFF : (muted ? P.SILENCE.MUTED : P.SILENCE.NONE);
      this.emit('live', { angle: Math.round(a * 100) / 100, sigma, rate, state, silence: sil, aflags: (this.over && !sil) ? P.AF.MOTOR : 0, sysFlags: Math.abs(rate) < 1 ? 3 | 4 : 4, effLimit: eff, seq: this.seq++ & 0xffff, ms: (t * 1000) & 0xffff });
    }
    _status() {
      const rem = Math.max(0, Math.round((this.muteUntil - Date.now()) / 1000));
      this.emit('status', { proto: 1, fw: '2.0', calBits: this.calBits, hwBits: P.HB.S1 | P.HB.S2 | P.HB.MOTOR | P.HB.AUTHED | P.HB.OWNER | P.HB.TIME, battMv: 0, muteRemainS: rem, alarmOff: !this.set.alarmEnabled,
                            overCount: this.overCount, approachCount: this.approachCount, min: this.min, max: this.max, rateS1: 400, rateS2: 500, warnCount: 0 });
      this.emit('diag', { rtLoopMaxUs: 1180, latLastMs: 0.6, latMaxMs: 1.9, tempS1: 29, tempS2: 27, gaps1: 0, gaps2: 0, i2cErr: 0, rssi: -58, mainLoopMaxMs: 6, lost: 0, kfRejects: 0 });
    }
  }

  window.KneeDevice = KneeDevice;
  window.DemoDevice = DemoDevice;
})();
