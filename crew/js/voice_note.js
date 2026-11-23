/* =============================================================
   voice_note.js
   Mantis Gardens — "Record a voice note" on the crew work record
   (released to all crew; tester mode, ?test=1, also shows speech details).

   The crew member talks through the work; the app drafts the Service
   Notes (client sees). Everything said goes to Service Notes (owner's
   choice, Nov 22, 2026; it first also drafted Internal Notes). Nothing is
   added to the form until they review the draft and tap "Add to notes".

   How it works:
     - Records the microphone as 16 kHz mono WAV with the Web Audio API
       (works on iPhone Safari and Android Chrome alike).
     - Every PIECE_SECONDS it sends the finished piece to
       POST /voice/transcribe while recording continues, so the wait at
       the end is short (the backend's speech-to-text takes pieces of
       under a minute). Recording stops by itself at MAX_SECONDS.
     - Then POST /voice/organize turns the joined transcript into the two
       drafts. The audio is never stored anywhere.
   Backend: mantis-backend/src/lib/voiceNotes.js. Styles: css/voice_note.css.
   ============================================================= */
const VoiceNote = (() => {
  const PIECE_SECONDS = 50;
  const MAX_SECONDS = 180;
  const OUT_RATE = 16000;
  const SILENT_PEAK = 0.003;          // loudest sample below this (about -50 dB) = only silence reached the app

  let ctx = null, stream = null, source = null, node = null, wakeLock = null;
  let recording = false, buffers = [], samples = 0, startedAt = 0, timer = null;
  let pieces = [], level = 0;
  let stats = { calls: 0, peak: 0 };   // did any sound reach the app? (phones can deliver silence)
  let warned = false;
  let lastTranscript = '';
  let lastSpeechInfo = '';            // tester info: word hints used and speech model

  const $ = (id) => document.getElementById(id);
  const base = () => (typeof SCRIPT_URL !== 'undefined' ? SCRIPT_URL : '');
  function idToken() {
    let t = sessionStorage.getItem('mg_id_token') || '';
    if (!t) {
      const ls = localStorage.getItem('mg_id_token') || '';
      if (ls && Date.now() < parseInt(localStorage.getItem('mg_id_token_expiry') || '0')) { sessionStorage.setItem('mg_id_token', ls); t = ls; }
    }
    return t;
  }
  async function post(path, body) {
    const res = await fetch(`${base()}${path}?id_token=${encodeURIComponent(idToken())}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error('Your sign-in has expired. Close this, reload the page, and try again.');
    if (!res.ok || json.error) throw new Error(json.error || ('HTTP ' + res.status));
    return json;
  }
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  // ── Audio: Float32 at the device rate -> 16 kHz 16-bit mono WAV ──
  function toWav(chunks, inRate) {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const all = new Float32Array(total);
    let off = 0; chunks.forEach(c => { all.set(c, off); off += c.length; });
    const ratio = inRate / OUT_RATE;
    const outLen = Math.floor(total / ratio);
    const pcm = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {                 // average each block: a simple low-pass + downsample
      const a = Math.floor(i * ratio), b = Math.min(total, Math.max(a + 1, Math.floor((i + 1) * ratio)));
      let sum = 0; for (let j = a; j < b; j++) sum += all[j];
      const v = Math.max(-1, Math.min(1, sum / (b - a)));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const dv = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, OUT_RATE, true); dv.setUint32(28, OUT_RATE * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
    new Int16Array(buf, 44).set(pcm);
    return new Blob([buf], { type: 'audio/wav' });
  }
  const blobToBase64 = (blob) => new Promise((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => bad(new Error('Could not read the recording.'));
    r.readAsDataURL(blob);
  });

  // Sends one finished piece; resolves to its text (one retry on a network blip).
  function cutPiece() {
    if (!buffers.length) return;
    const chunks = buffers, rate = ctx.sampleRate;
    buffers = []; samples = 0;
    const p = (async () => {
      const audio = await blobToBase64(toWav(chunks, rate));
      try { return await post('/voice/transcribe', { audio }); }
      catch (e) { if (/sign-in/.test(e.message)) throw e; return await post('/voice/transcribe', { audio }); }
    })();
    p.catch(() => {});                                 // handled when all pieces are awaited
    pieces.push(p);
  }

  // ── Modal ─────────────────────────────────────────────────
  function ensureModal() {
    if ($('vn-modal')) return;
    const m = document.createElement('div');
    m.id = 'vn-modal';
    m.className = 'vn-overlay';
    m.innerHTML = `<div class="vn-box" role="dialog" aria-modal="true" aria-labelledby="vn-title">
      <div class="vn-title" id="vn-title">Voice note</div>
      <div id="vn-step-start">
        <p class="vn-text">Talk through the work you did, what you noticed and anything planned for next time. This becomes the Service Notes, which the client sees. Up to 3 minutes. You'll check it before it's added.</p>
        <button class="vn-btn vn-primary" onclick="VoiceNote.start()">&#127908; Start recording</button>
      </div>
      <div id="vn-step-rec" style="display:none">
        <div class="vn-rec"><span class="vn-dot"></span><span id="vn-time">0:00</span><span class="vn-of">/ 3:00</span></div>
        <div class="vn-meter"><div id="vn-level"></div></div>
        <button class="vn-btn vn-primary" onclick="VoiceNote.stop()">&#9632; Stop &amp; write notes</button>
      </div>
      <div id="vn-step-busy" style="display:none"><div class="vn-spinner"></div><p class="vn-text" id="vn-busy-text">Working&hellip;</p></div>
      <div id="vn-step-review" style="display:none">
        <label class="vn-label" for="vn-service">Service notes <span class="vn-client">(client sees these)</span></label>
        <textarea class="vn-area" id="vn-service" rows="10" oninput="VoiceNote.showGuesses()"></textarea>
        <div class="vn-guesses" id="vn-guesses" style="display:none"></div>
        <div class="vn-unclear" id="vn-unclear" style="display:none"></div>
        <details class="vn-transcript"><summary>What you said (transcript)</summary><div id="vn-transcript-text"></div></details>
        <p class="vn-text vn-small">Check the notes &mdash; especially plant names, anything in [brackets?], and anything not meant for the client.</p>
        <button class="vn-btn vn-primary" id="vn-apply" onclick="VoiceNote.apply()">Add to notes</button>
        <button class="vn-btn vn-primary" id="vn-retry" style="display:none" onclick="VoiceNote.retry()">Try writing the notes again</button>
        <button class="vn-btn" onclick="VoiceNote.reset()">Record again</button>
      </div>
      <div class="vn-error" id="vn-error" style="display:none"></div>
      <button class="vn-btn vn-ghost" id="vn-cancel" onclick="VoiceNote.close()">Cancel</button>
    </div>`;
    document.body.appendChild(m);
  }
  function step(name) {
    ['start', 'rec', 'busy', 'review'].forEach(s => { $('vn-step-' + s).style.display = s === name ? '' : 'none'; });
  }
  function showError(msg) { const e = $('vn-error'); e.textContent = msg; e.style.display = msg ? '' : 'none'; }
  function busy(text) { $('vn-busy-text').textContent = text; step('busy'); }

  function open() {
    ensureModal();
    reset();
    $('vn-modal').classList.add('open');
  }
  function reset() {
    cleanup();
    pieces = []; lastTranscript = '';
    showError('');
    step('start');
  }
  function close() {
    cleanup();
    pieces = [];
    const m = $('vn-modal'); if (m) m.classList.remove('open');
  }
  function cleanup() {
    recording = false;
    clearInterval(timer); timer = null;
    try { if (source) source.disconnect(); if (node) node.disconnect(); } catch (e) { /* already gone */ }
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {});
    if (wakeLock) wakeLock.release().catch(() => {});
    ctx = stream = source = node = wakeLock = null;
    buffers = []; samples = 0;
  }

  async function start() {
    showError('');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { showError('This browser cannot record audio.'); return; }
    // Create and resume the audio context right here, inside the tap: iPhone and Android
    // can leave one created after an await "suspended", and then no sound is captured.
    cleanup();
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const resumed = ctx.resume().catch(() => {});
    try {
      // No channelCount or noiseSuppression: some phones return silence with a forced
      // channel count, and phone call-style noise suppression can strip speech.
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true } });
    } catch (e) {
      cleanup();
      showError('The microphone is blocked. Allow microphone access for this site in your browser settings, then try again.');
      return;
    }
    await resumed;
    if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) { /* reported below */ } }
    source = ctx.createMediaStreamSource(stream);
    node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (ev) => {
      if (!recording) return;
      const ch = ev.inputBuffer.getChannelData(0);
      buffers.push(new Float32Array(ch));
      samples += ch.length;
      let peak = 0; for (let i = 0; i < ch.length; i += 16) peak = Math.max(peak, Math.abs(ch[i]));
      stats.calls++; stats.peak = Math.max(stats.peak, peak);
      level = Math.max(peak, level * 0.85);
      if (samples >= PIECE_SECONDS * ctx.sampleRate) cutPiece();
    };
    source.connect(node);
    node.connect(ctx.destination);                     // some browsers only run the processor when connected
    try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* optional */ }
    pieces = []; buffers = []; samples = 0;
    stats = { calls: 0, peak: 0 }; warned = false;
    recording = true;
    startedAt = Date.now();
    step('rec');
    timer = setInterval(() => {
      const s = (Date.now() - startedAt) / 1000;
      $('vn-time').textContent = fmt(Math.min(s, MAX_SECONDS));
      $('vn-level').style.width = Math.min(100, Math.round(level * 140)) + '%';
      if (!warned && s > 4 && stats.peak < SILENT_PEAK) {   // say so now, not after 3 minutes
        warned = true;
        showError('No sound is reaching the app from the microphone. Tap Stop, close other apps using the microphone (calls, voice memos), and try again.');
      }
      if (s >= MAX_SECONDS) stop();
    }, 200);
  }

  async function stop() {
    if (!recording) return;
    const seconds = (Date.now() - startedAt) / 1000;
    recording = false;
    if (seconds < 2) {                                 // too short: discard without sending anything
      cleanup(); pieces = [];
      showError('That was too short. Tap Start and talk for a few seconds.'); step('start'); return;
    }
    cutPiece();
    const sent = pieces;
    const heard = { calls: stats.calls, peak: stats.peak, state: ctx ? ctx.state : 'none', rate: ctx ? ctx.sampleRate : 0 };
    cleanup();
    // Sound never reached the app: say so (with details to pass on) instead of sending silence.
    const details = `(details: ${heard.calls} audio blocks, peak ${heard.peak.toFixed(4)}, ${heard.state}, ${heard.rate} Hz)`;
    if (!heard.calls) { showError(`The microphone did not send any audio to the app. Reload the page and try again. ${details}`); step('start'); return; }
    if (heard.peak < SILENT_PEAK) { showError(`The microphone sent only silence. Check that no other app is using it, reload the page, and try again. ${details}`); step('start'); return; }
    showError('');
    try {
      busy('Turning your recording into text…');
      const results = await Promise.all(sent);
      lastTranscript = results.map(r => String((r && r.text) || '').trim()).filter(Boolean).join(' ');
      const r0 = results.find(r => r && r.model) || {};
      lastSpeechInfo = r0.model ? `Speech model ${r0.model}, ${Math.min(...results.map(r => (r && r.hints) || 0))} word hints` : '';
      if (!lastTranscript) throw new Error(`No words were recognized. Try again closer to the phone, away from equipment noise. ${details}`);
      await writeNotes();
    } catch (e) {
      failed(e);
    }
  }

  // Writing the notes failed after the recording was transcribed: keep the transcript
  // on screen (nothing said is lost) and offer to try the writing step again.
  function failed(e) {
    showError(e.message);
    if (!lastTranscript) { step('start'); return; }
    $('vn-transcript-text').textContent = lastTranscript;
    const det = document.querySelector('#vn-modal .vn-transcript'); if (det) det.open = true;
    $('vn-apply').style.display = 'none';
    $('vn-retry').style.display = '';
    step('review');
  }
  async function retry() {
    try { await writeNotes(); } catch (e) { failed(e); }
  }

  async function writeNotes() {
    busy('Writing your notes…');
    const val = (id) => { const el = $(id); return el ? el.value : ''; };
    const out = await post('/voice/organize', {
      transcript: lastTranscript, clientName: val('wr-client-name'), date: val('wr-date-start'), team: val('wr-team'),
    });
    $('vn-service').value = out.serviceNotes || '';
    showGuesses();
    const u = $('vn-unclear');
    if (out.unclear && out.unclear.length) {
      // Corrected names, [bracketed?] guesses and anything not understood.
      u.innerHTML = '<b>Please check:</b><ul>' + out.unclear.map(s => '<li>' + s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) + '</li>').join('') + '</ul>';
      u.style.display = '';
    } else u.style.display = 'none';
    $('vn-transcript-text').textContent = lastTranscript + (lastSpeechInfo && window.MANTIS_TEST ? `\n\n(${lastSpeechInfo})` : '');
    $('vn-apply').style.display = '';
    $('vn-retry').style.display = 'none';
    showError('');
    step('review');
  }

  // [best guess?] words in the draft, each with an Accept button that removes the
  // brackets and question mark and keeps the word. To change a guess instead, the
  // crew member edits it in the box; the list updates as they type.
  const GUESS = /\[([^\]]*?)\?\]/g;
  const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function showGuesses() {
    const box = $('vn-guesses'); if (!box) return;
    const found = [...$('vn-service').value.matchAll(GUESS)].map(m => m[1].trim());
    if (!found.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.innerHTML = '<div class="vn-guess-head">Guesses in the notes &mdash; accept, or fix the word in the box:</div>'
      + found.map((w, i) => `<div class="vn-guess"><span class="vn-guess-word">${esc(w) || '(blank)'}</span>`
        + `<button type="button" class="vn-guess-btn" onclick="VoiceNote.acceptGuess(${i})">&#10003; Accept</button></div>`).join('')
      + (found.length > 1 ? '<button type="button" class="vn-guess-all" onclick="VoiceNote.acceptGuess(-1)">&#10003; Accept all</button>' : '');
    box.style.display = '';
  }
  function acceptGuess(n) {                          // n = which guess (0-based), -1 = all
    const ta = $('vn-service');
    let i = -1;
    ta.value = ta.value.replace(GUESS, (m, w) => (++i === n || n === -1) ? w.trim() : m);
    showGuesses();
  }

  // Adds the drafts to the form: fills an empty box, or adds below what is already there.
  function apply() {
    // A [bracketed?] guess must not slip into the client's notes unnoticed.
    const left = $('vn-service').value.match(/\[[^\]]*\?\]/g) || [];
    if (left.length && !confirm(`These guesses are still in the notes:\n\n${left.join('\n')}\n\nFix them first? Tap Cancel to go back and edit, or OK to add the notes as they are.`)) return;
    [['vn-service', 'wr-service-notes']].forEach(([from, to]) => {
      const text = $(from).value.trim();
      const target = $(to);
      if (!text || !target) return;
      target.value = target.value.trim() ? target.value.replace(/\s+$/, '') + '\n\n' + text : text;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    });
    close();
    const s = $('wr-service-notes'); if (s) s.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Released to all crew.
  function showButton() {
    const sec = $('wr-voice');
    if (sec) sec.style.display = '';
  }
  showButton();

  return { open, start, stop, apply, retry, reset, close, showGuesses, acceptGuess, _toWav: toWav };
})();
