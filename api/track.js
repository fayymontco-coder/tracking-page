const SEVENTEEN_TRACK_API_KEY = process.env.SEVENTEEN_TRACK_API_KEY;
const API_BASE = 'https://api.17track.net/track/v2.2';

// ---- Masking: carrier names ----
const CARRIER_MASKS = [
  [/china\s*post/gi, 'International Mail'],
  [/yanwen/gi, 'Global Express'],
  [/yun\s*express/gi, 'Global Express'],
  [/yunexpress/gi, 'Global Express'],
  [/cainiao/gi, 'Global Logistics'],
  [/sf\s*express/gi, 'Priority Express'],
  [/shunfeng/gi, 'Priority Express'],
  [/ems\s*china/gi, 'International Express Mail'],
  [/\bems\b/gi, 'International Express Mail'],
  [/4px/gi, 'Global Fulfillment'],
  [/cne\s*express/gi, 'Global Express'],
  [/winit/gi, 'International Logistics'],
  [/e-?ems/gi, 'International Express'],
  [/zto\s*express/gi, 'Express Courier'],
  [/sto\s*express/gi, 'Express Courier'],
  [/yto\s*express/gi, 'Express Courier'],
  [/yunda/gi, 'Express Courier'],
  [/best\s*express/gi, 'Express Courier'],
  [/jd\s*logistics/gi, 'Global Logistics'],
  [/wishpost/gi, 'Global Fulfillment'],
  [/sdh/gi, 'Global Express'],
  [/闪电猴/g, 'Global Express'],
  [/shein/gi, 'Express Courier'],
  [/wanb/gi, 'International Logistics'],
];

// ---- Masking: Chinese cities ----
const CHINA_LOCATIONS = [
  'shanghai', 'beijing', 'guangzhou', 'shenzhen', 'hangzhou',
  'chengdu', 'wuhan', 'nanjing', 'tianjin', 'chongqing',
  'dongguan', 'foshan', 'suzhou', 'ningbo', 'zhengzhou',
  'wenzhou', 'quanzhou', 'yiwu', 'xiamen', 'changsha',
  'jinan', 'hefei', 'kunming', 'harbin', 'fuzhou',
  'nanchang', 'taiyuan', 'nanning', 'shijiazhuang', 'urumqi',
  'qingdao', 'dalian', 'shenyang', 'wuxi', 'zhuhai',
  'zhongshan', 'huizhou', 'changchun', 'guiyang', 'lanzhou',
  'jiaxing', 'taizhou', 'wuhu', 'nantong', 'yangzhou',
  'zhenjiang', 'linyi', 'weifang', 'yantai', 'jinhua',
  'shaoxing', 'huzhou', 'jiangmen', 'zhaoqing', 'maoming',
  'guangdong', 'zhejiang', 'jiangsu', 'shandong', 'fujian',
  'guangxi', 'yunnan', 'guizhou', 'sichuan', 'anhui',
];

function maskCarrier(name) {
  if (!name) return 'International Carrier';
  let result = name;
  for (const [pattern, replacement] of CARRIER_MASKS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function maskLocation(loc) {
  if (!loc) return '';
  const lower = loc.toLowerCase();
  const hasChina =
    lower.includes('china') ||
    lower.includes(', cn') ||
    lower.match(/\bcn\b/) ||
    CHINA_LOCATIONS.some((city) => lower.includes(city));
  if (hasChina) return 'International Warehouse';
  return loc.replace(/,?\s*CN\s*$/i, '').trim();
}

function maskDescription(text) {
  if (!text) return '';
  let result = text;
  for (const [pattern, replacement] of CARRIER_MASKS) {
    result = result.replace(pattern, replacement);
  }
  result = result.replace(/\bChina\b/gi, 'Origin');
  result = result.replace(/\bCN\b/g, '');
  for (const city of CHINA_LOCATIONS) {
    if (city.length < 4) continue;
    const re = new RegExp(`\\b${city}\\b`, 'gi');
    result = result.replace(re, 'Origin Facility');
  }
  result = result.replace(/sorting\s*center/gi, 'logistics center');
  result = result.replace(/operation\s*center/gi, 'logistics center');
  result = result.replace(/delivery\s*point/gi, 'delivery facility');
  return result.trim();
}

// ---- Status mapping (v2.2 uses track_info.latest_status.status) ----
const STATUS_MAP = {
  NotFound:     { label: 'Pending',            step: 0, color: '#9CA3AF' },
  InfoReceived: { label: 'Info Received',       step: 1, color: '#818CF8' },
  PickedUp:     { label: 'Picked Up',           step: 1, color: '#818CF8' },
  InTransit:    { label: 'In Transit',          step: 2, color: '#3B82F6' },
  Undelivered:  { label: 'Delivery Attempted',  step: 3, color: '#F59E0B' },
  Delivered:    { label: 'Delivered',           step: 4, color: '#10B981' },
  Returning:    { label: 'Returning to Sender', step: 3, color: '#EF4444' },
  Returned:     { label: 'Returned',            step: 4, color: '#6B7280' },
  Expired:      { label: 'Expired',             step: 1, color: '#EF4444' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Parse v2.2 response structure ----
function parseAccepted(accepted) {
  const trackInfo = accepted.track_info || {};
  const latestStatus = trackInfo.latest_status || {};
  const tracking = trackInfo.tracking || {};
  const providers = tracking.providers || [];

  // Collect all events from all providers
  const allEvents = [];
  let carrierName = '';

  for (const p of providers) {
    if (!carrierName && p.provider?.name) {
      carrierName = p.provider.name;
    }
    for (const e of (p.events || [])) {
      allEvents.push({
        date: e.time_iso || e.time_utc || '',
        description: maskDescription(e.description || ''),
        location: maskLocation(e.location || ''),
      });
    }
  }

  // Deduplicate
  const seen = new Set();
  const events = allEvents.filter((e) => {
    const key = `${e.date}|${e.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Status
  const rawStatus = latestStatus.status || accepted.tag || 'NotFound';
  const statusInfo = STATUS_MAP[rawStatus] || { label: 'Processing', step: 1, color: '#6366F1' };

  // Destination country
  const destination = trackInfo.shipping_info?.recipient_address?.country || '';

  return { events, carrierName, statusInfo, destination };
}

// ---- Main handler ----
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { number } = req.query;
  if (!number || number.trim().length < 5) {
    return res.status(400).json({ error: 'Valid tracking number required' });
  }
  if (!SEVENTEEN_TRACK_API_KEY) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  const trackingNumber = number.trim().toUpperCase();
  const headers = {
    '17token': SEVENTEEN_TRACK_API_KEY,
    'Content-Type': 'application/json',
  };

  try {
    // Try fetching first (may already be registered)
    let data = await fetchInfo(trackingNumber, headers);
    let accepted = data.data?.accepted?.[0];

    // If not found, register then retry
    if (!accepted) {
      await register(trackingNumber, headers);
      await sleep(3000);
      data = await fetchInfo(trackingNumber, headers);
      accepted = data.data?.accepted?.[0];
    }

    // One more retry
    if (!accepted) {
      await sleep(3000);
      data = await fetchInfo(trackingNumber, headers);
      accepted = data.data?.accepted?.[0];
    }

    if (!accepted) {
      return res.status(404).json({ error: 'Tracking number not found. Please check the number and try again.' });
    }

    const { events, carrierName, statusInfo, destination } = parseAccepted(accepted);

    if (events.length === 0) {
      return res.status(200).json({
        number: accepted.number,
        status: 'Info Received',
        statusStep: 1,
        statusColor: '#818CF8',
        carrier: 'International Carrier',
        destinationCountry: destination,
        events: [],
        lastUpdate: null,
        message: 'Your shipment has been registered. Tracking events will appear within 24 hours.',
      });
    }

    return res.status(200).json({
      number: accepted.number,
      status: statusInfo.label,
      statusStep: statusInfo.step,
      statusColor: statusInfo.color,
      carrier: maskCarrier(carrierName),
      destinationCountry: destination,
      events,
      lastUpdate: events[0]?.date || null,
    });

  } catch (err) {
    console.error('[track-api error]', err);
    return res.status(500).json({ error: 'Connection error. Please try again.' });
  }
}

async function fetchInfo(number, headers) {
  const res = await fetch(`${API_BASE}/gettrackinfo`, {
    method: 'POST',
    headers,
    body: JSON.stringify([{ number }]),
  });
  return res.json();
}

async function register(number, headers) {
  try {
    await fetch(`${API_BASE}/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify([{ number, auto_detection: true }]),
    });
  } catch (_) {}
}
