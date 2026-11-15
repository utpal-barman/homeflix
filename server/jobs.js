'use strict';
// ffmpeg "convert to MP4" jobs, one at a time.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { track, uniquePath, writeFileAtomicSync } = require('./util');

const TEMP_NAME = /^\.homeflix-convert-[0-9a-f]+\.mp4$/;

const KEEP_FINISHED = 30;

class Jobs {
  constructor(opts) {
    this.tools = opts.tools;
    this.library = opts.library;
    this.getConfig = opts.getConfig;
    this.log = opts.log || function () {};
    this.jobs = [];
    this.closed = false;
    // Remembers the converter we started, so a later launch can stop it if this one is force-quit.
    this.pidFile = opts.cacheDir ? path.join(opts.cacheDir, 'converting.json') : null;
  }

  notePid(child, tmp) {
    if (!this.pidFile) return;
    try {
      if (child) writeFileAtomicSync(this.pidFile, JSON.stringify({ owner: process.pid, pid: child.pid, tmp: tmp }));
      else fs.unlinkSync(this.pidFile);
    } catch (e) { /* best effort */ }
  }

  // Stop a converter that outlived a force-quit HomeFlix and remove its half-written file.
  cleanupOrphans() {
    if (!this.pidFile) return;
    let note;
    try { note = JSON.parse(fs.readFileSync(this.pidFile, 'utf8')); } catch (e) { return; }
    if (!note || !Number.isInteger(note.owner) || !Number.isInteger(note.pid) || typeof note.tmp !== 'string') {
      try { fs.unlinkSync(this.pidFile); } catch (e) { /* ignore */ }
      return;
    }
    if (note.owner !== process.pid) {
      try { process.kill(note.owner, 0); return; } catch (e) { if (e.code !== 'ESRCH') return; } // its HomeFlix is still alive
    }
    if (note.pid > 1) {
      // Process numbers get re-used: only stop it if it really is our converter.
      const ps = spawnSync('/bin/ps', ['-p', String(note.pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 });
      if (ps.status === 0 && /ffmpeg/.test(ps.stdout) && ps.stdout.indexOf(path.basename(note.tmp)) !== -1) {
        try { process.kill(note.pid, 'SIGKILL'); } catch (e) { /* already gone */ }
      }
    }
    if (TEMP_NAME.test(path.basename(note.tmp))) { try { fs.unlinkSync(note.tmp); } catch (e) { /* ignore */ } }
    try { fs.unlinkSync(this.pidFile); } catch (e) { /* ignore */ }
  }

  list() {
    return this.jobs.map(function (j) {
      return { id: j.id, itemId: j.itemId, title: j.title, state: j.state, percent: j.percent, error: j.error };
    });
  }

  public(job) {
    return { id: job.id, itemId: job.itemId, title: job.title, state: job.state, percent: job.percent, error: job.error };
  }

  // Queue a conversion for a library record. Re-uses an unfinished job for the same item.
  add(rec) {
    const existing = this.jobs.find(function (j) { return j.itemId === rec.id && (j.state === 'queued' || j.state === 'running'); });
    if (existing) return existing;
    const job = {
      id: crypto.randomBytes(6).toString('hex'), itemId: rec.id, title: rec.title,
      state: 'queued', percent: 0, error: null,
      src: rec.path, duration: rec.duration || 0,
      outDir: rec.writable ? rec.dir : path.join(this.getConfig().libraryFolder, rec.collection),
      outName: rec.file.slice(0, rec.file.length - rec.ext.length - 1) + '.mp4',
      tmp: null, child: null
    };
    this.jobs.push(job);
    this.trim();
    this.pump();
    return job;
  }

  trim() {
    const finished = this.jobs.filter(function (j) { return j.state === 'done' || j.state === 'failed'; });
    while (finished.length > KEEP_FINISHED) {
      const old = finished.shift();
      this.jobs.splice(this.jobs.indexOf(old), 1);
    }
  }

  pump() {
    if (this.closed) return;
    if (this.jobs.some(function (j) { return j.state === 'running'; })) return;
    const job = this.jobs.find(function (j) { return j.state === 'queued'; });
    if (job) this.start(job);
  }

  fail(job, message) {
    job.state = 'failed';
    job.error = message;
    job.child = null;
    if (job.tmp) { try { fs.unlinkSync(job.tmp); } catch (e) { /* ignore */ } }
    this.pump();
  }

  start(job) {
    job.state = 'running';
    try {
      fs.mkdirSync(job.outDir, { recursive: true });
    } catch (e) {
      return this.fail(job, 'HomeFlix could not save the converted video in your library folder. Check that the folder still exists and try again.');
    }
    job.tmp = path.join(job.outDir, '.homeflix-convert-' + job.id + '.mp4');
    const args = ['-nostdin', '-loglevel', 'error', '-y', '-i', job.src,
      '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
      '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', '-f', 'mp4', job.tmp];
    let child;
    try {
      child = track(spawn(this.tools.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch (e) {
      return this.fail(job, 'The converter could not be started. Try again.');
    }
    job.child = child;
    this.notePid(child, job.tmp);
    let buf = '', errTail = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      lines.forEach((line) => {
        let secs = null;
        let m = /^out_time_(?:us|ms)=(\d+)/.exec(line); // both are microseconds in ffmpeg
        if (m) secs = parseInt(m[1], 10) / 1e6;
        else if ((m = /^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line))) secs = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
        if (secs !== null && job.duration > 0) {
          job.percent = Math.max(job.percent, Math.min(99, Math.floor((secs / job.duration) * 100)));
        }
      });
    });
    child.stderr.on('data', function (d) { errTail = (errTail + d).slice(-2000); });
    child.on('error', () => { if (job.state === 'running') this.fail(job, 'The converter could not be started. Try again.'); });
    child.on('close', (code) => {
      this.notePid(null);
      if (job.state !== 'running') return; // cancelled
      job.child = null;
      if (code !== 0) {
        this.log('convert failed: ' + errTail.trim().split('\n').pop());
        const full = /No space left/i.test(errTail);
        return this.fail(job, full
          ? 'Your Mac ran out of disk space while converting. Free up some space and try again.'
          : 'This video could not be converted. The file may be damaged or in a format HomeFlix does not know.');
      }
      let out;
      try {
        out = uniquePath(job.outDir, job.outName);
        fs.renameSync(job.tmp, out);
      } catch (e) {
        return this.fail(job, 'HomeFlix could not save the converted video. Check your library folder and try again.');
      }
      job.tmp = null;
      // Only report "done" once the new file is in the library, so the panel can show it straight away.
      Promise.resolve(this.library.addFile(out)).catch(function () {}).then(() => {
        if (job.state !== 'running') return;
        job.percent = 100;
        job.state = 'done';
        this.pump();
      });
    });
  }

  // Cancel a waiting/running job or dismiss a finished one. Returns false when unknown.
  remove(id) {
    const i = this.jobs.findIndex(function (j) { return j.id === id; });
    if (i === -1) return false;
    const job = this.jobs[i];
    const wasRunning = job.state === 'running';
    this.jobs.splice(i, 1);
    job.state = 'cancelled';
    if (job.child) {
      const child = job.child, tmp = job.tmp;
      child.once('close', function () { if (tmp) { try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ } } });
      try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
    }
    if (job.tmp) { try { fs.unlinkSync(job.tmp); } catch (e) { /* ignore */ } }
    if (wasRunning) this.pump();
    return true;
  }

  close() {
    this.closed = true;
    this.jobs.slice().forEach((j) => { if (j.state === 'running' || j.state === 'queued') this.remove(j.id); });
  }
}

module.exports = { Jobs };
