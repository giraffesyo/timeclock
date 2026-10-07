// The outside world a standalone server talks to, for the end-to-end tests:
// a mail server that keeps what it is sent, an OpenID Connect provider that
// signs in whoever a test says it is, and a list of breached passwords.
//
//   SMTP  :E2E_SMTP_PORT           takes mail without TLS or sign-in
//   HTTP  :E2E_SERVICES_PORT
//     GET /mail?to=ADDRESS         the messages sent to an address, oldest first
//     /idp/...                     the provider (its issuer is <origin>/idp)
//     GET /breach/range/PREFIX     the breach list, in the range API's format

import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { toggl } from './toggl.mjs';

const httpPort = Number(process.env.E2E_SERVICES_PORT ?? 8095);
const smtpPort = Number(process.env.E2E_SMTP_PORT ?? 8094);
const origin = `http://localhost:${httpPort}`;
const issuer = `${origin}/idp`;

/** The one client secret the provider accepts, whatever the client's id. */
const CLIENT_SECRET = process.env.E2E_IDP_SECRET ?? 'the provider’s secret';
/** The passwords on the breach list. */
const BREACHED = ['breached passphrase'];

// --- Mail ---

/** A header's RFC 2047 encoded words (=?utf-8?q?...?= or ?b?), as text. */
const decodeWords = (value) =>
  value.replace(/=\?([^?]+)\?([qQbB])\?([^?]*)\?=\s*/g, (_, charset, kind, text) =>
    kind.toLowerCase() === 'b'
      ? Buffer.from(text, 'base64').toString(charset)
      : Buffer.from(
          text
            .replaceAll('_', ' ')
            .replace(/=([0-9A-F]{2})/gi, (_m, hex) => String.fromCharCode(Number.parseInt(hex, 16))),
          'latin1',
        ).toString(charset),
  );

/** @type {{to: string, from: string, subject: string, text: string}[]} */
const outbox = [];

createTcpServer((socket) => {
  socket.setEncoding('utf8');
  let buffer = '';
  let data = null; // the message being received, once DATA is given
  let from = '';
  let to = '';
  const say = (line) => socket.write(`${line}\r\n`);
  say('220 e2e ESMTP');
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      if (data !== null) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end < 0) return;
        const raw = buffer.slice(0, end).replace(/^\.\./gm, '.');
        buffer = buffer.slice(end + 5);
        data = null;
        const split = raw.indexOf('\r\n\r\n');
        const subject = decodeWords(raw.slice(0, split).match(/^Subject: (.*)$/m)?.[1] ?? '');
        outbox.push({ to: to.toLowerCase(), from, subject, text: raw.slice(split + 4).replaceAll('\r\n', '\n') });
        say('250 OK');
        continue;
      }
      const eol = buffer.indexOf('\r\n');
      if (eol < 0) return;
      const line = buffer.slice(0, eol);
      buffer = buffer.slice(eol + 2);
      const verb = line.slice(0, 4).toUpperCase();
      if (verb === 'EHLO') socket.write('250-e2e\r\n250 8BITMIME\r\n');
      else if (verb === 'MAIL') {
        from = line.match(/<(.*)>/)?.[1] ?? '';
        say('250 OK');
      } else if (verb === 'RCPT') {
        to = line.match(/<(.*)>/)?.[1] ?? '';
        say('250 OK');
      } else if (verb === 'DATA') {
        data = '';
        say('354 Go ahead');
      } else if (verb === 'QUIT') {
        say('221 Bye');
        socket.end();
      } else say('250 OK');
    }
  });
  socket.on('error', () => {});
}).listen(smtpPort);

// --- The provider ---

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'e2e', use: 'sig', alg: 'RS256' };
const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

function idToken(claims) {
  const body = `${b64({ alg: 'RS256', typ: 'JWT', kid: 'e2e' })}.${b64(claims)}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(privateKey).toString('base64url')}`;
}

/** Sign-ins the provider approved, by the code it handed back. */
const codes = new Map();

const attr = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** The provider's sign-in page: it believes whatever address it is given. */
function authorizePage(query) {
  const keep = ['redirect_uri', 'state', 'nonce', 'client_id', 'code_challenge']
    .map((k) => `<input type="hidden" name="${k}" value="${attr(query.get(k) ?? '')}">`)
    .join('');
  return `<!doctype html><meta charset="utf-8"><title>Example Identity</title>
<h1>Example Identity</h1>
<form action="/idp/approve">${keep}
<label>Email at the provider <input name="email" type="email" required autofocus></label>
<label>Name at the provider <input name="name"></label>
<label><input name="unverified" type="checkbox"> The address isn’t verified</label>
<button>Sign in at the provider</button></form>`;
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

createHttpServer(async (req, res) => {
  const url = new URL(req.url ?? '/', origin);
  const json = (status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const path = url.pathname;
  if (await toggl(req, res, url)) return;

  if (path === '/readyz') return json(200, { ok: true });

  if (path === '/mail') {
    const to = (url.searchParams.get('to') ?? '').toLowerCase();
    return json(
      200,
      outbox.filter((m) => m.to === to),
    );
  }

  if (path.startsWith('/breach/range/')) {
    const prefix = path.slice('/breach/range/'.length).toUpperCase();
    const lines = ['0018A45C4D1DEF81644B54AB7F969B88D65:3'];
    for (const password of BREACHED) {
      const digest = createHash('sha1').update(password).digest('hex').toUpperCase();
      if (digest.startsWith(prefix)) lines.push(`${digest.slice(5)}:1207`);
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(lines.join('\r\n'));
  }

  if (path === '/idp/.well-known/openid-configuration') {
    return json(200, {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/keys`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
    });
  }
  if (path === '/idp/keys') return json(200, { keys: [jwk] });
  if (path === '/idp/authorize') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(authorizePage(url.searchParams));
  }
  if (path === '/idp/approve') {
    const q = url.searchParams;
    const code = randomBytes(16).toString('hex');
    codes.set(code, {
      email: q.get('email'),
      name: q.get('name') ?? '',
      verified: !q.has('unverified'),
      nonce: q.get('nonce'),
      client: q.get('client_id'),
      challenge: q.get('code_challenge'),
    });
    const back = new URL(q.get('redirect_uri') ?? '');
    back.searchParams.set('code', code);
    back.searchParams.set('state', q.get('state') ?? '');
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }
  if (path === '/idp/token' && req.method === 'POST') {
    const form = new URLSearchParams(await body(req));
    // The secret comes in the Authorization header, form-encoded, or in the form.
    const basic = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
    const secret =
      form.get('client_secret') ?? decodeURIComponent(basic.slice(basic.indexOf(':') + 1).replaceAll('+', ' '));
    if (secret !== CLIENT_SECRET) return json(401, { error: 'invalid_client' });
    const grant = codes.get(form.get('code'));
    codes.delete(form.get('code'));
    const challenge = createHash('sha256')
      .update(form.get('code_verifier') ?? '')
      .digest('base64url');
    if (!grant || grant.challenge !== challenge) return json(400, { error: 'invalid_grant' });
    const now = Math.floor(Date.now() / 1000);
    return json(200, {
      access_token: randomBytes(16).toString('hex'),
      token_type: 'Bearer',
      expires_in: 300,
      id_token: idToken({
        iss: issuer,
        sub: `user-${createHash('sha1').update(grant.email).digest('hex').slice(0, 12)}`,
        aud: grant.client,
        iat: now,
        exp: now + 300,
        nonce: grant.nonce,
        email: grant.email,
        email_verified: grant.verified,
        name: grant.name,
      }),
    });
  }
  json(404, { error: 'not found' });
}).listen(httpPort);
