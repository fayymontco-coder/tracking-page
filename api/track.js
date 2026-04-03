const SEVENTEEN_TRACK_API_KEY = process.env.SEVENTEEN_TRACK_API_KEY;
const API_BASE = 'https://api.17track.net/track/v2.2';

// ----- Masking dictionaries -----

const CARRIER_MASKS = [
  [/china\s*post/gi, 'International Mail'],
  [/yanwen/gi, 'Global Express'],
  [/yun\s*express/gi, 'Global Express'],
  [/cainiao/gi, 'Global Logistics'],
  [/sf\s*express/gi, 'Priority Express'],
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
  [/shunfeng/gi, 'Priority Express'],
];

const CHINA_LOCATIONS = [
  'shanghai', 'beijing', 'guangzhou', 'shenzhen', 'hangzhou',
  'chengdu', 'wuhan', 'nanjing', 'tianjin', 'chongqing',
  'dongguan', 'foshan', 'suzhou', 'ningbo', 'zhengzhou',
  'wenzhou', 'quanzhou', 'yiwu', 'xiamen', 'changsha',
  'jinan', 'hefei', 'kunming', 'harbin', 'fuzhou',
  'nanchang', 'taiyuan', 'nanning', 'shijiazhuang', 'urumqi',
  'qingdao', 'dalian', 'shenyang', 'wuxi', 'zhuhai',
  'zhongshan', 'huizhou', 'changchun', 'guiyang', 'lanzhou',
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

  // If any known Chinese city or "china" is in the location, replace
  const hasChina =
    lower.includes('china') ||
    lower.includes(', cn') ||
    CHINA_LOCATIONS.some((city) => lower.includes(city));

  if (hasChina) return 'International Warehouse';

  // Strip trailing country code artifacts
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
    const re = new RegExp(`\\b${city}\\b`, 'gi');
    result = result.replace(re, 'Origin City');
  }

  return result.trim();
}

// ----- Status mapping -----

const TAG_STATUS = {
  NotFound:    { label: 'Pending',             step: 0, color: '#9CA3AF' },
  InfoReceived:{ label: 'Info Received',        step: 1, color: '#818CF8' },
  PickedUp:    { label: 'Picked Up',            step: 1, color: '#818CF8' },
  InTransit:   { label: 'In Transit',           step: 2, color: '#3B82F6' },
  Undelivered: { label: 'Delivery Attempted',   step: 3, color: '#F59E0B' },
  Delivered:   { label: 'Delivered',            step: 4, color: '#10B981' },
  Returning:   { label: 'Returning to Sender',  step: 3, color: '#EF4444' },
  Returned:    { label: 'Returned',             step: 4, color: '#6B7280' },
  Expired:     { label: 'Expired',              step: 1, color: '#EF4444' },
};

// ----- Handler -----

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

  const headers = {
    '17token': SEVENTEEN_TRACK_API_KEY,
    'Content-Type': 'application/json',
  };

  try {
    // Register (idempotent — safe to call every time)
    await fetch(`${API_BASE}/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify([{ number: number.trim() }]),
    });

    // Fetch tracking info
    const infoRes = await fetch(`${API_BASE}/gettrackinfo`, {
      method: 'POST',
      headers,
      body: JSON.stringify([{ number: number.trim() }]),
    });

    const infoData = await infoRes.json();

    if (infoData.code !== 0) {
      return res.status(502).json({ error: 'Tracking service error' });
    }

    const accepted = infoData.data?.accepted?.[0];
    if (!accepted) {
      const rejected = infoData.data?.rejected?.[0];
      const reason = rejected?.error?.message || 'Tracking number not found';
      return res.status(404).json({ error: reason });
    }

    const track = accepted.track?.z0 || {};
    const rawEvents = track.z || [];

    const events = rawEvents.map((e) => ({
      date: e.a || '',
      description: maskDescription(e.b || ''),
      location: maskLocation(e.c || ''),
    }));

    const statusInfo = TAG_STATUS[accepted.tag] || { label: 'Processing', step: 1, color: '#6366F1' };

    return res.status(200).json({
      number: accepted.number,
      status: statusInfo.label,
      statusStep: statusInfo.step,
      statusColor: statusInfo.color,
      carrier: maskCarrier(track.c || ''),
      destinationCountry: track.d || '',
      events,
      lastUpdate: events[0]?.date || null,
    });

  } catch (err) {
    console.error('[track-api]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
