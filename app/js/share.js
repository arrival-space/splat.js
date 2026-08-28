// share.js — the social layer on top of the trainer.
//
// A shared creation IS an arrival space: the SOG is its walkable model, and
// a `splatjs` block in the space data (written through the same authed API
// the upload button already uses) carries everything the splat.js viewer
// needs to present it — sogUrl, recon, thumbnail, training stats. Reading
// is public: two read-only endpoints resolve share links and page the
// gallery, honoring the space's privacy ("Open" and "Link Only" resolve,
// only "Open" is listed).
//
//   share link:  <app>/index.html?space=<spaceId>
//   enter space: https://arrival.space/<spaceId>

import { getToken, api, uploadFile, forgetRevokedToken, storedToken, API_BASE } from './arrival.js';
import { buildReconJson } from './session_io.js';
import { zipStore } from './zip.js';

const API = `${API_BASE}/api/v1`;

/** Publish the current run as a shared arrival space.
 *  Returns { spaceId, spaceUrl, link }. */
export async function shareCreation(S, sogBlob, {
  title, privacy = 'Link Only', includePhotos = false, thumbBlob = null,
  popup = null, onStatus = () => {}, onProgress = () => {}, recon: reconOverride = null,
} = {}) {
  const token = await getToken(onStatus, popup);
  const slug = (title || 'splat').toLowerCase().replace(/\W+/g, '_');

  try {
    // 1) the walkable space, with the SOG as its model
    const { resourceKey, fileUrl: sogUrl } = await uploadFile(sogBlob, `${slug}.sog`, { token, onStatus, onProgress });
    onStatus('Creating the space …');
    const space = await api('/user/create-space', token, {
      space_data: { title: title || 'Splat.js scene', description: 'Trained in the browser with Splat.js', resource_key: resourceKey },
    });
    const spaceUrl = space.data.space_url;
    const spaceId = String(spaceUrl).split('/').pop();

    // 2) the recon (tour, compare, stats) — plus the photographs when the
    //    creator opted in (preset runs already reference public URLs).
    //    Photos upload in parallel, four in flight; a stray 429 retries.
    const recon = reconOverride || buildReconJson(S); // records share without a live session
    if (includePhotos && S.loadedFiles && S.loadedFiles.length) {
      const total = S.loadedFiles.length;
      let done = 0;
      let next = 0;
      const worker = async () => {
        for (;;) {
          const i = next++;
          if (i >= total) return;
          const f = S.loadedFiles[i];
          const up = await uploadResilient(f.source || f, `${slug}_${f.name}`, token, onStatus);
          recon.source.urls[i] = up.fileUrl;
          onStatus(`Uploading photos … ${++done}/${total}`);
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
    }
    const rz = await uploadFile(
      new Blob([JSON.stringify(recon)], { type: 'application/json' }),
      `${slug}_recon.json`, { token, contentType: 'application/json', onStatus });

    // 3) the thumbnail for the gallery tile
    let thumbUrl = null;
    if (thumbBlob) {
      const th = await uploadFile(thumbBlob, `${slug}_thumb.webp`, { token, contentType: 'image/webp', onStatus });
      thumbUrl = th.fileUrl;
    }

    // 4) stamp the space: description + the splatjs block the public
    //    endpoints resolve
    onStatus('Publishing …');
    const sess = S.session;
    const dB = S.psnrTest ? S.psnrTest.psnr : S.psnrTrain;
    await api(`/spaces/${spaceId}`, token, {
      description: `${title} — ${Number(S.splats).toLocaleString('en-US')} splats trained in the browser by Splat.js` +
        (dB ? ` · ${dB.toFixed(1)} dB` : ''),
      privacy,
      splatjs: {
        version: 1,
        sogUrl,
        reconUrl: rz.fileUrl,
        thumbUrl,
        splats: S.splats,
        iter: sess.trainer.iter,
        minutes: S.minutes || 0,
        // input facts for the pre-start detail card
        frames: (recon.source && recon.source.names && recon.source.names.length) || null,
        res: (recon.frames && recon.frames[0] && recon.frames[0].tw)
          ? `${recon.frames[0].tw} × ${recon.frames[0].th}` : null,
        psnrTrain: S.psnrTrain ?? null,
        psnrTest: S.psnrTest ? { psnr: S.psnrTest.psnr, frames: S.psnrTest.frames.length } : null,
      },
    }, 'PUT');

    return { spaceId, spaceUrl, link: shareLink(spaceId) };
  } catch (e) {
    if (forgetRevokedToken(e)) {
      throw new Error('your Arrival.Space key was revoked — press Share again to sign in');
    }
    throw e;
  }
}

/** uploadFile that shrugs off a stray 429 or network blip with a short
 *  retry — resilience, not pacing. */
async function uploadResilient(blob, fileName, token, onStatus, tries = 4) {
  for (let a = 1; ; a++) {
    try {
      return await uploadFile(blob, fileName, { token, contentType: 'image/jpeg' });
    } catch (e) {
      if (a >= tries || e.auth) throw e;
      await new Promise((r) => setTimeout(r, 3000 * a));
    }
  }
}

export const shareLink = (spaceId) => {
  // always target index.html: the extensionless /splat-js URL 301s through
  // the CDN and loses its query string on the way
  const path = location.pathname.endsWith('.html')
    ? location.pathname
    : location.pathname.replace(/\/$/, '') + '/index.html';
  return `${location.origin}${path}?space=${spaceId}`;
};

/** Resolve a share link (public — no account, no key). */
export async function resolveShare(spaceId) {
  const res = await fetch(`${API}/splatjs/share/${encodeURIComponent(spaceId)}`);
  if (res.status === 404) throw new Error('this space has no shared splat (or it is private)');
  if (!res.ok) throw new Error(`share lookup failed (${res.status})`);
  const data = await res.json();
  return data.data;
}

/** One page of the public gallery. */
export async function fetchGallery({ count = 12, before = null } = {}) {
  const u = new URL(`${API}/splatjs/gallery`);
  u.searchParams.set('count', count);
  if (before) u.searchParams.set('before', before);
  const res = await fetch(u);
  if (!res.ok) return { items: [], nextBefore: null };
  const data = await res.json();
  return data.data || { items: [], nextBefore: null };
}

// ---------------------------------------------------------------------------
// managing your own shares (needs the stored sign-in — no popup here)
// ---------------------------------------------------------------------------

/** The signed-in user's shares, privacy included (management view). */
export async function fetchMine() {
  const token = storedToken();
  if (!token) return null;
  const res = await fetch(`${API}/splatjs/mine`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const data = await res.json();
  return (data.data && data.data.items) || [];
}

/** Flip a share's visibility — "Closed" is the kill-switch: the link stops
 *  resolving instantly. Takes stored privacy values (Open/Link Only/Closed). */
export function setSharePrivacy(spaceId, privacy) {
  return api(`/spaces/${encodeURIComponent(spaceId)}`, storedToken(), { privacy }, 'PUT');
}

/** Delete the share's space entirely. */
export function deleteShare(spaceId) {
  return api(`/spaces/${encodeURIComponent(spaceId)}`, storedToken(), undefined, 'DELETE');
}
