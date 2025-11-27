/* webhook.gs */
const SUPPRESS_FIRST_SEND = false;  // 첫 실행에도 전송

// 1) 스페이스 Webhook URL
const WEBHOOK_URL = 'https://chat.googleapis.com/v1/spaces/AAQAUcz7qjY/messages?key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI&token=ST7kUpV9GdhRO4IYa0CGYoG7hQeu1GIAyZC6rVDjiqE';
const THREAD_KEY   = 'workspace-status';

const ONLY_MAJOR   = true;   // OUTAGE/DISRUPTION만 알림
const ONLY_ONGOING = true;   // end가 없는 '진행 중'만 알림
const MAX_ITEMS    = 5;      // 최대 표시 개수

/** ====== 데이터 소스 ====== **/
const BASE = 'https://www.google.com/appsstatus/dashboard';

/** ====== 유틸/공통 ====== **/
function fetchJson(url) {
  const sep = url.includes('?') ? '&' : '?';
  const full = `${url}${sep}hl=en&nocache=${Date.now()}`;
  const res = UrlFetchApp.fetch(full, { muteHttpExceptions: false });
  return JSON.parse(res.getContentText('utf-8'));
}
function normalizeIncidents(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.incidents)) return raw.incidents;
  return [];
}
function normalizeProducts(raw) {
  const arr = raw?.products ?? (Array.isArray(raw) ? raw : []);
  const map = {};
  arr.forEach(p => map[p.id] = p.title || p.name || p.product_name || p.id);
  return map;
}
function lastUpdate(inc) {
  const u = inc.updates || [];
  return u.length ? u[u.length - 1] : (inc.most_recent_update || null);
}
function fmtUTC(iso){
  if(!iso) return '';
  return Utilities.formatDate(new Date(iso), 'UTC', "yyyy-MM-dd HH:mm:ss '(UTC)'");
}
function postToChatText(text) {
  const url = `${WEBHOOK_URL}&threadKey=${encodeURIComponent(THREAD_KEY)}`;
  const payload = { text };
  const params = {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };
  const res = UrlFetchApp.fetch(url, params);
  Logger.log(res.getResponseCode() + ' ' + res.getContentText());
}

/** ====== 번역/문구 유틸 ====== **/
// 제품명은 영어 그대로 두고, 섹션 텍스트만 한국어 번역
function trKo(s) {
  if (!s) return '';
  try {
    // 원문이 영어가 아닐 수도 있으니 자동 감지 → ko
    return LanguageApp.translate(String(s), '', 'ko');
  } catch (e) {
    Logger.log('Translate fail: ' + e.message);
    return s;
  }
}
function statusKoFromRaw(statusRaw) {
  if (/OUTAGE/i.test(statusRaw)) return '서비스 중단';
  if (/DISRUPTION/i.test(statusRaw)) return '부분 장애';
  return '정보';
}

/** ====== 문자열/제품명 유틸 ====== **/
function toName(x, productMap) {
  if (!x) return null;
  if (typeof x === 'string') return productMap[x] || x;  // id 또는 이름
  return x.title || x.name || x.product_name || (x.id ? (productMap[x.id] || x.id) : null);
}
function collectAllStrings(obj, out) {
  if (!obj) return out || [];
  out = out || [];
  const t = typeof obj;
  if (t === 'string') { out.push(obj); return out; }
  if (t === 'object') {
    if (Array.isArray(obj)) obj.forEach(v => collectAllStrings(v, out));
    else Object.keys(obj).forEach(k => collectAllStrings(obj[k], out));
  }
  return out;
}
function buildNameDictionary(productMap) {
  const set = new Set();
  Object.keys(productMap).forEach(id => {
    const name = productMap[id];
    if (id) set.add(String(id).toLowerCase());
    if (name) set.add(String(name).toLowerCase());
  });
  [
    'gmail','google mail',
    'google drive','drive',
    'google meet','meet',
    'google chat','chat',
    'calendar','google calendar',
    'admin console','admin',
    'google docs','docs',
    'google sheets','sheets',
    'google slides','slides',
    'google forms','forms',
    'google sites','sites',
    'google classroom','classroom',
    'google keep','keep',
    'gcpw','google credential provider for windows',
    'google mdm','mdm','google mdm for windows devices',
    'google identity'
  ].forEach(a => set.add(a));
  return Array.from(set);
}
function scanNamesInTexts(productMap, texts) {
  const hay = (texts || []).filter(Boolean).join(' ').toLowerCase();
  const dict = buildNameDictionary(productMap);
  const hits = new Set();
  dict.forEach(term => {
    if (!term) return;
    if (hay.includes(term)) {
      const exactName = Object.values(productMap).find(n => n && n.toLowerCase() === term);
      if (exactName) { hits.add(exactName); return; }
      const byId = Object.keys(productMap).find(id => id.toLowerCase() === term);
      if (byId) { hits.add(productMap[byId] || byId); return; }
      hits.add(term.replace(/\b\w/g, c => c.toUpperCase()));
    }
  });
  return Array.from(hits);
}
function extractProductNames(inc, productMap) {
  const names = new Set();

  // 1) 구조화 필드
  (inc.products || []).forEach(v => { const n = toName(v, productMap); if (n) names.add(n); });
  (inc.product_ids || []).forEach(v => { const n = toName(v, productMap); if (n) names.add(n); });
  (inc.impacted_products || []).forEach(v => { const n = toName(v, productMap); if (n) names.add(n); });

  const ed = inc.external_desc || {};
  (ed.products || []).forEach(v => { const n = toName(v, productMap); if (n) names.add(n); });
  (ed.impacted_products || ed.affected_products || []).forEach(v => {
    const n = toName(v, productMap); if (n) names.add(n);
  });

  const mru = inc.most_recent_update || {};
  (mru.products || []).forEach(v => { const n = toName(v, productMap); if (n) names.add(n); });
  (mru.impacted_products || mru.affected_products || []).forEach(v => {
    const n = toName(v, productMap); if (n) names.add(n);
  });

  (inc.updates || []).forEach(u => {
    (u.products || []).forEach(v => { const n = toName(v, productMap); if (n) names.add(n); });
    (u.impacted_products || u.affected_products || []).forEach(v => {
      const n = toName(v, productMap); if (n) names.add(n);
    });
  });

  // 2) 없으면 텍스트 전체 스캔
  if (!names.size) {
    const texts = collectAllStrings(inc, []);
    scanNamesInTexts(productMap, texts).forEach(n => names.add(n));
  }

  return Array.from(names);
}

/** ====== 업데이트 섹션 파서 ====== **/
function extractSectionsFromText(text) {
  const out = { Title: '', Description: '', Symptoms: '', Workaround: '' };
  if (!text) return out;
  const src = String(text).replace(/\r/g, '');

  // **Title** 패턴
  const reBold = /\*\*(Title|Description|Symptoms|Workaround)\*\*\s*\n([\s\S]*?)(?=\n\*\*(?:Title|Description|Symptoms|Workaround)\*\*|\s*$)/gi;
  let m, matched = false;
  while ((m = reBold.exec(src)) !== null) {
    const key = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    out[key] = (out[key] ? out[key] + '\n\n' : '') + m[2].trim();
    matched = true;
  }
  if (matched) return out;

  // Plain 헤더
  const rePlain = /^(Title|Description|Symptoms|Workaround)\s*\n([\s\S]*?)(?=^(?:Title|Description|Symptoms|Workaround)\s*$|$)/gmi;
  while ((m = rePlain.exec(src)) !== null) {
    const key = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    out[key] = (out[key] ? out[key] + '\n\n' : '') + m[2].trim();
    matched = true;
  }
  if (matched) return out;

  // 키워드 기반 분류 (fallback)
  const paras = src.split(/\n\s*\n/);
  paras.forEach(p => {
    const low = p.toLowerCase();
    if (low.includes('symptom')) out.Symptoms += (out.Symptoms ? '\n\n' : '') + p.trim();
    else if (low.includes('workaround')) out.Workaround += (out.Workaround ? '\n\n' : '') + p.trim();
    else out.Description += (out.Description ? '\n\n' : '') + p.trim();
  });
  return out;
}

/** ====== 필터 ====== **/
function isMajor(status='') {
  const s = status.toUpperCase();
  return s.includes('OUTAGE') || s.includes('DISRUPTION');
}
function isOngoing(inc) { return !inc.end; }
function keepIncident(inc) {
  const last = lastUpdate(inc) || {};
  if (ONLY_MAJOR && !isMajor(last.status || '')) return false;
  if (ONLY_ONGOING && !isOngoing(inc)) return false;
  return true;
}

/** ====== 메시지 구성 (한국어 표시) ====== **/
function formatLines(items, productMap) {
  return items.slice(0, MAX_ITEMS).map(inc => {
    const last   = lastUpdate(inc) || {};
    const when   = fmtUTC(inc.begin);
    const statusRaw = last.status || '';
    const sev = /OUTAGE/i.test(statusRaw) ? '🔴'
             : /DISRUPTION/i.test(statusRaw) ? '🟠'
             : 'ℹ️';
    const statusKo = statusKoFromRaw(statusRaw);

    // 섹션 파싱 + 한국어 번역 (제품명/URL은 그대로)
    const baseTitle = inc.external_desc?.title || inc.title || 'Incident';
    const sections = extractSectionsFromText(last.text || inc.external_desc?.text || '');
    const titleEn = sections.Title || baseTitle;
    const titleKo = trKo(titleEn);
    const descKo = sections.Description ? trKo(sections.Description) : '';
    const sympKo = sections.Symptoms ? trKo(sections.Symptoms) : '';
    const workKo = sections.Workaround ? trKo(sections.Workaround) : '';

    // 제품명(영어 유지)
    const prodNames = extractProductNames(inc, productMap);
    const prods = (prodNames && prodNames.length) ? prodNames.join(', ') : '—';

    const link = inc.id ? `${BASE}/incidents/${encodeURIComponent(inc.id)}?hl=en` : '';

    // 출력 (한국어 라벨 + 영어 제품명 유지)
    const parts = [
      `${sev} *${titleKo}*`,
      `• 시간: ${when}`,
      `• 상태: ${statusKo}`,
      `• 서비스: ${prods}`,
      link ? `• 링크: ${link}` : ''
    ].filter(Boolean);

    const blocks = [
      '*제목*',
      titleKo,
      descKo ? '\n*설명*\n' + descKo.trim() : '',
      sympKo ? '\n*증상*\n' + sympKo.trim() : '',
      workKo ? '\n*우회 방법*\n' + workKo.trim() : ''
    ].filter(Boolean);

    return parts.join('\n') + '\n\n' + blocks.join('\n');
  });
}

/** ====== 해시/상태 저장 ====== **/
function fingerprint(items) {
  return items.map(inc => {
    const last = lastUpdate(inc) || {};
    return [
      inc.id || inc.external_desc?.title || inc.title || inc.begin || 'unknown',
      (last.status || '').toUpperCase(),
      inc.end ? 'ENDED' : 'OPEN'
    ].join('|');
  }).join(',');
}
function getPropKey(query) { return 'GWS_ALERT_FINGERPRINT__' + (query ? String(query).toLowerCase() : '*'); }
function getSummaryKey(query) { return 'GWS_ALERT_LAST_OPEN_SUMMARY__' + (query ? String(query).toLowerCase() : '*'); }

/** ====== 수동 실행 (항상 전송) ====== **/
function pushWorkspaceStatusToChat(query) {
  const {items, productMap} = loadAlertableItems(query);

  if (!items.length) {
    postToChatText(`✅ 현재 공개된 사고가 없습니다.`);
    return;
  }

  const lines = formatLines(items, productMap);
  postToChatText(lines.join('\n\n'));
}

/** ====== 트리거 실행 (변화 감지) ====== **/
function pushWorkspaceStatusIfIncident(query) {
  const {items, productMap} = loadAlertableItems(query);
  const curr = fingerprint(items);
  const key  = getPropKey(query);
  const skey = getSummaryKey(query);
  const props = PropertiesService.getScriptProperties();
  const prev = props.getProperty(key) || '';
  const prevSummary = props.getProperty(skey) || '';

  if (SUPPRESS_FIRST_SEND && prev === '' && items.length) {
    const lines = formatLines(items, productMap);
    props.setProperty(key, curr);
    props.setProperty(skey, lines.join('\n\n'));
    Logger.log('First run: seeded state only (no send).');
    return;
  }

  if (!items.length && prev !== '') {
    postToChatText(`✅ 진행 중이던 사고가 모두 해결되었습니다.${prevSummary ? '\n\n해결된 사고 요약(이전 상태):\n' + prevSummary : ''}`);
    props.setProperty(key, '');
    props.deleteProperty(skey);
    return;
  }

  if (!items.length) {
    if (prev !== '') props.setProperty(key, '');
    props.deleteProperty(skey);
    Logger.log('No alertable incidents. Skipping send.');
    return;
  }

  if (prev === curr) {
    Logger.log('No change since last run. Skipping send.');
    return;
  }

  const lines = formatLines(items, productMap);
  postToChatText(lines.join('\n\n'));
  props.setProperty(key, curr);
  props.setProperty(skey, lines.join('\n\n'));
}

/** ====== 내부: 데이터 로드 + 필터 ====== **/
function loadAlertableItems(query) {
  const incidentsRaw = fetchJson(BASE + '/incidents.json');
  const productsRaw  = fetchJson(BASE + '/products.json');
  const productMap   = normalizeProducts(productsRaw);

  let items = normalizeIncidents(incidentsRaw)
    .sort((a,b) => new Date(b.begin) - new Date(a.begin));

  if (query) {
    const q = String(query).toLowerCase();
    items = items.filter(inc => {
      const names = extractProductNames(inc, productMap).map(n => n.toLowerCase());
      const idsHit = (inc.products || []).some(id => (productMap[id] || id).toLowerCase().includes(q));
      const namesHit = names.some(n => n.includes(q));
      return idsHit || namesHit;
    });
  }

  items = items.filter(keepIncident);
  return { items, productMap };
}

function seedAlertState(query) {
  const {items, productMap} = loadAlertableItems(query);
  const props = PropertiesService.getScriptProperties();
  props.setProperty(getPropKey(query), fingerprint(items));
  props.setProperty(getSummaryKey(query), formatLines(items, productMap).join('\n\n'));
  Logger.log('Seeded alert state without sending.');
}
function resetAlertState(query) {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(getPropKey(query));
  props.deleteProperty(getSummaryKey(query));
  Logger.log('Reset alert state.');
}
