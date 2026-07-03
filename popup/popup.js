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
  maxTotal: 500
};

const LEVEL_NAMES = {
  gaokao: '高考', cet4: '四级', cet6: '六级',
  toefl: '托福', ielts: '雅思', gre: 'GRE', kaoyan: '考研',
  jlpt_n5: 'N5', jlpt_n4: 'N4', jlpt_n3: 'N3', jlpt_n2: 'N2', jlpt_n1: 'N1'
};

// 英语层级 id 与日语层级 id
const EN_LEVELS = ['gaokao', 'cet4', 'cet6', 'kaoyan', 'toefl', 'ielts', 'gre'];
const JA_LEVELS = ['jlpt_n5', 'jlpt_n4', 'jlpt_n3', 'jlpt_n2', 'jlpt_n1'];

// 与 background 保持一致：用本地时区算日期 key
function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

document.addEventListener('DOMContentLoaded', () => {
  initSettings();
  initReview();
  const openOpt = document.getElementById('open-options');
  if (openOpt) openOpt.addEventListener('click', (e) => {
    e.preventDefault();
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  });
  chrome.runtime.sendMessage({ type: 'GET_STATS' }, (resp) => {
    if (!resp || !resp.ok) return;
    renderStats(resp);
  });
});

// ---------- 复习卡片 ----------
let gReviewQueue = [];
let gReviewIndex = 0;
let gReviewTotal = 0;

function initReview() {
  chrome.runtime.sendMessage({ type: 'GET_REVIEW_BATCH' }, (resp) => {
    const section = document.getElementById('review-section');
    const empty = document.getElementById('review-empty');
    if (!resp || !resp.ok || !resp.batch || resp.batch.length === 0) {
      section.style.display = 'none';
      empty.style.display = 'block';
      if (resp && resp.reason === 'daily_cap_reached') {
        empty.textContent = '今天的复习额度已用完，明天继续吧 👍';
      }
      return;
    }
    gReviewQueue = resp.batch;
    gReviewIndex = 0;
    gReviewTotal = resp.batch.length;
    section.style.display = 'block';
    empty.style.display = 'none';
    renderReviewCard();

    document.getElementById('btn-remember').addEventListener('click', () => answerReview('remember'));
    document.getElementById('btn-forget').addEventListener('click', () => answerReview('forget'));
  });
}

function renderReviewCard() {
  const card = document.getElementById('review-card');
  const progress = document.getElementById('review-progress');
  const item = gReviewQueue[gReviewIndex];
  if (!item) return;
  progress.textContent = `${gReviewIndex + 1}/${gReviewTotal}`;
  const levelName = LEVEL_NAMES[item.level] || '';
  const posTag = item.pos ? `<span class="rc-pos">${item.pos}</span>` : '';
  // 例句:日语词条优先用日语例句,英语词条用英语例句,不混入英语
  const exMain = item.example_ja || item.example_en || '';
  const meaningTail = item.meaning_zh && item.meaning_zh !== item.word ? ' · ' + item.meaning_zh : '';
  card.innerHTML = `
    <div class="rc-cn">${item.word}${meaningTail}</div>
    <div class="rc-en">${item.english || ''} ${posTag}<span class="rc-tag">${levelName}</span></div>
    <div class="rc-phonetic">${item.phonetic ? '/' + item.phonetic + '/' : ''}</div>
    ${exMain ? `<div class="rc-ex">${exMain}</div>` : ''}
    ${item.example_zh ? `<div class="rc-ex-zh">${item.example_zh}</div>` : ''}
  `;
}

function answerReview(action) {
  const item = gReviewQueue[gReviewIndex];
  if (!item) return;
  chrome.runtime.sendMessage({ type: 'REVIEW_ACTION', payload: { word: item.word, action, ts: Date.now() } });
  gReviewIndex++;
  if (gReviewIndex >= gReviewQueue.length) {
    document.getElementById('review-section').style.display = 'none';
    const empty = document.getElementById('review-empty');
    empty.style.display = 'block';
    empty.textContent = '这一批复习完了 🎉 稍后再来看看';
    chrome.runtime.sendMessage({ type: 'GET_STATS' }, (resp) => { if (resp && resp.ok) renderStats(resp); });
  } else {
    renderReviewCard();
  }
}

function initSettings() {
  const elEnabled = document.getElementById('toggle-enabled');
  const elDensity = document.getElementById('density');
  const elDensityNum = document.getElementById('density-num');
  const langEn = document.getElementById('lang-en');
  const langJa = document.getElementById('lang-ja');
  const groupEn = document.getElementById('levels-en');
  const groupJa = document.getElementById('levels-ja');

  // 所有层级复选框（英+日），id 形如 lv-gaokao / lv-jlpt_n5
  const allLevelIds = [...EN_LEVELS, ...JA_LEVELS];
  const levelEls = {};
  allLevelIds.forEach(id => { levelEls[id] = document.getElementById('lv-' + id); });

  // 根据目标语言显示对应层级组
  const applyLangUI = (lang) => {
    const isJa = lang === 'ja';
    groupEn.style.display = isJa ? 'none' : 'block';
    groupJa.style.display = isJa ? 'block' : 'none';
  };

  chrome.storage.local.get(['nneo_settings'], (data) => {
    const s = { ...DEFAULT_SETTINGS, ...(data.nneo_settings || {}),
      levels: { ...DEFAULT_SETTINGS.levels, ...((data.nneo_settings || {}).levels || {}) } };
    elEnabled.checked = !!s.enabled;
    const lang = s.targetLang === 'ja' ? 'ja' : 'en';
    langEn.checked = lang === 'en';
    langJa.checked = lang === 'ja';
    applyLangUI(lang);
    allLevelIds.forEach(id => { if (levelEls[id]) levelEls[id].checked = !!s.levels[id]; });
    elDensity.value = s.maxPerScreen || DEFAULT_SETTINGS.maxPerScreen;
    elDensityNum.textContent = elDensity.value;
  });

  const save = () => {
    // 先读现有设置，避免覆盖掉设置页里配置的黑名单/复习节奏
    chrome.storage.local.get(['nneo_settings'], (data) => {
      const prev = data.nneo_settings || {};
      const prevLevels = { ...DEFAULT_SETTINGS.levels, ...(prev.levels || {}) };
      const targetLang = langJa.checked ? 'ja' : 'en';
      const levels = { ...prevLevels };
      allLevelIds.forEach(id => { if (levelEls[id]) levels[id] = levelEls[id].checked; });
      const s = {
        ...DEFAULT_SETTINGS,
        ...prev,
        enabled: elEnabled.checked,
        targetLang,
        levels,
        maxPerScreen: parseInt(elDensity.value, 10) || DEFAULT_SETTINGS.maxPerScreen
      };
      chrome.storage.local.set({ nneo_settings: s });
    });
  };

  // 切换语言时同步显隐 + 保存
  langEn.addEventListener('change', () => { applyLangUI('en'); save(); });
  langJa.addEventListener('change', () => { applyLangUI('ja'); save(); });
  elEnabled.addEventListener('change', save);
  allLevelIds.forEach(id => { if (levelEls[id]) levelEls[id].addEventListener('change', save); });
  elDensity.addEventListener('input', () => { elDensityNum.textContent = elDensity.value; });
  elDensity.addEventListener('change', save);
}


function renderStats(data) {
  const { mastered, learning, toReview, daily } = data;
  document.getElementById('count-mastered').textContent = mastered ?? 0;
  document.getElementById('count-learning').textContent = learning ?? 0;
  document.getElementById('count-review').textContent = toReview ?? 0;

  render7DayTrend(daily || {});
}

function render7DayTrend(daily) {
  const container = document.getElementById('chart-bars');
  container.innerHTML = '';

  const days = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 3600 * 1000);
    const key = localDateKey(d); // 与 background 一致，用本地时区
    days.push(key);
  }

  let maxTotal = 1;
  days.forEach(day => {
    const v = daily[day] || { learned: 0, reviewed: 0, failed: 0 };
    const total = (v.learned || 0) + (v.reviewed || 0) + (v.failed || 0);
    if (total > maxTotal) maxTotal = total;
  });

  days.forEach(day => {
    const v = daily[day] || { learned: 0, reviewed: 0, failed: 0 };
    const total = (v.learned || 0) + (v.reviewed || 0) + (v.failed || 0);
    const scale = total / maxTotal;
    const maxHeight = 70;
    const totalHeight = maxHeight * scale;

    const learnedHeight = total ? (totalHeight * (v.learned || 0) / total) : 0;
    const reviewedHeight = total ? (totalHeight * (v.reviewed || 0) / total) : 0;
    const failedHeight = total ? (totalHeight * (v.failed || 0) / total) : 0;

    const dayEl = document.createElement('div');
    dayEl.className = 'chart-bar-day';

    const stack = document.createElement('div');
    stack.className = 'chart-bar-stack';

    if (failedHeight > 0) {
      const segFailed = document.createElement('div');
      segFailed.className = 'bar-seg bar-failed';
      segFailed.style.height = `${failedHeight}px`;
      stack.appendChild(segFailed);
    }
    if (reviewedHeight > 0) {
      const segReviewed = document.createElement('div');
      segReviewed.className = 'bar-seg bar-reviewed';
      segReviewed.style.height = `${reviewedHeight}px`;
      stack.appendChild(segReviewed);
    }
    if (learnedHeight > 0) {
      const segLearned = document.createElement('div');
      segLearned.className = 'bar-seg bar-learned';
      segLearned.style.height = `${learnedHeight}px`;
      stack.appendChild(segLearned);
    }

    const label = document.createElement('div');
    label.className = 'chart-day-label';
    label.textContent = day.slice(5); // MM-DD

    dayEl.appendChild(stack);
    dayEl.appendChild(label);
    container.appendChild(dayEl);
  });
}

