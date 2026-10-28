/* Windows app download. One switch: /download.json → "enabled".
   Off: every "Windows app" button shows a "coming soon" note.
   On: the buttons download the exe straight from this site (no GitHub page). */
(() => {
  let info = { enabled: false };
  const ready = fetch('/download.json', { cache: 'no-store' }).then((r) => r.json()).then((d) => { info = d || info; relabel(); }).catch(() => {});

  function relabel() {
    if (!info.enabled) return;
    document.querySelectorAll('a[href="#download"]').forEach((a) => {
      if (a.classList.contains('btn')) a.textContent = `Download for Windows (v${info.version})`;
      else if (!a.classList.contains('more')) a.textContent = 'Windows app';
    });
  }

  function download() {
    const a = document.createElement('a');
    a.href = info.file;
    a.download = `LightKeeper-${info.version}.exe`;
    document.body.append(a); a.click(); a.remove();
  }

  function soon() {
    if (document.getElementById('soon')) return;
    const o = document.createElement('div');
    o.id = 'soon';
    o.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999';
    o.innerHTML = '<div style="background:#141f2b;border:1px solid #2b3a4c;border-radius:12px;padding:20px 24px;max-width:360px;color:#e6edf5;font:14px Inter,system-ui,sans-serif;text-align:center"><h3 style="margin:0 0 8px">Windows app coming soon</h3><p style="margin:0 0 14px;color:#a9b7c6">The desktop download is not available yet. The web edition here has the map, aids, places, tides and weather.</p><button style="background:#4f9dff;color:#fff;border:0;border-radius:8px;padding:8px 18px;font:inherit;cursor:pointer">OK</button></div>';
    o.addEventListener('click', (ev) => { if (ev.target === o || ev.target.tagName === 'BUTTON') o.remove(); });
    document.body.append(o);
  }

  window.lkDownload = async () => { await ready; if (info.enabled) download(); else soon(); };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('a[href="#download"]')) return;
    e.preventDefault();
    window.lkDownload();
  });
})();
