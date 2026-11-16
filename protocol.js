// KneeAngle - Bluetooth-Protokoll Version 1 (Dekoder/Enkoder)
// Laeuft im Browser (window.KneeProto) und in Node (module.exports) - siehe test/protocol.test.js
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KneeProto = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const uuid = (x) => `4b4e${x}-6b6e-6565-616e-676c65303031`;
  const UUID = {
    service: uuid('0001'), live: uuid('0002'), status: uuid('0003'), cal: uuid('0004'), msg: uuid('0005'),
    cmd: uuid('0006'), settings: uuid('0007'), log: uuid('0008'), auth: uuid('0009'), diag: uuid('000a')
  };
  const PROTO_VERSION = 1;
  const CMD = { CHAR: 1, ZERO_REF: 2, MUTE: 3, VIB_TEST: 4, SET_TIME: 5, LOG_READ: 6, LOG_CLEAR: 7, STATS_RESET: 8, MOTOR_CAL: 9, INFO: 10, FORGET: 12 };
  const STATE = { NORMAL: 0, APPROACH: 1, OVER: 2, INVALID: 3, CAL: 4 };
  const SILENCE = { NONE: 0, MUTED: 1, OFF: 2 };
  const AF = { PREDICTED: 1, UNRELIABLE: 2, MOTOR: 4, PAUSED: 8, BATT_LOW: 16, BATT_CRIT: 32, MOTOR_FAULT: 64 };
  const SF = { REST1: 1, REST2: 2, ACC: 4, VERT: 8, SAT: 16, NOSENSCAL: 32, BIAS: 64, REINIT: 128, NOZERO: 256, NOJOINT: 512, OFFLINE: 1024 };
  const CB = { ACC1: 1, ACC2: 2, GYR1: 4, GYR2: 8, JOINT: 16, ZERO: 32, LEVER: 64, MOTORCAL: 128 };
  const HB = { S1: 1, S2: 2, MOTOR: 4, BATT: 8, AUTHED: 16, WINDOW: 32, OWNER: 64, TIME: 128 };
  const HINT = { NONE: 0, HOLD_STILL: 1, NEW_POSE: 2, MOVING: 3, MOVE: 4, TILT_MORE_1: 5, TILT_MORE_2: 6, PAUSE_SHORT: 7, STRAIGHT: 8, FLEX: 9, AXIS_VERTICAL: 10, COMPUTING: 11, FLEX_MORE: 12, GOOD: 13 };
  const RESULT = { NONE: 0, OK: 1, OK_PARTIAL: 2, ABORTED: 3, ACC_FIT: 4, TOO_LITTLE_MOTION: 5, AXIS1: 6, AXIS2: 7, SIGN: 8, NO_REST: 9, TIMEOUT: 10, TOO_FEW: 11, NEED_JOINT: 12 };

  const dv = (buf) => (buf instanceof DataView ? buf : new DataView(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength));
  const i16inv = (v) => (v === 0x7fff ? null : v);

  function decodeLive(buf) {
    const d = dv(buf);
    if (d.byteLength < 18) return null;
    const a = i16inv(d.getInt16(0, true));
    return {
      angle: a === null ? null : a / 100, sigma: d.getUint16(2, true) / 100, rate: d.getInt16(4, true) / 10,
      state: d.getUint8(6), silence: d.getUint8(7), aflags: d.getUint8(8), sysFlags: d.getUint16(10, true),
      effLimit: d.getInt16(12, true) / 100, seq: d.getUint16(14, true), ms: d.getUint16(16, true)
    };
  }
  function decodeStatus(buf) {
    const d = dv(buf);
    if (d.byteLength < 20) return null;
    const mn = i16inv(d.getInt16(13, true)), mx = i16inv(d.getInt16(15, true));
    const mute = d.getUint16(7, true);
    return {
      proto: d.getUint8(0), fw: `${d.getUint8(1)}.${d.getUint8(2)}`, calBits: d.getUint8(3), hwBits: d.getUint8(4),
      battMv: d.getUint16(5, true), muteRemainS: mute === 0xffff ? 0 : mute, alarmOff: mute === 0xffff,
      overCount: d.getUint16(9, true), approachCount: d.getUint16(11, true),
      min: mn === null ? null : mn / 100, max: mx === null ? null : mx / 100,
      rateS1: d.getUint8(17) * 2, rateS2: d.getUint8(18) * 2, warnCount: d.getUint8(19)
    };
  }
  function decodeCal(buf) {
    const d = dv(buf);
    if (d.byteLength < 19) return null;
    const p = d.getUint8(0), sec = d.getUint32(11, true);
    const a = []; for (let i = 0; i < 6; i++) a.push(d.getUint8(5 + i));
    return {
      mode: p & 3, step: (p >> 2) & 3, resultMode: (p >> 4) & 3, progress: d.getUint8(1), hint: d.getUint8(2),
      result: d.getUint8(3), resultSeq: d.getUint8(4), a, sectorMask: sec & 0x03ffffff, curSector: (sec >>> 27) & 31,
      q1: d.getInt16(15, true), q2: d.getInt16(17, true)
    };
  }
  function decodeDiag(buf) {
    const d = dv(buf);
    if (d.byteLength < 20) return null;
    return {
      rtLoopMaxUs: d.getUint16(0, true), latLastMs: d.getUint16(2, true) / 100, latMaxMs: d.getUint16(4, true) / 100,
      tempS1: d.getInt8(6), tempS2: d.getInt8(7), gaps1: d.getUint16(8, true), gaps2: d.getUint16(10, true),
      i2cErr: d.getUint16(12, true), rssi: d.getInt8(14), mainLoopMaxMs: d.getUint8(15), lost: d.getUint16(16, true), kfRejects: d.getUint16(18, true)
    };
  }
  function decodeSettings(buf) {
    const d = dv(buf);
    if (d.byteLength < 20 || d.getUint8(0) !== 1) return null;
    return {
      alarmEnabled: !!d.getUint8(1), limit: d.getInt16(2, true) / 10, zone: d.getUint16(4, true) / 10, hyst: d.getUint16(6, true) / 10,
      approachOn: !!d.getUint8(8), approachMoveOnly: !!d.getUint8(9), rateMin: d.getUint8(10) / 10, rateMax: d.getUint8(11) / 10,
      approachStrength: d.getUint8(12), alarmStrength: d.getUint8(13), predictMs: d.getUint16(14, true),
      cautiousOn: !!d.getUint8(16), kSigma: d.getUint8(17) / 10, batteryPresent: !!d.getUint8(18)
    };
  }
  function encodeSettings(s) {
    const b = new Uint8Array(20), d = new DataView(b.buffer);
    d.setUint8(0, 1); d.setUint8(1, s.alarmEnabled ? 1 : 0);
    d.setInt16(2, Math.round(s.limit * 10), true); d.setUint16(4, Math.round(s.zone * 10), true); d.setUint16(6, Math.round(s.hyst * 10), true);
    d.setUint8(8, s.approachOn ? 1 : 0); d.setUint8(9, s.approachMoveOnly ? 1 : 0);
    d.setUint8(10, Math.round(s.rateMin * 10)); d.setUint8(11, Math.round(s.rateMax * 10));
    d.setUint8(12, Math.round(s.approachStrength)); d.setUint8(13, Math.round(s.alarmStrength));
    d.setUint16(14, Math.round(s.predictMs), true);
    d.setUint8(16, s.cautiousOn ? 1 : 0); d.setUint8(17, Math.round(s.kSigma * 10)); d.setUint8(18, s.batteryPresent ? 1 : 0);
    return b;
  }
  // Plausibilitaet wie im Geraet; gibt Liste von Fehlertexten zurueck (leer = ok)
  function validateSettings(s) {
    const e = [];
    if (!(s.limit >= -20 && s.limit <= 30)) e.push('Grenzwinkel muss zwischen −20° und +30° liegen.');
    if (!(s.zone >= 2 && s.zone <= 30)) e.push('Annäherungszone muss zwischen 2° und 30° liegen.');
    if (!(s.hyst >= 0.5 && s.hyst <= 5)) e.push('Hysterese muss zwischen 0.5° und 5° liegen.');
    if (s.hyst >= s.zone) e.push('Die Hysterese muss kleiner sein als die Annäherungszone.');
    if (s.rateMax < s.rateMin) e.push('Die Pulsrate an der Grenze darf nicht kleiner sein als am Zonenrand.');
    if (!(s.predictMs >= 0 && s.predictMs <= 300)) e.push('Vorhersage: 0 bis 300 ms.');
    return e;
  }
  function decodeLog(buf) {
    const d = dv(buf);
    const t = d.getUint8(0);
    if (t === 0xff && d.byteLength >= 9) return { end: true, count: d.getUint16(1, true), deviceTime: d.getUint32(3, true), timeValid: !!d.getUint8(7) };
    if (t === 0x01 && d.byteLength >= 19) {
      const type = d.getUint8(3), flags = d.getUint8(4);
      const rec = { index: d.getUint16(1, true), type, flags, seq: d.getUint16(5, true), time: d.getUint32(7, true), timeValid: !!(flags & 1) };
      if (type === 1) {
        rec.durS = d.getUint16(11, true) / 100; rec.extreme = d.getInt16(13, true) / 100; rec.limit = d.getInt16(15, true) / 100;
        rec.predictedOnly = !!(flags & 2); rec.silenced = !!(flags & 4);
      } else if (type === 2) {
        rec.approachTotal = d.getUint16(11, true) | (d.getUint16(13, true) << 16); rec.warnTotal = d.getInt16(15, true);
      }
      return rec;
    }
    return null;
  }
  function decodeAuth(buf) {
    const d = dv(buf);
    if (d.byteLength < 19) return null;
    return { authed: !!d.getUint8(0), windowOpen: !!d.getUint8(1), ownerSet: !!d.getUint8(2), nonce: new Uint8Array(d.buffer.slice(d.byteOffset + 3, d.byteOffset + 19)) };
  }
  async function authMac(token, nonce) {
    const inp = new Uint8Array(32); inp.set(token, 0); inp.set(nonce, 16);
    const h = await crypto.subtle.digest('SHA-256', inp);
    return new Uint8Array(h).slice(0, 16);
  }
  const cmd = {
    char: (c) => Uint8Array.of(CMD.CHAR, c.charCodeAt(0)),
    zeroRef: (deg) => { const b = new Uint8Array(3), d = new DataView(b.buffer); b[0] = CMD.ZERO_REF; d.setInt16(1, Math.round(deg * 100), true); return b; },
    mute: (min) => { const b = new Uint8Array(3), d = new DataView(b.buffer); b[0] = CMD.MUTE; d.setUint16(1, min, true); return b; },
    vibTest: (t) => Uint8Array.of(CMD.VIB_TEST, t),
    setTime: (epoch) => { const b = new Uint8Array(5), d = new DataView(b.buffer); b[0] = CMD.SET_TIME; d.setUint32(1, epoch >>> 0, true); return b; },
    logRead: (start) => { const b = new Uint8Array(3), d = new DataView(b.buffer); b[0] = CMD.LOG_READ; d.setUint16(1, start || 0, true); return b; },
    logClear: () => Uint8Array.of(CMD.LOG_CLEAR), statsReset: () => Uint8Array.of(CMD.STATS_RESET),
    motorCal: () => Uint8Array.of(CMD.MOTOR_CAL), info: () => Uint8Array.of(CMD.INFO), forget: () => Uint8Array.of(CMD.FORGET)
  };
  const auth = {
    claim: (token) => { const b = new Uint8Array(17); b[0] = 1; b.set(token, 1); return b; },
    prove: (mac) => { const b = new Uint8Array(17); b[0] = 2; b.set(mac, 1); return b; }
  };
  return { UUID, PROTO_VERSION, CMD, STATE, SILENCE, AF, SF, CB, HB, HINT, RESULT, decodeLive, decodeStatus, decodeCal, decodeDiag,
           decodeSettings, encodeSettings, validateSettings, decodeLog, decodeAuth, authMac, cmd, auth };
});
