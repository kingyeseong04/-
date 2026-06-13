/* ─── ChemDigest — Chemistry News Digest ─── */

// ── RSS Sources ──────────────────────────────────────────────────────────────
const SOURCES = [
  {
    id: 'sciday',
    name: 'ScienceDaily',
    label: 'ScienceDaily',
    url: 'https://www.sciencedaily.com/rss/matter_energy/chemistry.xml',
    badge: 'src-sciday',
  },
  {
    id: 'phys',
    name: 'Phys.org',
    label: 'Phys.org',
    url: 'https://phys.org/rss-feed/chemistry-news/',
    badge: 'src-phys',
  },
  {
    id: 'cen',
    name: 'C&EN',
    label: 'C&EN',
    url: 'https://cen.acs.org/rss/latest.xml',
    badge: 'src-cen',
  },
  {
    id: 'rsc',
    name: 'RSC Chemistry World',
    label: 'RSC',
    url: 'https://www.chemistryworld.com/rss/news.xml',
    badge: 'src-rsc',
  },
  {
    id: 'acs',
    name: 'ACS Publications',
    label: 'ACS',
    url: 'https://pubs.acs.org/action/showFeed?type=axatoc&feed=rss&jc=jcisd8',
    badge: 'src-acs',
  },
];

// ── Chemistry field keyword mapping ─────────────────────────────────────────
const FIELDS = {
  organic: {
    label: '유기화학',
    keywords: ['organic', 'synthesis', 'catalysis', 'catalyst', 'reaction mechanism',
               'carbon', 'alkene', 'alkyne', 'aromatic', 'stereoselective',
               'enantioselective', 'asymmetric', 'ligand', 'organocatalysis',
               'total synthesis', 'natural product', 'covalent bond', 'hydrocarbon'],
    color: '#16a34a', bg: '#dcfce7',
  },
  inorganic: {
    label: '무기화학',
    keywords: ['inorganic', 'metal complex', 'coordination', 'transition metal',
               'crystal structure', 'zeolite', 'metal-organic framework', 'MOF',
               'solid state', 'oxide', 'nitride', 'carbide', 'silicate',
               'semiconductor', 'ionic', 'electrocatalysis', 'photocatalysis'],
    color: '#2563eb', bg: '#dbeafe',
  },
  biochem: {
    label: '생화학',
    keywords: ['biochem', 'protein', 'enzyme', 'dna', 'rna', 'gene', 'amino acid',
               'peptide', 'lipid', 'metaboli', 'biological', 'cell', 'receptor',
               'antibody', 'biosynthesis', 'genome', 'crispr', 'epigenetic',
               'ribozyme', 'nucleotide', 'glycan', 'proteomics', 'molecular biology'],
    color: '#dc2626', bg: '#fee2e2',
  },
  materials: {
    label: '재료화학',
    keywords: ['material', 'battery', 'electrode', 'solar cell', 'photovoltaic',
               'thin film', 'composite', 'alloy', 'ceramic', 'graphene',
               'carbon nanotube', 'perovskite', 'superconductor', 'ferroelectric',
               'piezoelectric', 'magnetic', 'coating', 'corrosion', 'fuel cell',
               'energy storage', 'lithium', 'electrolyte'],
    color: '#7c3aed', bg: '#ede9fe',
  },
  analytical: {
    label: '분석화학',
    keywords: ['analytical', 'spectroscopy', 'chromatography', 'detection',
               'sensor', 'biosensor', 'mass spectrometry', 'nmr', 'fluorescence',
               'electrochemical', 'microscopy', 'imaging', 'probe', 'assay',
               'hplc', 'gc-ms', 'raman', 'infrared', 'x-ray diffraction',
               'quantification', 'trace', 'biomarker'],
    color: '#ea580c', bg: '#ffedd5',
  },
  physical: {
    label: '물리화학',
    keywords: ['physical chemistry', 'quantum', 'thermodynamics', 'kinetics',
               'surface chemistry', 'adsorption', 'diffusion', 'electrochemistry',
               'photochemistry', 'computational', 'density functional', 'dft',
               'molecular dynamics', 'ab initio', 'spectral', 'band gap',
               'entropy', 'reaction rate', 'potential energy', 'molecular simulation'],
    color: '#0891b2', bg: '#e0f2fe',
  },
  environmental: {
    label: '환경화학',
    keywords: ['environmental', 'pollution', 'contaminant', 'water treatment',
               'atmospheric', 'climate', 'carbon dioxide', 'co2', 'greenhouse',
               'remediation', 'wastewater', 'heavy metal', 'pesticide',
               'plastic degradation', 'microplastic', 'ozone', 'air quality',
               'soil contamination', 'biodegradable', 'green chemistry', 'sustainable'],
    color: '#65a30d', bg: '#ecfccb',
  },
  medicinal: {
    label: '의약화학',
    keywords: ['drug', 'pharmaceutical', 'medicine', 'therapeutic', 'clinical',
               'anticancer', 'antimicrobial', 'antibiotic', 'antiviral',
               'pharmacology', 'bioavailability', 'toxicity', 'inhibitor',
               'scaffold', 'lead compound', 'drug discovery', 'hit compound',
               'pharmacokinetic', 'medicinal chemistry', 'chemotherapy'],
    color: '#e11d48', bg: '#ffe4e6',
  },
  nano: {
    label: '나노화학',
    keywords: ['nanoparticle', 'nanomaterial', 'quantum dot', 'nanostructure',
               'nanotechnology', 'nanocomposite', 'nanocatalyst', 'gold nanoparticle',
               'silver nanoparticle', 'nanocluster', 'single atom', 'atomic layer',
               'self-assembly', 'supramolecular', 'colloidal', 'nanopore'],
    color: '#d97706', bg: '#fef3c7',
  },
  polymer: {
    label: '고분자화학',
    keywords: ['polymer', 'polymerization', 'copolymer', 'monomer', 'polyethylene',
               'polypropylene', 'polystyrene', 'rubber', 'elastomer', 'resin',
               'crosslink', 'chain length', 'molecular weight', 'radical polymerization',
               'ring-opening', 'living polymerization', 'block copolymer', 'hydrogel',
               'thermoplastic', 'thermoset', 'biopolymer'],
    color: '#9333ea', bg: '#f5f3ff',
  },
};

// ── State ────────────────────────────────────────────────────────────────────
let allArticles = [];
let activeField = 'all';
let activeDays = 1;
let enabledSources = new Set(SOURCES.map(s => s.id));
let autoRefreshTimer = null;

// ── Helpers ──────────────────────────────────────────────────────────────────
function detectField(title, desc) {
  const text = (title + ' ' + desc).toLowerCase();
  for (const [key, def] of Object.entries(FIELDS)) {
    if (def.keywords.some(kw => text.includes(kw))) return key;
  }
  return 'general';
}

function relativeTime(date) {
  const now = new Date();
  const diff = now - date;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 5) return '방금 전';
  if (mins < 60) return `${mins}분 전`;
  if (hours < 24) return `${hours}시간 전`;
  if (days === 1) return '어제';
  if (days < 7) return `${days}일 전`;
  return date.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

function isRecent(date) {
  if (activeDays === 0) return true;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - activeDays);
  cutoff.setHours(0, 0, 0, 0);
  return date >= cutoff;
}

function stripHtml(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html || '';
  return tmp.textContent || tmp.innerText || '';
}

// ── Fetch via rss2json ───────────────────────────────────────────────────────
async function fetchFeed(source) {
  const proxy = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(source.url)}&count=50&api_key=`;
  try {
    const res = await fetch(proxy, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(data.message || 'Feed error');
    return (data.items || []).map(item => {
      const date = new Date(item.pubDate || item.published || Date.now());
      const desc = stripHtml(item.description || item.summary || '').slice(0, 300);
      const field = detectField(item.title || '', desc);
      return {
        id: item.guid || item.link,
        title: item.title || '(제목 없음)',
        summary: desc,
        link: item.link || '#',
        date,
        source: source,
        field,
        isNew: (new Date() - date) < 3600000 * 6, // < 6h
      };
    });
  } catch (e) {
    console.warn(`[ChemDigest] ${source.name} 피드 오류:`, e.message);
    return [];
  }
}

// ── Render card ──────────────────────────────────────────────────────────────
function renderCard(article) {
  const fieldDef = FIELDS[article.field] || { label: '일반', color: '#6b7280', bg: '#f3f4f6' };
  const fieldClass = `field-${article.field}`;

  const card = document.createElement('a');
  card.className = `card ${fieldClass}`;
  card.href = article.link;
  card.target = '_blank';
  card.rel = 'noopener noreferrer';
  card.style.setProperty('--field-color', fieldDef.color);
  card.style.setProperty('--field-bg', fieldDef.bg);

  card.innerHTML = `
    <div class="card-top">
      <div class="card-badges">
        <span class="badge badge-source">${article.source.label}</span>
        <span class="badge badge-field" style="background:${fieldDef.bg};color:${fieldDef.color}">${fieldDef.label}</span>
        ${article.isNew ? '<span class="badge badge-new">NEW</span>' : ''}
      </div>
      <span class="card-date">${relativeTime(article.date)}</span>
    </div>
    <div class="card-title">${article.title}</div>
    ${article.summary ? `<div class="card-summary">${article.summary}</div>` : ''}
    <div class="card-footer">
      <span class="card-link-label">원문 보기 →</span>
      <span class="card-source-name">${article.source.name}</span>
    </div>
  `;
  return card;
}

// ── Apply filters & render ───────────────────────────────────────────────────
function applyFilters() {
  const grid = document.getElementById('news-grid');
  const empty = document.getElementById('empty-state');
  grid.innerHTML = '';

  const filtered = allArticles.filter(a => {
    if (!enabledSources.has(a.source.id)) return false;
    if (!isRecent(a.date)) return false;
    if (activeField !== 'all' && a.field !== activeField) return false;
    return true;
  });

  // Sort by date desc
  filtered.sort((a, b) => b.date - a.date);

  document.getElementById('article-count').textContent =
    filtered.length > 0 ? `${filtered.length}개 기사` : '';

  if (filtered.length === 0) {
    empty.style.display = 'block';
  } else {
    empty.style.display = 'none';
    filtered.forEach(a => grid.appendChild(renderCard(a)));
  }
}

// ── Load all feeds ───────────────────────────────────────────────────────────
async function loadAllFeeds() {
  const statusText = document.getElementById('status-text');
  const loading = document.getElementById('loading-screen');
  const grid = document.getElementById('news-grid');
  const empty = document.getElementById('empty-state');

  loading.style.display = 'flex';
  grid.innerHTML = '';
  empty.style.display = 'none';
  statusText.textContent = '피드를 불러오는 중...';

  const results = await Promise.allSettled(SOURCES.map(fetchFeed));
  allArticles = [];
  results.forEach(r => {
    if (r.status === 'fulfilled') allArticles.push(...r.value);
  });

  // Deduplicate by link
  const seen = new Set();
  allArticles = allArticles.filter(a => {
    if (seen.has(a.link)) return false;
    seen.add(a.link);
    return true;
  });

  loading.style.display = 'none';

  const now = new Date();
  statusText.textContent = `마지막 갱신: ${now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`;

  applyFilters();
}

// ── Build source toggles ─────────────────────────────────────────────────────
function buildSourceToggles() {
  const container = document.getElementById('source-toggles');
  SOURCES.forEach(src => {
    const btn = document.createElement('button');
    btn.className = 'src-toggle active';
    btn.textContent = src.label;
    btn.dataset.src = src.id;
    btn.addEventListener('click', () => {
      if (enabledSources.has(src.id)) {
        enabledSources.delete(src.id);
        btn.classList.remove('active');
      } else {
        enabledSources.add(src.id);
        btn.classList.add('active');
      }
      applyFilters();
    });
    container.appendChild(btn);
  });
}

// ── Event listeners ──────────────────────────────────────────────────────────
function setupEvents() {
  // Field chips
  document.getElementById('filter-chips').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    document.querySelectorAll('#filter-chips .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    activeField = chip.dataset.field;
    applyFilters();
  });

  // Date range chips
  document.querySelector('.date-filter-bar').addEventListener('click', e => {
    const chip = e.target.closest('.chip-sm');
    if (!chip) return;
    document.querySelectorAll('.chip-sm').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    activeDays = parseInt(chip.dataset.days);
    applyFilters();
  });

  // Refresh button
  document.getElementById('refresh-btn').addEventListener('click', () => {
    loadAllFeeds();
  });

  // Theme toggle
  const themeBtn = document.getElementById('theme-btn');
  const savedTheme = localStorage.getItem('chemdigest-theme') || 'light';
  if (savedTheme === 'dark') {
    document.body.classList.add('dark');
    themeBtn.textContent = '☀️';
  }
  themeBtn.addEventListener('click', () => {
    const isDark = document.body.classList.toggle('dark');
    themeBtn.textContent = isDark ? '☀️' : '🌙';
    localStorage.setItem('chemdigest-theme', isDark ? 'dark' : 'light');
  });
}

// ── Date badge ───────────────────────────────────────────────────────────────
function updateDateBadge() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('ko-KR', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
  });
  document.getElementById('date-badge').textContent = dateStr;
}

// ── Auto-refresh every 10 min ─────────────────────────────────────────────────
function scheduleAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => {
    loadAllFeeds();
    updateDateBadge();
  }, 10 * 60 * 1000);
}

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  updateDateBadge();
  setupEvents();
  buildSourceToggles();
  loadAllFeeds();
  scheduleAutoRefresh();
});
