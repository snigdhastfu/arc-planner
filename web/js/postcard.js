// End-of-day "Tuck in" postcard: assembled doodle by doodle, then stamped.
import { S, savePostcard, postcards } from './state.js';
import { call } from './bridge.js';
import * as T from './time.js';
import { doodleSVG, strokeFor } from './doodle.js';
import { set, to, drawOn, motion } from './anim.js';
import { roughRect, roughCircle } from './rough.js';
import { esc, shareOrDownload, announce, toast } from './dom.js';
import { pick } from './copy.js';
import { chime, pop } from './sound.js';
import { openSheet } from './ui/sheet.js';

const W = 390, H = 520;
let fontData = null;

async function fontFace() {
  if (fontData === null) {
    try {
      const buf = await fetch('fonts/Fredoka-600.woff2').then((r) => r.arrayBuffer());
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      fontData = `@font-face{font-family:PF;src:url(data:font/woff2;base64,${btoa(bin)}) format("woff2");font-weight:600}`;
    } catch (_) { fontData = ''; }
  }
  return fontData;
}

/** Build the postcard SVG markup (self-contained so it can be rasterised). */
export async function postcardSVG(day) {
  const blocks = S.plan.blocks.filter((b) => T.dayKey(new Date(b.start)) === day);
  const res = call('postcard', { day, blocks, items: S.items, seed: day });
  const [y, m, d] = day.split('-').map(Number);
  const dateLine = `${T.weekdayShort(T.weekdayOf(day)).toUpperCase()} ${d} ${T.monthShort(m - 1).toUpperCase()}`;
  const border = roughRect(W, H, 30, `pc-${day}`, { jitter: 1.4, inset: 3 });
  const ring = roughCircle(326, 66, 34, `ring-${day}`, { jitter: 1.2 });
  const tuck = roughRect(150, 46, 12, `tuck-${day}`, { jitter: 1.2, inset: 2 });
  const stickers = res.stickers.map((s, i) => {
    const size = Math.round(64 * s.scale);
    return `<g class="pc-sticker" data-i="${i}" transform="translate(${s.x} ${s.y}) rotate(${s.rot})"><g transform="translate(${-size / 2} ${-size / 2})">${doodleSVG(s.doodle, size, s.color, { boil: false, draw: false })}</g></g>`;
  }).join('');
  const font = await fontFace();
  const summary = wrapText(res.summary, 30);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Postcard for ${esc(dateLine)}: ${esc(res.summary)}">
  <style>${font}.t{font-family:PF,Fredoka,ui-rounded,system-ui,sans-serif;font-weight:600}</style>
  <rect width="${W}" height="${H}" rx="30" fill="#000"/>
  <path d="${border}" fill="none" stroke="#F7C8D3" stroke-width="2" stroke-linecap="round"/>
  <text class="t" x="32" y="58" font-size="13" letter-spacing="2" fill="#A8A8B0">ARC · POSTCARD</text>
  <text class="t" x="32" y="86" font-size="24" fill="#F0EFEF">${esc(dateLine)}</text>
  <g transform="rotate(-8 326 66)"><path d="${ring}" fill="none" stroke="#FDDEB2" stroke-width="2"/><text class="t" x="326" y="62" text-anchor="middle" font-size="11" fill="#FDDEB2">${d}</text><text class="t" x="326" y="76" text-anchor="middle" font-size="9" fill="#FDDEB2">${T.monthShort(m - 1).toUpperCase()} ${y}</text></g>
  <g class="pc-stickers">${stickers}</g>
  ${res.stickers.length ? '' : `<g transform="translate(163 210)">${doodleSVG('moon', 64, '#F7C8D3', { boil: false, draw: false })}</g>`}
  <text class="t pc-summary" x="32" y="${H - 92}" font-size="18" fill="#FFF7E6" transform="rotate(-1.5 32 ${H - 92})">${summary.map((l, i) => `<tspan x="32" dy="${i ? 22 : 0}">${esc(l)}</tspan>`).join('')}</text>
  <g class="pc-stamp" transform="translate(${W - 182} ${H - 64}) rotate(-6 75 23)"><path d="${tuck}" fill="none" stroke="#7CBB93" stroke-width="2.5"/><text class="t" x="75" y="30" text-anchor="middle" font-size="16" letter-spacing="2" fill="#7CBB93">TUCKED IN</text></g>
</svg>`;
  return { svg, res };
}

function wrapText(s, n) {
  const words = s.split(' ');
  const lines = [''];
  for (const w of words) {
    if ((lines[lines.length - 1] + ' ' + w).trim().length > n) lines.push(w);
    else lines[lines.length - 1] = (lines[lines.length - 1] + ' ' + w).trim();
  }
  return lines.slice(0, 3);
}

/** Rasterise the SVG to a PNG blob via canvas. */
export async function toPNG(svg, scale = 2) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const c = document.createElement('canvas');
    c.width = W * scale; c.height = H * scale;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob(res, 'image/png'));
  } finally { URL.revokeObjectURL(url); }
}
const blobToDataURL = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });

export async function openTuckIn(day, from) {
  const { svg, res } = await postcardSVG(day);
  openSheet({
    title: 'Tuck in',
    from,
    seed: 'tuck',
    tall: true,
    body: `<div class="postcard-stage" data-stage>${svg}</div>
      <p class="m" style="text-align:center;margin:0">${esc(pick('tuckedIn', day))}</p>
      <div class="sheet-actions"><button class="btn btn-primary" data-save style="background:var(--blush)">Save postcard</button><button class="btn btn-text" data-close>Close</button></div>`,
    onMount: (s) => {
      const stage = s.el.querySelector('[data-stage] svg');
      animateIn(stage);
      s.el.querySelector('[data-close]').onclick = () => s.close();
      s.el.querySelector('[data-save]').onclick = async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        const png = await toPNG(svg);
        await savePostcard(day, { summary: res.summary, svg, png: await blobToDataURL(png), at: T.iso(T.now()) });
        const how = await shareOrDownload(png, `arc-postcard-${day}.png`, 'Arc postcard');
        btn.disabled = false;
        toast(how === 'shared' ? 'Postcard shared.' : how === 'cancelled' ? 'Saved in your postcards.' : 'Postcard saved.');
      };
    },
  });
  // auto-store so the archive always has the day
  postcards().then(async (list) => {
    if (!list.some((p) => p.day === day)) await savePostcard(day, { summary: res.summary, svg, at: T.iso(T.now()) });
  });
}

function animateIn(svg) {
  const stickers = [...svg.querySelectorAll('.pc-sticker')];
  const stampEl = svg.querySelector('.pc-stamp');
  const summary = svg.querySelector('.pc-summary');
  if (motion.reduced) return;
  svg.querySelectorAll('svg.doodle path').forEach((p) => p.setAttribute('data-draw', ''));
  stickers.forEach((g, i) => {
    g.style.opacity = '0';
    setTimeout(() => {
      g.style.opacity = '1';
      drawOn(g, { duration: 500, stagger: 50 });
      pop(1 + i * 0.05);
    }, 300 + i * 260);
  });
  summary.style.opacity = '0';
  stampEl.style.opacity = '0';
  const t = 300 + stickers.length * 260;
  setTimeout(() => { summary.style.transition = 'opacity .5s'; summary.style.opacity = '1'; }, t);
  setTimeout(() => {
    stampEl.style.opacity = '1';
    stampEl.style.transformBox = 'fill-box';
    stampEl.style.transformOrigin = 'center';
    stampEl.animate([{ transform: 'scale(2.2)', opacity: 0 }, { transform: 'scale(.92)', opacity: 1, offset: 0.7 }, { transform: 'scale(1)', opacity: 1 }], { duration: 380, easing: 'cubic-bezier(.3,1.4,.5,1)' });
    chime();
    announce('Tucked in.');
  }, t + 500);
}

export async function openArchived(p) {
  openSheet({
    title: T.shortDateKey(p.day),
    seed: 'arch' + p.day,
    tall: true,
    body: `<div class="postcard-stage">${p.svg}</div><div class="sheet-actions"><button class="btn btn-primary" data-share style="background:var(--blush)">Save or share</button></div>`,
    onMount: (s) => {
      s.el.querySelector('[data-share]').onclick = async () => {
        const png = await toPNG(p.svg);
        await shareOrDownload(png, `arc-postcard-${p.day}.png`, 'Arc postcard');
      };
    },
  });
}
