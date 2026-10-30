// ---------------------------------------------------------------------------
// EMAIL ONE-TIME-CODE SIGN-IN: the alternative to Google sign-in.
// authRequestCode: emails a 6-digit code. authVerifyCode: swaps the code for a
// session token. Session tokens look like "ts1.<payload>.<signature>"; the payload
// is base64url JSON {email, exp (epoch seconds)} and the signature is an HMAC-SHA256
// keyed by the SESSION_SECRET Script Property (created on first use, never sent out).
// verifyGoogleToken_ / verifyGoogleTokenInfo_ also accept these tokens, so every
// other file treats both sign-in methods identically (identity = verified email).
// ---------------------------------------------------------------------------

var SESSION_PREFIX = 'ts1.';
var SESSION_TTL_SECONDS = 2 * 60 * 60;
var REMEMBER_TTL_SECONDS = 30 * 24 * 60 * 60;
var CODE_TTL_SECONDS = 10 * 60;
var CODE_MAX_ATTEMPTS = 5;
var CODE_REQUESTS_PER_EMAIL = 3;     // per CODE_TTL_SECONDS
var CODE_REQUESTS_GLOBAL = 60;       // per hour, protects the daily MailApp quota
var EMAIL_PATTERN = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

function getSessionSecret_() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('SESSION_SECRET');
  if (secret) return secret;
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    secret = props.getProperty('SESSION_SECRET');
    if (!secret) {
      secret = Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid();
      props.setProperty('SESSION_SECRET', secret);
    }
    return secret;
  } finally {
    lock.releaseLock();
  }
}

function hmacB64_(text) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(text, getSessionSecret_())).replace(/=+$/, '');
}

function emailKey_(prefix, email) {
  return prefix + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, email, Utilities.Charset.UTF_8));
}

// sub/name are set only for tokens exchanged from a Google sign-in, so a remembered Google
// user keeps the same profile key and prefilled name as a live Google sign-in.
function issueSessionToken_(email, ttlSeconds, sub, name) {
  var claims = { email: email, exp: Math.floor(Date.now() / 1000) + (ttlSeconds || SESSION_TTL_SECONDS) };
  if (sub) claims.sub = String(sub);
  if (name) claims.name = String(name).substring(0, 100);
  var payload = Utilities.base64EncodeWebSafe(JSON.stringify(claims), Utilities.Charset.UTF_8).replace(/=+$/, '');
  return SESSION_PREFIX + payload + '.' + hmacB64_(payload);
}

function isSessionToken_(token) {
  return typeof token === 'string' && token.indexOf(SESSION_PREFIX) === 0;
}

// Returns { sub, email, emailVerified } for a valid, unexpired session token, else null.
function verifySessionToken_(token) {
  if (!isSessionToken_(token)) return null;
  var parts = token.split('.');
  if (parts.length !== 3) return null;
  if (hmacB64_(parts[1]) !== parts[2]) return null;
  try {
    var padded = parts[1] + '===='.slice(parts[1].length % 4 || 4);
    var claims = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(padded)).getDataAsString());
    if (!claims.email || Number(claims.exp) * 1000 < Date.now()) return null;
    var email = String(claims.email).trim().toLowerCase();
    return { sub: claims.sub ? String(claims.sub) : 'email:' + email, email: email, emailVerified: true };
  } catch (err) {
    return null;
  }
}

function newLoginCode_() {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid());
  var n = 0;
  for (var i = 0; i < 4; i++) n = n * 256 + (bytes[i] & 255);
  return ('00000' + (n % 1000000)).slice(-6);
}

function cleanEmail_(v) {
  var email = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
  return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : '';
}

// Same response whether or not mail was sent, so this can't be used to probe addresses.
function authRequestCode_(data) {
  var email = cleanEmail_(data.email);
  if (!email) return { status: 'error', code: 'invalid', message: 'Enter a valid email address.' };
  var generic = { status: 'success', message: 'If that address can receive mail, a sign-in code is on its way. It expires in 10 minutes.' };

  var cache = CacheService.getScriptCache();
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  var code;
  try {
    var perEmailKey = emailKey_('rc_', email);
    var perEmail = Number(cache.get(perEmailKey) || 0);
    var globalCount = Number(cache.get('rc_global') || 0);
    if (perEmail >= CODE_REQUESTS_PER_EMAIL) {
      return { status: 'error', code: 'rate_limit', message: 'Too many code requests for this address. Wait a few minutes and try again.' };
    }
    if (globalCount >= CODE_REQUESTS_GLOBAL) {
      return { status: 'error', code: 'rate_limit', message: 'Sign-in by email is busy. Try again later or use Google sign-in.' };
    }
    cache.put(perEmailKey, String(perEmail + 1), CODE_TTL_SECONDS);
    cache.put('rc_global', String(globalCount + 1), 3600);

    code = newLoginCode_();
    cache.put(emailKey_('code_', email), JSON.stringify({ h: hmacB64_(email + ':' + code), tries: 0 }), CODE_TTL_SECONDS);
  } finally {
    lock.releaseLock();
  }

  MailApp.sendEmail({
    to: email,
    subject: 'Troop 58 sign-in code',
    body: 'Your Troop 58 sign-in code is ' + code + '\n\nIt expires in 10 minutes. ' +
          'If you did not ask for this, you can ignore this email.'
  });
  logEvent_('authRequestCode', 'code sent');
  return generic;
}

function authVerifyCode_(data) {
  var email = cleanEmail_(data.email);
  var code = String(data.code === undefined || data.code === null ? '' : data.code).replace(/\s+/g, '');
  var bad = { status: 'error', code: 'bad_code', message: 'That code is wrong or has expired. Request a new one.' };
  if (!email || !/^\d{6}$/.test(code)) return bad;

  var cache = CacheService.getScriptCache();
  var key = emailKey_('code_', email);
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var raw = cache.get(key);
    if (!raw) return bad;
    var entry = JSON.parse(raw);
    if (entry.tries >= CODE_MAX_ATTEMPTS) { cache.remove(key); return bad; }
    if (entry.h !== hmacB64_(email + ':' + code)) {
      entry.tries++;
      cache.put(key, JSON.stringify(entry), CODE_TTL_SECONDS);
      return bad;
    }
    cache.remove(key);
  } finally {
    lock.releaseLock();
  }
  logEvent_('authVerifyCode', 'ok');
  return { status: 'success', token: issueSessionToken_(email, data.remember === true ? REMEMBER_TTL_SECONDS : SESSION_TTL_SECONDS) };
}

// "Remember me" for Google sign-in: swaps a live Google ID token for a 30-day session token.
// Session tokens are refused here so a remembered session can't be renewed forever.
function authExchange_(data) {
  if (isSessionToken_(data.idToken)) return { status: 'error', code: 'signin', message: 'Please sign in with Google.' };
  var info = verifyGoogleTokenInfo_(data.idToken);
  if (!info || !info.emailVerified || !info.email) return { status: 'error', code: 'signin', message: 'Your sign-in has expired or is invalid. Please sign in again.' };
  return { status: 'success', token: issueSessionToken_(info.email, REMEMBER_TTL_SECONDS, info.sub, info.name) };
}
