/* Advanced WeatherPro
   - Uses Open-Meteo for weather and air quality
   - India-first autocomplete & search (count=20)
   - Map view (OpenStreetMap embed)
   - 15-day forecast + current details + AQI
*/

/* -----------------------------
   Configuration & Globals
   ----------------------------- */
const GEO_BASE = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_BASE = "https://api.open-meteo.com/v1/forecast";
const AIR_BASE = "https://air-quality-api.open-meteo.com/v1/air-quality";

let isCelsius = true;
let lastLocation = null; // {lat, lon, name}
let cachedSuggestions = {}; // simple cache
let lastForecastData = null;

// weather code mapping (Open-Meteo)
const WEATHER_CODES = {
  0: {txt:"Clear sky", emoji:"☀️"},
  1: {txt:"Mainly clear", emoji:"🌤️"},
  2: {txt:"Partly cloudy", emoji:"⛅"},
  3: {txt:"Overcast", emoji:"☁️"},
  45: {txt:"Fog", emoji:"🌫️"},
  48: {txt:"Depositing rime fog", emoji:"🌫️"},
  51: {txt:"Light drizzle", emoji:"🌦️"},
  53: {txt:"Moderate drizzle", emoji:"🌦️"},
  55: {txt:"Dense drizzle", emoji:"🌧️"},
  61: {txt:"Slight rain", emoji:"🌧️"},
  63: {txt:"Moderate rain", emoji:"🌧️"},
  65: {txt:"Heavy rain", emoji:"🌧️"},
  71: {txt:"Slight snow", emoji:"❄️"},
  73: {txt:"Moderate snow", emoji:"❄️"},
  75: {txt:"Heavy snow", emoji:"❄️"},
  80: {txt:"Rain showers", emoji:"🌦️"},
  81: {txt:"Heavy rain showers", emoji:"🌧️"},
  95: {txt:"Thunderstorm", emoji:"⛈️"}
};

/* -----------------------------
   Helpers
   ----------------------------- */
const $ = id => document.getElementById(id);
const el = (tag, attrs={}, children="")=>{
  const d = document.createElement(tag);
  for(const k in attrs) d.setAttribute(k, attrs[k]);
  if(typeof children === "string") d.innerHTML = children;
  else if(Array.isArray(children)) children.forEach(c => d.appendChild(c));
  return d;
};

function fmtTemp(t){
  if (t === null || t === undefined) return "N/A";
  return isCelsius ? `${t} °C` : `${(t*9/5+32).toFixed(1)} °F`;
}
function safe(v){ return (v===null||v===undefined) ? "N/A" : v; }

/* returns index in hourly.time that matches current_time */
function findHourlyIndex(hourly, targetIso){
  if(!hourly || !hourly.time) return -1;
  // exact match
  let i = hourly.time.indexOf(targetIso);
  if(i>=0) return i;
  // fallback: match date+hour prefix
  const prefix = targetIso.slice(0,13); // YYYY-MM-DDTHH
  return hourly.time.findIndex(t => t.slice(0,13) === prefix);
}

/* build OpenStreetMap embed iframe with small bbox around lat/lon */
function mapIframeFor(lat, lon, name){
  const span = 0.03;
  const left = (lon - span).toFixed(5);
  const right = (lon + span).toFixed(5);
  const top = (lat + span).toFixed(5);
  const bottom = (lat - span).toFixed(5);
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${left}%2C${bottom}%2C${right}%2C${top}&layer=mapnik&marker=${lat}%2C${lon}`;
  return `<iframe src="${src}" style="border:0;width:100%;height:100%"></iframe><div style="padding:8px;text-align:center;font-size:0.85rem;color:var(--muted)">You can open in OpenStreetMap for detailed view — <a target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=12/${lat}/${lon}">Open Map</a></div>`;
}

/* -----------------------------
   UI wiring: search box & suggestions
   ----------------------------- */
const searchInput = $("searchInput");
const suggestionsBox = $("suggestions");
const searchBtn = $("searchBtn");
const locBtn = $("locBtn");
const unitsBtn = $("unitsBtn");

let suggestionTimer = null;
searchInput.addEventListener("input", (e)=>{
  const q = e.target.value.trim();
  if(!q){ suggestionsBox.hidden = true; return; }
  clearTimeout(suggestionTimer);
  suggestionTimer = setTimeout(()=> fetchSuggestions(q), 220);
});

searchInput.addEventListener("keydown", (e)=>{
  if(e.key === "Enter") { e.preventDefault(); doSearch(); suggestionsBox.hidden = true; }
  if(e.key === "Escape") suggestionsBox.hidden = true;
});

searchBtn.addEventListener("click", ()=>{ doSearch(); });
locBtn.addEventListener("click", useMyLocation);
unitsBtn.addEventListener("click", ()=>{
  isCelsius = !isCelsius;
  unitsBtn.textContent = isCelsius ? "°C" : "°F";
  if(lastLocation) loadWeather(lastLocation.lat, lastLocation.lon, lastLocation.name);
});

/* fetch suggestions: India-first, count=20 */
async function fetchSuggestions(q){
  try{
    suggestionsBox.innerHTML = `<div class="loading">Searching...</div>`;
    suggestionsBox.hidden = false;

    // check cache
    if(cachedSuggestions[q]) { renderSuggestions(cachedSuggestions[q]); return; }

    // India-first request (count=20)
    let urlIndia = `${GEO_BASE}?name=${encodeURIComponent(q)}&count=20&country=IN&language=en&format=json`;
    let resp = await fetch(urlIndia).then(r=>r.ok ? r.json() : null);
    let results = (resp && resp.results) ? resp.results : [];

    // If nothing in India, do a global query with count=10
    if(results.length === 0){
      let urlGlobal = `${GEO_BASE}?name=${encodeURIComponent(q)}&count=10&language=en&format=json`;
      let r2 = await fetch(urlGlobal).then(r=>r.ok ? r.json() : null);
      results = (r2 && r2.results) ? r2.results : [];
    }

    cachedSuggestions[q] = results;
    renderSuggestions(results);
  }catch(err){
    suggestionsBox.innerHTML = `<div class="loading">Error searching</div>`;
    console.error(err);
  }
}

function renderSuggestions(list){
  if(!list || list.length === 0){
    suggestionsBox.innerHTML = `<div class="loading">No results</div>`;
    return;
  }
  suggestionsBox.innerHTML = "";
  list.forEach(item=>{
    const text = `${item.name}${item.admin1 ? ", " + item.admin1 : ""}${item.country ? ", " + item.country : ""}`;
    const div = el("div",{class:"suggestion"}, `<strong>${item.name}</strong> <div class="muted">${item.admin1 || ""} ${item.country || ""}</div>`);
    div.addEventListener("click", ()=>{
      suggestionsBox.hidden = true;
      searchInput.value = text;
      // call getWeather
      const name = `${item.name}${item.admin1 ? ", " + item.admin1 : ""}${item.country ? ", " + item.country : ""}`;
      loadWeather(item.latitude, item.longitude, name);
    });
    suggestionsBox.appendChild(div);
  });
}

/* -----------------------------
   Search flow
   ----------------------------- */
async function doSearch(){
  const q = searchInput.value.trim();
  if(!q) return alert("Type a city (e.g. Bihar Sharif) to search.");
  // Attempt india-first geocode but tolerant to many forms
  try{
    // try India first
    let resp = await fetch(`${GEO_BASE}?name=${encodeURIComponent(q)}&count=20&country=IN&language=en&format=json`).then(r=>r.ok ? r.json() : null);
    let loc = resp && resp.results && resp.results[0];
    if(!loc){
      // fallback global
      let r2 = await fetch(`${GEO_BASE}?name=${encodeURIComponent(q)}&count=10&language=en&format=json`).then(r=>r.ok ? r.json() : null);
      loc = r2 && r2.results && r2.results[0];
    }
    if(!loc) return alert("Location not found. Try typing a nearby larger city or use the suggestions dropdown.");
    const name = `${loc.name}${loc.admin1 ? ", " + loc.admin1 : ""}${loc.country ? ", " + loc.country : ""}`;
    loadWeather(loc.latitude, loc.longitude, name);
  }catch(err){
    console.error(err);
    alert("Search error. See console.");
  }
}

/* -----------------------------
   Geolocation
   ----------------------------- */
function useMyLocation(){
  if(!navigator.geolocation) return alert("Geolocation not supported");
  $("mainLoading")?.remove();
  showMainLoading(true);
  navigator.geolocation.getCurrentPosition(async pos=>{
    try{
      const lat = pos.coords.latitude; const lon = pos.coords.longitude;
      // reverse name
      const rev = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10&addressdetails=1`).then(r=>r.ok? r.json():null);
      const display = rev?.display_name || `Lat ${lat.toFixed(3)}, Lon ${lon.toFixed(3)}`;
      loadWeather(lat, lon, display);
    }catch(e){
      console.error(e);
      alert("Cannot reverse geocode location.");
    }
  }, err=>{
    console.error(err);
    alert("Location permission denied or unavailable.");
    showMainLoading(false);
  }, {enableHighAccuracy:true, timeout:10000});
}

/* -----------------------------
   Main: loadWeather -> fetch APIs and render
   ----------------------------- */
async function loadWeather(lat, lon, displayName){
  lastLocation = {lat, lon, name: displayName};
  // show loading
  showMainLoading(true);

  // build forecast request: daily fields; hourly for pressure/humidity; current_weather true
  const dailyFields = [
    "weathercode",
    "temperature_2m_max","temperature_2m_min",
    "precipitation_sum","precipitation_probability_mean",
    "uv_index_max","sunrise","sunset"
  ].join(",");

  // hourly we will request pressure and humidity and temperature & wind for possible finer current values
  const hourlyFields = ["pressure_msl","relative_humidity_2m","temperature_2m","windspeed_10m"].join(",");

  const forecastUrl =
    `${FORECAST_BASE}?latitude=${lat}&longitude=${lon}&daily=${dailyFields}&hourly=${hourlyFields}&current_weather=true&timezone=auto&forecast_days=15`;

  const airUrl = `${AIR_BASE}?latitude=${lat}&longitude=${lon}&hourly=pm2_5,pm10,us_aqi&timezone=auto`;

  try{
    const [forecastResp, airResp] = await Promise.all([
      fetch(forecastUrl).then(r=>r.ok ? r.json() : Promise.reject("Forecast err")),
      fetch(airUrl).then(r=>r.ok ? r.json() : Promise.resolve(null)) // air sometimes missing
    ]);

    // store lastForecastData for modal detail viewing
    lastForecastData = { forecast: forecastResp, air: airResp };

    renderCurrentCard(forecastResp, airResp, displayName);
    renderForecastGrid(forecastResp, airResp);
    renderMap(lat, lon, displayName);
    getGlobalWeather(); // refresh global asynchronously
  }catch(e){
    console.error(e);
    alert("Failed to fetch weather data. Try again or check console.");
  }finally{
    showMainLoading(false);
  }
}

/* -----------------------------
   Rendering: current card, forecast grid, map, global
   ----------------------------- */
function showMainLoading(show){
  const currentCard = $("currentCard");
  if(show){
    currentCard.innerHTML = `<div class="loading" id="mainLoading">Loading weather…</div>`;
  } else {
    const node = $("mainLoading");
    if(node) node.remove();
  }
}

function renderCurrentCard(data, air, name){
  const cur = data.current_weather;
  // find hourly index
  const hourly = data.hourly || {};
  const nowIdx = findHourlyIndex(hourly, cur.time);
  const pressure = (hourly.pressure_msl && nowIdx>=0) ? hourly.pressure_msl[nowIdx] : (data.daily.pressure_msl ? data.daily.pressure_msl[0] : "N/A");
  // humidity field we requested as relative_humidity_2m in hourly
  const humidity = (hourly.relative_humidity_2m && nowIdx>=0) ? hourly.relative_humidity_2m[nowIdx] : "N/A";
  const wind = cur.windspeed ?? "N/A";
  const weatherCode = cur.weathercode ?? null;
  const weather = WEATHER_CODES[weatherCode] || {txt:"Unknown", emoji:"🌍"};
  const aqi = (air && air.hourly && air.hourly.us_aqi && air.hourly.us_aqi.length>0) ? air.hourly.us_aqi[0] : (air && air.current?.us_aqi) || "N/A";
  // Build card
  const html = `
    <div class="current-top">
      <div style="flex:1">
        <div class="location-name">${name}</div>
        <div class="small-muted">${new Date(cur.time).toLocaleString()}</div>
      </div>
      <div style="text-align:right">
        <div class="current-temp">${fmtTemp(cur.temperature)}</div>
        <div class="small-muted">${weather.txt} ${weather.emoji}</div>
      </div>
    </div>

    <div class="row">
      <div class="stat">
        <div class="label">Wind</div>
        <div class="value">${safe(wind)} km/h</div>
      </div>
      <div class="stat">
        <div class="label">Pressure</div>
        <div class="value">${safe(pressure)} hPa</div>
      </div>
      <div class="stat">
        <div class="label">Humidity</div>
        <div class="value">${safe(humidity)} %</div>
      </div>
    </div>

    <div style="margin-top:10px" class="extra-grid">
      <div class="stat"><div class="label">UV Index</div><div class="value">${safe(data.daily?.uv_index_max?.[0] ?? 'N/A')}</div></div>
      <div class="stat"><div class="label">AQI (US)</div><div class="value">${safe(aqi)}</div></div>
      <div class="stat"><div class="label">Sunrise / Sunset</div><div class="value">${(data.daily?.sunrise?.[0] ? new Date(data.daily.sunrise[0]).toLocaleTimeString() : 'N/A')} / ${(data.daily?.sunset?.[0] ? new Date(data.daily.sunset[0]).toLocaleTimeString() : 'N/A')}</div></div>
    </div>
  `;
  $("currentCard").innerHTML = html;
}

/* forecast grid cards clickable for details */
function renderForecastGrid(data, air){
  const grid = $("forecastGrid");
  grid.innerHTML = "";
  const days = data.daily.time || [];
  days.forEach((d,i)=>{
    const code = data.daily.weathercode?.[i];
    const meta = WEATHER_CODES[code] || {txt:"", emoji:"🌍"};
    const maxT = data.daily.temperature_2m_max?.[i];
    const minT = data.daily.temperature_2m_min?.[i];
    const rain = data.daily.precipitation_sum?.[i] ?? 0;
    const chance = data.daily.precipitation_probability_mean?.[i] ?? "N/A";
    const uv = data.daily.uv_index_max?.[i] ?? "N/A";

    const card = el("div",{class:"day-card", tabindex:0});
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="text-align:left">
          <div class="fw">${new Date(d).toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'})}</div>
          <div class="small-muted">${meta.txt}</div>
        </div>
        <div style="text-align:right">
          <div class="weather-emoji">${meta.emoji}</div>
          <div class="small-muted">${fmtTemp(maxT)} / ${fmtTemp(minT)}</div>
        </div>
      </div>
      <div style="margin-top:8px" class="small-muted">
        Rain: ${rain} mm • Chance: ${chance}% • UV: ${uv}
      </div>
    `;
    // on click show modal with deeper info
    card.addEventListener("click", ()=> openDayModal(i));
    card.addEventListener("keypress", (e)=>{ if(e.key==="Enter") openDayModal(i); });
    grid.appendChild(card);
  });
}

/* map rendering */
function renderMap(lat, lon, name){
  const mapWrap = $("mapWrap");
  mapWrap.innerHTML = mapIframeFor(lat, lon, name);
  $("mapName").textContent = name;
}

/* -----------------------------
   Day modal (expanded details)
   ----------------------------- */
const dayModal = $("dayModal");
const modalClose = $("modalClose");
modalClose.addEventListener("click", closeDayModal);
dayModal.addEventListener("click", (e)=> { if(e.target === dayModal) closeDayModal(); });

function openDayModal(dayIndex){
  if(!lastForecastData) return;
  const d = lastForecastData.forecast;
  const air = lastForecastData.air;
  const date = d.daily.time[dayIndex];
  const code = d.daily.weathercode?.[dayIndex];
  const meta = WEATHER_CODES[code] || {txt:"Unknown", emoji:"🌍"};
  const maxT = d.daily.temperature_2m_max?.[dayIndex];
  const minT = d.daily.temperature_2m_min?.[dayIndex];
  const rain = d.daily.precipitation_sum?.[dayIndex] ?? 0;
  const chance = d.daily.precipitation_probability_mean?.[dayIndex] ?? "N/A";
  const uv = d.daily.uv_index_max?.[dayIndex] ?? "N/A";
  // get air quality approximate for day using first hourly value if present
  const aqi = (air && air.hourly && air.hourly.us_aqi && air.hourly.us_aqi.length>dayIndex) ? air.hourly.us_aqi[dayIndex] : (air && air.current?.us_aqi) || "N/A";

  const content = `
    <div class="modal-content">
      <h3>${new Date(date).toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'})} — ${meta.txt} ${meta.emoji}</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-top:10px">
        <div class="stat"><div class="label">Max Temp</div><div class="value">${fmtTemp(maxT)}</div></div>
        <div class="stat"><div class="label">Min Temp</div><div class="value">${fmtTemp(minT)}</div></div>
        <div class="stat"><div class="label">Rain (sum)</div><div class="value">${safe(rain)} mm</div></div>
        <div class="stat"><div class="label">Rain Chance</div><div class="value">${safe(chance)} %</div></div>
        <div class="stat"><div class="label">UV Index</div><div class="value">${safe(uv)}</div></div>
        <div class="stat"><div class="label">AQI (US)</div><div class="value">${safe(aqi)}</div></div>
      </div>
      <div style="margin-top:12px;font-size:0.95rem;color:var(--muted)">Detailed hourly values are available in the API response (not shown here). Close to return.</div>
    </div>
  `;
  $("modalContent").innerHTML = content;
  dayModal.setAttribute("aria-hidden","false");
}

function closeDayModal(){ dayModal.setAttribute("aria-hidden","true"); }

/* -----------------------------
   Global weather (5 cities)
   ----------------------------- */
async function getGlobalWeather(){
  const cities = [
    {name:"Delhi",lat:28.61,lon:77.21},
    {name:"New York",lat:40.71,lon:-74.01},
    {name:"London",lat:51.51,lon:-0.13},
    {name:"Tokyo",lat:35.68,lon:139.69},
    {name:"Sydney",lat:-33.87,lon:151.21}
  ];
  const container = $("globalGrid");
  container.innerHTML = `<div class="loading">Loading global report…</div>`;
  try{
    const promises = cities.map(c => fetch(`${FORECAST_BASE}?latitude=${c.lat}&longitude=${c.lon}&current_weather=true&timezone=auto`).then(r=>r.ok? r.json():null));
    const results = await Promise.all(promises);
    container.innerHTML = "";
    results.forEach((res, idx)=>{
      if(!res || !res.current_weather){ container.appendChild(el("div",{class:"city-card"}, `<div class="small-muted">${cities[idx].name}</div><div class="muted">N/A</div>`)); return; }
      const cw = res.current_weather;
      const code = cw.weathercode;
      const meta = WEATHER_CODES[code] || {txt:"", emoji:"🌍"};
      const card = el("div",{class:"city-card"}, `
        <div style="font-weight:700">${cities[idx].name}</div>
        <div style="font-size:1.05rem">${fmtTemp(cw.temperature)}</div>
        <div class="small-muted">${meta.emoji} ${meta.txt}</div>
        <div class="small-muted">Wind ${cw.windspeed} km/h</div>
      `);
      container.appendChild(card);
    });
  }catch(e){
    console.error(e);
    container.innerHTML = `<div class="loading">Failed to load global report</div>`;
  }
}

/* -----------------------------
   init: try to load default (Delhi) on load
   ----------------------------- */
window.addEventListener("load", ()=>{
  // wire buttons that exist after DOM ready
  $("searchBtn").addEventListener("click", doSearch);
  $("locBtn").addEventListener("click", useMyLocation);
  $("unitsBtn").addEventListener("click", ()=>{ isCelsius = !isCelsius; $("unitsBtn").textContent = isCelsius ? "°C" : "°F"; if(lastLocation) loadWeather(lastLocation.lat, lastLocation.lon, lastLocation.name); });

  // default: Delhi
  loadWeather(28.61,77.21,"Delhi, India");
  getGlobalWeather();
});
