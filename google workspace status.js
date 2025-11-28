/* webhook.gs */
const SUPPRESS_FIRST_SEND = false;  // 첫 실행에도 전송

// 1) 스페이스 Webhook URL
const WEBHOOK_URL = 'https://chat.googleapis.com/v1/spaces/AAQAvRvdbkY/messages?key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI&token=I2S1P2AFHImwunrL6BeP_6-oJ-kko6TFQU86pN7Guk0';
const THREAD_KEY   = 'workspace-status';

const ONLY_MAJOR   = false;   // OUTAGE/DISRUPTION만 알림
const ONLY_ONGOING = false;    // end가 없는 '진행 중'만 알림
const MAX_ITEMS    = 1;       // 최대 표시 개수

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

/** 최신 업데이트 선택 유틸 (정렬 무관, most_recent_update 우선) */
function getUpdateMillis(u) {
  const t = u?.when || u?.update_time || u?.updated || u?.time || u?.timestamp;
  return t ? new Date(t).getTime() : 0;
}
function lastUpdate(inc) {
  if (inc?.most_recent_update) return inc.most_recent_update;
  const u = inc?.updates || [];
  if (!u.length) return null;
  return u.reduce((a, b) => (getUpdateMillis(a) >= getUpdateMillis(b) ? a : b));
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

/** ====== 텍스트 정제 유틸 ====== **/
// \u003c, \u003e, HTML 엔티티, 태그, 마크다운(**, `코드`) 제거 + 줄바꿈 정리
function unescapeAnglesAndEntities(s) {
  return String(s)
    .replace(/\\u003c/gi, '<').replace(/\\u003e/gi, '>')
    .replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&amp;/gi,'&')
    .replace(/&quot;/gi,'"').replace(/&#39;/gi,"'");
}
function stripHtml(s) {
  let x = unescapeAnglesAndEntities(s);
  // 블록 단위 태그를 줄바꿈으로 치환
  x = x
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<\s*hr[^>]*>/gi, '\n')
    .replace(/<ul[^>]*>|<\/ul>|<ol[^>]*>|<\/ol>|<li[^>]*>/gi, '\n');
  // 나머지 태그 제거
  x = x.replace(/<[^>]+>/g, '');
  return x;
}
function stripMarkdown(s) {
  return String(s)
    // **bold** -> bold
    .replace(/\*\*(.*?)\*\*/g, '$1')
    // *italic* -> italic (양끝 별 하나 제거)
    .replace(/(^|[\s(])\*(\S[^*]*?)\*(?=[\s).,;!?]|$)/g, '$1$2')
    // 인라인 코드 `...` 및 ```...``` 제거
    .replace(/```[\s\S]*?```/g, m => m.replace(/```/g,''))
    .replace(/`([^`]*)`/g, '$1');
}
function squashWhitespace(s) {
  return String(s)
    .replace(/\r/g,'')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function sanitize(s) {
  return squashWhitespace(stripMarkdown(stripHtml(s)));
}

/** ====== 번역/문구 유틸 ====== **/
function trKo(s) {
  const clean = sanitize(s);
  if (!clean) return '';
  try {
    return LanguageApp.translate(clean, '', 'ko');
  } catch (e) {
    Logger.log('Translate fail: ' + e.message);
    return clean;
  }
}

// 상태 문구 확대 (DEGRADED, ISSUE 등)
function statusKoFromRaw(statusRaw) {
  if (/OUTAGE/i.test(statusRaw)) return '서비스 중단';
  if (/DISRUPTION|DEGRADED|ISSUE|PARTIAL/i.test(statusRaw)) return '부분 장애';
  return '정보';
}

/** ====== 문자열/제품명 유틸 ====== **/
function toName(x, productMap) {
  if (!x) return null;
  if (typeof x === 'string') return productMap[x] || x;
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
  (inc.products || []).forEach(v => { const n = toName(v, productMap); if (n) names.add(n); });
  (inc.product_ids || []).forEach(v => { const n = toName(v, productMap); if (n) names.add(n); });

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
  if (!status) return false;
  const s = status.toUpperCase();
  return /(OUTAGE|DISRUPTION|DEGRADED|SERVICE ISSUE|PARTIAL|DEGRADATION)/.test(s);
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
    const lu       = inc.most_recent_update || lastUpdate(inc) || {};
    const when     = fmtUTC(inc.begin);
    const statusRaw= lu.status || '';
    const sev = /OUTAGE/i.test(statusRaw) ? '🔴'
             : /DISRUPTION|DEGRADED|ISSUE|PARTIAL/i.test(statusRaw) ? '🟠'
             : 'ℹ️';
    const statusKo = statusKoFromRaw(statusRaw);

    // 섹션 파싱 후 정제/번역
    const baseTitle = inc.external_desc?.title || inc.title || 'Incident';
    const sections  = extractSectionsFromText(lu.text || inc.external_desc?.text || '');

    const titleKo = trKo(sections.Title || baseTitle);
    const descKo  = sections.Description ? trKo(sections.Description) : '';
    const sympKo  = sections.Symptoms ? trKo(sections.Symptoms) : '';
    const workKo  = sections.Workaround ? trKo(sections.Workaround) : '';

    // 제품명(영어 유지)
    const prodNames = extractProductNames(inc, productMap);
    const prods = (prodNames && prodNames.length) ? prodNames.join(', ') : '—';

    const link = inc.id ? `${BASE}/incidents/${encodeURIComponent(inc.id)}?hl=en` : '';

    // 출력: 마크다운 굵게(*) 없이 평문 레이블 사용
    const parts = [
      `${sev} ${titleKo}`,
      `• 최초 오류 보고시간: ${when}`,
      `• 상태: ${statusKo}`,
      `• 서비스: ${prods}`,
      link ? `• 오류 상세링크: ${link}` : ''
    ].filter(Boolean);

    const blocks = [
      `제목: ${titleKo}`,
      descKo ? `\n설명:\n${descKo.trim()}` : '',
      sympKo ? `\n증상:\n${sympKo.trim()}` : '',
      workKo ? `\n우회 해결방법:\n${workKo.trim()}` : ''
    ].filter(Boolean);

    // 최종 정리: 혹시 남은 마크다운/HTML이 있어도 sanitize로 한 번 더
    return sanitize(parts.join('\n')) + '\n\n' + sanitize(blocks.join('\n'));
  });
}

/** ====== 해시/상태 저장 ====== **/
function md5Hex(s) {
  if (s == null) s = '';
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5,
    String(s),
    Utilities.Charset.UTF_8
  );
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}
function fingerprint(items) {
  return items.map(inc => {
    const lu = inc.most_recent_update || lastUpdate(inc) || {};
    const lastWhen =
      lu.when || lu.update_time || lu.updated || lu.time || lu.timestamp || '';
    const updatesLen = (inc.updates || []).length;
    const lastTextHash = md5Hex(lu.text || '');
    return [
      inc.id || inc.external_desc?.title || inc.title || inc.begin || 'unknown',
      (lu.status || '').toUpperCase(),
      inc.end ? 'ENDED' : 'OPEN',
      lastWhen,
      updatesLen,
      lastTextHash
    ].join('|');
  }).join(',');
}
function getPropKey(query) { return 'GWS_ALERT_FINGERPRINT__' + (query ? String(query).toLowerCase() : '*'); }
function getSummaryKey(query) { return 'GWS_ALERT_LAST_OPEN_SUMMARY__' + (query ? String(query).toLowerCase() : '*'); }

/** ====== 수동 실행 ====== **/
function pushWorkspaceStatusToChat(query) {
  const {items, productMap} = loadAlertableItems(query);
  if (!items.length) {
    postToChatText(`✅ 현재 공개된 사고가 없습니다.`);
    return;
  }
  const lines = formatLines(items, productMap);
  postToChatText(lines.join('\n\n'));
}

/** ====== 트리거 실행 ====== **/
function pushWorkspaceStatusIfIncident() {
  const query = null;  // 또는 '' – 트리거에서는 항상 전체 조회
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
    postToChatText(
      `✅ 진행 중이던 사고가 모두 해결되었습니다.` +
      (prevSummary ? '\n\n해결된 사고 요약(이전 상태):\n' + sanitize(prevSummary) : '')
    );
    props.setProperty(key, '');
    props.deleteProperty(skey);
    return;
  }

  if (!items.length) {
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

  Logger.log(`총 ${items.length}건의 사건을 불러왔습니다.`);
  items.forEach(inc => {
    const st = (lastUpdate(inc)?.status || '(no status)');
    Logger.log(`- ${inc.id || '(no id)'} / ${st}`);
  });

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
  Logger.log(`필터 통과 후 남은 사건 수: ${items.length}`);
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
