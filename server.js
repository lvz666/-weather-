const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 19000;
const DB_FILE = path.join(__dirname, 'subscriptions.json');
const HTML_FILE = path.join(__dirname, 'index.html');

// 1. 初始化本地数据存储
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, '[]', 'utf-8');
}

function readSubscriptions() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch (err) {
    return [];
  }
}

function writeSubscriptions(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {}
}

const weatherCache = {};

// 2. 核心天气预警监控轮询
async function checkWeatherAndNotify() {
  console.log("[" + new Date().toLocaleString() + "] 开始执行气象预警轮询检测...");
  const subs = readSubscriptions();
  if (subs.length === 0) return;

  const cityCodes = [];
  subs.forEach(s => {
    if (cityCodes.indexOf(s.cityCode) === -1) cityCodes.push(s.cityCode);
  });

  for (const code of cityCodes) {
    try {
      const weatherUrl = "http://www.weather.com.cn/data/alarm/" + code + ".html";
      const response = await fetch(weatherUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      if (!response.ok) continue;

      const resData = await response.json();
      const currentContentStr = JSON.stringify(resData);
      const hasAlarm = resData && resData.data && resData.data.length > 0;

      if (!hasAlarm) {
        weatherCache[code] = currentContentStr;
        continue;
      }

      if (weatherCache[code] === currentContentStr) continue;

      const firstAlarm = resData.data[0];
      const alarmTitle = "【" + firstAlarm.cityName + " " + firstAlarm.eventType + "预警】";
      const alarmBody = firstAlarm.issueTime + "发布：" + firstAlarm.content;

      const targetSubs = subs.filter(s => s.cityCode === code);
      for (const sub of targetSubs) {
        const soundQuery = sub.sound !== 'none' ? "sound=" + sub.sound : 'sound=silence';
        const iconQuery = sub.iconUrl ? "&icon=" + encodeURIComponent(sub.iconUrl) : '';
        
        // 适配最完美的 Bark 私有服务器参数配置格式
        const baseServer = sub.barkServer ? sub.barkServer.replace(/\/$/, '') : 'https://api.day.app';
        const barkUrl = baseServer + "/" + sub.barkKey + "/" + encodeURIComponent(alarmTitle) + "/" + encodeURIComponent(alarmBody) + "?level=critical&" + soundQuery + iconQuery;
        
        console.log("正在通过推送服务器 [" + baseServer + "] 发送预警...");
        await fetch(barkUrl).catch(e => {
          console.error("向私有服务器推送失败:", e.message);
        });
      }
      weatherCache[code] = currentContentStr;
    } catch (err) {
      console.error("监测异常:", err.message);
    }
  }
}

setInterval(checkWeatherAndNotify, 10 * 60 * 1000); // 10分钟轮询一次
setTimeout(checkWeatherAndNotify, 2000);

// 3. HTTP 服务器后端路由
http.createServer((req, res) => {
  const reqUrl = new URL(req.url, "http://" + req.headers.host);
  const pathname = reqUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 读取并返回 HTML 页面
  if (pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (fs.existsSync(HTML_FILE)) {
      res.end(fs.readFileSync(HTML_FILE, 'utf-8'));
    } else {
      res.end('<h3>正在加载中...</h3>');
    }
    return;
  }

  if (pathname === '/api/subscriptions' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readSubscriptions()));
    return;
  }

  if (pathname === '/api/subscribe' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        let list = readSubscriptions();
        const index = list.findIndex(s => s.barkKey === payload.barkKey);
        if (index > -1) list[index] = Object.assign({}, list[index], payload);
        else list.push(payload);
        writeSubscriptions(list);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 1 }));
      } catch (err) {
        res.writeHead(500); res.end(err.message);
      }
    });
    return;
  }

  if (pathname === '/api/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        let list = readSubscriptions().filter(s => s.barkKey !== payload.barkKey);
        writeSubscriptions(list);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 1 }));
      } catch (err) {
        res.writeHead(500); res.end(err.message);
      }
    });
    return;
  }

  // 支持带丰富字段参数的历史灾害推送 API
  if (pathname === '/api/test-push' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const { barkServer, barkKey, title, sound, iconUrl, desc } = payload;
        
        if (!barkKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: -1, msg: '缺少 Bark Key' }));
          return;
        }

        const testTitle = title || "【气象测试】";
        const testBody = desc || "测试推送连接成功";
        const soundQuery = sound !== 'none' ? "sound=" + sound : 'sound=silence';
        const iconQuery = iconUrl ? "&icon=" + encodeURIComponent(iconUrl) : '';
        
        // 组装参数
        const baseServer = barkServer ? barkServer.replace(/\/$/, '') : 'https://api.day.app';
        const barkUrl = baseServer + "/" + barkKey + "/" + encodeURIComponent(testTitle) + "/" + encodeURIComponent(testBody) + "?level=critical&" + soundQuery + iconQuery;

        await fetch(barkUrl);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 1 }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: -1, msg: '发送失败：' + err.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not Found');
}).listen(PORT, () => {
  console.log("===========================================================");
  console.log("🚀 高分辨率极光版气象订阅后台正在运行: http://localhost:" + PORT);
  console.log("===========================================================");
