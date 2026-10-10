// nonortc popup logic
const globalToggle = document.getElementById('globalToggle');
const siteToggle = document.getElementById('siteToggle');
const siteHost = document.getElementById('siteHost');
const statusBadge = document.getElementById('statusBadge');
const openOptions = document.getElementById('openOptions');

let currentHost = null;
let settings = {};

// 站点对「时区 / 语言 / 地理定位」的有效防护状态（三态）：
//   显式 true  -> 仅本站强制开启
//   显式 false -> 仅本站放行
//   未设置     -> 跟随全局默认
// 注意：WebRTC / DNS / 真实IP 由全局开关独占控制，不参与此处判定。
function effectiveSiteProtected(s) {
  if (!currentHost) return false;
  const map = (s && s.siteSettings) || {};
  const v = map[currentHost];
  if (v === true) return true;
  if (v === false) return false;
  return !!s.globalEnabled;
}

function refreshBadge() {
  const siteOn = effectiveSiteProtected(settings);
  const globalOn = !!settings.globalEnabled;
  if (siteOn) {
    statusBadge.textContent = globalOn ? '已防护' : '仅本站防护';
    statusBadge.className = 'badge on';
  } else {
    statusBadge.textContent = globalOn ? '本站已放行' : '未启用';
    statusBadge.className = 'badge off';
  }
}

function syncUI() {
  globalToggle.checked = !!settings.globalEnabled;
  siteToggle.checked = effectiveSiteProtected(settings);
  // 站点开关不再受全局开关限制，仅当无法识别当前站点时禁用。
  siteToggle.disabled = !currentHost;
  refreshBadge();
}

async function loadSettings() {
  settings = await chrome.storage.local.get(['globalEnabled', 'siteSettings']);
  settings.siteSettings = settings.siteSettings || {};
  syncUI();
}

globalToggle.addEventListener('change', async () => {
  await chrome.storage.local.set({ globalEnabled: globalToggle.checked });
  await loadSettings();
});

siteToggle.addEventListener('change', async () => {
  if (!currentHost) return;
  const map = Object.assign({}, settings.siteSettings || {});
  const desired = siteToggle.checked;
  if (desired === !!settings.globalEnabled) {
    delete map[currentHost];        // 与全局默认一致 -> 移除例外
  } else {
    map[currentHost] = desired;     // true=仅本站强制开启；false=仅本站放行
  }
  await chrome.storage.local.set({ siteSettings: map });
  await loadSettings();
});

openOptions.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// 获取当前标签页 host
(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      try { currentHost = new URL(tab.url).hostname; } catch (e) { currentHost = null; }
    }
  } catch (e) {}
  if (!currentHost) {
    siteHost.textContent = '（无法识别当前站点）';
    siteToggle.disabled = true;
  } else {
    siteHost.textContent = currentHost;
  }
  await loadSettings();
})();
