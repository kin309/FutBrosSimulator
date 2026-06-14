/**
 * Sobe o relay WebSocket + Vite na LAN automaticamente.
 * Uso: node start-lan.js [--ip 192.168.x.x]
 */
import os from 'os';
import fs from 'fs';
import { spawn } from 'child_process';

const WS_PORT  = 3001; // relay (só localhost — protegido pelo proxy do Vite)
const VITE_PORT = 5173;

// Interfaces virtuais/VPN a evitar por padrão
const VIRTUAL_PATTERN = /vEthernet|Hyper-V|VMware|VirtualBox|Loopback|Hamachi|Radmin|Tailscale/i;

// Faixas de IP privado comuns (LAN real)
function isLanIp(addr) {
  return (
    addr.startsWith('192.168.') ||
    addr.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(addr)
  );
}

function getAllCandidates() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const iface of addrs ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        candidates.push({ name, address: iface.address });
      }
    }
  }
  return candidates;
}

function pickBestIp(candidates) {
  // Preferência: LAN real + interface não-virtual
  const preferred = candidates.filter(
    (c) => isLanIp(c.address) && !VIRTUAL_PATTERN.test(c.name),
  );
  if (preferred.length > 0) return preferred[0].address;

  // Fallback: qualquer LAN real
  const anyLan = candidates.filter((c) => isLanIp(c.address));
  if (anyLan.length > 0) return anyLan[0].address;

  // Último recurso: primeira disponível
  return candidates[0]?.address ?? '127.0.0.1';
}

// Permite passar --ip manualmente: node start-lan.js --ip 192.168.x.x
const manualIpIndex = process.argv.indexOf('--ip');
const manualIp = manualIpIndex !== -1 ? process.argv[manualIpIndex + 1] : null;

const candidates = getAllCandidates();
const ip = manualIp ?? pickBestIp(candidates);
// WS vai pelo proxy do Vite (mesma porta do frontend — sem porta extra no firewall)
const wsUrl  = `ws://${ip}:${VITE_PORT}`;
const appUrl = `http://${ip}:${VITE_PORT}`;

// Escreve .env.local para que o Vite injete VITE_WS_URL no bundle
fs.writeFileSync('.env.local', `VITE_WS_URL=${wsUrl}\n`, 'utf8');

const pad = (s) => String(s).padEnd(28);

console.log('');
console.log('╔══════════════════════════════════════════════╗');
console.log('║         Football Sim — Modo LAN              ║');
console.log('╠══════════════════════════════════════════════╣');
console.log(`║  IP selecionado : ${pad(ip)}║`);
console.log(`║  Relay WS       : ${pad(wsUrl)}║`);
console.log(`║  App (frontend) : ${pad(appUrl)}║`);
console.log('╠══════════════════════════════════════════════╣');

if (candidates.length > 1) {
  console.log('║  Outras interfaces disponíveis:              ║');
  for (const c of candidates) {
    const marker = c.address === ip ? '►' : ' ';
    console.log(`║  ${marker} ${c.name.slice(0, 18).padEnd(18)} ${c.address.padEnd(17)}║`);
  }
  console.log('║  Para usar outro IP: node start-lan.js       ║');
  console.log('║    --ip <endereço>                           ║');
  console.log('╠══════════════════════════════════════════════╣');
}

console.log('║  Compartilhe o link do App com seu amigo.    ║');
console.log('║  Ctrl+C encerra os dois servidores.          ║');
console.log('╚══════════════════════════════════════════════╝');
console.log('');

function startProcess(cmd, args, cwd, label) {
  const proc = spawn(cmd, args, { cwd, stdio: 'pipe', shell: true });

  proc.stdout.on('data', (data) => {
    process.stdout.write(`[${label}] ${data}`);
  });
  proc.stderr.on('data', (data) => {
    process.stderr.write(`[${label}] ${data}`);
  });
  proc.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`[${label}] encerrou com código ${code}`);
    }
  });

  return proc;
}

const relay = startProcess('npm', ['run', 'dev'], './server', 'relay');
setTimeout(() => {
  startProcess('npm', ['run', 'dev'], '.', 'vite');
}, 800);

process.on('SIGINT', () => {
  relay.kill();
  process.exit(0);
});
