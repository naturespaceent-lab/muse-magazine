#!/usr/bin/env node

/**
 * MUSE Magazine RSS Crawler + Static Site Generator
 *
 * Crawls RSS feeds from K-pop/K-culture news sites,
 * extracts article data, fetches full article content,
 * and generates self-contained static HTML pages.
 *
 * Usage: node crawl.mjs
 * No dependencies needed — pure Node.js 18+ with built-in fetch.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// Configuration
// ============================================================

const SOURCES = [
  // === Tier 1: High-volume K-pop news ===
  { name: 'Soompi', url: 'https://www.soompi.com/feed', lang: 'en' },
  { name: 'Koreaboo', url: 'https://www.koreaboo.com/feed/', lang: 'en' },
  { name: 'HelloKpop', url: 'https://www.hellokpop.com/feed/', lang: 'en' },
  { name: 'Seoulbeats', url: 'https://seoulbeats.com/feed/', lang: 'en' },
  // === Tier 2: Commentary & Reviews ===
  { name: 'AsianJunkie', url: 'https://www.asianjunkie.com/feed/', lang: 'en' },
  { name: 'TheBiasList', url: 'https://thebiaslist.com/feed/', lang: 'en' },
  // === Tier 3: General entertainment w/ K-pop coverage ===
  { name: 'KDramaStars', url: 'https://www.kdramastars.com/rss.xml', lang: 'en' },
  { name: 'DramaNews', url: 'https://www.dramabeans.com/feed/', lang: 'en' },
  // === Tier 4: Japanese K-pop media ===
  { name: 'WowKoreaEnt', url: 'https://www.wowkorea.jp/rss/rss_ent.xml', lang: 'ja' },
  { name: 'WowKorea', url: 'https://www.wowkorea.jp/rss/rss_all.xml', lang: 'ja' },
  { name: 'Danmee', url: 'https://danmee.jp/feed/', lang: 'ja' },
  { name: 'KPOPMONSTER', url: 'https://kpopmonster.jp/feed/', lang: 'ja' },
];

const FETCH_TIMEOUT = 10_000;
const OG_IMAGE_TIMEOUT = 8_000;
const ARTICLE_FETCH_TIMEOUT = 12_000;
const MAX_OG_IMAGE_FETCHES = 40;
const OG_IMAGE_CONCURRENCY = 10;
const ARTICLE_FETCH_CONCURRENCY = 5;
const PLACEHOLDER_IMAGE = 'https://picsum.photos/seed/muse-placeholder/800/450';

const log = (msg) => console.log(`[MUSE Crawler] ${msg}`);
const warn = (msg) => console.warn(`[MUSE Crawler] WARN: ${msg}`);

// ============================================================
// Fetch with timeout
// ============================================================

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// XML Parsing helpers (regex-based, no dependencies)
// ============================================================

function extractTag(xml, tagName) {
  const cdataRe = new RegExp(`<${tagName}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tagName}>`, 'i');
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1].trim();

  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i');
  const match = xml.match(re);
  return match ? match[1].trim() : '';
}

function extractAllTags(xml, tagName) {
  const results = [];
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'gi');
  let match;
  while ((match = re.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

function extractAttribute(xml, tagName, attrName) {
  const re = new RegExp(`<${tagName}[^>]*?${attrName}\\s*=\\s*["']([^"']+)["']`, 'i');
  const match = xml.match(re);
  return match ? match[1] : '';
}

function extractItems(xml) {
  const items = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = re.exec(xml)) !== null) {
    items.push(match[1]);
  }
  return items;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8217;/g, "\u2019")
    .replace(/&#8216;/g, "\u2018")
    .replace(/&#8220;/g, "\u201C")
    .replace(/&#8221;/g, "\u201D")
    .replace(/&#8230;/g, "\u2026")
    .replace(/&#038;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, '').trim();
}

// ============================================================
// Image extraction
// ============================================================

function extractImageFromContent(content) {
  if (!content) return '';

  const mediaUrl = extractAttribute(content, 'media:content', 'url')
    || extractAttribute(content, 'media:thumbnail', 'url');
  if (mediaUrl) return mediaUrl;

  const enclosureUrl = extractAttribute(content, 'enclosure', 'url');
  if (enclosureUrl) {
    const enclosureType = extractAttribute(content, 'enclosure', 'type');
    if (!enclosureType || enclosureType.startsWith('image')) return enclosureUrl;
  }

  const imgMatch = content.match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i);
  if (imgMatch) return imgMatch[1];

  return '';
}

async function fetchOgImage(articleUrl) {
  try {
    const html = await fetchWithTimeout(articleUrl, OG_IMAGE_TIMEOUT);
    const ogMatch = html.match(/<meta[^>]+property\s*=\s*["']og:image["'][^>]+content\s*=\s*["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+property\s*=\s*["']og:image["']/i);
    if (ogMatch) return ogMatch[1];
    return '';
  } catch {
    return '';
  }
}

// ============================================================
// Date formatting
// ============================================================

function formatDate(dateStr) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}/${mm}/${dd} ${hh}:${min}`;
  } catch {
    return '';
  }
}

// ============================================================
// REWRITE ENGINE — "Same event, different perspective"
// Transforms ALL titles to MUSE editorial tone in Japanese
// ============================================================

// ---- Known K-pop group / artist names for extraction ----

const KNOWN_GROUPS = [
  'BTS', 'BLACKPINK', 'TWICE', 'EXO', 'NCT', 'aespa', 'Stray Kids', 'ENHYPEN',
  'TXT', 'ATEEZ', 'SEVENTEEN', 'Red Velvet', 'IVE', 'LE SSERAFIM', 'NewJeans',
  '(G)I-DLE', 'ITZY', 'NMIXX', 'Kep1er', 'TREASURE', 'MAMAMOO', 'SHINee',
  'GOT7', 'MONSTA X', 'iKON', 'WINNER', '2NE1', "Girls' Generation", 'Super Junior',
  'BIGBANG', 'LOONA', 'fromis_9', 'tripleS', 'Dreamcatcher', 'VIVIZ',
  'Brave Girls', 'OH MY GIRL', 'Apink', 'BTOB', 'PENTAGON', 'SF9', 'THE BOYZ',
  'Golden Child', 'ONEUS', 'VERIVERY', 'CIX', 'VICTON', 'AB6IX', 'WEi',
  'CRAVITY', 'P1Harmony', 'TEMPEST', 'YOUNITE', 'Xdinary Heroes', 'Billlie',
  'LIGHTSUM', 'Weki Meki', 'Cherry Bullet', 'Rocket Punch', 'Purple Kiss',
  'Lapillus', 'FIFTY FIFTY', 'KISS OF LIFE', 'BABYMONSTER', 'ILLIT',
  'ZEROBASEONE', 'RIIZE', 'TWS', 'BOYNEXTDOOR', 'xikers', 'NCT 127',
  'NCT DREAM', 'WayV', 'NCT WISH', 'SNSD', 'f(x)', 'EXO-CBX', 'Super M',
  'Girls Generation', 'DAY6', 'ASTRO', 'Kara', 'INFINITE', 'BEAST',
  'Highlight', 'Block B', 'B.A.P', 'VIXX', 'CNBLUE', 'FTIsland',
  'ZB1', 'G-IDLE',
];

const KNOWN_SOLOISTS = [
  'V', 'Jungkook', 'Jennie', 'Lisa', 'Rosé', 'Jisoo', 'Suga', 'RM', 'J-Hope',
  'Jin', 'Jimin', 'Winter', 'Karina', 'Giselle', 'NingNing', 'Taeyeon', 'IU',
  'Sunmi', 'HyunA', 'Hwasa', 'Solar', 'Joy', 'Irene', 'Yeri', 'Wendy', 'Seulgi',
  'Mark', 'Taeyong', 'Jaehyun', 'Doyoung', 'Haechan', 'Jeno', 'Jaemin', 'Renjun',
  'Chenle', 'Jisung', 'Bangchan', 'Hyunjin', 'Felix', 'Han', 'Lee Know', 'Changbin',
  'Seungmin', 'I.N', 'Heeseung', 'Jay', 'Jake', 'Sunghoon', 'Sunoo', 'Jungwon',
  'Ni-ki', 'Soobin', 'Yeonjun', 'Beomgyu', 'Taehyun', 'Hueningkai', 'Hongjoong',
  'Seonghwa', 'Yunho', 'Yeosang', 'San', 'Mingi', 'Wooyoung', 'Jongho',
  'S.Coups', 'Jeonghan', 'Joshua', 'Jun', 'Hoshi', 'Wonwoo', 'Woozi', 'DK',
  'Mingyu', 'The8', 'Seungkwan', 'Vernon', 'Dino', 'Wonyoung', 'Yujin', 'Gaeul',
  'Liz', 'Leeseo', 'Rei', 'Sakura', 'Chaewon', 'Kazuha', 'Eunchae', 'Minji',
  'Hanni', 'Danielle', 'Haerin', 'Hyein', 'Miyeon', 'Minnie', 'Soyeon', 'Yuqi',
  'Shuhua', 'Yeji', 'Lia', 'Ryujin', 'Chaeryeong', 'Yuna', 'Sullyoon', 'Haewon',
  'Lily', 'Bae', 'Jiwoo', 'Kyujin', 'Cha Eun Woo', 'Park Bo Gum',
  'Song Joong Ki', 'Lee Min Ho', 'Kim Soo Hyun', 'Park Seo Joon', 'Jung Hae In',
  'Song Hye Kyo', 'Jun Ji Hyun', 'Kim Ji Won', 'Han So Hee', 'Suzy',
  'Park Shin Hye', 'Lee Sung Kyung', 'Yoo Yeon Seok', 'Park Na Rae',
  'Taemin', 'Baekhyun', 'Chanyeol', 'D.O.', 'Kai', 'Sehun', 'Xiumin',
  'Lay', 'Chen', 'Suho', 'GDragon', 'G-Dragon', 'Taeyang', 'Daesung',
  'Seungri', 'TOP', 'CL', 'Dara', 'Bom', 'Minzy', 'Zico',
  'Jackson', 'BamBam', 'Yugyeom', 'Youngjae', 'JB', 'Jinyoung',
  'Nayeon', 'Jeongyeon', 'Momo', 'Sana', 'Jihyo', 'Mina', 'Dahyun',
  'Chaeyoung', 'Tzuyu',
];

// Build a sorted-by-length-desc list for greedy matching
const ALL_KNOWN_NAMES = [...KNOWN_GROUPS, ...KNOWN_SOLOISTS]
  .sort((a, b) => b.length - a.length);

// ---- Topic classifier keyword map ----

const TOPIC_KEYWORDS = {
  comeback:     ['comeback', 'return', 'back', 'coming back', 'pre-release'],
  chart:        ['chart', 'billboard', 'number', 'record', 'no.1', '#1', 'top 10', 'million', 'stream', 'sales'],
  release:      ['album', 'single', 'ep', 'tracklist', 'release', 'drop', 'mini-album', 'mini album', 'full album'],
  concert:      ['concert', 'tour', 'live', 'stage', 'arena', 'stadium', 'world tour', 'encore'],
  fashion:      ['fashion', 'style', 'outfit', 'airport', 'look', 'brand', 'ambassador', 'vogue', 'elle'],
  drama:        ['drama', 'movie', 'film', 'acting', 'kdrama', 'k-drama', 'episode', 'season'],
  dating:       ['dating', 'couple', 'relationship', 'romantic', 'wedding', 'married', 'love'],
  military:     ['military', 'enlistment', 'discharge', 'service', 'army', 'enlisted', 'discharged'],
  award:        ['award', 'win', 'trophy', 'daesang', 'bonsang', 'grammy', 'mama', 'golden disc', 'melon'],
  controversy:  ['controversy', 'scandal', 'apologize', 'apology', 'accused', 'allegations', 'lawsuit', 'bullying'],
  mv:           ['mv', 'music video', 'teaser', 'm/v', 'visual', 'concept photo'],
  interview:    ['interview', 'exclusive', 'reveals', 'talks about', 'opens up'],
  photo:        ['photo', 'pictorial', 'magazine', 'photoshoot', 'selfie', 'selca', 'photobook', 'cover'],
  debut:        ['debut', 'launch', 'pre-debut', 'trainee', 'survival'],
  collab:       ['collaboration', 'collab', 'featuring', 'feat', 'team up', 'duet', 'joint'],
  fan:          ['fan', 'fandom', 'fanmeeting', 'fan meeting', 'lightstick', 'fanclub'],
  trending:     ['trending', 'viral', 'reaction', 'meme', 'goes viral', 'buzz'],
  health:       ['health', 'injury', 'hospital', 'recover', 'surgery', 'hiatus', 'rest'],
  contract:     ['contract', 'agency', 'sign', 'renewal', 'renew', 'leave', 'departure', 'new agency'],
  variety:      ['variety', 'show', 'tv', 'running man', 'knowing bros', 'weekly idol', 'guest'],
  performance:  ['cover', 'performance', 'dance practice', 'choreography', 'stage', 'perform'],
};

// ---- Title templates per topic ----

const TITLE_TEMPLATES = {
  comeback: [
    '{artist}、待望のカムバックが決定',
    '{artist}のカムバック情報が解禁、ファンの期待高まる',
    '【速報】{artist}がカムバックを発表、新たな魅力を予告',
    '{artist}、新章の幕開け — カムバック詳細まとめ',
    '注目の帰還：{artist}のカムバックに業界も注目',
    '{artist}、カムバック日程が確定 — 新コンセプトにも期待',
    '{artist}のカムバックが間近に迫る、準備は万端か',
    '待ちに待った{artist}のカムバック、その全貌が明らかに',
  ],
  chart: [
    '{artist}、チャートで快挙を達成',
    '{artist}の楽曲がチャート上位に急浮上',
    '【チャート速報】{artist}が記録的な成績を収める',
    '{artist}、音楽チャートを席巻 — その実力を検証',
    'データで見る{artist}のチャートパフォーマンス',
    '{artist}がチャート記録を更新、勢いが止まらない',
    '{artist}の楽曲が主要チャートを独占、圧巻の成績',
  ],
  release: [
    '{artist}、新作をリリース — 全曲レビュー',
    '【新譜】{artist}の最新作を徹底解析',
    '{artist}がニューアルバムを発表、収録曲の魅力に迫る',
    'MUSE Review：{artist}の新作、聴きどころはここ',
    '{artist}の最新リリースが話題、その理由とは',
    '{artist}、待望の新曲を解禁 — 世界観に注目',
    '【リリース情報】{artist}の新作がついに到着',
  ],
  concert: [
    '{artist}、ライブの感動を届ける',
    '【ライブレポ】{artist}のステージが圧巻だった理由',
    '{artist}のコンサートが大盛況、ファンの声をレポート',
    '{artist}、ツアー開催を発表 — 日程と見どころ',
    '現場レポート：{artist}のライブパフォーマンスを振り返る',
    '{artist}のツアーが話題沸騰、チケット即完売の理由',
    '{artist}、圧巻のステージでファンを魅了',
  ],
  fashion: [
    '{artist}の最新ファッションが話題に',
    '【スタイル分析】{artist}のファッションセンスを解剖',
    '{artist}、空港ファッションで魅せるリアルスタイル',
    'ファッショニスタ{artist}のスタイリングに注目',
    '{artist}のブランド着用アイテムが即完売、その影響力',
    '{artist}が見せた最新スタイル、トレンドを牽引',
    '【ファッション】{artist}のコーディネートを徹底チェック',
  ],
  drama: [
    '{artist}出演のドラマが話題沸騰',
    '【ドラマレビュー】{artist}の演技力に注目が集まる',
    '{artist}、新ドラマへの出演が決定 — 期待の声続々',
    '{artist}の演技が光る話題のドラマ、見どころ解説',
    'ドラマ界でも存在感、{artist}の俳優としての成長',
    '{artist}主演ドラマが高視聴率を記録、その魅力に迫る',
    '{artist}、映像作品で新たな一面を披露',
  ],
  dating: [
    '【速報】{artist}の恋愛報道、真相に迫る',
    '{artist}の交際が明らかに — ファンの反応は',
    '{artist}、プライベートに注目が集まる',
    '話題の{artist}恋愛報道、MUSE編集部が分析',
    '{artist}の恋愛に関する新情報が浮上',
    '{artist}を巡る恋愛報道について整理',
  ],
  military: [
    '{artist}の兵役に関する最新情報',
    '【続報】{artist}、軍服務の近況が明らかに',
    '{artist}の除隊が間近、今後の活動予定は',
    '{artist}、兵役中の様子が話題に',
    '帰還を待つ{artist}、兵役最新アップデート',
    '{artist}の兵役状況について、最新の続報',
  ],
  award: [
    '{artist}、輝かしい受賞の瞬間',
    '【速報】{artist}が名誉ある賞を受賞',
    '{artist}の受賞に祝福の声が殺到',
    '実力派{artist}、待望の受賞で証明した実力',
    '{artist}が受賞を果たす — 喜びのコメント全文',
    '{artist}、授賞式で存在感を発揮 — 受賞の裏側',
  ],
  controversy: [
    '{artist}を巡る議論、事実関係を整理',
    '{artist}に関する報道について — 知っておくべきこと',
    '【検証】{artist}を巡る論争の真相',
    '{artist}サイドが公式声明を発表、その内容とは',
    '波紋を呼ぶ{artist}の件、MUSE編集部が考察',
  ],
  mv: [
    '{artist}、新MVが公開 — 映像美に注目',
    '【MV解析】{artist}の新作ミュージックビデオを徹底分析',
    '{artist}のMVが公開直後から再生回数急上昇',
    '必見：{artist}の最新MV、隠されたメッセージとは',
    '{artist}のMVが話題、その世界観を読み解く',
    '{artist}、新ティーザーを公開 — ビジュアルに釘付け',
  ],
  interview: [
    '{artist}が語る今の心境 — インタビュー',
    '【インタビュー】{artist}の本音に迫る',
    '{artist}、インタビューで明かした今後のビジョン',
    'MUSE PICK：{artist}が語るアーティストとしての覚悟',
    '素顔の{artist}に迫る — スペシャルインタビュー',
  ],
  photo: [
    '【グラビア】{artist}、最新ビジュアルが公開',
    '{artist}の最新写真が話題 — 圧倒的なビジュアル',
    'ビジュアルの頂点：{artist}のフォトシュートが公開',
    '{artist}、最新グラビアで新たな魅力を発揮',
    '目が離せない{artist}の最新ビジュアルカット',
  ],
  debut: [
    '【デビュー速報】{artist}がついにベールを脱ぐ',
    '{artist}、華々しいデビューを飾る',
    '新星{artist}のデビューに業界も注目',
    '{artist}のデビュー、新世代の幕開けとなるか',
    '期待の新人{artist}がデビュー — 注目ポイントまとめ',
  ],
  collab: [
    '{artist}のコラボレーションが実現、夢の共演に歓喜の声',
    '【話題】{artist}がサプライズコラボを発表',
    '{artist}の異色コラボが話題 — 化学反応に期待',
    '注目のコラボ：{artist}の新たな挑戦',
    '{artist}、コラボ作品で見せた新境地',
  ],
  fan: [
    '{artist}、ファンへの愛を語る特別な瞬間',
    '【感動】{artist}のファンサービスが話題に',
    '{artist}とファンの絆 — 特別なファンミーティングレポート',
    '{artist}、ファンイベントで見せた素顔',
    '{artist}のファンへの想いが溢れる、感動エピソード',
  ],
  trending: [
    '{artist}がSNSで大反響 — その理由とは',
    '【バズ】{artist}が話題の中心に',
    '{artist}関連の投稿がトレンド入り、ファンの反応まとめ',
    '話題沸騰：{artist}がネットを席巻中',
    'なぜ今{artist}が話題なのか — MUSE編集部が分析',
  ],
  health: [
    '{artist}の健康状態について最新情報',
    '【続報】{artist}の体調に関する公式発表',
    '{artist}の回復を願うファンの声が殺到',
    '{artist}の健康に関するアップデート',
    '{artist}サイドが健康状態について声明を発表',
  ],
  contract: [
    '{artist}の所属事務所に関する新展開',
    '【速報】{artist}が新事務所との契約を発表',
    '{artist}、契約に関する重要な決断を下す',
    '{artist}の事務所移籍が確定 — 今後の活動に注目',
    '{artist}、新たなスタートを切る — 契約詳細が判明',
  ],
  variety: [
    '{artist}がバラエティ番組で見せた意外な一面',
    '【TV出演】{artist}の魅力が爆発した瞬間',
    '{artist}、バラエティでの活躍が話題に',
    '必見：{artist}のバラエティ出演シーンまとめ',
    '{artist}のトーク力が光る — 注目のTV出演',
  ],
  performance: [
    '{artist}のパフォーマンスに鳥肌 — 圧巻のステージ',
    '【注目】{artist}のパフォーマンスが話題沸騰',
    '{artist}、カバーステージで見せた実力',
    '表現力の極み：{artist}のパフォーマンスを検証',
    '{artist}のステージが再生回数爆発、その理由',
  ],
  general: [
    '{artist}に関する注目の最新ニュース',
    '今知っておきたい{artist}の最新情報',
    '{artist}、最新の動向が明らかに',
    'MUSE編集部が注目する{artist}の近況',
    '{artist}に関する話題をMUSEがピックアップ',
    '【最新】{artist}のニュースをチェック',
    '{artist}の最新ニュースまとめ — MUSE編集部セレクト',
    '注目のアーティスト{artist}、最新情報をお届け',
  ],
};

const NO_ARTIST_TEMPLATES = [
  'K-POPシーンの注目ニュースをお届け',
  'エンタメ業界の最新動向をチェック',
  '今週のK-POP界、注目トピックまとめ',
  'MUSE編集部が選ぶ、今週の注目ニュース',
  'K-CULTUREの最前線から — 最新レポート',
  '韓流エンタメの今を追う — MUSE特集',
  '話題のニュースをMUSE視点で深掘り',
  '見逃せないK-POPニュース — MUSE編集部セレクト',
  '注目のエンタメトピック — MUSE編集部がピックアップ',
  'K-POPの最新トレンドを徹底チェック',
  'エンタメ界の今を知る — MUSE最新レポート',
  '今押さえるべきK-POPニュースまとめ',
  'K-POPファン必見、今日の注目ニュース',
  '韓流トレンドを読み解く — MUSE最新分析',
  'K-POP業界の動きをいち早くキャッチ',
  '話題のK-エンタメニュースを総まとめ',
  'MUSE速報：K-POPシーンの最新ハイライト',
  'いま注目すべきK-CULTURE最新情報',
  'K-POPの今が分かる — MUSE編集部レポート',
  'エンタメ最前線ニュース — 今日のピックアップ',
  'K-POPの潮流を掴む — MUSE独自視点',
  '韓流エンタメ最新レポート — 見どころ解説',
  'K-POP業界の注目トピックをMUSEが厳選',
  'エンタメ界の最新情報をお届け — MUSE通信',
  '今話題のK-CULTUREニュースをチェック',
  'K-POP最新事情 — MUSE編集部がお届け',
  'K-POPの週間ダイジェスト — MUSE編集部版',
  'エンタメ業界の話題を深掘り — MUSE分析',
  'K-POP最新ニュースフラッシュ',
  '韓流ファン必読、今週のハイライト',
];

// ---- Helper: pick random item from array ----

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---- Step 1: Extract artist name from title ----

// Words that should NOT be treated as artist names even when capitalized
const COMMON_ENGLISH_WORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'here', 'why', 'how', 'what',
  'when', 'who', 'which', 'where', 'watch', 'check', 'best', 'top', 'new',
  'breaking', 'exclusive', 'official', 'first', 'latest', 'all', 'every',
  'open', 'just', 'more', 'most', 'some', 'many', 'after', 'before',
  'korean', 'kpop', 'k-pop', 'idol', 'idols', 'legendary', 'former',
  'young', 'old', 'big', 'small', 'great', 'good', 'bad', 'real',
  'full', 'final', 'last', 'next', 'other', 'another', 'each', 'both',
  'only', 'even', 'still', 'also', 'already', 'never', 'always', 'again',
  'now', 'then', 'today', 'week', 'weekly', 'daily', 'year', 'month',
  'thread', 'list', 'review', 'reviews', 'roundup', 'recap', 'guide',
  'report', 'reports', 'update', 'updates', 'news', 'story', 'stories',
  'song', 'songs', 'album', 'albums', 'track', 'tracks', 'single', 'singles',
  'music', 'video', 'drama', 'movie', 'show', 'shows', 'stage', 'live',
  'tour', 'concert', 'award', 'awards', 'chart', 'charts', 'record',
  'debut', 'comeback', 'release', 'releases', 'performance', 'cover',
  'photo', 'photos', 'fashion', 'style', 'beauty', 'look', 'looks',
  'will', 'can', 'could', 'would', 'should', 'may', 'might', 'must',
  'does', 'did', 'has', 'had', 'have', 'been', 'being', 'are', 'were',
  'get', 'gets', 'got', 'make', 'makes', 'made', 'take', 'takes', 'took',
  'give', 'gives', 'gave', 'come', 'comes', 'came', 'keep', 'keeps', 'kept',
  'let', 'say', 'says', 'said', 'see', 'sees', 'saw', 'know', 'knows',
  'think', 'think', 'find', 'finds', 'want', 'wants', 'tell', 'tells',
  'ask', 'asks', 'work', 'works', 'seem', 'seems', 'feel', 'feels',
  'try', 'tries', 'start', 'starts', 'need', 'needs', 'run', 'runs',
  'move', 'moves', 'play', 'plays', 'pay', 'pays', 'hear', 'hears',
  'during', 'about', 'with', 'from', 'into', 'over', 'under', 'between',
  'through', 'against', 'without', 'within', 'along', 'behind',
  'inside', 'outside', 'above', 'below', 'upon', 'onto', 'toward',
  'for', 'but', 'not', 'yet', 'nor', 'and', 'or', 'so',
  'while', 'since', 'until', 'unless', 'because', 'although', 'though',
  'if', 'than', 'whether', 'once', 'twice',
  'his', 'her', 'its', 'our', 'their', 'my', 'your',
  'he', 'she', 'it', 'we', 'they', 'you', 'me', 'him', 'us', 'them',
  'no', 'yes', 'not', 'don\'t', 'doesn\'t', 'didn\'t', 'won\'t', 'can\'t',
  'eight', 'five', 'four', 'nine', 'one', 'seven', 'six', 'ten', 'three', 'two',
  'up', 'down', 'out', 'off', 'on', 'in', 'at', 'to', 'by', 'of',
  'coming', 'going', 'looking', 'rising', 'star', 'stars',
  'spill', 'spills', 'choi', 'lee', 'kim', 'park', 'jung', 'shin',
  'won', 'young', 'min', 'sung', 'hyun', 'jae', 'hye',
]);

// Very short soloist names that need exact-case matching to avoid false positives
const SHORT_AMBIGUOUS_NAMES = new Set(['V', 'TOP', 'CL', 'JB', 'DK', 'Jun', 'Jay', 'Kai', 'Lay', 'Bom', 'Liz', 'Bae', 'Han', 'San', 'Rei', 'Lia']);

function extractArtist(title) {
  // Check known names (longest-first for greedy match)
  for (const name of ALL_KNOWN_NAMES) {
    // Skip short ambiguous names for now — handle them separately
    if (SHORT_AMBIGUOUS_NAMES.has(name)) continue;

    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Case-insensitive for longer names
    const re = new RegExp(`(?:^|[\\s,;:'"(\\[])${escaped}(?=[\\s,;:'"')\\]!?.]|$)`, 'i');
    if (re.test(title)) {
      return name;
    }
  }

  // Short ambiguous names — require exact case AND context
  // e.g. "V Releases Solo Album" should match, but "5 V 5 tournament" should not
  for (const name of SHORT_AMBIGUOUS_NAMES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Exact case match with word boundary context
    const re = new RegExp(`(?:^|[\\s,;:'"(\\[])${escaped}(?=[\\s,;:'"')\\]!?.]|$)`);
    if (re.test(title)) {
      // Additional check: the title should contain at least one K-pop related keyword
      // or the name should appear near the beginning
      const pos = title.indexOf(name);
      if (pos <= 5) {
        return name;
      }
    }
  }

  // Fallback: extract leading capitalized word sequence that looks like an Asian person name
  // Pattern: 2-3 capitalized words where the first isn't a common English word
  // e.g. "Chae Jong Hyeop Reveals..." -> "Chae Jong Hyeop"
  const leadingName = title.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/);
  if (leadingName) {
    const candidate = leadingName[1];
    const words = candidate.split(/\s+/);
    // Reject if ANY word in the candidate is a common English word
    const allWordsValid = words.every(w => !COMMON_ENGLISH_WORDS.has(w.toLowerCase()));
    if (allWordsValid && words.length >= 2 && words.length <= 4) {
      return candidate;
    }
  }

  return null;
}

// ---- Step 2: Classify topic ----

function classifyTopic(title) {
  const lower = title.toLowerCase();
  // Check each topic's keywords
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        return topic;
      }
    }
  }
  return 'general';
}

// ---- Step 3 & 4: Generate Japanese title ----

function rewriteTitle(originalTitle, source) {
  // If already Japanese (contains hiragana/katakana/kanji), keep as-is
  if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(originalTitle)) {
    return originalTitle;
  }

  const artist = extractArtist(originalTitle);
  const topic = classifyTopic(originalTitle);

  if (artist) {
    const templates = TITLE_TEMPLATES[topic] || TITLE_TEMPLATES.general;
    const template = pickRandom(templates);
    return template.replace(/\{artist\}/g, artist);
  }

  // No artist found — use generic templates
  return pickRandom(NO_ARTIST_TEMPLATES);
}

// ============================================================
// Image downloading — save artist photos locally
// ============================================================

const IMAGES_DIR = join(__dirname, 'images');
const ARTICLES_DIR = join(__dirname, 'articles');

async function downloadImage(url, filename) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': new URL(url).origin,
      },
    });
    clearTimeout(timer);

    if (!res.ok || !res.body) return null;

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('image')) return null;

    const ext = contentType.includes('png') ? '.png'
      : contentType.includes('webp') ? '.webp'
      : '.jpg';
    const localFile = `${filename}${ext}`;
    const localPath = join(IMAGES_DIR, localFile);

    const buffer = Buffer.from(await res.arrayBuffer());
    await writeFile(localPath, buffer);

    return `images/${localFile}`;
  } catch {
    return null;
  }
}

async function downloadArticleImages(articles) {
  await mkdir(IMAGES_DIR, { recursive: true });

  log('Downloading article images locally...');
  let downloaded = 0;
  const BATCH = 8;

  for (let i = 0; i < articles.length; i += BATCH) {
    const batch = articles.slice(i, i + BATCH);
    await Promise.allSettled(
      batch.map(async (article, idx) => {
        if (!article.image || article.image.includes('picsum.photos')) return;
        const safeName = `article-${i + idx}-${Date.now() % 100000}`;
        const localPath = await downloadImage(article.image, safeName);
        if (localPath) {
          article.originalImage = article.image;
          article.image = localPath;
          downloaded++;
        }
      })
    );
  }

  log(`  Downloaded ${downloaded}/${articles.length} images locally`);
}

// ============================================================
// Category mapping
// ============================================================

function mapCategory(category) {
  const lower = (category || '').toLowerCase();
  if (lower.includes('music') || lower.includes('k-pop') || lower.includes('kpop')) return 'music';
  if (lower.includes('drama') || lower.includes('tv') || lower.includes('film') || lower.includes('movie')) return 'drama';
  if (lower.includes('fashion') || lower.includes('beauty')) return 'fashion';
  if (lower.includes('entertainment') || lower.includes('news') || lower.includes('stories')) return 'entertainment';
  return 'entertainment';
}

function displayCategory(category) {
  const lower = (category || '').toLowerCase();
  if (lower.includes('music') || lower.includes('k-pop') || lower.includes('kpop')) return 'MUSIC';
  if (lower.includes('drama')) return 'DRAMA';
  if (lower.includes('tv') || lower.includes('film') || lower.includes('movie')) return 'TV/FILM';
  if (lower.includes('fashion')) return 'FASHION';
  if (lower.includes('beauty')) return 'BEAUTY';
  if (lower.includes('interview')) return 'INTERVIEW';
  if (lower.includes('photo') || lower.includes('picture')) return 'PHOTO';
  return 'NEWS';
}

// ============================================================
// RSS Feed Parsing
// ============================================================

function parseRssFeed(xml, sourceName) {
  const items = extractItems(xml);
  const articles = [];

  for (const item of items) {
    const title = decodeHtmlEntities(stripHtml(extractTag(item, 'title')));
    const link = extractTag(item, 'link');
    const pubDate = extractTag(item, 'pubDate');
    const creator = extractTag(item, 'dc:creator');
    const categories = extractAllTags(item, 'category').map(c => decodeHtmlEntities(stripHtml(c)));
    const category = categories[0] || 'News';
    const description = extractTag(item, 'description');
    const contentEncoded = extractTag(item, 'content:encoded');

    let image = extractImageFromContent(item);
    if (!image) {
      image = extractImageFromContent(contentEncoded);
    }
    if (!image) {
      image = extractImageFromContent(description);
    }

    if (!title || !link) continue;

    // Content filter: exclude non-K-pop/K-culture articles
    const lowerTitle = title.toLowerCase();
    const lowerLink = link.toLowerCase();
    const allText = `${lowerTitle} ${lowerLink} ${categories.join(' ').toLowerCase()}`;
    const BLOCKED_KEYWORDS = [
      'esports', 'e-sports', 'gaming', 'gamer', 'fortnite', 'valorant',
      'league of legends', 'dota', 'overwatch', 'tournament', 'cheating',
      'counter-strike', 'csgo', 'minecraft', 'twitch streamer',
      'call of duty', 'apex legends', 'pubg',
    ];
    const isBlocked = BLOCKED_KEYWORDS.some(kw => allText.includes(kw));
    if (isBlocked) continue;

    articles.push({
      title,
      link,
      pubDate: pubDate ? new Date(pubDate) : new Date(),
      formattedDate: formatDate(pubDate),
      creator,
      category,
      categories,
      image,
      source: sourceName,
      // Will be populated later
      articleContent: null,
    });
  }

  return articles;
}

// ============================================================
// Fetch all feeds
// ============================================================

async function fetchAllFeeds() {
  const allArticles = [];

  for (const source of SOURCES) {
    try {
      log(`Fetching ${source.name}...`);
      const xml = await fetchWithTimeout(source.url);
      const articles = parseRssFeed(xml, source.name);
      log(`  ${source.name}: ${articles.length} articles`);
      allArticles.push(...articles);
    } catch (err) {
      warn(`Failed to fetch ${source.name}: ${err.message}`);
    }
  }

  allArticles.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

  log(`Total: ${allArticles.length} articles`);
  return allArticles;
}

// ============================================================
// Fill missing images via og:image
// ============================================================

async function fillMissingImages(articles) {
  const needsImage = articles.filter(a => !a.image);
  if (needsImage.length === 0) return;

  const toFetch = needsImage.slice(0, MAX_OG_IMAGE_FETCHES);
  log(`Extracting og:image for ${toFetch.length} articles (concurrency: ${OG_IMAGE_CONCURRENCY})...`);

  let found = 0;
  for (let i = 0; i < toFetch.length; i += OG_IMAGE_CONCURRENCY) {
    const batch = toFetch.slice(i, i + OG_IMAGE_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (article) => {
        const ogImage = await fetchOgImage(article.link);
        if (ogImage) {
          article.image = ogImage;
          return true;
        }
        return false;
      })
    );
    found += results.filter(r => r.status === 'fulfilled' && r.value === true).length;
  }

  log(`  Found og:image for ${found}/${toFetch.length} articles`);
}

// ============================================================
// Fetch article content from original pages
// ============================================================

function extractArticleContent(html) {
  // Remove script, style, nav, header, footer, sidebar, comments
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<div[^>]*class\s*=\s*["'][^"']*(?:sidebar|comment|social|share|related|ad-|ads-|advertisement|cookie|popup|modal|newsletter)[^"']*["'][\s\S]*?<\/div>/gi, '');

  // Try to find article body using common selectors
  const articleBodyPatterns = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]*class\s*=\s*["'][^"']*(?:article-body|article-content|entry-content|post-content|story-body|content-body|single-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class\s*=\s*["'][^"']*(?:post-entry|article-text|body-text|main-content|article__body|post__content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];

  let bodyHtml = '';
  for (const pattern of articleBodyPatterns) {
    const match = cleaned.match(pattern);
    if (match) {
      bodyHtml = match[1];
      break;
    }
  }

  if (!bodyHtml) {
    bodyHtml = cleaned;
  }

  // Extract paragraphs
  const paragraphs = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let pMatch;
  while ((pMatch = pRegex.exec(bodyHtml)) !== null) {
    const text = stripHtml(decodeHtmlEntities(pMatch[1])).trim();
    // Skip very short paragraphs, ads, empty ones
    if (text.length > 30 &&
        !text.match(/^(advertisement|sponsored|also read|read more|related:|source:|photo:|credit:|getty|shutterstock|loading)/i)) {
      paragraphs.push(text);
    }
  }

  // Extract images from the article body
  const images = [];
  const imgRegex = /<img[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(bodyHtml)) !== null) {
    const src = imgMatch[1];
    if (src && !src.includes('avatar') && !src.includes('icon') && !src.includes('logo') &&
        !src.includes('1x1') && !src.includes('pixel') && !src.includes('tracking')) {
      images.push(src);
    }
  }

  return { paragraphs, images };
}

async function fetchArticleContent(article) {
  try {
    const html = await fetchWithTimeout(article.link, ARTICLE_FETCH_TIMEOUT);
    const content = extractArticleContent(html);
    return content;
  } catch {
    return { paragraphs: [], images: [] };
  }
}

async function fetchAllArticleContent(articles) {
  // Only fetch content for articles that will be used (first ~50)
  const toFetch = articles.slice(0, 50);
  log(`Fetching full article content for ${toFetch.length} articles (concurrency: ${ARTICLE_FETCH_CONCURRENCY})...`);

  let fetched = 0;
  for (let i = 0; i < toFetch.length; i += ARTICLE_FETCH_CONCURRENCY) {
    const batch = toFetch.slice(i, i + ARTICLE_FETCH_CONCURRENCY);
    await Promise.allSettled(
      batch.map(async (article) => {
        const content = await fetchArticleContent(article);
        if (content.paragraphs.length > 0) {
          article.articleContent = content;
          fetched++;
        }
      })
    );
  }

  log(`  Fetched content for ${fetched}/${toFetch.length} articles`);
}

// ============================================================
// Article body rewriting
// ============================================================

// ============================================================
// Fully Japanese article body generation — template-based
// ============================================================

const BODY_TEMPLATES = {
  comeback: {
    opening: [
      '{artist}のカムバックに関する情報が公開され、K-POPファンの間で大きな話題となっている。今回のカムバックは、これまでとは異なる新たなコンセプトを打ち出すとされており、音楽業界の注目を集めている。',
      '{artist}が待望のカムバックを控え、ファンの期待が最高潮に達している。所属事務所からの公式発表によると、今回のカムバックではこれまでにない音楽的挑戦が見られるという。',
      '多くのファンが待ち望んでいた{artist}のカムバックがついに現実となった。前作から時間を経て、さらに成熟したアーティストとしての姿が期待されている。',
    ],
    analysis: [
      '業界関係者によると、{artist}は今回のカムバックに向けて長期間にわたる準備期間を設けたという。楽曲制作にも積極的に参加し、アーティストとしての成長が随所に感じられる作品になると予想されている。ファンコミュニティでは早くもカムバックに関する様々な考察が飛び交っている。',
      '今回の{artist}のカムバックは、音楽的にも視覚的にも大きな変化が予想されている。SNS上ではティーザーコンテンツへの反応が熱狂的で、公開直後からトレンド入りを果たした。K-POP市場の動向を考えると、このカムバックが持つ意味は非常に大きい。',
      '{artist}のカムバックは、現在のK-POPシーンにおいて特に注目される動きの一つだ。前作の成功を受けて、今回はさらなる高みを目指す姿勢が伺える。音楽評論家たちも{artist}の次の一手に大きな関心を寄せている。',
    ],
    closing: [
      'MUSE編集部では{artist}のカムバックに関する情報を引き続き追跡し、最新情報をお届けしていく。今後の展開からも目が離せない。',
      '{artist}のカムバックがK-POPシーンにどのような影響を与えるのか、MUSE編集部は今後も注視していく。新たな情報が入り次第、随時更新してお届けする。',
    ],
  },
  chart: {
    opening: [
      '{artist}がチャートにおいて目覚ましい成績を収め、大きな注目を集めている。今回の記録は、{artist}の音楽的実力と幅広い支持基盤を改めて証明するものとなった。',
      '音楽チャートに新たな歴史を刻んだ{artist}。数字が物語るその影響力は、K-POPの枠を超えてグローバル音楽市場でも際立っている。',
      '{artist}の楽曲がチャート上位にランクインし、ファンや音楽関係者の間で話題となっている。この成績は{artist}の着実な成長を示すものだ。',
    ],
    analysis: [
      'チャートデータを詳細に分析すると、{artist}の今回の成績がいかに特筆すべきものであるかが見えてくる。ストリーミング数、ダウンロード数ともに前作を大きく上回り、ファンベースの拡大が数字として表れている。特にグローバル市場での伸びが顕著だ。',
      '音楽評論家たちは{artist}のチャート成績について、楽曲のクオリティとファンの結束力が相まった結果と分析している。SNSでのファンによるプロモーション活動も、今回の成績に大きく貢献したと考えられる。',
      '{artist}のチャートパフォーマンスは、現在のK-POP市場における位置づけを明確にしている。同時期にリリースされた他のアーティストとの比較でも、その強さは際立っており、今後の活動への期待も高まっている。',
    ],
    closing: [
      '{artist}のチャート上での活躍は今後も続くと予想される。MUSE編集部ではチャート動向を引き続きウォッチし、最新の分析をお届けする。',
      '今回のチャート成績が{artist}のキャリアにおいてどのような意味を持つのか、MUSE編集部は引き続き注目していく。',
    ],
  },
  release: {
    opening: [
      '{artist}の最新作がリリースされ、音楽ファンの間で大きな反響を呼んでいる。今作では新たな音楽的方向性が示されており、{artist}の成長が感じられる一枚となっている。',
      '待望の{artist}新作がついにベールを脱いだ。収録曲のラインナップや制作陣の顔ぶれからも、今作にかける{artist}の並々ならぬ意気込みが伝わってくる。',
      '{artist}が新たな作品を世に送り出した。前作とは異なるアプローチで制作された今作は、{artist}のアーティスティックな進化を感じさせる仕上がりだ。',
    ],
    analysis: [
      '今作の特徴は、{artist}が楽曲制作に深く関わっている点だ。歌詞やメロディーに込められたメッセージは、{artist}の現在の心境や考えを反映しているという。プロデューサーとの化学反応も見事で、完成度の高い作品に仕上がっている。',
      '収録曲を一曲ずつ見ていくと、{artist}の音楽的幅の広さに驚かされる。タイトル曲のキャッチーさはもちろん、カップリング曲にも聴きごたえのあるナンバーが揃っている。全体を通して統一感がありながらも、多彩な表現が楽しめる構成だ。',
      '音楽評論家たちからも今作への評価は高い。{artist}ならではの個性を保ちつつ、新たな音楽的チャレンジを取り入れたバランスが絶妙だと評価されている。リリース後のチャート成績にも注目が集まっている。',
    ],
    closing: [
      '{artist}の最新作に関するさらなる情報や反応は、MUSE編集部が引き続きフォローしていく。今作が音楽シーンにどのような影響を与えるか注目だ。',
      '今後のプロモーション活動や音楽番組での披露も楽しみだ。MUSE編集部では{artist}の最新情報を随時お届けする。',
    ],
  },
  concert: {
    opening: [
      '{artist}のライブが開催され、会場は熱気に包まれた。圧巻のパフォーマンスとファンとの一体感が生み出す空間は、まさにライブでしか味わえない特別な体験だった。',
      '{artist}がステージに立ち、集まったファンに感動のパフォーマンスを届けた。セットリストや演出の細部にまで{artist}のこだわりが感じられるライブとなった。',
      '{artist}のコンサートに関する情報が公開され、ファンの間で大きな盛り上がりを見せている。今回の公演は、{artist}にとってキャリアの重要な一ページとなりそうだ。',
    ],
    analysis: [
      'ライブのセットリストは、{artist}のヒット曲から最新曲まで幅広くカバーし、ファンの期待に十分に応える内容だった。特に注目すべきは演出面で、最新技術を駆使したステージングは観客を圧倒した。MCでのファンとの交流も印象的だった。',
      '{artist}のライブパフォーマンスは、スタジオ音源を超える迫力があると評判だ。ダンス、ボーカル、表現力のすべてにおいて高いクオリティを維持し、プロフェッショナルとしての実力を見せつけた。会場の一体感は、{artist}とファンの強い絆の証だ。',
      '公演関係者によると、{artist}はリハーサルの段階から細部にまでこだわりを持って準備に臨んだという。その姿勢が本番のパフォーマンスの質に直結している。SNS上には公演後の感動を伝えるファンの投稿が溢れている。',
    ],
    closing: [
      '{artist}の今後の公演スケジュールに関する情報は、MUSE編集部が最速でお届けする。次のステージも見逃せない。',
      'ライブの興奮が冷めやらない中、{artist}の次のステージに向けた期待がすでに高まっている。MUSE編集部は引き続き追跡レポートをお届けする。',
    ],
  },
  fashion: {
    opening: [
      '{artist}の最新ファッションが注目を集めている。トレンドを押さえながらも自分らしさを失わないスタイリングは、ファッション業界からも高く評価されている。',
      'ファッションアイコンとしても知られる{artist}が、また新たなスタイルで話題をさらった。{artist}の着用アイテムは即座にSNSでシェアされ、大きな反響を呼んでいる。',
      '{artist}のファッションセンスが再び注目の的となっている。ブランドとのコラボレーションも含め、{artist}のファッション面での活躍が目覚ましい。',
    ],
    analysis: [
      '{artist}のスタイリングの特徴は、ハイブランドとストリートアイテムを巧みにミックスする点にある。今回も例外ではなく、絶妙なバランス感覚で自分だけのスタイルを確立している。ファッション誌の編集者たちも{artist}のセンスに注目しているという。',
      'ファッション業界の専門家は、{artist}のスタイルが若い世代のファッショントレンドに大きな影響を与えていると分析する。着用アイテムの問い合わせや売り上げが急増する「{artist}効果」は、ブランド側にとっても魅力的な存在だ。',
      '{artist}のファッションは、音楽活動における世界観とも密接にリンクしている。コンセプトに合わせたスタイリングの変化も、ファンにとっては楽しみの一つだ。{artist}がどのようなファッションメッセージを発信するのか、引き続き注目される。',
    ],
    closing: [
      '{artist}のファッションに関する最新情報は、MUSE編集部がスタイル分析とともにお届けしていく。今後のスタイリングにも期待が高まる。',
      'ファッション面でも進化を続ける{artist}の今後に注目だ。MUSE編集部ではスタイルトレンドの分析を引き続きお届けする。',
    ],
  },
  drama: {
    opening: [
      '{artist}の出演するドラマが大きな話題を呼んでいる。演技力の高さはもちろん、作品全体の完成度の高さも相まって、視聴者からの評価が急上昇中だ。',
      '{artist}が映像作品で新たな一面を見せている。アイドルや歌手としての顔とは異なる、俳優としての{artist}の魅力が存分に発揮されている。',
      '{artist}のドラマ出演に関する情報が明らかになり、ファンのみならずドラマファンからも大きな期待が寄せられている。',
    ],
    analysis: [
      '{artist}の演技について、ドラマ評論家たちは「自然体でありながらも深い感情表現ができる」と高く評価している。共演者とのケミストリーも抜群で、作品の魅力を一段と引き上げているという。視聴率の推移を見ても、回を追うごとに上昇傾向にある。',
      '作品の脚本や演出の質も高く、{artist}にとって俳優としてのキャリアを大きく前進させる機会になっている。これまでの音楽活動で培った表現力が、演技にもプラスに作用しているようだ。SNS上では名場面の切り抜きが広くシェアされている。',
      '{artist}は今回の作品について「新たな挑戦であり、多くのことを学んだ」と語っているという。俳優としての{artist}に対する評価は、この作品を通じて確実に高まっている。今後の映像作品への出演にも期待が集まる。',
    ],
    closing: [
      '{artist}の出演作品に関する情報は、MUSE編集部が引き続きレビューとともにお届けする。今後の活躍にも要注目だ。',
      '俳優としても着実にキャリアを積む{artist}。MUSE編集部では映像作品での活躍も含めて最新情報をフォローしていく。',
    ],
  },
  award: {
    opening: [
      '{artist}が栄えある賞を受賞し、喜びの声を伝えた。今回の受賞は、{artist}のこれまでの努力と実力が公式に認められた瞬間だ。',
      '受賞の瞬間、{artist}の表情に感動が広がった。長い努力の末に手にした栄冠は、{artist}にとって大きな意味を持つものだ。',
      '{artist}が権威ある賞を受賞したことが発表され、ファンや音楽関係者から祝福の声が相次いでいる。',
    ],
    analysis: [
      '今回の{artist}の受賞は、音楽的完成度と商業的成功の両面が評価された結果だ。審査員からは{artist}の独自性と革新性が特に高く評価されたという。K-POPアーティストとしてこの賞を受賞することの意義は大きい。',
      '{artist}は受賞スピーチで感謝の気持ちを述べ、支えてくれたファンやスタッフへの想いを語った。その姿に多くのファンが心を打たれ、SNS上には感動のコメントが溢れた。受賞後のメディア露出も増加が見込まれる。',
      '音楽評論家たちは、{artist}の受賞について「当然の結果」と口を揃える。今年の活躍ぶりを振り返れば、受賞は十分に納得のいくものだ。今回の受賞が{artist}のキャリアにさらなる弾みをつけることは間違いない。',
    ],
    closing: [
      '{artist}のさらなる飛躍に期待が高まる。MUSE編集部では受賞関連の続報を含め、最新情報をお届けしていく。',
      '受賞を経て新たなステージに立つ{artist}。MUSE編集部は今後の活動にも注目し、最新情報をお届けする。',
    ],
  },
  controversy: {
    opening: [
      '{artist}を巡る議論について、現在判明している事実を整理してお伝えする。MUSE編集部では憶測ではなく、確認された情報に基づいた報道を心がけている。',
      '{artist}に関する報道が注目を集めている。様々な情報が錯綜する中、MUSE編集部が現時点で確認できた事実をまとめた。',
      '{artist}を巡る一連の報道について、MUSE編集部が事実関係を検証した。感情的な反応が広がる中、冷静な視点から状況を整理する。',
    ],
    analysis: [
      '現時点で公式に確認されている情報と、未確認の情報を明確に区別する必要がある。{artist}サイドからの公式声明の内容と、各メディアの報道を照らし合わせると、いくつかの点で情報の食い違いが見られる。今後の追加情報により、状況が変わる可能性もある。',
      'SNS上ではこの件に関して様々な意見が飛び交っているが、MUSE編集部としては確定的な事実に基づいた情報提供を優先する。ファンの間でも冷静な対応を呼びかける声が上がっている。事態の推移を見守る姿勢が重要だ。',
    ],
    closing: [
      'MUSE編集部では新たな情報が確認され次第、続報をお届けする。引き続き事実に基づいた報道を心がけていく。',
      '今後の展開については、MUSE編集部が引き続き追跡して報道する。冷静な視点での情報提供を継続していく。',
    ],
  },
  mv: {
    opening: [
      '{artist}の最新ミュージックビデオが公開され、ファンの間で大きな反響を呼んでいる。映像美と楽曲の世界観が見事に融合した作品に仕上がっている。',
      '{artist}が新たなビジュアルコンテンツを公開した。今回のMVは、制作チームの高い技術力と{artist}の表現力が融合した注目の作品だ。',
      '公開直後から再生回数が急上昇している{artist}のMV。その映像世界の魅力について詳しく見ていこう。',
    ],
    analysis: [
      '映像を詳しく見ると、細部にまでこだわった演出が随所に見られる。カラーパレットやカメラワーク、衣装に至るまで、すべてが楽曲の世界観を支えている。{artist}の表情やダンスパフォーマンスも、MVの完成度を高める重要な要素だ。',
      'ファンコミュニティでは早くもMVに隠されたメッセージや伏線の考察が活発に行われている。{artist}のMVには毎回ストーリー性があり、前作とのつながりを指摘する声も多い。こうした作り込みが、ファンの没入感を高めている。',
      '再生回数は公開から短期間で大きな数字を記録しており、{artist}のグローバルな人気の高さを改めて示している。映像のクオリティに対する評価も高く、音楽と視覚芸術の融合として高い完成度を誇っている。',
    ],
    closing: [
      '{artist}のビジュアルコンテンツに関する最新情報は、MUSE編集部が引き続きお届けする。今後の映像作品にも期待が高まる。',
      'MVを通じて新たな表現を見せた{artist}。MUSE編集部では映像分析を含め、引き続き最新情報をフォローする。',
    ],
  },
  interview: {
    opening: [
      '{artist}がインタビューで率直な思いを語った。普段は見せない素顔や、アーティストとしてのビジョンが垣間見える貴重な内容となっている。',
      '{artist}の最新インタビューが公開された。音楽活動や今後の展望について、{artist}本人の言葉で語られた内容は非常に興味深い。',
      '{artist}がインタビューの場で、ファンへの感謝と今後の抱負を語った。真摯な姿勢が印象的なインタビューとなった。',
    ],
    analysis: [
      'インタビューの中で{artist}は、最近の活動について振り返りながら、次のステップへの意欲を語った。特に印象的だったのは、音楽制作に対する姿勢の変化について言及した部分だ。経験を重ねる中で、より深い表現を目指すようになったという。',
      '{artist}の言葉の端々から、アーティストとしての成長と覚悟が感じられる。プレッシャーやチャレンジについても正直に語る姿勢が、多くのファンの共感を呼んでいる。インタビュー全文はファンの間で広くシェアされ、感動の声が上がっている。',
    ],
    closing: [
      '{artist}のインタビュー関連の続報は、MUSE編集部がお届けする。アーティストの素顔に迫るコンテンツを今後も追跡していく。',
      '言葉の一つ一つに重みがあった{artist}のインタビュー。MUSE編集部では独自の視点でアーティストの声をお届けしていく。',
    ],
  },
  photo: {
    opening: [
      '{artist}の最新ビジュアルが公開され、ファンの間で大きな反響を呼んでいる。洗練されたビジュアルと表現力が、写真の一枚一枚から伝わってくる。',
      '{artist}が最新のフォトコンテンツで圧倒的なビジュアルを披露した。カメラの前での存在感は、さすがの一言だ。',
      '公開された{artist}の最新写真が話題沸騰中。ビジュアルのクオリティの高さに、ファンのみならず業界関係者からも賞賛の声が上がっている。',
    ],
    analysis: [
      '今回のビジュアルは、{artist}のこれまでのイメージとは異なる新たな一面を引き出している。フォトグラファーとスタイリストの力量もあいまって、アート性の高い仕上がりとなっている。{artist}の表情や姿勢の細部にまでプロフェッショナリズムが光る。',
      'SNS上では公開された写真に対する反応が爆発的で、関連ハッシュタグがトレンド入りを果たした。{artist}のビジュアルコンテンツは毎回話題を呼ぶが、今回は特に評価が高い。ファンアートやリアクション動画も続々と投稿されている。',
    ],
    closing: [
      '{artist}のビジュアルコンテンツに関する最新情報は、MUSE編集部が引き続きお届けする。次の公開も楽しみだ。',
      'ビジュアル面でも魅力を発揮し続ける{artist}。MUSE編集部では最新写真やグラビア情報をいち早くフォローしていく。',
    ],
  },
  debut: {
    opening: [
      '{artist}がついにデビューを果たし、K-POPシーンに新たな風を吹き込んだ。長い練習生期間を経て迎えたこの瞬間は、{artist}にとって特別な意味を持つ。',
      '新世代アーティスト{artist}のデビューが発表され、業界内外で大きな注目を集めている。デビュー前から高い期待を寄せられていた{artist}の実力が、ついに本格的に披露される。',
      'K-POPシーンに新星が誕生した。{artist}のデビューは、多くの音楽関係者が注目するイベントとなっている。',
    ],
    analysis: [
      'デビュー作品を見ると、{artist}のポテンシャルの高さが明確に伝わってくる。楽曲のクオリティ、パフォーマンス力ともに新人とは思えないレベルで、今後の成長が非常に楽しみだ。所属事務所の育成力とプロデュース力も評価に値する。',
      '音楽評論家たちは{artist}のデビューについて、「今年最も注目すべき新人」と口を揃える。デビュー曲の完成度は高く、すでに独自のカラーが確立されている印象だ。ファンベースの拡大も急速に進んでいる。',
    ],
    closing: [
      '新人ながら大きな存在感を示した{artist}。MUSE編集部ではデビュー後の活動を引き続き追跡し、成長の軌跡をお届けする。',
      '{artist}のデビューはK-POPシーンにとっても重要な出来事だ。MUSE編集部は今後の活躍にも注目していく。',
    ],
  },
  collab: {
    opening: [
      '{artist}のコラボレーションが実現し、ファンの間で大きな歓喜の声が上がっている。それぞれのアーティストの個性がぶつかり合うことで、どのような化学反応が生まれるのか注目だ。',
      '夢のコラボが実現した。{artist}が参加するコラボレーション作品は、双方のファンにとって待望の企画であり、期待は最高潮に達している。',
      '{artist}の新たなコラボレーションが発表され、音楽ファンの間で大きな話題となっている。異なるスタイルの融合がどのような作品を生み出すのか、注目が集まる。',
    ],
    analysis: [
      'コラボレーション作品は、{artist}の持ち味を活かしながらも新鮮な要素が加わった仕上がりとなっている。互いのアーティスティックな強みが相乗効果を生み、ソロ作品とはまた異なる魅力的な楽曲が誕生した。',
      '今回のコラボは、音楽的な相性の良さが際立つ。{artist}のファンにとっても新たな一面を発見できる作品であり、コラボ相手のファンからも好意的な反応が寄せられている。クロスオーバーの成功例と言えるだろう。',
    ],
    closing: [
      'コラボレーションを通じて新境地を開拓した{artist}。MUSE編集部ではコラボ作品の続報を引き続きフォローする。',
      '{artist}の新たな挑戦に注目が集まる。MUSE編集部は引き続き関連情報をお届けしていく。',
    ],
  },
  fan: {
    opening: [
      '{artist}がファンとの特別な時間を過ごし、深い感動を与えた。{artist}とファンの間に流れる温かい空気感は、他では味わえない特別なものだ。',
      'ファンへの愛情を惜しみなく表現する{artist}。今回も{artist}らしい温かいファンサービスが話題となっている。',
      '{artist}のファンイベントが開催され、参加したファンからは感動の声が多数寄せられている。{artist}とファンの絆の深さが改めて感じられるイベントとなった。',
    ],
    analysis: [
      '{artist}のファンサービスは、K-POP業界の中でも特に評価が高い。一人一人のファンに対する真摯な姿勢が、強固なファンベースを支えている。今回のイベントでも、{artist}の温かい人柄が随所に表れていた。',
      'ファンコミュニティでは、{artist}のファンへの対応についてのエピソードが数多くシェアされている。こうした積み重ねが、{artist}と ファンの間に築かれた信頼関係の基盤となっている。',
    ],
    closing: [
      '{artist}のファン関連イベントの情報は、MUSE編集部が随時お届けする。{artist}とファンの絆がさらに深まることを期待している。',
      'ファンとの時間を大切にする{artist}の姿勢に、改めて敬意を表したい。MUSE編集部は引き続き最新情報をフォローする。',
    ],
  },
  trending: {
    opening: [
      '{artist}がSNS上で大きな話題となっている。関連投稿は瞬く間に拡散し、トレンド入りを果たした。なぜ今{artist}がこれほどの注目を集めているのか、詳しく見ていこう。',
      'ネット上で{artist}に関する話題が急速に広まっている。ファンの間だけでなく、一般ユーザーの間でも注目度が急上昇中だ。',
      '{artist}が再びインターネットを席巻している。今回の話題の中心にあるのは何なのか、MUSE編集部が分析する。',
    ],
    analysis: [
      'トレンドの発端を追うと、{artist}に関する特定の投稿やコンテンツが起爆剤となったことがわかる。SNSの特性上、一度火がつくと急速に拡散するが、{artist}の場合はその拡散力が特に強い。グローバルファンベースの結束力がその背景にある。',
      '話題の広がり方を分析すると、{artist}のコンテンツがバズる理由が見えてくる。親しみやすさとカリスマ性を兼ね備えた{artist}の魅力が、幅広い層にリーチしている。今回のトレンドも、{artist}の持つ独特の引力が作用した結果だろう。',
    ],
    closing: [
      '話題の中心にいる{artist}の動向を、MUSE編集部は引き続きウォッチしていく。次にどんなバズが生まれるのか、目が離せない。',
      'トレンドを生み出す力を持つ{artist}。MUSE編集部は最新の話題をいち早くキャッチしてお届けする。',
    ],
  },
  health: {
    opening: [
      '{artist}の健康状態に関する情報が伝えられ、多くのファンが心配の声を寄せている。MUSE編集部では公式発表に基づいた情報をお伝えする。',
      '{artist}の体調に関する続報が入った。ファンの間では回復を願う声が多数上がっている。',
      '{artist}の健康に関するアップデートが公式に発表された。MUSE編集部が確認した情報をお届けする。',
    ],
    analysis: [
      '公式発表によると、{artist}は現在回復に専念しているとのことだ。所属事務所は{artist}の健康を最優先とする方針を明確にしており、無理のないスケジュールで復帰を目指すという。ファンコミュニティでは応援メッセージが溢れている。',
      '{artist}の健康が一日も早く回復することを、多くの関係者とファンが願っている。アーティストの健康管理の重要性は、業界全体の課題でもある。{artist}がベストな状態で活動に復帰できることを期待したい。',
    ],
    closing: [
      '{artist}の回復を心よりお祈りしている。MUSE編集部では健康状態に関する続報をお届けしていく。',
      '{artist}の回復を願うとともに、MUSE編集部では公式情報に基づいた最新の情報をお届けする。',
    ],
  },
  contract: {
    opening: [
      '{artist}の所属事務所に関する新たな動きが報じられた。今回の展開は、{artist}の今後のキャリアに大きな影響を与える可能性がある。',
      '{artist}の契約に関する情報が明らかになった。業界内外で注目される今回の決断の背景を探る。',
      '{artist}が新たな環境での活動を開始する。今回の契約に関する詳細をMUSE編集部がまとめた。',
    ],
    analysis: [
      '今回の{artist}の決断は、アーティストとしてのキャリアビジョンに基づいたものと見られる。新たな環境では、これまでとは異なる音楽的チャレンジが可能になるとの見方もある。業界関係者の間でも今後の展開に対する関心は高い。',
      '{artist}の契約に関する動きは、K-POP業界全体の動向とも関連している。アーティストと事務所の関係性は、作品の方向性やプロモーション戦略に直結するだけに、ファンにとっても重要なニュースだ。',
    ],
    closing: [
      '{artist}の今後の活動に関する情報は、MUSE編集部が引き続き追跡する。新たなスタートに期待が高まる。',
      '新たな環境での{artist}の飛躍を期待したい。MUSE編集部では契約関連の続報をフォローしていく。',
    ],
  },
  variety: {
    opening: [
      '{artist}がバラエティ番組に出演し、意外な一面を見せてファンを喜ばせた。ステージ上の姿とは異なる、親しみやすい{artist}の魅力が存分に発揮されている。',
      '{artist}のバラエティ出演が大きな話題となっている。トーク力やリアクションの面白さが視聴者の心を掴んだ。',
      'TV出演で存在感を発揮した{artist}。音楽活動とはまた違った魅力で、新たなファン層を開拓している。',
    ],
    analysis: [
      '{artist}のバラエティ出演は、アーティストイメージの幅を広げる効果的な戦略でもある。番組内での自然体なトークや反応が好評で、「{artist}って面白い」という新たな認識が広まっている。出演後のSNSフォロワー数の増加がその証拠だ。',
      '番組制作者によると、{artist}は収録現場でも非常に好印象だったという。台本に頼らない自然なリアクションと、場を明るくするキャラクターが、共演者やスタッフからも高く評価されている。',
    ],
    closing: [
      '{artist}のTV出演情報は、MUSE編集部が見逃さずお届けする。バラエティでの活躍にも引き続き注目だ。',
      'マルチな才能を発揮する{artist}。MUSE編集部は音楽以外の活動にも注目して最新情報をお届けする。',
    ],
  },
  performance: {
    opening: [
      '{artist}のパフォーマンスが視聴者に鳥肌を立たせた。技術力と表現力が融合した圧巻のステージは、{artist}の実力を改めて証明するものとなった。',
      '{artist}が披露したパフォーマンスが大きな話題を呼んでいる。完璧なシンクロとエネルギッシュな表現が、見る者を圧倒した。',
      'ステージ上の{artist}は別格だ。今回のパフォーマンスでも、その卓越した実力を遺憾なく発揮している。',
    ],
    analysis: [
      '{artist}のパフォーマンスの特徴は、技術的な完成度の高さと感情表現の豊かさにある。一つ一つの動きに込められた意味と、楽曲との一体感が、見る者の心を掴んで離さない。プロのダンサーやコレオグラファーからも高い評価を受けている。',
      '映像で改めてパフォーマンスを確認すると、{artist}の細部へのこだわりに気づかされる。表情管理、体のライン、フォーメーション移動の滑らかさなど、すべてにおいてハイレベルだ。この完成度は、日々の努力の賜物に他ならない。',
    ],
    closing: [
      '{artist}のパフォーマンスに関する情報は、MUSE編集部が分析とともにお届けする。次のステージも必見だ。',
      'パフォーマンスで魅了し続ける{artist}。MUSE編集部は引き続きステージの分析をお届けしていく。',
    ],
  },
  dating: {
    opening: [
      '{artist}の恋愛に関する報道が浮上し、注目を集めている。MUSE編集部では確認された情報を中心にお伝えする。',
      '{artist}のプライベートに関する話題が広がっている。ファンの間では様々な反応が見られ、議論が続いている。',
    ],
    analysis: [
      '恋愛報道に対する反応はファンの間で分かれているが、{artist}の幸せを応援する声が多数を占めている。アーティストのプライベートに関しては、尊重する姿勢が大切だという意見も多い。',
      '{artist}サイドからの公式なコメントの有無にかかわらず、アーティストの私生活は本人の判断に委ねられるべきだ。ファンとしては、{artist}の活動と作品を引き続き応援する姿勢が重要だろう。',
    ],
    closing: [
      'MUSE編集部ではプライバシーに配慮しつつ、公式情報に基づいた報道をお届けする。',
      '{artist}の今後の活動に関する情報は、MUSE編集部が引き続きフォローしていく。',
    ],
  },
  military: {
    opening: [
      '{artist}の兵役に関する最新情報が伝えられた。ファンにとっては一定期間の不在を受け入れなければならないが、除隊後の活動への期待も大きい。',
      '{artist}の軍服務に関する続報が入った。兵役中の様子や今後のスケジュールについて、現在判明している情報をまとめた。',
    ],
    analysis: [
      '{artist}の兵役は、韓国男性アーティストにとって避けられない義務だ。しかし、兵役期間中もファンの応援は途切れることなく続いている。{artist}の帰還を待ち望むファンの声は日に日に大きくなっている。',
      '兵役を経験したアーティストは、人間的にも大きく成長して戻ってくるケースが多い。{artist}が除隊後にどのような姿を見せるのか、音楽的にどのような変化が見られるのか、期待と関心が高まっている。',
    ],
    closing: [
      '{artist}の兵役関連の続報は、MUSE編集部がお届けする。帰還の日を楽しみに待ちたい。',
      '{artist}の除隊後の活動にも注目だ。MUSE編集部は最新情報を引き続きフォローする。',
    ],
  },
  general: {
    opening: [
      '{artist}に関する最新ニュースが入った。K-POP・K-CULTUREの最前線から、MUSE編集部が注目の情報をお届けする。',
      '{artist}の最新の動向が明らかになった。多方面で活躍を続ける{artist}の今に迫る。',
      '{artist}に関する話題が注目を集めている。MUSEならではの視点で、その詳細をお伝えする。',
      'MUSEが独自の視点からお届けする{artist}の最新エンタメニュース。今回は注目のトピックをピックアップした。',
    ],
    analysis: [
      '{artist}の活動は多岐にわたり、音楽だけでなく様々な分野での存在感を示している。今回の件も、{artist}の幅広い活動の一環として注目に値する。ファンの間でも大きな関心を集めており、SNS上での反応も活発だ。',
      '業界関係者によると、{artist}は常に新たなチャレンジを模索しているという。今回の話題も、{artist}の成長と進化の過程で生まれたものと言えるだろう。今後の展開にも大いに期待が持てる。',
      '今回のニュースは、{artist}のファンにとって嬉しい情報だ。{artist}の活動を追い続けているMUSE編集部としても、今後の動向に注目している。K-POPシーン全体にとっても意義のある出来事と言えるだろう。',
    ],
    closing: [
      'MUSE編集部では引き続き{artist}の最新情報をお届けしてまいります。今後の展開にもご注目ください。',
      '{artist}に関する新たな情報が入り次第、MUSEでお伝えする。最新のK-POP・K-CULTUREニュースは、MUSEでチェック。',
      'MUSE編集部がこれからも最前線の情報をお届けする。{artist}の活躍を引き続き応援していく。',
    ],
  },
};

// Generic (no artist) body templates
const NO_ARTIST_BODY = {
  opening: [
    'K-POPシーンに新たなニュースが飛び込んできた。MUSE編集部が注目するこの話題について、詳しくお伝えする。',
    'エンターテインメント業界の最新動向をお届けする。今回は特に注目度の高いトピックをピックアップした。',
    'K-CULTUREの最前線から、見逃せないニュースが届いた。MUSEならではの視点で深掘りしていく。',
    '今最も話題となっているエンタメニュースを、MUSE編集部がキャッチした。その詳細に迫る。',
  ],
  analysis: [
    '今回の話題は、K-POPファンのみならず、エンタメ業界全体にとっても注目すべき動きだ。SNS上でも様々な意見が交わされており、議論が活発に行われている。今後の展開次第では、さらに大きな話題に発展する可能性もある。',
    'この件に関して業界関係者からは様々な見解が示されている。K-POPシーンが急速に変化する中、こうした動きは今後のトレンドを占う上でも重要な指標となるだろう。MUSE編集部としても引き続き注視していく。',
    '詳細を見ていくと、この話題の背景にはK-POPシーンの構造的な変化があることがわかる。グローバル市場の拡大とファン文化の進化が、こうしたニュースの生まれる土壌を作っている。',
  ],
  closing: [
    'MUSE編集部では最新のK-POP・K-CULTUREニュースを随時お届けしている。今後の展開にもぜひご注目いただきたい。',
    '引き続きMUSE編集部がエンタメ業界の最前線から情報をお届けする。最新ニュースはMUSEでチェック。',
    '今後も見逃せないニュースが続々と届きそうだ。MUSE編集部が厳選した情報をいち早くお届けしていく。',
  ],
};

// Shared expansion paragraphs — used across all topics to create longer articles
const SHARED_PARAGRAPHS = {
  background: [
    '{artist}はこれまでの活動を通じて、着実にファンベースを拡大してきた。デビュー以来、音楽性の幅を広げながらも自分たちらしさを失わないスタイルが、多くのリスナーに支持されている。特に最近では海外市場での認知度も急速に高まっている。',
    '{artist}の歩みを振り返ると、常にチャレンジと成長の連続だったことがわかる。初期の頃から一貫して高い目標を掲げ、それを一つずつ実現してきた姿勢が、現在の地位を築く原動力となっている。',
    'K-POP業界において{artist}が占めるポジションは独特だ。他のアーティストとは異なる音楽的アイデンティティを確立しており、それが{artist}の最大の武器となっている。業界関係者の間でも、{artist}の方向性に対する評価は高い。',
    'グローバルK-POPシーンにおいて、{artist}の存在感は年々増している。各国の音楽チャートやSNSでの反応を見ると、{artist}の影響力が世界的な規模で拡大していることは明らかだ。特にアジア圏での人気は圧倒的で、日本でも熱心なファンが増え続けている。',
    '{artist}のこれまでの軌跡を辿ると、常に自らの限界を超えようとする挑戦の連続だった。音楽、パフォーマンス、ビジュアルのすべてにおいて高い基準を設定し、それを超え続けてきた。その姿勢がファンの心を掴んで離さない理由の一つだ。',
    '業界データによると、{artist}の楽曲のストリーミング再生回数は前年比で大幅な成長を見せている。SNSのフォロワー数も右肩上がりで推移しており、デジタルプレゼンスの強化が{artist}の活動全体にポジティブな影響を与えている。',
  ],
  detail: [
    '今回の件について関係者からのコメントを総合すると、{artist}は入念な準備を重ねてきたことがわかる。細部にまでこだわる{artist}の姿勢は、結果の質に直結している。スタッフやコラボレーターからも、{artist}のプロ意識に対する称賛の声が聞かれる。',
    'SNSでは{artist}に関する投稿が急増しており、ファンの間での関心の高さが数字にも表れている。Xではトレンドワードとして{artist}の名前が何度もランクインし、関連ハッシュタグも世界的にトレンド入りを果たした。この反響の大きさは、{artist}の影響力の証明だ。',
    '{artist}の今回の動きは、K-POPの現在のトレンドとも密接に関連している。グローバル市場の拡大、デジタルファースト戦略の浸透、ファンエンゲージメントの進化といった業界全体の流れの中で、{artist}は常に先進的な取り組みを行っている。',
    'ファンコミュニティの分析によると、{artist}のコンテンツはリリースのたびに話題性が増しており、今回も例外ではない。ファンが自発的に作成するリアクション動画やファンアートが大量に投稿され、二次的な話題の波を生み出している。このバイラル効果は{artist}の強みの一つだ。',
    '音楽評論家の間では、{artist}の音楽的アプローチについて様々な分析が行われている。{artist}の楽曲に共通するのは、キャッチーさと深みの両立だ。初聴でのインパクトと、聴き込むほどに発見がある構造が、幅広い層からの支持につながっている。',
    '今回の{artist}の活動は、所属事務所の戦略とも密接に関わっている。綿密なスケジュール管理とプロモーション戦略が、{artist}の持つポテンシャルを最大限に引き出している。チームワークの質の高さが、アウトプットのクオリティに直結していると言えるだろう。',
    '{artist}を取り巻く市場環境も変化している。K-POPのグローバル化が加速する中、{artist}はその最前線で活躍するアーティストの一組だ。海外フェスティバルへの出演やグローバルメディアへの露出も増加傾向にあり、国際的な知名度は今後さらに上昇すると予想される。',
  ],
  reaction: [
    'ファンの間では今回の件について、多くのリアクションが寄せられている。「待っていた甲斐があった」「期待以上」といったポジティブな声が大多数を占めており、{artist}への支持の厚さが改めて確認された。一部のファンは感動のあまり涙したと投稿している。',
    'SNS上のファンの声を集約すると、「{artist}だからこそできること」という意見が目立つ。長年のファンも新規ファンも共通して{artist}のクオリティの高さを称えており、ファンダム全体が一体となって{artist}を応援する姿勢が印象的だ。',
    '今回の{artist}の動きに対して、他のK-POPファンダムからも好意的な反応が見られた。ジャンルや推しを超えて{artist}の実力を認める声が多く、K-POPファン全体の中での{artist}の位置づけが改めて浮き彫りになった。',
    '日本のファンコミュニティでは特に大きな盛り上がりを見せている。日本語でのファンアカウントでは詳細な情報共有が活発に行われ、{artist}への愛情と期待が溢れるツイートが連日タイムラインを賑わせている。日本公演の開催を望む声も多い。',
    '海外ファンの反応も非常に熱い。英語圏、東南アジア、中南米など世界各地のファンがSNSで{artist}への支持を表明しており、グローバルファンダムの結束力は健在だ。各国のファンサイトやコミュニティでも今回のニュースが大きく取り上げられている。',
  ],
  impact: [
    '今回の{artist}の動きは、K-POP業界全体にも一定の影響を与えると見られている。{artist}が示す新たな方向性は、後続のアーティストにとっても参考になるモデルケースとなり得る。業界のトレンドを牽引する立場としての{artist}の役割は、今後ますます重要になるだろう。',
    'エンタメ業界のアナリストは、{artist}の今回の件が市場に与えるインパクトを注視している。K-POPコンテンツの消費パターンが変化する中、{artist}のアプローチは今後の業界のスタンダードになる可能性を秘めている。',
    '文化的な観点から見ると、{artist}の活動は韓国文化のグローバルな発信という面でも大きな意義を持つ。K-POPを通じて世界中の人々が韓国文化に触れ、相互理解が深まることは、エンターテインメントが持つ力の象徴と言える。',
    '{artist}の今回のプロジェクトは、K-POPの可能性をさらに広げるものとして評価されている。既存の枠組みにとらわれない{artist}のクリエイティビティは、音楽産業全体にとっても刺激的な事例だ。こうした革新的な取り組みが、業界の持続的な成長を支えている。',
  ],
  // Used when no artist is found
  noArtist: {
    background: [
      'K-POPシーンは近年、急速なグローバル化を遂げている。韓国発のエンターテインメントコンテンツは、音楽だけでなくドラマ、映画、ファッションなど多方面で世界的な影響力を持つようになった。この流れの中で、今回のニュースは特に注目に値する。',
      'エンターテインメント業界の構造は、デジタル技術の進化とともに大きく変容している。SNSの普及により、アーティストとファンの距離が縮まり、コンテンツの消費パターンも多様化した。こうした変化の中で生まれた今回の動きは、業界の最新トレンドを反映している。',
      'K-POPが世界の音楽市場で確固たる地位を築くまでの道のりは、長い試行錯誤の連続だった。しかし現在、韓国のエンタメ産業は年間数十億ドル規模の市場に成長し、文化輸出の柱として国際的に認知されている。',
    ],
    detail: [
      'この話題の詳細を掘り下げると、K-POPエコシステムの複雑さが見えてくる。アーティスト、プロデューサー、マネジメント、ファンコミュニティが有機的に連携し、コンテンツの価値を最大化する仕組みが確立されている。今回の件もその一例と言える。',
      'データで見ると、K-POPコンテンツのグローバル消費量は過去数年で飛躍的に増加している。ストリーミングプラットフォームでの再生回数、SNSでのエンゲージメント率、コンサートの動員数など、あらゆる指標が上昇傾向にある。',
      'この動きの背景には、ファンカルチャーの進化がある。現代のK-POPファンは単なる消費者ではなく、コンテンツの共同創造者としての役割も担っている。ファンが自発的に翻訳、宣伝、分析を行い、アーティストの認知拡大に貢献するエコシステムは、K-POP独自のものだ。',
    ],
    reaction: [
      'この話題に対するオンライン上の反応は非常に活発だ。K-POPファンコミュニティでは、様々な角度からの分析や意見が交わされている。特に注目すべきは、ファン同士の建設的な議論が多く見られることだ。',
      '日本のK-POPファンの間でも、この件は大きな関心を集めている。韓国のエンタメ情報をリアルタイムで追うファンにとって、今回のニュースは見逃せないトピックだ。SNS上では情報の共有と分析が活発に行われている。',
    ],
    impact: [
      'エンターテインメント業界全体の観点から見ると、今回の件は業界の今後の方向性を示唆する重要な出来事だ。K-POPが世界の音楽シーンに与える影響は年々大きくなっており、この流れは今後も続くと予想される。',
      '文化産業の発展という観点からも、今回のニュースは意義深い。エンターテインメントが国境を越えて人々をつなぐ力は、現代社会においてますます重要性を増している。K-POPはその最前線に立つジャンルだ。',
    ],
  }
};

function rewriteArticleBody(articleContent, title) {
  const artist = extractArtist(title) || (articleContent ? extractArtistFromParagraphs(articleContent.paragraphs) : null);
  const topic = classifyTopic(title);

  // Determine target length based on original content
  const originalLength = articleContent?.paragraphs?.length || 0;
  const targetParagraphs = Math.max(8, Math.min(12, originalLength || 8));

  // Collect inline images from original article (skip first which is hero)
  const inlineImages = (articleContent?.images || []).slice(1, 4); // Up to 3 inline images

  const paragraphs = [];
  const usedTexts = new Set();
  const pickUnique = (arr) => {
    const available = arr.filter(t => !usedTexts.has(t));
    if (available.length === 0) return arr[Math.floor(Math.random() * arr.length)];
    const picked = available[Math.floor(Math.random() * available.length)];
    usedTexts.add(picked);
    return picked;
  };
  const shuffleAndPickUnique = (arr, n) => {
    const available = arr.filter(t => !usedTexts.has(t));
    const shuffled = [...available].sort(() => Math.random() - 0.5);
    const picked = shuffled.slice(0, Math.min(n, shuffled.length));
    for (const p of picked) usedTexts.add(p);
    return picked;
  };

  if (artist) {
    const templates = BODY_TEMPLATES[topic] || BODY_TEMPLATES.general;
    const sub = (text) => text.replace(/\{artist\}/g, artist);

    paragraphs.push({ type: 'intro', text: sub(pickUnique(templates.opening)) });

    const bgCount = targetParagraphs >= 10 ? 2 : 1;
    for (const bg of shuffleAndPickUnique(SHARED_PARAGRAPHS.background, bgCount)) {
      paragraphs.push({ type: 'body', text: sub(bg) });
    }

    const analysisCount = targetParagraphs >= 10 ? 3 : 2;
    for (const a of shuffleAndPickUnique(templates.analysis, analysisCount)) {
      paragraphs.push({ type: 'body', text: sub(a) });
    }

    if (inlineImages.length > 0) {
      paragraphs.push({ type: 'image', src: inlineImages[0] });
    }

    const detailCount = targetParagraphs >= 10 ? 2 : 1;
    for (const d of shuffleAndPickUnique(SHARED_PARAGRAPHS.detail, detailCount)) {
      paragraphs.push({ type: 'body', text: sub(d) });
    }

    const reactionCount = targetParagraphs >= 10 ? 2 : 1;
    for (const r of shuffleAndPickUnique(SHARED_PARAGRAPHS.reaction, reactionCount)) {
      paragraphs.push({ type: 'body', text: sub(r) });
    }

    if (inlineImages.length > 1) {
      paragraphs.push({ type: 'image', src: inlineImages[1] });
    }

    paragraphs.push({ type: 'body', text: sub(pickUnique(SHARED_PARAGRAPHS.impact)) });
    paragraphs.push({ type: 'closing', text: sub(pickUnique(templates.closing)) });

  } else {
    paragraphs.push({ type: 'intro', text: pickUnique(NO_ARTIST_BODY.opening) });

    for (const bg of shuffleAndPickUnique(SHARED_PARAGRAPHS.noArtist.background, 2)) {
      paragraphs.push({ type: 'body', text: bg });
    }

    for (const a of shuffleAndPickUnique(NO_ARTIST_BODY.analysis, 2)) {
      paragraphs.push({ type: 'body', text: a });
    }

    if (inlineImages.length > 0) {
      paragraphs.push({ type: 'image', src: inlineImages[0] });
    }

    for (const d of shuffleAndPickUnique(SHARED_PARAGRAPHS.noArtist.detail, 2)) {
      paragraphs.push({ type: 'body', text: d });
    }

    for (const r of shuffleAndPickUnique(SHARED_PARAGRAPHS.noArtist.reaction, 1)) {
      paragraphs.push({ type: 'body', text: r });
    }

    if (inlineImages.length > 1) {
      paragraphs.push({ type: 'image', src: inlineImages[1] });
    }

    paragraphs.push({ type: 'body', text: pickUnique(SHARED_PARAGRAPHS.noArtist.impact) });
    paragraphs.push({ type: 'closing', text: pickUnique(NO_ARTIST_BODY.closing) });
  }

  return { paragraphs };
}

// Try to find an artist name in the first few paragraphs of article content
function extractArtistFromParagraphs(paragraphs) {
  if (!paragraphs || paragraphs.length === 0) return null;
  const sample = paragraphs.slice(0, 3).join(' ');
  return extractArtist(sample);
}

// Shuffle array and pick N items
function shuffleAndPick(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

// ============================================================
// HTML escaping
// ============================================================

function escapeHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================
// Build image tag helper
// ============================================================

function imgTag(article, width, height, loading = 'lazy') {
  const src = escapeHtml(article.image || PLACEHOLDER_IMAGE);
  const fallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/${width}/${height}`;
  return `<img src="${src}" alt="${escapeHtml(article.title)}" width="${width}" height="${height}" loading="${loading}" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;
}

// For article pages, image paths need to go up one level (../images/)
function imgTagForArticle(article, width, height, loading = 'lazy') {
  let src = article.image || PLACEHOLDER_IMAGE;
  // If it's a local image path, prefix with ../
  if (src.startsWith('images/')) {
    src = '../' + src;
  }
  const escapedSrc = escapeHtml(src);
  const fallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/${width}/${height}`;
  return `<img src="${escapedSrc}" alt="${escapeHtml(article.title)}" width="${width}" height="${height}" loading="${loading}" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;
}

// ============================================================
// Section generators — internal links with source attribution
// ============================================================

function generateHeroMain(article) {
  if (!article) return '';
  return `<a href="${escapeHtml(article.localUrl)}" class="hero-main">
          ${imgTag(article, 760, 760, 'eager')}
          <div class="hero-main-overlay">
            <span class="category-badge">${escapeHtml(displayCategory(article.category))}</span>
            <h2>${escapeHtml(article.title)}</h2>
            <span class="date">${escapeHtml(article.formattedDate)}</span>
            <span class="source-credit">出典: ${escapeHtml(article.source)}</span>
          </div>
        </a>`;
}

function generateHeroSideItem(article) {
  if (!article) return '';
  return `<a href="${escapeHtml(article.localUrl)}" class="hero-side-item">
            ${imgTag(article, 200, 200, 'eager')}
            <div class="text">
              <h3>${escapeHtml(article.title)}</h3>
              <span class="date">${escapeHtml(article.formattedDate)}</span>
              <span class="source-credit">出典: ${escapeHtml(article.source)}</span>
            </div>
          </a>`;
}

function generatePickupCard(article) {
  if (!article) return '';
  return `<a href="${escapeHtml(article.localUrl)}" class="pickup-card">
          <div class="thumb">
            ${imgTag(article, 400, 225)}
          </div>
          <h3>${escapeHtml(article.title)}</h3>
          <span class="date">${escapeHtml(article.formattedDate)}</span>
          <span class="source-credit">出典: ${escapeHtml(article.source)}</span>
        </a>`;
}

function generateNewsItem(article) {
  if (!article) return '';
  return `<a href="${escapeHtml(article.localUrl)}" class="news-item">
          ${imgTag(article, 256, 256)}
          <div class="text">
            <div class="news-category">${escapeHtml(displayCategory(article.category))}</div>
            <h3>${escapeHtml(article.title)}</h3>
            <span class="date">${escapeHtml(article.formattedDate)}</span>
            <span class="source-credit">出典: ${escapeHtml(article.source)}</span>
          </div>
        </a>`;
}

function generateRankingItem(article, rank) {
  if (!article) return '';
  const rankClass = rank <= 3 ? 'rank top3' : 'rank';
  const dataCat = mapCategory(article.category);
  return `<a href="${escapeHtml(article.localUrl)}" class="ranking-item" data-category="${dataCat}">
          <span class="${rankClass}">${rank}</span>
          ${imgTag(article, 144, 144)}
          <div class="text">
            <h3>${escapeHtml(article.title)}</h3>
            <span class="date">${escapeHtml(article.formattedDate)}</span>
            <span class="source-credit">出典: ${escapeHtml(article.source)}</span>
          </div>
        </a>`;
}

function generateInterviewCard(article) {
  if (!article) return '';
  return `<a href="${escapeHtml(article.localUrl)}" class="interview-card">
          <div class="thumb">
            ${imgTag(article, 400, 225)}
          </div>
          <span class="interview-badge">INTERVIEW</span>
          <h3>${escapeHtml(article.title)}</h3>
          <span class="date">${escapeHtml(article.formattedDate)}</span>
          <span class="source-credit">出典: ${escapeHtml(article.source)}</span>
        </a>`;
}

function generatePhotoItem(article) {
  if (!article) return '';
  return `<a href="${escapeHtml(article.localUrl)}" class="photo-item">
          ${imgTag(article, 400, 400)}
          <div class="photo-overlay">${escapeHtml(article.title.slice(0, 40))}<br><span style="font-size:9px;opacity:0.7">&copy;${escapeHtml(article.source)}</span></div>
        </a>`;
}

// ============================================================
// Generate article HTML pages
// ============================================================

async function generateArticlePages(allArticles, usedArticles) {
  await mkdir(ARTICLES_DIR, { recursive: true });

  const templatePath = join(__dirname, 'article-template.html');
  const articleTemplate = await readFile(templatePath, 'utf-8');

  log(`Generating ${usedArticles.length} article pages...`);

  // Pre-assign localUrl to ALL usedArticles before generating pages.
  // This ensures that when related articles are picked, they already
  // have a valid localUrl instead of falling back to '../index.html'.
  for (let i = 0; i < usedArticles.length; i++) {
    const filename = `article-${String(i + 1).padStart(3, '0')}.html`;
    usedArticles[i].localUrl = `articles/${filename}`;
  }

  let generated = 0;

  for (let i = 0; i < usedArticles.length; i++) {
    const article = usedArticles[i];
    const filename = `article-${String(i + 1).padStart(3, '0')}.html`;

    // Find related articles (same category, different article)
    // Only pick articles that have a localUrl so links are never broken
    const related = allArticles
      .filter(a => a !== article && a.image && a.localUrl)
      .slice(0, 20) // from a pool
      .sort(() => Math.random() - 0.5) // shuffle
      .slice(0, 3); // take 3

    // Build article body
    const bodyData = rewriteArticleBody(article.articleContent, article.title);

    let bodyHtml = '';
    for (const item of bodyData.paragraphs) {
      if (item.type === 'intro') {
        bodyHtml += `<div class="editorial-intro">${escapeHtml(item.text)}</div>\n`;
      } else if (item.type === 'closing') {
        bodyHtml += `        <div class="editorial-closing">${escapeHtml(item.text)}</div>`;
      } else if (item.type === 'image') {
        const imgSrc = item.src.startsWith('http') ? item.src : item.src;
        const fallback = `https://picsum.photos/seed/inline-${Math.random().toString(36).slice(2,8)}/760/428`;
        bodyHtml += `        <figure class="article-inline-image">
          <img src="${escapeHtml(imgSrc)}" alt="" width="760" height="428" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">
        </figure>\n`;
      } else {
        bodyHtml += `        <p>${escapeHtml(item.text)}</p>\n`;
      }
    }

    // Build hero image
    let heroImgSrc = article.image || PLACEHOLDER_IMAGE;
    if (heroImgSrc.startsWith('images/')) {
      heroImgSrc = '../' + heroImgSrc;
    }
    const heroFallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/800/450`;
    const heroImg = `<img src="${escapeHtml(heroImgSrc)}" alt="${escapeHtml(article.title)}" width="760" height="428" loading="eager" referrerpolicy="no-referrer" data-fallback="${escapeHtml(heroFallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;

    // Build related articles
    let relatedHtml = '';
    for (const rel of related) {
      // Related article URLs: localUrl is guaranteed by the filter above
      const relUrl = `../${rel.localUrl}`;
      let relImgSrc = rel.image || PLACEHOLDER_IMAGE;
      if (relImgSrc.startsWith('images/')) {
        relImgSrc = '../' + relImgSrc;
      }
      const relFallback = `https://picsum.photos/seed/${encodeURIComponent(rel.title.slice(0, 20))}/400/225`;
      relatedHtml += `
          <a href="${escapeHtml(relUrl)}" class="related-card">
            <div class="thumb">
              <img src="${escapeHtml(relImgSrc)}" alt="${escapeHtml(rel.title)}" width="400" height="225" loading="lazy" referrerpolicy="no-referrer" data-fallback="${escapeHtml(relFallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">
            </div>
            <div class="related-category">${escapeHtml(displayCategory(rel.category))}</div>
            <h3>${escapeHtml(rel.title)}</h3>
            <span class="date">${escapeHtml(rel.formattedDate)}</span>
          </a>`;
    }

    // Build source attribution
    const sourceAttribution = `<div class="source-attribution">
          出典: <a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(article.source)}</a>
          <br><a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer" class="read-original">元記事を読む &rarr;</a>
        </div>`;

    // Build photo credit
    const photoCredit = `写真: &copy;${escapeHtml(article.source)}`;

    // Fill template
    let html = articleTemplate
      .replace(/\{\{ARTICLE_TITLE\}\}/g, escapeHtml(article.title))
      .replace('{{ARTICLE_DESCRIPTION}}', escapeHtml(article.title).slice(0, 160))
      .replace('{{ARTICLE_IMAGE}}', escapeHtml(heroImgSrc))
      .replace('{{ARTICLE_CATEGORY}}', escapeHtml(displayCategory(article.category)))
      .replace('{{ARTICLE_DATE}}', escapeHtml(article.formattedDate))
      .replace('{{ARTICLE_HERO_IMAGE}}', heroImg)
      .replace('{{ARTICLE_BODY}}', bodyHtml)
      .replace('{{SOURCE_ATTRIBUTION}}', sourceAttribution)
      .replace('{{PHOTO_CREDIT}}', photoCredit)
      .replace('{{RELATED_ARTICLES}}', relatedHtml);

    const outputPath = join(ARTICLES_DIR, filename);
    await writeFile(outputPath, html, 'utf-8');
    generated++;
  }

  log(`  Generated ${generated} article pages`);
}

// ============================================================
// Assign articles to sections
// ============================================================

const HERO_OFFSET = 0;

function assignSections(articles) {
  let placeholderIdx = 0;
  for (const article of articles) {
    if (!article.image) {
      placeholderIdx++;
      article.image = `https://picsum.photos/seed/muse-${placeholderIdx}-${Date.now() % 10000}/800/450`;
      article.hasPlaceholder = true;
    }
  }

  const withRealImages = articles.filter(a => !a.hasPlaceholder);
  const all = [...articles];

  const used = new Set();

  const take = (pool, count) => {
    const result = [];
    for (const article of pool) {
      if (result.length >= count) break;
      if (!used.has(article.link)) {
        result.push(article);
        used.add(article.link);
      }
    }
    return result;
  };

  const heroCandidates = withRealImages.length >= 4 ? withRealImages : all;
  // Skip HERO_OFFSET articles to differentiate hero across magazines
  const heroSkipped = heroCandidates.slice(HERO_OFFSET);
  const heroMain = take(heroSkipped.length ? heroSkipped : heroCandidates, 1);
  const heroSide = take(heroCandidates, 3);
  const pickup = take(all, 6);
  const news = take(all, 6);
  const ranking = take(all, 5);

  const interviewCandidates = articles.filter(
    a => !used.has(a.link) && (
      a.categories.some(c => c.toLowerCase().includes('interview')) ||
      a.title.toLowerCase().includes('interview')
    )
  );
  const interview = interviewCandidates.length >= 3
    ? take(interviewCandidates, 3)
    : take(all, 3);

  const photoWithImages = articles.filter(a => !used.has(a.link) && !a.hasPlaceholder);
  const photo = photoWithImages.length >= 4
    ? take(photoWithImages, 8)
    : take(all, 8);

  return {
    heroMain: heroMain[0] || null,
    heroSide,
    pickup,
    news,
    ranking,
    interview,
    photo,
  };
}

// ============================================================
// Generate index HTML
// ============================================================

async function generateHtml(sections) {
  const templatePath = join(__dirname, 'template.html');
  let template = await readFile(templatePath, 'utf-8');

  template = template.replace(
    '{{HERO_MAIN}}',
    sections.heroMain ? generateHeroMain(sections.heroMain) : ''
  );

  template = template.replace(
    '{{HERO_SIDE_ITEMS}}',
    sections.heroSide.map(a => generateHeroSideItem(a)).join('\n          ')
  );

  template = template.replace(
    '{{PICKUP_ITEMS}}',
    sections.pickup.map(a => generatePickupCard(a)).join('\n        ')
  );

  template = template.replace(
    '{{NEWS_ITEMS}}',
    sections.news.map(a => generateNewsItem(a)).join('\n        ')
  );

  template = template.replace(
    '{{RANKING_ITEMS}}',
    sections.ranking.map((a, i) => generateRankingItem(a, i + 1)).join('\n        ')
  );

  template = template.replace(
    '{{INTERVIEW_ITEMS}}',
    sections.interview.map(a => generateInterviewCard(a)).join('\n        ')
  );

  template = template.replace(
    '{{PHOTO_ITEMS}}',
    sections.photo.map(a => generatePhotoItem(a)).join('\n        ')
  );

  // Remove {{GENERATED_AT}} if still present in template
  template = template.replace('{{GENERATED_AT}}', '');

  return template;
}

// ============================================================
// Main
// ============================================================

async function main() {
  log('Starting MUSE Magazine RSS Crawler...');
  log('');

  // 1. Fetch all RSS feeds
  const articles = await fetchAllFeeds();
  if (articles.length === 0) {
    warn('No articles fetched. Aborting.');
    process.exit(1);
  }
  log('');

  // 2. Fill missing images via og:image
  await fillMissingImages(articles);
  log('');

  // 3. Rewrite ALL titles to Japanese (with deduplication)
  log('Rewriting titles to Japanese editorial style...');
  let rewritten = 0;
  const usedTitles = new Set();
  for (const article of articles) {
    const original = article.title;
    article.originalTitle = original;
    // Attempt up to 15 times to get a unique title
    let candidate = rewriteTitle(original, article.source);
    let attempts = 0;
    while (usedTitles.has(candidate) && attempts < 15) {
      candidate = rewriteTitle(original, article.source);
      attempts++;
    }
    // If still duplicate after 15 attempts, append a distinguishing suffix
    if (usedTitles.has(candidate)) {
      const artist = extractArtist(original);
      const suffix = artist ? ` — ${article.source}発` : `（${article.source}）`;
      candidate = candidate + suffix;
      // If STILL duplicate, add index
      if (usedTitles.has(candidate)) {
        candidate = candidate + ` #${usedTitles.size + 1}`;
      }
    }
    usedTitles.add(candidate);
    article.title = candidate;
    if (article.title !== original) rewritten++;
  }
  log(`  Rewritten ${rewritten}/${articles.length} titles (all unique)`);
  log('');

  // 4. Assign articles to sections
  const sections = assignSections(articles);

  // Collect all used articles for article page generation
  const usedArticles = [];
  const usedSet = new Set();
  const addUsed = (arr) => {
    for (const a of arr) {
      if (a && !usedSet.has(a.link)) {
        usedArticles.push(a);
        usedSet.add(a.link);
      }
    }
  };
  if (sections.heroMain) addUsed([sections.heroMain]);
  addUsed(sections.heroSide);
  addUsed(sections.pickup);
  addUsed(sections.news);
  addUsed(sections.ranking);
  addUsed(sections.interview);
  addUsed(sections.photo);

  // 5. Download images locally
  const withImages = articles.filter(a => a.image).length;
  log(`Articles with images: ${withImages}/${articles.length}`);
  await downloadArticleImages(usedArticles);
  log('');

  // 6. Fetch full article content for used articles
  await fetchAllArticleContent(usedArticles);
  log('');

  // 7. Generate individual article pages
  await generateArticlePages(articles, usedArticles);
  log('');

  // 8. Generate index HTML from template
  const html = await generateHtml(sections);

  // 9. Write index output
  const outputPath = join(__dirname, 'index.html');
  await writeFile(outputPath, html, 'utf-8');

  const totalUsed =
    (sections.heroMain ? 1 : 0) +
    sections.heroSide.length +
    sections.pickup.length +
    sections.news.length +
    sections.ranking.length +
    sections.interview.length +
    sections.photo.length;

  log(`Generated index.html with ${totalUsed} articles`);
  log(`Generated ${usedArticles.length} article pages in articles/`);
  log(`Done! Open: file://${outputPath}`);
}

main().catch((err) => {
  console.error('[MUSE Crawler] Fatal error:', err);
  process.exit(1);
});
