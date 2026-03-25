require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const API_KEY = process.env.OPENWEATHER_API_KEY;

if (!API_KEY) {
  console.warn('OPENWEATHER_API_KEY not set. Set it in Netlify environment variables');
}

app.use(cors());
// Disable caching for API responses
app.use((req,res,next)=>{ res.set('Cache-Control','no-store'); next(); });

// Soil data from SoilGrids (no API key). Falls back to deterministic mock if needed.
app.get('/soil', async (req, res) => {
  try{
    const { lat, lon } = req.query;
    if(!lat || !lon) return res.status(400).json({ error: 'Missing lat/lon' });

    // Try SoilGrids v2.0 properties API
    try {
      const url = new URL('https://rest.isric.org/soilgrids/v2.0/properties/query');
      url.searchParams.set('lat', lat);
      url.searchParams.set('lon', lon);
      url.searchParams.append('property','phh2o');
      url.searchParams.append('property','soc');
      url.searchParams.append('property','nitrogen');
      url.searchParams.set('depth','0-5cm');
      url.searchParams.set('value','mean');
      const r = await fetch(url);
      if (!r.ok) throw new Error(`SoilGrids error ${r.status}`);
      const j = await r.json();

      const layers = j?.properties?.layers || j?.layers || [];
      const byName = (name)=> layers.find(l=> l.name===name) || {};
      const firstVal = (layer)=>{
        const d = layer.depths?.[0];
        const mean = d?.values?.mean;
        return mean !== undefined ? Number(mean.toFixed(2)) : null;
      };

      return res.json({
        ph: firstVal(byName('phh2o')) || 6.5,
        nitrogen: firstVal(byName('nitrogen')) || 0.15,
        organic_matter: (firstVal(byName('soc')) || 1.5) * 1.724,
        source: 'soilgrids'
      });
    } catch (soilErr) {
      console.warn('SoilGrids failed, using mock data:', soilErr.message);
      // Deterministic mock based on coordinates
      const hash = Math.abs(Math.sin(lat*lon) * 10000);
      return res.json({
        ph: 5.5 + (hash % 3),
        nitrogen: 0.1 + (hash % 20) / 100,
        organic_matter: 1.0 + (hash % 30) / 10,
        source: 'mock'
      });
    }
  } catch (e) {
    console.error('Soil API error:', e);
    return res.status(500).json({ error: 'Soil data fetch failed' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/rain-history', async (req, res) => {
  try {
    const { lat, lon } = req.query;
    if (!lat || !lon) return res.status(400).json({ error: 'Missing lat/lon' });

    // Open-Meteo historical rain data (free, no key)
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=2023-01-01&end_date=2023-12-31&daily=precipitation_sum&timezone=auto`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Open-Meteo error ${r.status}`);
    const data = await r.json();

    const daily = data?.daily || {};
    const precip = daily.precipitation_sum || [];
    const monthly = new Array(12).fill(0);
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    precip.forEach((val, i) => {
      const date = new Date(daily.time[i]);
      if (!isNaN(date)) {
        const m = date.getMonth();
        monthly[m] += Number(val) || 0;
      }
    });

    const result = monthNames.map((name, i) => ({
      month: name,
      rainfall: Number(monthly[i].toFixed(1))
    }));

    return res.json(result);
  } catch (e) {
    console.error('Rain history error:', e);
    return res.status(500).json({ error: 'Rain history fetch failed' });
  }
});

app.get('/geocode', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Missing query' });

    // Nominatim (OpenStreetMap) - free geocoding
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Nominatim error ${r.status}`);
    const data = await r.json();

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Location not found' });
    }

    const { lat, lon, display_name, class: placeClass, type } = data[0];
    return res.json({
      lat: parseFloat(lat),
      lon: parseFloat(lon),
      display_name,
      class: placeClass,
      type
    });
  } catch (e) {
    console.error('Geocode error:', e);
    return res.status(500).json({ error: 'Geocoding failed' });
  }
});

app.get('/weather', async (req, res) => {
  try {
    const { lat, lon } = req.query;
    if (!lat || !lon) return res.status(400).json({ error: 'Missing lat/lon' });
    if (!API_KEY) return res.status(500).json({ error: 'OpenWeather API key not configured' });

    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${API_KEY}&units=metric`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`OpenWeather error ${r.status}`);
    const data = await r.json();

    const result = {
      temperature: data.main.temp,
      humidity: data.main.humidity,
      description: data.weather[0].description,
      wind_speed: data.wind.speed,
      location: data.name
    };

    return res.json(result);
  } catch (e) {
    console.error('Weather API error:', e);
    return res.status(500).json({ error: 'Weather data fetch failed' });
  }
});

// Export for Netlify Functions
exports.handler = async (event, context) => {
  const path = event.path.replace('/.netlify/functions/api', '');
  const method = event.httpMethod;
  
  // Mock Express request/response
  const req = {
    method,
    query: event.queryStringParameters || {},
    path,
    headers: event.headers || {}
  };
  
  let responseData = '';
  let statusCode = 200;
  let headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  };

  try {
    // Handle the request
    if (method === 'OPTIONS') {
      return { statusCode: 200, headers, body: '' };
    }

    // Route handling
    if (path === '/health') {
      responseData = JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() });
    } else if (path === '/soil') {
      const result = await new Promise((resolve, reject) => {
        req.query = event.queryStringParameters || {};
        app._router.handle({ ...req, url: '/soil' }, {
          status: (code) => { statusCode = code; },
          json: (data) => { responseData = JSON.stringify(data); },
          send: (data) => { responseData = data; }
        }, reject);
      });
    } else if (path === '/rain-history') {
      const result = await new Promise((resolve, reject) => {
        req.query = event.queryStringParameters || {};
        app._router.handle({ ...req, url: '/rain-history' }, {
          status: (code) => { statusCode = code; },
          json: (data) => { responseData = JSON.stringify(data); },
          send: (data) => { responseData = data; }
        }, reject);
      });
    } else if (path === '/geocode') {
      const result = await new Promise((resolve, reject) => {
        req.query = event.queryStringParameters || {};
        app._router.handle({ ...req, url: '/geocode' }, {
          status: (code) => { statusCode = code; },
          json: (data) => { responseData = JSON.stringify(data); },
          send: (data) => { responseData = data; }
        }, reject);
      });
    } else if (path === '/weather') {
      const result = await new Promise((resolve, reject) => {
        req.query = event.queryStringParameters || {};
        app._router.handle({ ...req, url: '/weather' }, {
          status: (code) => { statusCode = code; },
          json: (data) => { responseData = JSON.stringify(data); },
          send: (data) => { responseData = data; }
        }, reject);
      });
    } else {
      statusCode = 404;
      responseData = JSON.stringify({ error: 'Not found' });
    }

  } catch (error) {
    statusCode = 500;
    responseData = JSON.stringify({ error: error.message });
  }

  return {
    statusCode,
    headers,
    body: responseData
  };
};
