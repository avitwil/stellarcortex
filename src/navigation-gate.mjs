import net from 'node:net';

// Not a full public suffix list: common country suffixes and shared hosting domains only.
const SHARED_SUFFIXES = new Set([
  'co.il',
  'org.il',
  'ac.il',
  'gov.il',
  'net.il',
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'co.jp',
  'ne.jp',
  'or.jp',
  'com.br',
  'com.tr',
  'co.in',
  'co.za',
  'com.mx',
  'github.io',
  'gitlab.io',
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'web.app',
  'firebaseapp.com',
  'herokuapp.com',
  'azurewebsites.net',
  'cloudfront.net',
  'amazonaws.com',
  'blogspot.com',
  'wordpress.com',
]);
export function urlHost(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return null;
  }
}
function site(host) {
  if (net.isIP(host.replace(/^\[|\]$/g, ''))) return host;
  const labels = host.split('.');
  return labels.slice(SHARED_SUFFIXES.has(labels.slice(-2).join('.')) ? -3 : -2).join('.');
}
export const sameSite = (a, b) => site(a) === site(b);
// Only ever given text the owner wrote. An email address does not name a site.
export function hostsIn(text) {
  const found = String(text).matchAll(
    /(?<![\w@.])(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63})(?![\w-])/gi,
  );
  return [...new Set([...found].map(match => match[1].toLowerCase()))].slice(0, 50);
}
