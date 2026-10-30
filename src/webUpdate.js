// ブラウザ版・ホーム画面アプリ（PWA）で、新しい版を公開したらすぐ切り替わるようにする（2026-10-31）
// ホーム画面のアプリは裏に置いたまま開き直すので、ページが読み直されず古い版のまま残る。
// そこで画面に戻ってきた時（と数分おき）に、今のページの HTML を取り直して、読み込んでいるプログラムの名前が
// 変わっていたら新しい版が出たとみなす。
// - auto: true … 操作の途中（画面の中の窓が開いている）でなければ、そのまま読み直す
// - auto: false … 下に「新しい版があります」の帯を出し、押した時だけ読み直す（入力の途中を消さないため）
// APK（アプリ内）は別の仕組み（updateCheck.js）なので、ここでは何もしない

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const SCRIPT_RE = /<script[^>]+type="module"[^>]+src="([^"]+)"/;

function currentScript() {
  const el = document.querySelector('script[type="module"][src]');
  return el ? el.getAttribute('src') : '';
}

async function latestScript() {
  const res = await fetch(location.pathname, { cache: 'no-store' });
  if (!res.ok) return '';
  const m = (await res.text()).match(SCRIPT_RE);
  return m ? m[1] : '';
}

const busy = () => !!document.querySelector('.app-dialog-backdrop');

function showBar() {
  if (document.getElementById('web-update-bar')) return;
  const bar = document.createElement('button');
  bar.id = 'web-update-bar';
  bar.type = 'button';
  bar.textContent = '新しい版があります。押すと更新します';
  bar.style.cssText = 'position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom));transform:translateX(-50%);'
    + 'z-index:99999;padding:12px 18px;border-radius:999px;border:1px solid #c9a646;background:#1b1b1b;color:#e9cf7a;'
    + 'font-size:14px;box-shadow:0 4px 16px rgba(0,0,0,.5);max-width:calc(100% - 32px);';
  bar.addEventListener('click', () => location.reload());
  document.body.appendChild(bar);
}

export function watchWebUpdate({ auto = false } = {}) {
  if (window.Capacitor?.isNativePlatform?.()) return;
  const mine = currentScript();
  if (!mine) return; // 組み立てる前（開発中）は調べない
  let checking = false;
  let found = false;
  const check = async () => {
    if (checking || document.visibilityState !== 'visible') return;
    checking = true;
    try {
      if (!found) {
        const latest = await latestScript();
        found = !!latest && latest !== mine;
      }
      if (found) {
        if (auto && !busy()) location.reload();
        else showBar();
      }
    } catch { /* 電波が無い時などは次の機会に */ }
    checking = false;
  };
  document.addEventListener('visibilitychange', check);
  window.addEventListener('pageshow', (e) => { if (e.persisted) check(); });
  setInterval(check, CHECK_INTERVAL_MS);
}
