/* =============================
    WeatherPro AI — script.js
    Advanced single-file app logic
    Uses Open-Meteo APIs (no API keys)
    ============================= */

/* CONFIG & GLOBALS */
const GEO_BASE = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_BASE = "https://api.open-meteo.com/v1/forecast";
const AIR_BASE = "https://air-quality-api.open-meteo.com/v1/air-quality";

let isCelsius = true;
let lastLocation = null; // {lat, lon, name}
let lastForecastData = null; // store forecast + air
let suggestionCache = {};
let aiVoiceActive = false;

/* DOM Shortcuts */
const $ = id => document.getElementById(id);
const searchInput = $("searchInput");
const suggestions = $("suggestions");
const searchBtn = $("searchBtn");
const locBtn = $("locBtn");
const unitsBtn = $("unitsBtn");
const mainLoading = $("mainLoading");
const currentCard = $("currentCard");
const mapWrap = $("mapWrap");
const mapName = $("mapName");
const forecastGrid = $("forecastGrid");
const globalGrid = $("globalGrid");
const aiOutput = $("aiOutput");
const aiSummaryBtn = $("aiSummaryBtn");
const aiSpeakBtn = $("aiSpeakBtn");
const aiVoiceBtn = $("aiVoiceBtn");
const exportBtn = $("exportBtn");
const dayModal = $("dayModal");
const modalClose = $("modalClose");
const modalContent = $("modalContent");

/* Utility helpers */
const sleep = ms => new Promise(res => setTimeout(res, ms));
const safe = v => (v === null || v === undefined) ? "N/A" : v;
const nowIso = () => (new Date()).toISOString();
function fmtTemp(v){ if(v===null || v===undefined) return "N/A"; return isCelsius ? `${v.toFixed(1)} °C` : `${(v*9/5+32).toFixed(1)} °F`; } // Added .toFixed(1) for consistency
function round1(n){ return Math.round((n + Number.EPSILON) * 10) / 10; }
function formatTime(iso){ if(!iso) return "N/A"; return new Date(iso).toLocaleTimeString(undefined, {hour:'2-digit', minute:'2-digit'}); }
function aqiClass(aqi){
    const n = Number(aqi);
    if(isNaN(n)) return "";
    if(n <= 50) return "good";
    if(n <= 100) return "moderate";
    if(n <= 150) return "unhealthy-sensitive";
    if(n <= 200) return "unhealthy";
    return "hazardous";
}

/* WEATHER CODE MAPPING (Open-Meteo) */
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
    71: {txt:"Slight snowfall", emoji:"❄️"},
    73: {txt:"Moderate snowfall", emoji:"❄️"},
    75: {txt:"Heavy snowfall", emoji:"❄️"},
    80: {txt:"Rain showers", emoji:"🌦️"},
    81: {txt:"Heavy rain showers", emoji:"🌧️"},
    95: {txt:"Thunderstorm", emoji:"⛈️"}
};

/* Init on load */
window.addEventListener("load", () => {
    wireEvents();
    // load default location Delhi
    // Try to load last seen location from cache first
    const cachedLoc = loadLastSeen();
    if (cachedLoc) {
        loadWeather(cachedLoc.lat, cachedLoc.lon, cachedLoc.name);
        searchInput.value = cachedLoc.name;
    } else {
        loadWeather(28.61, 77.21, "Delhi, India");
    }
    loadGlobalReportAsync();
});

/* -----------------------------
    Event wiring
    ----------------------------- */
function wireEvents(){
    // search suggestions input
    let timer = null;
    searchInput.addEventListener("input", (e) => {
        const q = e.target.value.trim();
        if(!q){ suggestions.hidden = true; return; }
        clearTimeout(timer);
        timer = setTimeout(()=> fetchSuggestions(q), 220);
    });

    // keyboard shortcuts
    document.addEventListener("keydown", (e) => {
        if(e.key === "U" || e.key === "u"){ toggleUnits(); }
        if(e.key === "Escape"){ suggestions.hidden = true; closeModal(); }
        if(e.key === "Enter" && document.activeElement === searchInput){ doSearch(); suggestions.hidden = true; }
    });

    searchBtn.addEventListener("click", doSearch);
    locBtn.addEventListener("click", useMyLocation);
    unitsBtn.addEventListener("click", toggleUnits);
    aiSummaryBtn.addEventListener("click", generateAISummary);
    aiSpeakBtn.addEventListener("click", speakSummary);
    aiVoiceBtn.addEventListener("click", startVoiceCommand);
    exportBtn.addEventListener("click", exportJSON);

    modalClose.addEventListener("click", closeModal);
    dayModal.addEventListener("click", (ev)=> { if(ev.target === dayModal) closeModal(); } );
}

/* -----------------------------
    AUTOCOMPLETE & GEOCODING
    ----------------------------- */
async function fetchSuggestions(q){
    try{
        suggestions.hidden = false;
        suggestions.innerHTML = `<div class="loading">Searching…</div>`;
        if(suggestionCache[q]) {
            renderSuggestions(suggestionCache[q]); return;
        }

        // India first (count=20 to capture small towns)
        const indiaUrl = `${GEO_BASE}?name=${encodeURIComponent(q)}&count=20&country=IN&language=en&format=json`;
        let resp = await fetch(indiaUrl).then(r => r.ok ? r.json() : null);
        let list = (resp && resp.results) ? resp.results : [];

        // If no India results, global fallback (count=10)
        if(!list || list.length === 0){
            const globalUrl = `${GEO_BASE}?name=${encodeURIComponent(q)}&count=10&language=en&format=json`;
            const resp2 = await fetch(globalUrl).then(r => r.ok ? r.json() : null);
            list = (resp2 && resp2.results) ? resp2.results : [];
        }

        suggestionCache[q] = list;
        renderSuggestions(list);
    }catch(err){
        console.error("Suggestions error", err);
        suggestions.innerHTML = `<div class="loading">Search failed</div>`;
    }
}

function renderSuggestions(list){
    if(!list || list.length === 0){ suggestions.innerHTML = `<div class="loading">No results</div>`; return; }
    suggestions.innerHTML = "";
    list.forEach(item => {
        const txt = `${item.name}${item.admin1 ? ", " + item.admin1 : ""}${item.country ? ", " + item.country : ""}`;
        const div = document.createElement("div");
        div.className = "suggestion";
        div.setAttribute("role","option");
        div.innerHTML = `<strong>${item.name}</strong> <span class="muted small"> ${item.admin1 || ""} ${item.country || ""}</span>`;
        div.addEventListener("click", () => {
            suggestions.hidden = true;
            searchInput.value = txt;
            loadWeather(item.latitude, item.longitude, txt);
        });
        suggestions.appendChild(div);
    });
}

/* -----------------------------
    SEARCH FLOW
    ----------------------------- */
async function doSearch(){
    const q = searchInput.value.trim();
    if(!q) return alert("Please type a city name (e.g. Bihar Sharif)");
    try{
        // try India first with count=20
        let resp = await fetch(`${GEO_BASE}?name=${encodeURIComponent(q)}&count=20&country=IN&language=en&format=json`).then(r=>r.ok? r.json():null);
        let loc = resp && resp.results && resp.results[0];
        if(!loc){
            let resp2 = await fetch(`${GEO_BASE}?name=${encodeURIComponent(q)}&count=10&language=en&format=json`).then(r=>r.ok? r.json():null);
            loc = resp2 && resp2.results && resp2.results[0];
        }
        if(!loc) return alert("Location not found. Try a nearby larger city or use suggestions dropdown.");
        const display = `${loc.name}${loc.admin1 ? ", " + loc.admin1 : ""}${loc.country ? ", " + loc.country : ""}`;
        loadWeather(loc.latitude, loc.longitude, display);
    }catch(err){
        console.error("Search error", err);
        alert("Search failed, check console.");
    } finally { suggestions.hidden = true; }
}

/* -----------------------------
    GEOLOCATION (Use My Location)
    ----------------------------- */
function useMyLocation(){
    if(!navigator.geolocation) return alert("Geolocation not supported in this browser.");
    showMainLoading(true, "Getting your location…");
    navigator.geolocation.getCurrentPosition(async pos => {
        try{
            const lat = pos.coords.latitude; const lon = pos.coords.longitude;
            // reverse geocode with Nominatim
            const rev = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`).then(r=>r.ok? r.json():null);
            const name = rev?.display_name || `Lat ${lat.toFixed(3)}, Lon ${lon.toFixed(3)}`;
            loadWeather(lat, lon, name);
        }catch(err){
            console.error("Reverse geocode failed", err);
            alert("Could not determine location name. Using coordinates.");
            loadWeather(pos.coords.latitude, pos.coords.longitude, `Lat ${pos.coords.latitude.toFixed(3)}, Lon ${pos.coords.longitude.toFixed(3)}`);
        }
    }, err => {
        console.error("Geolocation denied", err);
        alert("Location permission denied or unavailable.");
        showMainLoading(false);
    }, { enableHighAccuracy: true, timeout: 12000 });
}

/* -----------------------------
    LOAD WEATHER (Core)
    - Fetch forecast (daily + hourly current)
    - Fetch air quality
    - Render current, forecast, map, AI summary
    ----------------------------- */
async function loadWeather(lat, lon, name){
    lastLocation = { lat: Number(lat), lon: Number(lon), name: name || `${lat},${lon}` };
    showMainLoading(true, `Fetching weather for ${lastLocation.name}...`);

    // daily fields for 15 days
    const dailyFields = [
        "weathercode",
        "temperature_2m_max", "temperature_2m_min",
        "precipitation_sum", "precipitation_probability_mean",
        "uv_index_max", "sunrise", "sunset"
    ].join(",");

    // hourly fields for current pressure/humidity/etc.
    const hourlyFields = ["pressure_msl","relative_humidity_2m","temperature_2m","windspeed_10m","winddirection_10m","surface_pressure"].join(",");

    const forecastUrl = `${FORECAST_BASE}?latitude=${lastLocation.lat}&longitude=${lastLocation.lon}&daily=${dailyFields}&hourly=${hourlyFields}&current_weather=true&timezone=auto&forecast_days=15`;
    const airUrl = `${AIR_BASE}?latitude=${lastLocation.lat}&longitude=${lastLocation.lon}&hourly=pm2_5,pm10,us_aqi,european_aqi&timezone=auto`;

    try{
        const [forecastResp, airResp] = await Promise.all([
            fetch(forecastUrl).then(r => r.ok ? r.json() : Promise.reject("Forecast fetch failed")),
            fetch(airUrl).then(r => r.ok ? r.json() : null) // air may fail or be empty
        ]);

        lastForecastData = { forecast: forecastResp, air: airResp };
        renderCurrent(forecastResp, airResp);
        renderForecast(forecastResp, airResp);
        renderMap(lastLocation.lat, lastLocation.lon, lastLocation.name);
        generateAISummary();
        cacheLastSeen(); // localStorage cache
    }catch(err){
        console.error("Weather fetch error", err);
        alert("Failed to fetch weather. See console for details.");
    } finally {
        showMainLoading(false);
    }
}

/* -----------------------------
    RENDER: Current Weather Card
    ----------------------------- */
function renderCurrent(data, air){
    const cur = data.current_weather || {};
    const hourly = data.hourly || {};
    const idx = findHourlyIndex(hourly, cur.time);
    const pressure = (hourly.pressure_msl && idx >= 0) ? hourly.pressure_msl[idx] : (data.daily?.pressure_msl?.[0] ?? "N/A");
    const humidity = (hourly.relative_humidity_2m && idx >= 0) ? hourly.relative_humidity_2m[idx] : "N/A";
    const windspeed = cur.windspeed ?? "N/A";
    const weatherCode = cur.weathercode ?? 0;
    const weather = WEATHER_CODES[weatherCode] || { txt: "Unknown", emoji: "🌍" };
    const aqiUS = (air && air.hourly && air.hourly.us_aqi && air.hourly.us_aqi.length>0) ? air.hourly.us_aqi[0] : (air && air.current?.us_aqi) || "N/A";
    const aqiEU = (air && air.hourly && air.hourly.european_aqi && air.hourly.european_aqi.length>0) ? air.hourly.european_aqi[0] : (air && air.current?.european_aqi) || "N/A";

    // build HTML
    const html = `
        <div class="current-top">
            <div style="flex:1">
                <div class="location-name">${lastLocation.name}</div>
                <div class="small-muted">${new Date(cur.time || Date.now()).toLocaleString()}</div>
                <div class="small-muted">Sunrise: ${formatTime(data.daily?.sunrise?.[0])} • Sunset: ${formatTime(data.daily?.sunset?.[0])}</div>
            </div>

            <div style="text-align:right">
                <div class="current-temp">${fmtTemp(cur.temperature)}</div>
                <div class="small-muted">${weather.txt} ${weather.emoji}</div>
            </div>
        </div>

        <div class="row">
            <div class="stat temp"><div class="label">Temperature</div><div class="value">${fmtTemp(cur.temperature)}</div></div>
            <div class="stat"><div class="label">Wind</div><div class="value">${windspeed} km/h</div></div>
            <div class="stat pressure"><div class="label">Pressure</div><div class="value">${safe(pressure)} hPa</div></div>
        </div>

        <div class="extra-grid" style="margin-top:12px">
            <div class="stat humidity"><div class="label">Humidity</div><div class="value">${safe(humidity)} %</div></div>
            <div class="stat uv"><div class="label">UV Index</div><div class="value">${safe(data.daily?.uv_index_max?.[0] ?? "N/A")}</div></div>
            <div class="stat aqi ${aqiClass(aqiUS)}"><div class="label">AQI (US)</div><div class="value">${safe(aqiUS)} <span class="small muted">| EU ${safe(aqiEU)}</span></div></div>
        </div>

        <div style="margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <button id="speakNow" class="btn outline">Speak Summary</button>
            <button id="downloadCSV" class="btn">Download CSV</button>
            <button id="showDetails" class="btn outline">Open Forecast Modal</button>
        </div>

        <canvas id="trendCanvas" class="sparkline" width="600" height="40" aria-hidden="true"></canvas>
    `;

    currentCard.innerHTML = html;

    // wire small buttons inside current
    $("speakNow").addEventListener("click", speakSummary);
    $("downloadCSV").addEventListener("click", () => exportCSV(lastForecastData));
    $("showDetails").addEventListener("click", () => openDayModal(0));

    // draw trend sparkline - use daily max temps
    drawSparkline("trendCanvas", data.daily?.temperature_2m_max || []);
}

/* -----------------------------
    RENDER: Forecast Grid
    ----------------------------- */
function renderForecast(data, air){
    forecastGrid.innerHTML = "";
    const days = (data.daily && data.daily.time) ? data.daily.time : [];
    const tempsMax = data.daily?.temperature_2m_max || [];
    const tempsMin = data.daily?.temperature_2m_min || [];

    days.forEach((d, i) => {
        const code = data.daily.weathercode?.[i];
        const meta = WEATHER_CODES[code] || { txt: "N/A", emoji: "🌍" };
        const maxT = tempsMax[i];
        const minT = tempsMin[i];
        const rain = data.daily.precipitation_sum?.[i] ?? 0;
        const chance = data.daily.precipitation_probability_mean?.[i] ?? "N/A";
        const uv = data.daily.uv_index_max?.[i] ?? "N/A";

        const card = document.createElement("div");
        card.className = "day-card";
        card.tabIndex = 0;
        card.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center">
                <div>
                    <div class="fw">${new Date(d).toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'})}</div>
                    <div class="small-muted">${meta.txt}</div>
                </div>
                <div style="text-align:right">
                    <div class="weather-emoji">${meta.emoji}</div>
                    <div class="small-muted">${fmtTemp(maxT)} / ${fmtTemp(minT)}</div>
                </div>
            </div>
            <div style="margin-top:8px" class="small-muted">Rain: ${rain} mm • Chance: ${chance}% • UV: ${uv}</div>
            <canvas class="sparkline day-spark" data-day-index="${i}" width="300" height="40" aria-hidden="true"></canvas>
        `;
        card.addEventListener("click", () => openDayModal(i));
        card.addEventListener("keypress", (e)=> { if(e.key === "Enter") openDayModal(i); });

        forecastGrid.appendChild(card);

        // draw a small sparkline using hourly temperature slice (if available)
        // fallback: draw mini trend from daily min/max
        const dayCanvas = card.querySelector(".day-spark");
        const hourTemps = extractHourlyTempsForDay(data.hourly, d);
        if(hourTemps && hourTemps.length > 0){
            drawSparklineElement(dayCanvas, hourTemps);
        } else {
            drawSparklineElement(dayCanvas, [minT, (minT+maxT)/2, maxT]);
        }
    });

    // scroll into view on mobile
    forecastGrid.scrollIntoView({behavior:"smooth", block:"start"});
}

/* -----------------------------
    RENDER: MAP
    ----------------------------- */
function renderMap(lat, lon, name){
    mapName.textContent = name;
    const span = 0.03;
    const left = (lon - span).toFixed(5);
    const right = (lon + span).toFixed(5);
    const top = (lat + span).toFixed(5);
    const bottom = (lat - span).toFixed(5);
    const src = `https://www.openstreetmap.org/export/embed.html?bbox=${left}%2C${bottom}%2C${right}%2C${top}&layer=mapnik&marker=${lat}%2C${lon}`;
    mapWrap.innerHTML = `<iframe src="${src}" style="border:0;width:100%;height:100%"></iframe><div style="padding:8px;text-align:center;font-size:0.85rem;color:var(--muted)"><a target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=12/${lat}/${lon}">Open map</a></div>`;
}

/* -----------------------------
    GLOBAL WEATHER REPORT (5 cities)
    ----------------------------- */
async function loadGlobalReportAsync(){
    globalGrid.innerHTML = `<div class="loading">Loading global report…</div>`;
    const cities = [
        { name: "Delhi", lat: 28.61, lon: 77.21 },
        { name: "New York", lat: 40.71, lon: -74.01 },
        { name: "London", lat: 51.51, lon: -0.13 },
        { name: "Tokyo", lat: 35.68, lon: 139.69 },
        { name: "Sydney", lat: -33.87, lon: 151.21 }
    ];
    try{
        const results = await Promise.all(cities.map(c => fetch(`${FORECAST_BASE}?latitude=${c.lat}&longitude=${c.lon}&current_weather=true&timezone=auto`).then(r=>r.ok? r.json(): null)));
        globalGrid.innerHTML = "";
        results.forEach((res, idx) => {
            if(!res || !res.current_weather){
                const div = document.createElement("div"); div.className = "city-card"; div.innerHTML = `<div>${cities[idx].name}</div><div class="small-muted">N/A</div>`; globalGrid.appendChild(div); return;
            }
            const cw = res.current_weather;
            const code = cw.weathercode;
            const meta = WEATHER_CODES[code] || {txt:"", emoji:"🌍"};
            const div = document.createElement("div"); div.className = "city-card";
            div.innerHTML = `<div style="font-weight:800">${cities[idx].name}</div><div style="font-size:1rem">${fmtTemp(cw.temperature)}</div><div class="small-muted">${meta.emoji} ${meta.txt}</div><div class="small-muted">Wind ${cw.windspeed} km/h</div>`;
            globalGrid.appendChild(div);
        });
    }catch(err){
        console.error("Global report failed", err);
        globalGrid.innerHTML = `<div class="loading">Unable to load global weather.</div>`;
    }
}

/* -----------------------------
    FIND HOURLY INDEX HELPER
    ----------------------------- */
function findHourlyIndex(hourly, targetIso){
    if(!hourly || !hourly.time) return -1;
    let i = hourly.time.indexOf(targetIso);
    if(i >= 0) return i;
    // match by date-hour prefix
    const prefix = (targetIso || "").slice(0,13);
    return hourly.time.findIndex(t => t.slice(0,13) === prefix);
}

/* -----------------------------
    EXTRACT HOURLY TEMPS FOR DAY
    ----------------------------- */
function extractHourlyTempsForDay(hourly, isoDate){
    if(!hourly || !hourly.time) return null;
    const dayPrefix = isoDate.slice(0,10);
    const temps = [];
    for(let i=0;i<hourly.time.length;i++){
        if(hourly.time[i].startsWith(dayPrefix)){
            const t = hourly.temperature_2m ? hourly.temperature_2m[i] : null;
            if(t !== null && t !== undefined) temps.push(t);
        }
    }
    return temps.length>0 ? temps : null;
}

/* -----------------------------
    DRAW SPARKLINE (canvas)
    ----------------------------- */
function drawSparkline(canvasIdOrElem, numbers){
    const el = (typeof canvasIdOrElem === "string") ? $(canvasIdOrElem) : canvasIdOrElem;
    if(!el) return;
    drawSparklineElement(el, numbers);
}
function drawSparklineElement(canvas, numbers){
    if(!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0,0,w,h);
    if(!numbers || numbers.length === 0) return;
    const min = Math.min(...numbers);
    const max = Math.max(...numbers);
    const range = (max - min) || 1;
    ctx.lineWidth = 2;
    // gradient stroke
    const grad = ctx.createLinearGradient(0,0,w,0);
    grad.addColorStop(0, "rgba(0,210,255,0.9)");
    grad.addColorStop(1, "rgba(58,123,213,0.9)");
    ctx.strokeStyle = grad;
    ctx.beginPath();
    numbers.forEach((v,i) => {
        const x = (i / (numbers.length - 1 || 1)) * (w - 8) + 4;
        const y = h - 4 - ((v - min) / range) * (h - 8);
        if(i === 0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.stroke();
    // small fill
    ctx.lineTo(w-4, h-4);
    ctx.lineTo(4, h-4);
    ctx.closePath();
    const fillGrad = ctx.createLinearGradient(0,0,0,h);
    fillGrad.addColorStop(0, "rgba(0,210,255,0.12)");
    fillGrad.addColorStop(1, "rgba(58,123,213,0.04)");
    ctx.fillStyle = fillGrad;
    ctx.fill();
}

/* -----------------------------
    AI ASSISTANT (Local heuristics)
    - Summarize next 3 days
    - Advice (umbrella, clothing)
    - Simple alerts (high UV, high AQI)
    ----------------------------- */
function generateAISummary(){
    if(!lastForecastData || !lastForecastData.forecast) { aiOutput.textContent = "No forecast loaded yet."; return; }
    const f = lastForecastData.forecast;
    const days = f.daily.time || [];
    const len = Math.min(3, days.length);
    const parts = [];
    // summary header
    parts.push(`Forecast summary for ${lastLocation.name}:`);
    // look for rain in next 3 days
    for(let i=0;i<len;i++){
        const date = new Date(days[i]).toLocaleDateString(undefined, {weekday:'short', month:'short', day:'numeric'});
        const chance = f.daily.precipitation_probability_mean?.[i] ?? 0;
        const rain = f.daily.precipitation_sum?.[i] ?? 0;
        const maxT = f.daily.temperature_2m_max?.[i] ?? null;
        const minT = f.daily.temperature_2m_min?.[i] ?? null;
        const uv = f.daily.uv_index_max?.[i] ?? 0;
        const wc = f.daily.weathercode?.[i] ?? 0;
        let sentence = `${date}: ${WEATHER_CODES[wc]?.txt || "Weather"} — `;
        sentence += `High ${round1(maxT)}°C, Low ${round1(minT)}°C. `;
        if(chance >= 60 || rain > 5) sentence += `High chance of rain (${chance}%), carry an umbrella. `;
        else if(chance >= 30) sentence += `Moderate chance of rain (${chance}%). `;
        else sentence += `Low chance of rain. `;
        if(uv >= 8) sentence += `Very high UV (${uv}) — wear sunscreen. `;
        else if(uv >= 6) sentence += `High UV (${uv}). `;
        parts.push(sentence);
    }

    // AQI and special advisories
    const air = lastForecastData.air;
    if(air && air.hourly && air.hourly.us_aqi && air.hourly.us_aqi.length>0){
        const aqiNow = air.hourly.us_aqi[0];
        parts.push(`Current US AQI: ${aqiNow}. ${aqiAdvice(aqiNow)}`);
    }

    // clothing advice based on today's max temp
    const todayMax = f.daily.temperature_2m_max?.[0] ?? null;
    if(todayMax !== null){
        const clothes = clothingAdvice(todayMax);
        parts.push(`Clothing advice: ${clothes}`);
    }

    const message = parts.join("\n\n");
    aiOutput.textContent = message;
    return message;
}

function clothingAdvice(tempC){
    if(tempC >= 32) return "Very hot — light clothes, stay hydrated, avoid midday sun.";
    if(tempC >= 25) return "Warm — T-shirt & light trousers, sunglasses recommended.";
    if(tempC >= 18) return "Mild — layer with light jacket for mornings/evenings.";
    if(tempC >= 10) return "Cool — jacket or sweater recommended.";
    return "Cold — heavy jacket, gloves and warm clothing.";
}

function aqiAdvice(aqi){
    if(aqi === "N/A" || aqi === null) return "AQI data not available.";
    const n = Number(aqi);
    if(isNaN(n)) return "AQI data not numeric.";
    if(n <= 50) return "Air quality is good.";
    if(n <= 100) return "Moderate — some sensitive groups should take care.";
    if(n <= 150) return "Unhealthy for sensitive groups — consider limiting prolonged outdoor exertion.";
    if(n <= 200) return "Unhealthy — reduce outdoor activity.";
    return "Very unhealthy/hazardous — avoid outdoor activity if possible.";
}

/* -----------------------------
    VOICE COMMANDS (SpeechRecognition API)
    - Recognize simple instructions like "search Mumbai"
    ----------------------------- */
async function startVoiceCommand(){
    if(!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)){
        alert("SpeechRecognition not supported in your browser.");
        return;
    }
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SpeechRec();
    rec.lang = 'en-IN';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    aiOutput.textContent = "Listening… say 'search <city>' or 'show forecast for <city>'";
    aiVoiceActive = true;
    rec.onresult = (e) => {
        const text = e.results[0][0].transcript.trim();
        aiOutput.textContent = `Heard: "${text}"`;
        // simple parsing
        const lowered = text.toLowerCase();
        if(lowered.startsWith("search ") || lowered.startsWith("show ")){
            const city = lowered.replace(/(search|show|forecast|for)/g, "").trim();
            if(city) {
                searchInput.value = city;
                doSearch();
            } else {
                aiOutput.textContent = "Could not detect city name. Try again.";
            }
        } else {
            aiOutput.textContent = 'Voice commands: say "search <city>" or "show forecast for <city>".';
        }
        aiVoiceActive = false;
    };
    rec.onend = () => { if(aiVoiceActive) aiOutput.textContent = "Listening ended."; aiVoiceActive = false; };
    rec.onerror = (err) => { console.error("Voice error", err); aiOutput.textContent = "Voice error: " + err.message; aiVoiceActive = false; };
    rec.start();
}

/* -----------------------------
    TEXT-TO-SPEECH: Speak the AI summary
    ----------------------------- */
function speakSummary(){
    const summary = aiOutput.textContent || generateAISummary();
    if(!('speechSynthesis' in window)) return alert("Text-to-speech not supported in this browser.");
    const utter = new SpeechSynthesisUtterance(summary);
    utter.lang = 'en-IN';
    utter.rate = 1;
    utter.pitch = 1;
    speechSynthesis.cancel();
    speechSynthesis.speak(utter);
}

/* -----------------------------
    EXPORT: JSON & CSV
    ----------------------------- */
function exportJSON(){
    if(!lastForecastData) return alert("No data to export.");
    const payload = {
        location: lastLocation,
        fetched_at: new Date().toISOString(),
        forecast: lastForecastData
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type: "application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `weatherpro_${(lastLocation?.name||'location').replace(/\s+/g,'_')}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
}

function exportCSV(dataObj){
    if(!dataObj || !dataObj.forecast) return alert("No forecast to export.");
    const f = dataObj.forecast;
    const rows = [["date","max_temp_C","min_temp_C","precip_mm","precip_chance_pct","uv_index"]];
    for(let i=0;i<f.daily.time.length;i++){
        rows.push([
            f.daily.time[i],
            f.daily.temperature_2m_max[i],
            f.daily.temperature_2m_min[i],
            f.daily.precipitation_sum[i],
            f.daily.precipitation_probability_mean[i],
            f.daily.uv_index_max[i]
        ]);
    }
    const csv = rows.map(r => r.map(v => `"${v}"`).join(",")).join("\n");
    const blob = new Blob([csv], {type: "text/csv"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `forecast_${(lastLocation?.name||'loc').replace(/\s+/g,'_')}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
}

/* -----------------------------
    MODAL: Day Details
    ----------------------------- */
function openDayModal(dayIndex){
    if(!lastForecastData || !lastForecastData.forecast) return;
    const f = lastForecastData.forecast;
    const air = lastForecastData.air;
    const date = f.daily.time[dayIndex];
    const code = f.daily.weathercode?.[dayIndex] ?? 0;
    const meta = WEATHER_CODES[code] || { txt: "Unknown", emoji: "🌍" };
    const hourlyDataAvailable = f.hourly && f.hourly.time.some(t => t.startsWith(date.slice(0,10)));

    const hourlyHtml = hourlyDataAvailable
        ? `<div class="small muted">Hourly data is available, check export.</div>`
        : `<div class="small muted">Hourly data not available for this day, check export JSON for raw data.</div>`;
    
    const html = `
        <h3>${new Date(date).toLocaleDateString(undefined,{weekday:'long', month:'long', day:'numeric'})} — ${meta.txt} ${meta.emoji}</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-top:10px">
            <div class="stat"><div class="label">Max Temp</div><div class="value">${fmtTemp(f.daily.temperature_2m_max[dayIndex])}</div></div>
            <div class="stat"><div class="label">Min Temp</div><div class="value">${fmtTemp(f.daily.temperature_2m_min[dayIndex])}</div></div>
            <div class="stat"><div class="label">Rain (sum)</div><div class="value">${safe(f.daily.precipitation_sum[dayIndex])} mm</div></div>
            <div class="stat"><div class="label">Rain Chance</div><div class="value">${safe(f.daily.precipitation_probability_mean[dayIndex])}%</div></div>
            <div class="stat"><div class="label">UV Index</div><div class="value">${safe(f.daily.uv_index_max[dayIndex])}</div></div>
            <div class="stat"><div class="label">AQI (US)</div><div class="value">${safe(air?.hourly?.us_aqi?.[dayIndex] ?? air?.current?.us_aqi ?? "N/A")}</div></div>
        </div>
        <div style="margin-top:12px" class="small muted">Note: hourly values are available via API. Use export JSON to download raw data.</div>
    `;
    modalContent.innerHTML = html;
    dayModal.setAttribute("aria-hidden","false");
}

function closeModal(){ dayModal.setAttribute("aria-hidden","true"); }

/* -----------------------------
    SMALL HELPERS
    ----------------------------- */
function showMainLoading(show, message){
    if(show){
        currentCard.innerHTML = `<div class="loading">${message || "Loading..."}</div>`;
        mainLoading.textContent = message || "Loading...";
        mainLoading.style.display = "block";
    } else {
        mainLoading.style.display = "none";
    }
}

function toggleUnits(){
    isCelsius = !isCelsius;
    unitsBtn.textContent = isCelsius ? "Fahrenheit" : "Celsius";

    // Re-render everything with new units
    if(lastForecastData) {
        renderCurrent(lastForecastData.forecast, lastForecastData.air);
        renderForecast(lastForecastData.forecast, lastForecastData.air);
        loadGlobalReportAsync(); // Re-fetch global (or re-render if data stored)
        generateAISummary(); // Summary should use new unit format
    }
}

function cacheLastSeen(){
    if(!lastLocation) return;
    try {
        localStorage.setItem('weatherpro_last_loc', JSON.stringify(lastLocation));
        localStorage.setItem('weatherpro_is_celsius', isCelsius ? 'true' : 'false');
    } catch(e) {
        console.warn("localStorage not available for caching.");
    }
}

function loadLastSeen(){
    try {
        const loc = localStorage.getItem('weatherpro_last_loc');
        const units = localStorage.getItem('weatherpro_is_celsius');
        if (units) {
            isCelsius = (units === 'true');
            unitsBtn.textContent = isCelsius ? "Fahrenheit" : "Celsius";
        }
        return loc ? JSON.parse(loc) : null;
    } catch(e) {
        return null;
    }
}

// End of script.js
