import { jwtVerify, createRemoteJWKSet } from 'https://esm.sh/jose@5.9.6';
import { validateFullSchedule, buildPublicSchedulePayload } from './public/shared/validator.js';

const FIREBASE_JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')
);

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, If-Match',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    // 1. HEALTH CHECK ENDPOINT (GET /api/health)
    if (parts[0] === 'api' && parts[1] === 'health') {
      return jsonResponse({ ok: true, timestamp: new Date().toISOString(), edge: request.cf?.colo || 'LOCAL' }, 200, corsHeaders);
    }

    // 2. ENDPOINT PUBLIK SISWA/GURU (GET /api/public/:schoolId) -> Baca dari Edge Cache / KV (0 Firestore Read)
    if (parts[0] === 'api' && parts[1] === 'public' && parts[2] && request.method === 'GET') {
      const schoolId = parts[2];
      const cache = caches.default;
      const cacheKey = new Request(url.toString(), request);

      let cachedRes = await cache.match(cacheKey);
      if (cachedRes) return cachedRes;

      // Ambil dari Cloudflare KV jika terpasang
      if (env.TIMETABLE_KV) {
        const kvData = await env.TIMETABLE_KV.get(`public:${schoolId}`);
        if (kvData) {
          const res = new Response(kvData, {
            headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }
          });
          ctx.waitUntil(cache.put(cacheKey, res.clone()));
          return res;
        }
      }

      return jsonResponse({ error: 'Jadwal publik belum tersedia atau belum dipublikasikan.' }, 404, corsHeaders);
    }

    // 3. ENDPOINT ADMIN TERPROTEKSI (/api/admin/:schoolId/...)
    if (parts[0] === 'api' && parts[1] === 'admin' && parts[2]) {
      const schoolId = parts[2];
      const action = parts[3]; // 'load' | 'save-draft' | 'publish'

      // Verifikasi JWT Token dari Firebase Auth
      const authUser = await verifyFirebaseUser(request, env);
      if (!authUser) {
        return jsonResponse({ error: 'Sesi habis atau tidak sah. Silakan login ulang.' }, 401, corsHeaders);
      }

      // Cek Otorisasi Admin Sekolah (via KV atau Firestore)
      const isAuthorized = await checkSchoolAdminAccess(authUser, schoolId, env);
      if (!isAuthorized) {
        return jsonResponse({ error: 'Anda tidak memiliki izin mengelola jadwal sekolah ini.' }, 403, corsHeaders);
      }

      // A. MUAT DATA ADMIN (GET /api/admin/:schoolId/load)
      if (action === 'load' && request.method === 'GET') {
        if (!env.TIMETABLE_KV) {
          return jsonResponse({ error: 'TIMETABLE_KV belum dikonfigurasi di Cloudflare.' }, 500, corsHeaders);
        }
        const raw = await env.TIMETABLE_KV.get(`admin:${schoolId}`);
        if (!raw) return jsonResponse({ empty: true, version: 0 }, 200, corsHeaders);
        return new Response(raw, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      // B. SIMPAN DRAFT DENGAN OPTIMISTIC LOCKING (PUT /api/admin/:schoolId/save-draft)
      if (action === 'save-draft' && request.method === 'PUT') {
        const expectedVersion = parseInt(request.headers.get('If-Match') || '0', 10);
        const payload = await request.json();

        const currentRaw = env.TIMETABLE_KV ? await env.TIMETABLE_KV.get(`admin:${schoolId}`) : null;
        const currentData = currentRaw ? JSON.parse(currentRaw) : { version: 0 };

        // Cegah Lost Update jika versi di server lebih baru daripada yang diedit user
        if (currentData.version > 0 && expectedVersion !== currentData.version) {
          return jsonResponse({
            error: 'Jadwal sudah diubah di tab atau perangkat lain. Muat ulang dulu, ya.',
            serverVersion: currentData.version
          }, 409, corsHeaders);
        }

        const nextVersion = currentData.version + 1;
        const record = {
          version: nextVersion,
          updatedAt: new Date().toISOString(),
          updatedBy: authUser.email || authUser.uid,
          state: payload
        };

        if (env.TIMETABLE_KV) {
          await env.TIMETABLE_KV.put(`admin:${schoolId}`, JSON.stringify(record));
        }

        return jsonResponse({ ok: true, version: nextVersion, updatedAt: record.updatedAt }, 200, corsHeaders);
      }

      // C. PUBLISH JADWAL RESMI KE SISWA (POST /api/admin/:schoolId/publish)
      if (action === 'publish' && request.method === 'POST') {
        const payload = await request.json();

        // Validasi ulang di sisi server sebelum publish
        const report = validateFullSchedule(payload);
        if (!report.isValid) {
          return jsonResponse({
            error: `Masih ada ${report.hardCount} jadwal yang bentrok. Perbaiki sebelum publish.`,
            conflicts: report.conflicts
          }, 400, corsHeaders);
        }

        // Bangun versi publik yang sudah disanitasi (tanpa data internal guru)
        const publicView = buildPublicSchedulePayload(payload);
        publicView.publishedAt = new Date().toISOString();

        if (env.TIMETABLE_KV) {
          await env.TIMETABLE_KV.put(`public:${schoolId}`, JSON.stringify(publicView));
        }

        // Arsipkan juga ke Firestore jika FIREBASE_PROJECT_ID tersedia
        if (env.FIREBASE_PROJECT_ID) {
          const authHeader = request.headers.get('Authorization');
          const fbUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/schedules/${schoolId}`;
          ctx.waitUntil(
            fetch(fbUrl, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
              body: JSON.stringify({
                fields: {
                  schoolName: { stringValue: payload.config?.schoolName || '' },
                  publishedAt: { stringValue: publicView.publishedAt },
                  publishedBy: { stringValue: authUser.email || authUser.uid },
                  publicJson: { stringValue: JSON.stringify(publicView) }
                }
              })
            })
          );
        }

        return jsonResponse({ ok: true, publishedAt: publicView.publishedAt }, 200, corsHeaders);
      }
    }

    return jsonResponse({ status: 'Web TimeTables Edge API v2' }, 200, corsHeaders);
  }
};

async function verifyFirebaseUser(request, env) {
  // Mode bypass lokal jika FIREBASE_PROJECT_ID belum diset saat tahap uji coba awal
  if (!env.FIREBASE_PROJECT_ID) {
    return { uid: 'dev-admin', email: 'admin@sekolah.sch.id', bypass: true };
  }

  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  try {
    const { payload } = await jwtVerify(token, FIREBASE_JWKS, {
      issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
      audience: env.FIREBASE_PROJECT_ID,
    });
    return { uid: payload.sub, email: payload.email };
  } catch (err) {
    return null;
  }
}

async function checkSchoolAdminAccess(authUser, schoolId, env) {
  if (authUser.bypass) return true;
  if (!env.FIREBASE_PROJECT_ID) return true;

  // Cek cache izin admin di KV agar cepat
  const cacheKey = `perm:${authUser.uid}:${schoolId}`;
  if (env.TIMETABLE_KV) {
    const cached = await env.TIMETABLE_KV.get(cacheKey);
    if (cached === 'ALLOWED') return true;
  }

  // Cek dokumen admins/{uid} di Firestore
  const fbUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/admins/${authUser.uid}`;
  const res = await fetch(fbUrl);
  if (!res.ok) return false;

  const doc = await res.json();
  const allowedSchool = doc.fields?.schoolId?.stringValue;
  if (allowedSchool === schoolId) {
    if (env.TIMETABLE_KV) {
      await env.TIMETABLE_KV.put(cacheKey, 'ALLOWED', { expirationTtl: 3600 });
    }
    return true;
  }
  return false;
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...extraHeaders, 'Content-Type': 'application/json' }
  });
}
