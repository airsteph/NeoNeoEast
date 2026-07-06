// NeoNeoEast 背景脚本 v3：学习状态机 + 间隔复习 + 图标小红点(MV3 service worker)
//
// 词的一生只有两种最终状态：learning(在学) / mastered(已掌握)
//  - 初见点「认识了」  -> 直接 mastered，永不再考、永不再替换
//  - 初见点「还不会」  -> learning，进入复习阶梯(第 1/3/7/14 天)
//  - 复习卡点「记得」  -> 阶梯 +1 格，连续走完 4 格 -> mastered 毕业
//  - 复习卡点「忘了」  -> 阶梯打回第 1 格重来
//
// 减负阀门：每天复习有上限(reviewDailyCap)，过期不惩罚只顺延，优先推最久没复习的。
// 图标小红点显示「今天还可以/需要复习几个」，点开插件即可复习。

const STORAGE_WORDS_KEY = 'nneo_words';
const STORAGE_STATS_KEY = 'nneo_stats';
const STORAGE_SETTINGS_KEY = 'nneo_settings';

const DAY = 24 * 3600 * 1000;
// 复习阶梯：第 1 天 -> 第 3 天 -> 第 7 天 -> 第 14 天，连续 4 次「记得」毕业
const STAGES_DAYS = [1, 3, 7, 14];
const GRADUATE_STAGE = STAGES_DAYS.length; // 走到第 4 格即毕业

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
  reviewDailyCap: 20,   // 每天最多复习多少个（减负核心阀门）
  reviewBatchSize: 5    // 每批推送多少个
};

// 用本地时区算“今天”，修掉旧版用 UTC 记错日期的 bug
function localDateKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function readAll() {
  const data = await chrome.storage.local.get([STORAGE_WORDS_KEY, STORAGE_STATS_KEY, STORAGE_SETTINGS_KEY]);
  const words = data[STORAGE_WORDS_KEY] || {};
  const stats = data[STORAGE_STATS_KEY] || { daily: {}, reviewDone: {} };
  if (!stats.daily) stats.daily = {};
  if (!stats.reviewDone) stats.reviewDone = {};
  const settings = { ...DEFAULT_SETTINGS, ...(data[STORAGE_SETTINGS_KEY] || {}),
    levels: { ...DEFAULT_SETTINGS.levels, ...((data[STORAGE_SETTINGS_KEY] || {}).levels || {}) } };
  return { words, stats, settings };
}

function ensureDaily(stats, dateKey) {
  stats.daily[dateKey] = stats.daily[dateKey] || { learned: 0, reviewed: 0, failed: 0 };
  return stats.daily[dateKey];
}

// ---------- 阅读页里的初见交互：认识 / 还不会 ----------
async function handleWordAction(payload) {
  const { word, action } = payload;
  if (!word || !action) return;
  const now = typeof payload.ts === 'number' ? payload.ts : Date.now();
  const today = localDateKey(now);

  const { words, stats, settings } = await readAll();
  const day = ensureDaily(stats, today);

  let w = words[word];
  if (!w) {
    w = words[word] = {
      word,
      english: payload.english || '',
      phonetic: payload.phonetic || '',
      pos: payload.pos || '',
      meaning_zh: payload.meaning_zh || '',
      example_zh: payload.example_zh || '',
      example_en: payload.example_en || '',
      example_ja: payload.example_ja || '',
      level: payload.level || '',
      status: 'learning',
      stage: 0,
      firstSeen: now,
      lastReview: now,
      nextReview: now,
      history: []
    };
  }
  w.lastReview = now;
  w.history.push({ ts: now, action });

  if (action === 'known') {
    // 初见就认识 = 直接毕业
    w.status = 'mastered';
    w.stage = GRADUATE_STAGE;
    w.nextReview = Number.MAX_SAFE_INTEGER;
    day.learned += 1;
  } else if (action === 'unknown') {
    // 初见不认识 = 进复习阶梯第一格（若已经在学则不重置进度）
    if (w.status !== 'mastered') {
      if (w.history.length <= 1) day.learned += 1; // 只有第一次纳入才算“今天学了一个新词”
      w.status = 'learning';
      w.nextReview = now; // 当天即可进入复习队列，不再等到第二天
    }
  }

  await chrome.storage.local.set({ [STORAGE_WORDS_KEY]: words, [STORAGE_STATS_KEY]: stats });
  await updateBadge();
  return { ok: true };
}

// ---------- 复习卡里的交互：记得 / 忘了 ----------
async function handleReviewAction(payload) {
  const { word, action } = payload;
  if (!word || !action) return { ok: false };
  const now = typeof payload.ts === 'number' ? payload.ts : Date.now();
  const today = localDateKey(now);

  const { words, stats } = await readAll();
  const w = words[word];
  if (!w) return { ok: false };

  const day = ensureDaily(stats, today);
  w.lastReview = now;
  w.history.push({ ts: now, action });

  if (action === 'remember') {
    w.stage = (w.stage || 0) + 1;
    day.reviewed += 1;
    if (w.stage >= GRADUATE_STAGE) {
      w.status = 'mastered';
      w.nextReview = Number.MAX_SAFE_INTEGER;
    } else {
      w.nextReview = now + STAGES_DAYS[w.stage] * DAY;
    }
  } else if (action === 'forget') {
    // 忘了 -> 阶梯重置，回到第一格
    w.stage = 0;
    w.status = 'learning';
    w.nextReview = now + STAGES_DAYS[0] * DAY;
    day.failed += 1;
  }

  // 记录今天已完成的复习次数（用于每日上限）
  stats.reviewDone[today] = (stats.reviewDone[today] || 0) + 1;

  await chrome.storage.local.set({ [STORAGE_WORDS_KEY]: words, [STORAGE_STATS_KEY]: stats });
  await updateBadge();
  return { ok: true };
}

// ---------- 计数（给 popup 面板） ----------
async function getStats() {
  const now = Date.now();
  const { words, stats } = await readAll();

  let mastered = 0, learning = 0, toReview = 0;
  Object.values(words).forEach((w) => {
    if (!w || typeof w !== 'object') return;
    if (w.status === 'mastered') { mastered++; return; }
    // 在学的词：到期了算“待复习”，没到期算“在学”
    if (now >= (w.nextReview || 0)) toReview++;
    else learning++;
  });

  return { ok: true, mastered, learning, toReview, daily: stats.daily || {} };
}

// ---------- 复习批次：到期的词，按最久没复习优先，受每日上限限制 ----------
async function getReviewBatch() {
  const now = Date.now();
  const { words, stats, settings } = await readAll();
  const today = localDateKey(now);
  const doneToday = stats.reviewDone[today] || 0;
  const remainingToday = Math.max(0, settings.reviewDailyCap - doneToday);
  if (remainingToday <= 0) {
    return { ok: true, batch: [], reason: 'daily_cap_reached', dailyCap: settings.reviewDailyCap };
  }

  const due = Object.values(words)
    .filter(w => w && w.status === 'learning' && now >= (w.nextReview || 0))
    .sort((a, b) => {
      // 优先推送有例句的词，其次按到期时间排序
      const ae = (a.example_en || a.example_ja) ? 1 : 0;
      const be = (b.example_en || b.example_ja) ? 1 : 0;
      if (ae !== be) return be - ae;
      return (a.nextReview || 0) - (b.nextReview || 0);
    });

  const limit = Math.min(settings.reviewBatchSize, remainingToday);
  const batch = due.slice(0, limit).map(w => {
    return {
      word: w.word,
      english: w.english,
      phonetic: w.phonetic,
      pos: w.pos,
      meaning_zh: w.meaning_zh,
      example_zh: w.example_zh,
      example_en: w.example_en || '',
      example_ja: w.example_ja,
      level: w.level,
      stage: w.stage || 0
    };
  });

  return { ok: true, batch, dueTotal: due.length, remainingToday, dailyCap: settings.reviewDailyCap };
}

// ---------- 图标小红点：今天还可以复习几个 ----------
async function updateBadge() {
  try {
    const now = Date.now();
    const { words, stats, settings } = await readAll();
    const today = localDateKey(now);
    const doneToday = stats.reviewDone[today] || 0;
    const remainingToday = Math.max(0, settings.reviewDailyCap - doneToday);

    let due = 0;
    Object.values(words).forEach((w) => {
      if (w && w.status === 'learning' && now >= (w.nextReview || 0)) due++;
    });

    const show = Math.min(due, remainingToday);
    await chrome.action.setBadgeText({ text: show > 0 ? String(show) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
  } catch (e) {
    console.warn('[NeoNeoEast] updateBadge failed', e);
  }
}

// ---------- 消息路由 ----------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;
  if (message.type === 'WORD_ACTION') {
    handleWordAction(message.payload || {}).then(sendResponse).catch(err => {
      console.error('WORD_ACTION error', err);
      sendResponse({ ok: false, error: String(err) });
    });
    return true;
  }
  if (message.type === 'REVIEW_ACTION') {
    handleReviewAction(message.payload || {}).then(sendResponse).catch(err => {
      console.error('REVIEW_ACTION error', err);
      sendResponse({ ok: false, error: String(err) });
    });
    return true;
  }
  if (message.type === 'GET_STATS') {
    getStats().then(sendResponse).catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (message.type === 'GET_REVIEW_BATCH') {
    getReviewBatch().then(sendResponse).catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});

// 定时刷新小红点（每 30 分钟），以及安装/启动时刷新
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('nneo-badge', { periodInMinutes: 30 });
  updateBadge();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('nneo-badge', { periodInMinutes: 30 });
  updateBadge();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'nneo-badge') updateBadge();
});
