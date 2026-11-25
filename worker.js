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

    // 1. HEALTH CHECK
    if (parts[0] === 'api' && parts[1] === 'health') {
      return jsonResponse({ ok: true, auth: 'google-gmail' }, 200, corsHeaders);
    }

    // 2. ENDPOINT PUBLIK SISWA (GET /api/public/:schoolId)
    if (parts[0] === 'api' && parts[1] === 'public' && parts[2] && request.method === 'GET') {
      const schoolId = parts[2];
      const cache = caches.default;
      const cacheKey = new Request(url.toString(), request);

      let cachedRes = await cache.match(cacheKey);
      if (cachedRes) return cachedRes;

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
      return jsonResponse({ error: 'Jadwal publik belum dipublikasikan oleh guru/admin.' }, 404, corsHeaders);
    }

    // 3. ENDPOINT ADMIN TERPROTEKSI LOGIN GMAIL (/api/admin/:schoolId/...)
    if (parts[0] === 'api' && parts[1] === 'admin' && parts[2]) {
      const schoolId = parts[2];
      const action = parts[3];

      const authUser = await verifyFirebaseUser(request, env);
      if (!authUser) {
        return jsonResponse({ error: 'Silakan login dengan akun Gmail Anda terlebih dahulu.' }, 401, corsHeaders);
      }

      // Isolasi Multi-Sekolah: Setiap user hanya boleh mengelola ruang jadwal miliknya sendiri (sch_<uid>)
      const expectedOwnerId = `sch_${authUser.uid}`;
      if (schoolId !== expectedOwnerId) {
        return jsonResponse({ error: 'Akses ditolak: Anda hanya dapat mengelola jadwal milik akun Gmail Anda.' }, 403, corsHeaders);
      }

      // A. MUAT DATA DARI CLOUD
      if (action === 'load' && request.method === 'GET') {
        const raw = env.TIMETABLE_KV ? await env.TIMETABLE_KV.get(`admin:${schoolId}`) : null;
        if (!raw) return jsonResponse({ empty: true, version: 0 }, 200, corsHeaders);
        return new Response(raw, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      // B. SIMPAN DRAFT KE CLOUD
      if (action === 'save-draft' && request.method === 'PUT') {
        const expectedVersion = parseInt(request.headers.get('If-Match') || '0', 10);
        const payload = await request.json();

        const currentRaw = env.TIMETABLE_KV ? await env.TIMETABLE_KV.get(`admin:${schoolId}`) : null;
        const currentData = currentRaw ? JSON.parse(currentRaw) : { version: 0 };

        if (currentData.version > 0 && expectedVersion !== currentData.version) {
          return jsonResponse({
            error: 'Jadwal baru saja diperbarui di tab lain. Muat ulang halaman dulu.',
            serverVersion: currentData.version
          }, 409, corsHeaders);
        }

        const nextVersion = currentData.version + 1;
        const record = {
          version: nextVersion,
          updatedAt: new Date().toISOString(),
          ownerEmail: authUser.email,
          state: payload
        };

        if (env.TIMETABLE_KV) {
          await env.TIMETABLE_KV.put(`admin:${schoolId}`, JSON.stringify(record));
        }

        return jsonResponse({ ok: true, version: nextVersion }, 200, corsHeaders);
      }

      // C. PUBLISH KE SISWA
      if (action === 'publish' && request.method === 'POST') {
        const payload = await request.json();
        const report = validateFullSchedule(payload);
        if (!report.isValid) {
          return jsonResponse({ error: `Masih ada ${report.hardCount} bentrok merah.` }, 400, corsHeaders);
        }

        const publicView = buildPublicSchedulePayload(payload);
        publicView.publishedAt = new Date().toISOString();

        if (env.TIMETABLE_KV) {
          await env.TIMETABLE_KV.put(`public:${schoolId}`, JSON.stringify(publicView));
        }

        return jsonResponse({ ok: true, schoolId, publishedAt: publicView.publishedAt }, 200, corsHeaders);
      }
    }

    return jsonResponse({ status: 'aSc Web TimeTables API Ready' }, 200, corsHeaders);
  }
};

async function verifyFirebaseUser(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  try {
    const options = env.FIREBASE_PROJECT_ID
      ? { issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`, audience: env.FIREBASE_PROJECT_ID }
      : {};
    const { payload } = await jwtVerify(token, FIREBASE_JWKS, options);
    if (!payload.sub) return null;
    return { uid: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...extraHeaders, 'Content-Type': 'application/json' }
  });
}
