/* =============================================================
   crew_ui.js
   Mantis Gardens — UI Utilities

   Contains:
     Submit progress indicator  (showSubmitProgress, hideSubmitProgress)
     Toast notification         (showToast)
   ============================================================= */

// =============================================================
// SUBMIT PROGRESS INDICATOR
// Shows a slim progress bar + status message inside the modal
// footer while the record is being written to Drive.
// =============================================================
function showSubmitProgress(message, pct) {
  let bar = document.getElementById('submit-progress');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'submit-progress';
    bar.style.cssText = [
      'position:absolute','bottom:0','left:0','right:0',
      'background:rgba(31,78,61,0.96)','color:#fff',
      'padding:10px 16px','font-family:Arial,sans-serif',
      'font-size:var(--fs-body)','display:flex','align-items:center','gap:12px',
      'z-index:10'
    ].join(';');
    bar.innerHTML = `
      <span id="submit-progress-msg" style="flex:1"></span>
      <div style="width:120px;height:4px;background:rgba(255,255,255,0.25);border-radius:2px;flex-shrink:0">
        <div id="submit-progress-bar" style="height:100%;background:#7ec8a0;border-radius:2px;transition:width 0.4s ease;width:0%"></div>
      </div>`;
    // Insert into modal
    const modal = document.querySelector('.modal');
    if (modal) { modal.style.position = 'relative'; modal.appendChild(bar); }
  }
  document.getElementById('submit-progress-msg').textContent = message;
  document.getElementById('submit-progress-bar').style.width = pct + '%';
}

function hideSubmitProgress() {
  const bar = document.getElementById('submit-progress');
  if (bar) {
    bar.style.transition = 'opacity 0.3s';
    bar.style.opacity = '0';
    setTimeout(() => bar.remove(), 350);
  }
}

// =============================================================
// TOAST NOTIFICATION
// showToast(msg) displays a brief overlay message at the bottom
// of the screen. Auto-hides after 2.4 seconds.
// =============================================================
// ── Toast ─────────────────────────────────────────────────────
function showToast(msg, duration) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration || 2400);
}

