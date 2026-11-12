// Tiny image I/O on top of ffmpeg: RGB24 buffers, no npm dependencies.
const { execFileSync } = require('child_process');

function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim();
  const [w, h] = out.split(',').map(Number);
  return { w, h };
}

// Read as RGB24, optionally scaled by `scale` (e.g. 0.25).
function read(file, scale = 1) {
  let { w, h } = probe(file);
  const args = ['-v', 'error', '-i', file];
  if (scale !== 1) {
    w = Math.round(w * scale);
    h = Math.round(h * scale);
    args.push('-vf', `scale=${w}:${h}:flags=area`);
  }
  args.push('-f', 'rawvideo', '-pix_fmt', 'rgb24', '-');
  const data = execFileSync('ffmpeg', args, { maxBuffer: 1 << 30 });
  return { w, h, data };
}

function write(file, { w, h, data }) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-i', '-', file], { input: data });
}

module.exports = { probe, read, write };
