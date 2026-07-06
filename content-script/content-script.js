// NeoNeoEast 内容脚本 v2：中文分词(Intl.Segmenter) + 分层词库 + 已学去重
// 逻辑：抽取正文文本节点 -> 用浏览器内置分词切成词 -> 命中词典且符合当前层级且未掌握 -> 替换成英文并挂 hover 卡片

// 不同目标语言用不同词库文件（同一时间只学一种语言)
const DICT_URL_BY_LANG = {
  en: chrome.runtime.getURL('data/dict-en.json'),
  ja: chrome.runtime.getURL('data/dict-ja.json')
};

// 默认设置（popup 会写入 storage 覆盖）
const DEFAULT_SETTINGS = {
  enabled: true,
  targetLang: 'en',    // 目标语言：'en'=英语 / 'ja'=日语。同一时间只能有一种
  levels: {            // 英/日各自的层级开关同存于此，按当前 targetLang 生效
    gaokao: true, cet4: true, cet6: false,
    toefl: false, ielts: false, gre: false, kaoyan: false,
    jlpt_n5: true, jlpt_n4: true, jlpt_n3: false, jlpt_n2: false, jlpt_n1: false
  },
  maxPerWord: 3,        // 每个词整页最多替换几次
  maxPerScreen: 4,      // 出词密度:约等于“每一屏正文里出现几个词”,数字越大越密(换算成词间隔生效)
  maxTotal: 500,        // 整页总上限(安全阀)
  blacklist: []         // 黑名单域名，命中则整页不替换
};

// 判断当前网页域名是否在黑名单里（支持精确域名与子域名）
function isBlacklisted(list) {
  if (!Array.isArray(list) || list.length === 0) return false;
  const host = (location.hostname || '').toLowerCase();
  return list.some((raw) => {
    const d = String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!d) return false;
    return host === d || host.endsWith('.' + d);
  });
}

// 级别中文名（英语 + 日语）
const LEVEL_NAMES = {
  gaokao: '高考', cet4: '四级', cet6: '六级',
  toefl: '托福', ielts: '雅思', gre: 'GRE', kaoyan: '考研',
  jlpt_n5: 'N5', jlpt_n4: 'N4', jlpt_n3: 'N3', jlpt_n2: 'N2', jlpt_n1: 'N1'
};

let gDict = {};
let gSettings = DEFAULT_SETTINGS;
let gKnownWords = {};     // 已掌握的词 { 中文词: true }
let gSegmenter = null;
let tooltipEl = null;
let tooltipHideTimer = null;

const wordReplaceCount = {}; // 每个词整页替换次数
// 间隔控制:自上一次替换以来,已经走过多少个"中文词"。初值给一个很大的数,
// 保证正文里遇到的第一个候选词就能立刻替换。
let wordsSinceLast = 1e9;
const processedNodes = new WeakSet(); // 已检查过的文本节点(避免滚动时重复分词)
let totalReplaced = 0;
let gRoot = null;             // 正文根节点,滚动时复用

(async function main() {
  console.log('[NeoNeoEast] content script v2 start');

  // 1) 读设置 + 已学词
  await loadSettingsAndKnown();
  if (!gSettings.enabled) {
    console.log('[NeoNeoEast] 已关闭，跳过');
    return;
  }
  if (isBlacklisted(gSettings.blacklist)) {
    console.log('[NeoNeoEast] 当前网站在黑名单，跳过', location.hostname);
    return;
  }

  // 2) 准备分词器（浏览器内置，无需下载）
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    gSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });
  } else {
    console.warn('[NeoNeoEast] 当前浏览器不支持 Intl.Segmenter，请升级 Chrome');
    return;
  }

  // 3) 加载词库
  try {
    gDict = await loadLocalDict();
  } catch (e) {
    console.error('[NeoNeoEast] 加载本地词典失败', e);
    return;
  }

  // 4) 等页面正文渲染（SPA 兼容）
  if (document.readyState === 'loading') {
    await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));
  }
  await new Promise(r => setTimeout(r, 500));

  const root =
    document.querySelector('main') ||
    document.querySelector('article') ||
    document.body;
  if (!root) return;

  gRoot = root;
  processTextNodes(root);
  console.log('[NeoNeoEast] 已替换词数:', totalReplaced);
  initHover(root);
  observeMutations(root);   // SPA/无限滚动新加载的内容,进入后按词间隔继续均匀补充替换
})();

async function loadSettingsAndKnown() {
  try {
    const data = await chrome.storage.local.get(['nneo_settings', 'nneo_words']);
    if (data.nneo_settings) {
      gSettings = { ...DEFAULT_SETTINGS, ...data.nneo_settings,
        levels: { ...DEFAULT_SETTINGS.levels, ...(data.nneo_settings.levels || {}) } };
    }
    const words = data.nneo_words || {};
    // 只要单词在 nneo_words 中存在（发生过任何交互：学会了/记录生词），就加入已知集合，不再替换
    for (const w of Object.keys(words)) {
      gKnownWords[w] = true;
    }
  } catch (e) {
    console.warn('[NeoNeoEast] 读取设置失败，用默认值', e);
  }
}

async function loadLocalDict() {
  const url = DICT_URL_BY_LANG[gSettings.targetLang] || DICT_URL_BY_LANG.en;
  const res = await fetch(url);
  if (!res.ok) throw new Error('dict fetch failed: ' + res.status);
  return await res.json();
}

// 判断一个词是否可用于替换：在词典里 + 层级开启 + 未掌握
function isReplaceable(word) {
  const info = gDict[word];
  if (!info) return false;
  if (!gSettings.levels[info.level]) return false;   // 层级未勾选
  if (gKnownWords[word]) return false;               // 已掌握，跳过
  return true;
}

function isInIgnoredTag(textNode) {
  let p = textNode.parentElement;
  while (p) {
    const tag = p.tagName.toLowerCase();
    if (['script','style','code','pre','textarea','input','button','select','a'].includes(tag)) return true;
    if (p.classList && (p.classList.contains('nneo-highlight-word') || p.classList.contains('nneo-tooltip'))) return true;
    p = p.parentElement;
  }
  return false;
}

function walkTextNodes(root, callback) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (!/[一-鿿]/.test(node.nodeValue)) return NodeFilter.FILTER_REJECT; // 无中文跳过
      if (isInIgnoredTag(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  nodes.forEach(callback); // 先收集再处理，避免边遍历边改 DOM
}

// 一“屏”正文大约含多少个中文词。用它把用户设的“每屏 N 个”换算成
// “每隔多少个词才替换一次”,从而彻底摆脱对页面布局(getBoundingClientRect)的依赖——
// 之前按视口高度算屏,遇到内层容器滚动/懒加载会全塌到第 0 屏,导致整页只出 4~5 个词。
const SCREEN_WORDS = 350;

// 由密度(每屏个数)换算出“两次替换之间至少间隔多少个中文词”。
// 密度越大 → 间隔越小 → 出词越密;反之越安静。
function currentMinGap() {
  const density = gSettings.maxPerScreen || DEFAULT_SETTINGS.maxPerScreen;
  return Math.max(1, Math.round(SCREEN_WORDS / density));
}

// 处理正文:遍历每个中文词,累计“自上次替换以来走过的词数”(wordsSinceLast)。
// 只有间隔攒够 minGap 个词、且该词可替换时才替换,替换后间隔清零重新数。
// 这样出词沿全文均匀铺开,不再扎堆在开头一屏,也不受滚动方式影响。
function processTextNodes(root) {
  const minGap = currentMinGap();
  walkTextNodes(root, (textNode) => {
    if (totalReplaced >= gSettings.maxTotal) return;
    if (processedNodes.has(textNode)) return;      // 这个节点已处理过,跳过
    processedNodes.add(textNode);

    const text = textNode.nodeValue;

    // 用分词器把整段文本切成词（按真实词边界切）
    let segments;
    try {
      segments = Array.from(gSegmenter.segment(text));
    } catch (e) {
      return;
    }

    let hasReplaced = false;
    const frag = document.createDocumentFragment();

    for (const seg of segments) {
      const word = seg.segment;
      // 只把“被分词器识别为完整词”的中文词计入间隔
      const isChineseWord = seg.isWordLike && /[一-鿿]/.test(word);
      if (isChineseWord) wordsSinceLast++;

      if (
        isChineseWord &&
        totalReplaced < gSettings.maxTotal &&
        wordsSinceLast >= minGap &&                      // 间隔攒够了才出词
        isReplaceable(word) &&
        (wordReplaceCount[word] || 0) < gSettings.maxPerWord
      ) {
        const info = gDict[word];
        const span = createHighlightSpan(word, info.english || word);
        frag.appendChild(span);
        wordReplaceCount[word] = (wordReplaceCount[word] || 0) + 1;
        totalReplaced++;
        wordsSinceLast = 0;                              // 重新开始数间隔
        hasReplaced = true;
      } else {
        frag.appendChild(document.createTextNode(word));
      }
    }

    if (hasReplaced) {
      textNode.parentNode.replaceChild(frag, textNode);
    }
  });
}

function createHighlightSpan(word, displayText) {
  const span = document.createElement('span');
  span.className = 'nneo-highlight-word';
  span.dataset.original = word;
  span.dataset.word = word;
  span.textContent = displayText;
  return span;
}

function initHover(root) {
  root.addEventListener('mouseover', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    if (!target.classList.contains('nneo-highlight-word')) return;
    const word = target.dataset.word;
    const info = word && gDict[word];
    if (!info) return;
    showTooltip(target, word, info);
  });
  root.addEventListener('mouseout', (e) => {
    const related = e.relatedTarget;
    if (tooltipEl && related instanceof Node && tooltipEl.contains(related)) return;
    if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
    tooltipHideTimer = setTimeout(hideTooltip, 200);
  });
}

function observeMutations(root) {
  const observer = new MutationObserver((mutations) => {
    if (totalReplaced >= gSettings.maxTotal) return;
    let need = false;
    for (const m of mutations) {
      if (m.type === 'childList' && m.addedNodes && m.addedNodes.length > 0) { need = true; break; }
    }
    if (!need) return;
    if (observeMutations._timer) clearTimeout(observeMutations._timer);
    observeMutations._timer = setTimeout(() => processTextNodes(root), 400);
  });
  observer.observe(root, { childList: true, subtree: true });
}

function showTooltip(target, word, info) {
  hideTooltip();
  tooltipEl = document.createElement('div');
  tooltipEl.className = 'nneo-tooltip';

  const levelName = LEVEL_NAMES[info.level] || '';
  const isJa = gSettings.targetLang === 'ja';

  // 词性标签(目前只有日语词库带 pos 字段)
  const posTag = info.pos ? `<span class="nneo-pos-tag">${info.pos}</span>` : '';

  // 例句:日语用 example_ja(母语例句) + example_zh(中文翻译),不再出现英语;
  //       英语沿用 example_en + example_zh。
  const exampleMain = isJa ? (info.example_ja || '') : (info.example_en || '');
  const exampleZh = info.example_zh || '';
  const exampleBlock = (exampleMain || exampleZh)
    ? `<div class="nneo-tooltip-example">${exampleMain ? exampleMain + '<br/>' : ''}${exampleZh ? '<span class="nneo-example-zh">' + exampleZh + '</span>' : ''}</div>`
    : '';

  tooltipEl.innerHTML = `
    <div class="nneo-tooltip-header">${info.english || ''} ${posTag}<span class="nneo-level-tag">${levelName}</span></div>
    <div class="nneo-tooltip-phonetic">${info.phonetic ? '/' + info.phonetic + '/' : ''}</div>
    <div class="nneo-tooltip-cn">${word}${info.meaning_zh && info.meaning_zh !== word ? ' · ' + info.meaning_zh : ''}</div>
    ${exampleBlock}
    <div class="nneo-tooltip-buttons">
      <button class="nneo-tooltip-button nneo-btn-known">
        <svg class="nneo-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 11.5l2 2 4-4"/>
          <path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9-4.03-9-9-9z"/>
        </svg>
        <span>无须学习</span>
      </button>
      <button class="nneo-tooltip-button nneo-btn-unknown">
        <svg class="nneo-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 4h12v16H4z"/>
          <path d="M16 8h4v8h-4z"/>
          <line x1="7" y1="9" x2="13" y2="9"/>
          <line x1="7" y1="12" x2="13" y2="12"/>
          <line x1="7" y1="15" x2="10" y2="15"/>
        </svg>
        <span>记录生词</span>
      </button>
    </div>
  `;

  document.body.appendChild(tooltipEl);

  tooltipEl.addEventListener('mouseenter', () => {
    if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
  });
  tooltipEl.addEventListener('mouseleave', hideTooltip);

  const rect = target.getBoundingClientRect();
  const tRect = tooltipEl.getBoundingClientRect();
  let top = rect.top - tRect.height - 8;
  if (top < 8) top = rect.bottom + 8;
  let left = rect.left;
  if (left + tRect.width > window.innerWidth - 8) left = window.innerWidth - tRect.width - 8;
  tooltipEl.style.top = `${top + window.scrollY}px`;
  tooltipEl.style.left = `${left + window.scrollX}px`;

  const payloadBase = {
    word, english: info.english, phonetic: info.phonetic,
    pos: info.pos, meaning_zh: info.meaning_zh, example_zh: info.example_zh,
    example_en: info.example_en, example_ja: info.example_ja,
    level: info.level, ts: Date.now()
  };

  const send = (action) => {
    chrome.runtime.sendMessage({ type: 'WORD_ACTION', payload: { ...payloadBase, action } });
    // 无论「学会了」还是「记录生词」，只要发生过交互，就标记为已知，本页及后续页面都不再替换
    gKnownWords[word] = true;
    // 两个按钮都立即把该词还原成中文
    revertWordOnPage(word);
    hideTooltip();
  };
  tooltipEl.querySelector('.nneo-btn-known').addEventListener('click', () => send('known'));
  tooltipEl.querySelector('.nneo-btn-unknown').addEventListener('click', () => send('unknown'));
}

// 用户点「认识了」，把当前页面所有该词的英文替换还原成中文
function revertWordOnPage(word) {
  document.querySelectorAll('.nneo-highlight-word').forEach((el) => {
    if (el.dataset.word === word) {
      el.replaceWith(document.createTextNode(el.dataset.original || word));
    }
  });
}

function hideTooltip() {
  if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
  if (tooltipEl && tooltipEl.parentNode) tooltipEl.parentNode.removeChild(tooltipEl);
  tooltipEl = null;
}
