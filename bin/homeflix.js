#!/usr/bin/env node
'use strict';

const major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 18) {
  console.error('\n  HomeFlix needs Node.js 18 or newer (this Mac has ' + process.versions.node + ').');
  console.error('  Download the latest version from https://nodejs.org and try again.\n');
  process.exit(1);
}

const http = require('http');
const { spawn } = require('child_process');
const { createApp, DEFAULT_CONTROL_PORT } = require('../server/app');

function parseArgs(argv) {
  const out = { open: true, serve: false, controlPort: DEFAULT_CONTROL_PORT, help: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-open') out.open = false;
    else if (a === '--serve') out.serve = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--control-port' || a.indexOf('--control-port=') === 0) {
      const v = a.indexOf('=') !== -1 ? a.slice(a.indexOf('=') + 1) : argv[++i];
      const n = parseInt(v, 10);
      if (!(n >= 1024 && n <= 65535)) { out.error = '--control-port needs a number between 1024 and 65535.'; return out; }
      out.controlPort = n;
    } else { out.error = 'Unknown option: ' + a; return out; }
  }
  return out;
}

// Is another HomeFlix already answering on this port?
function pingExisting(port) {
  return new Promise(function (resolve) {
    const req = http.get({ host: '127.0.0.1', port: port, path: '/api/ping', timeout: 800 }, function (res) {
      let body = '';
      res.on('data', function (d) { if (body.length < 4096) body += d; });
      res.on('end', function () {
        try { const j = JSON.parse(body); resolve(j && j.ok === true && typeof j.version === 'string'); } catch (e) { resolve(false); }
      });
    });
    req.on('timeout', function () { req.destroy(); resolve(false); });
    req.on('error', function () { resolve(false); });
  });
}

function openBrowser(url) {
  try {
    const c = spawn('/usr/bin/open', [url], { stdio: 'ignore', detached: true });
    c.on('error', function () {});
    c.unref();
  } catch (e) { /* the address is printed anyway */ }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.error) {
    if (args.error) console.error('\n  ' + args.error);
    console.log('\n  Usage: homeflix [--no-open] [--serve] [--control-port <number>]\n');
    console.log('    --no-open        do not open the control panel in the browser');
    console.log('    --serve          switch the TV server on straight away');
    console.log('    --control-port   use another port for the control panel (default ' + DEFAULT_CONTROL_PORT + ')\n');
    process.exit(args.error ? 2 : 0);
  }

  if (await pingExisting(args.controlPort)) {
    const url = 'http://localhost:' + args.controlPort;
    console.log('\n  HomeFlix is already running on this Mac.');
    console.log('  Control panel:  ' + url + '\n');
    if (args.open) openBrowser(url);
    return;
  }

  const app = createApp({
    controlPort: args.controlPort,
    serve: args.serve,
    log: args.verbose ? function (m) { console.log('  [homeflix] ' + m); } : function () {}
  });

  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    console.log('\n  Stopping HomeFlix...');
    const force = setTimeout(function () { process.exit(0); }, 3000);
    force.unref();
    try { await app.close(); } catch (e) { /* exiting anyway */ }
    console.log('  HomeFlix has stopped. You can close this window.\n');
    process.exit(0);
  }
  ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(function (sig) { process.on(sig, shutdown); });
  process.on('uncaughtException', function (e) {
    if (args.verbose) console.error(e);
    else console.error('  Something unexpected happened, but HomeFlix is still running. (' + (e && e.message) + ')');
  });
  process.on('unhandledRejection', function (e) {
    if (args.verbose) console.error(e);
  });

  try {
    await app.start();
  } catch (e) {
    console.error('\n  ' + (e && e.code === 'NO_PORT' ? e.message : 'HomeFlix could not start: ' + (e && e.message)) + '\n');
    process.exit(1);
  }

  const st = await app.status();
  const controlUrl = 'http://localhost:' + app.controlPort;
  const line = '  ----------------------------------------------------------';
  console.log('');
  console.log(line);
  console.log('   HOMEFLIX is running on this Mac.');
  console.log(line);
  console.log('');
  console.log('   Control panel (on this Mac):  ' + controlUrl);
  if (st.running && st.url) {
    console.log('   On your TV, open:             ' + st.url);
  } else if (st.running) {
    console.log('   The TV server is on, but this Mac is not connected to a network.');
    console.log('   Connect to your Wi-Fi to get the address for your TV.');
  } else {
    console.log('   Switch HomeFlix ON in the control panel to get the address for your TV.');
  }
  if (st.error) console.log('\n   Heads up: ' + st.error);
  console.log('');
  console.log('   Library folder: ' + st.config.libraryFolder);
  console.log('');
  console.log('   To stop HomeFlix: press Ctrl+C, or just close this window.');
  console.log('');
  if (args.open) openBrowser(controlUrl);
}

main();
