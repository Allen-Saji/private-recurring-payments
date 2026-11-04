import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('./dist/',import.meta.url));
const state = process.env.WALLET_STATE_DIR;
if (!state || !path.isAbsolute(state)) throw new Error('Set WALLET_STATE_DIR to the absolute private wallet state directory.');
const port = 4173;
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css'};
http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
  const host = req.headers.host;
  if (![ `localhost:${port}`, `127.0.0.1:${port}` ].includes(host) || (req.headers.origin && req.headers.origin !== `http://${host}`)) {res.writeHead(403).end();return;}
  if (req.method !== 'GET') {res.writeHead(405).end();return;}
  try {
    const pathname = new URL(req.url,'http://localhost').pathname;
    if (pathname === '/api/status') {
      res.setHeader('Content-Type','application/json');
      res.end(await readFile(path.join(state,'public-status.json')));return;
    }
    if (pathname !== '/' && !/^\/assets\/[a-zA-Z0-9_.-]+\.(js|css)$/.test(pathname)) {res.writeHead(404).end();return;}
    const file = path.join(root,pathname === '/' ? 'index.html' : pathname);
    res.setHeader('Content-Type',mime[path.extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch {res.writeHead(503).end('Wallet snapshot or built page unavailable.');}
}).listen(port,'127.0.0.1',()=>console.log(`Funding page: http://localhost:${port}`));
