// NeoNeoEast 设置页：黑名单 / 复习节奏 / 导出导入 / 数据概览

const SETTINGS_KEY = 'nneo_settings';
const WORDS_KEY = 'nneo_words';
const STATS_KEY = 'nneo_stats';

const DEFAULT_SETTINGS = {
  enabled: true,
  targetLang: 'en',
  levels: {
    gaokao: true, cet4: true, cet6: false,
    toefl: false, ielts: false, gre: false, kaoyan: false,
    jlpt_n5: true, jlpt_n4: true, jlpt_n3: false, jlpt_n2: false, jlpt_n1: false
  },
  maxPerWord: 3,
  maxPerScreen: 4,
  maxTotal: 500,
  blacklist: [],
  reviewDailyCap: 20,
  reviewBatchSize: 5
};

let gSettings = { ...DEFAULT_SETTINGS };

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  renderBlacklist();
  renderReviewInputs();
  renderOverview();
  renderCoverage();

  document.getElementById('bl-add-btn').addEventListener('click', addBlacklist);
  document.getElementById('bl-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addBlacklist(); });
  document.getElementById('save-review').addEventListener('click', saveReview);

  document.getElementById('exp-all').addEventListener('click', () => exportCsv('all'));
  document.getElementById('exp-mastered').addEventListener('click', () => exportCsv('mastered'));
  document.getElementById('exp-learning').addEventListener('click', () => exportCsv('learning'));
  document.getElementById('exp-review').addEventListener('click', () => exportCsv('review'));
  document.getElementById('exp-backup').addEventListener('click', exportBackup);
  document.getElementById('imp-file').addEventListener('change', importBackup);
});

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get([SETTINGS_KEY], (data) => {
      const s = data[SETTINGS_KEY] || {};
      gSettings = { ...DEFAULT_SETTINGS, ...s,
        levels: { ...DEFAULT_SETTINGS.levels, ...(s.levels || {}) },
        blacklist: Array.isArray(s.blacklist) ? s.blacklist : [] };
      resolve();
    });
  });
}

function persistSettings() {
  return new Promise((resolve) => chrome.storage.local.set({ [SETTINGS_KEY]: gSettings }, resolve));
}

// ---------- 黑名单 ----------
function renderBlacklist() {
  const ul = document.getElementById('bl-list');
  ul.innerHTML = '';
  if (gSettings.blacklist.length === 0) {
    const li = document.createElement('li');
    li.textContent = '暂无黑名单网站';
    li.style.opacity = '0.5';
    ul.appendChild(li);
    return;
  }
  gSettings.blacklist.forEach((d, i) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = d;
    const btn = document.createElement('button');
    btn.textContent = '删除';
    btn.addEventListener('click', async () => {
      gSettings.blacklist.splice(i, 1);
      await persistSettings();
      renderBlacklist();
    });
    li.appendChild(span);
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

async function addBlacklist() {
  const input = document.getElementById('bl-input');
  let d = (input.value || '').trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!d) return;
  if (!gSettings.blacklist.includes(d)) gSettings.blacklist.push(d);
  input.value = '';
  await persistSettings();
  renderBlacklist();
}

// ---------- 复习节奏 ----------
function renderReviewInputs() {
  document.getElementById('cap-input').value = gSettings.reviewDailyCap;
  document.getElementById('batch-input').value = gSettings.reviewBatchSize;
}

async function saveReview() {
  const cap = parseInt(document.getElementById('cap-input').value, 10);
  const batch = parseInt(document.getElementById('batch-input').value, 10);
  if (!isNaN(cap)) gSettings.reviewDailyCap = Math.max(5, Math.min(200, cap));
  if (!isNaN(batch)) gSettings.reviewBatchSize = Math.max(1, Math.min(50, batch));
  await persistSettings();
  renderReviewInputs();
  const tip = document.getElementById('save-tip');
  tip.textContent = '已保存 ✓';
  setTimeout(() => (tip.textContent = ''), 2000);
}

// ---------- 导出 CSV ----------
function statusOf(w, now) {
  if (w.status === 'mastered') return 'mastered';
  if (now >= (w.nextReview || 0)) return 'review';
  return 'learning';
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportCsv(kind) {
  chrome.storage.local.get([WORDS_KEY], (data) => {
    const words = data[WORDS_KEY] || {};
    const now = Date.now();
    const zhStatus = { mastered: '已掌握', learning: '在学', review: '待复习' };
    const rows = [['中文', '英文', '音标', '中文释义', '例句(英)', '例句(中)', '层级', '状态', '复习进度', '下次复习']];
    Object.values(words).forEach((w) => {
      if (!w || typeof w !== 'object') return;
      const st = statusOf(w, now);
      if (kind !== 'all' && kind !== st) return;
      const next = (w.nextReview && w.nextReview < Number.MAX_SAFE_INTEGER)
        ? new Date(w.nextReview).toLocaleDateString() : '—';
      rows.push([
        w.word, w.english, w.phonetic, w.meaning_zh,
        w.example_en, w.example_zh, w.level,
        zhStatus[st] || st, `${w.stage || 0}/4`, next
      ]);
    });
    const csv = '﻿' + rows.map(r => r.map(csvEscape).join(',')).join('\n');
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(csv, `neoneoeast-${kind}-${stamp}.csv`, 'text/csv;charset=utf-8');
    tipIO(`已导出 ${rows.length - 1} 个词`);
  });
}

// ---------- 完整备份 / 导入 ----------
function exportBackup() {
  chrome.storage.local.get([WORDS_KEY, STATS_KEY, SETTINGS_KEY], (data) => {
    const backup = {
      _app: 'NeoNeoEast',
      _version: 2,
      _exportedAt: new Date().toISOString(),
      words: data[WORDS_KEY] || {},
      stats: data[STATS_KEY] || {},
      settings: data[SETTINGS_KEY] || {}
    };
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(JSON.stringify(backup, null, 2), `neoneoeast-backup-${stamp}.json`, 'application/json');
    tipIO('备份已导出，妥善保存这个文件');
  });
}

function importBackup(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const b = JSON.parse(reader.result);
      if (b._app !== 'NeoNeoEast' || !b.words) {
        tipIO('文件格式不对，请选择本插件导出的备份文件', true);
        return;
      }
      const toSet = {};
      if (b.words) toSet[WORDS_KEY] = b.words;
      if (b.stats) toSet[STATS_KEY] = b.stats;
      if (b.settings) toSet[SETTINGS_KEY] = b.settings;
      chrome.storage.local.set(toSet, async () => {
        await loadSettings();
        renderBlacklist();
        renderReviewInputs();
        renderOverview();
        tipIO('导入成功，学习记录已恢复 ✓');
      });
    } catch (err) {
      tipIO('读取失败：' + err.message, true);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function tipIO(msg, isErr) {
  const el = document.getElementById('io-tip');
  el.textContent = msg;
  el.style.color = isErr ? '#f97373' : '#22c55e';
  setTimeout(() => (el.textContent = ''), 4000);
}

// ---------- 概览 ----------
function renderOverview() {
  chrome.storage.local.get([WORDS_KEY], (data) => {
    const words = data[WORDS_KEY] || {};
    const now = Date.now();
    let mastered = 0, learning = 0, review = 0;
    Object.values(words).forEach((w) => {
      if (!w || typeof w !== 'object') return;
      const st = statusOf(w, now);
      if (st === 'mastered') mastered++;
      else if (st === 'review') review++;
      else learning++;
    });
    const total = mastered + learning + review;
    document.getElementById('overview').innerHTML =
      `累计交互过 <b>${total}</b> 个词：已掌握 <b>${mastered}</b>、在学 <b>${learning}</b>、待复习 <b>${review}</b>。`;
  });
}

// ---------- 词库例句覆盖率 ----------
async function renderCoverage() {
  const container = document.getElementById('coverage');
  if (!container) return;

  const EN_LEVELS = ['gaokao', 'cet4', 'cet6', 'kaoyan', 'toefl', 'ielts', 'gre'];
  const JA_LEVELS = ['jlpt_n5', 'jlpt_n4', 'jlpt_n3', 'jlpt_n2', 'jlpt_n1'];
  const LEVEL_NAMES = {
    gaokao: '高考', cet4: '四级', cet6: '六级',
    toefl: '托福', ielts: '雅思', gre: 'GRE', kaoyan: '考研',
    jlpt_n5: 'N5', jlpt_n4: 'N4', jlpt_n3: 'N3', jlpt_n2: 'N2', jlpt_n1: 'N1'
  };

  try {
    const [enRes, jaRes] = await Promise.all([
      fetch(chrome.runtime.getURL('data/dict-en.json')),
      fetch(chrome.runtime.getURL('data/dict-ja.json'))
    ]);
    const enDict = await enRes.json();
    const jaDict = await jaRes.json();

    const badges = [];

    // 英语词库：统计 example_en 覆盖率
    const enByLevel = {};
    Object.values(enDict).forEach(w => {
      if (!enByLevel[w.level]) enByLevel[w.level] = { total: 0, withEx: 0 };
      enByLevel[w.level].total++;
      if (w.example_en) enByLevel[w.level].withEx++;
    });
    EN_LEVELS.forEach(lv => {
      const d = enByLevel[lv];
      if (!d) return;
      const pct = d.total ? Math.round(d.withEx / d.total * 100) : 0;
      badges.push({ name: LEVEL_NAMES[lv], total: d.total, withEx: d.withEx, pct, lang: 'en' });
    });

    // 日语词库：统计 example_ja 和 example_zh 覆盖率
    const jaByLevel = {};
    Object.values(jaDict).forEach(w => {
      if (!jaByLevel[w.level]) jaByLevel[w.level] = { total: 0, withEx: 0, withZh: 0 };
      jaByLevel[w.level].total++;
      if (w.example_ja) jaByLevel[w.level].withEx++;
      if (w.example_zh) jaByLevel[w.level].withZh++;
    });
    JA_LEVELS.forEach(lv => {
      const d = jaByLevel[lv];
      if (!d) return;
      const pct = d.total ? Math.round(d.withEx / d.total * 100) : 0;
      const pctZh = d.total ? Math.round(d.withZh / d.total * 100) : 0;
      badges.push({ name: LEVEL_NAMES[lv], total: d.total, withEx: d.withEx, pct, pctZh, withZh: d.withZh, lang: 'ja' });
    });

    container.innerHTML = badges.map(r => {
      const color = r.pct >= 90 ? '#22c55e' : (r.pct >= 30 ? '#f59e0b' : '#ef4444');
      const label = r.lang === 'en'
        ? `英语例句 ${r.pct}%`
        : `日语例句 ${r.pct}% · 中译 ${r.pctZh}%`;
      return `<div style="display:flex;align-items:center;gap:8px;margin:6px 0;padding:6px 10px;background:#F0F0F0;border:1px solid #E8E8E8;border-radius:6px;">
        <span style="min-width:40px;font-weight:600;color:#1A1A1A;">${r.name}</span>
        <span style="min-width:70px;color:#666666;font-size:13px;">${r.withEx}/${r.total}</span>
        <span style="flex:1;color:${color};font-size:13px;">${label}</span>
      </div>`;
    }).join('');

    const lowCoverage = badges.filter(r => r.pct < 90);
    if (lowCoverage.length > 0) {
      const note = document.createElement('p');
      note.className = 'opt-hint';
      note.style.marginTop = '8px';
      note.textContent = '黄色/红色标记的词库例句覆盖率较低，后续版本会持续补充。';
      container.appendChild(note);
    }
  } catch (e) {
    container.innerHTML = '<p class="opt-hint">词库覆盖率加载失败</p>';
  }
}
