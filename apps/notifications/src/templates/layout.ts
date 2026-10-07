// The frame both emails share: brand header, body, legal footer — as table-based HTML with inline styles (what
// mail clients actually render) and as the plain-text alternative.
import { escapeHtml, html, raw } from '../format.js';
import type { Address, RenderContext } from '../types.js';
import { strings } from './strings.js';

export function addressLines(a: Address): string[] {
  const name = [a.first_name, a.last_name]
    .filter((s): s is string => typeof s === 'string')
    .join(' ');
  const cityLine = [a.postal_code, a.city]
    .filter((s): s is string => typeof s === 'string')
    .join(' ');
  return [
    a.company ?? '',
    name,
    a.line1 ?? '',
    a.line2 ?? '',
    cityLine,
    a.region ?? '',
    a.country ?? '',
  ]
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

export function firstName(a: Address): string | null {
  const n = (a.first_name ?? '').trim();
  return n === '' ? null : n;
}

/** Only an absolute http(s) URL may become a link; anything else is shown as text or dropped. */
export function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^https?:\/\/[^\s]+$/i.test(value) ? value : null;
}

export function footerLines(ctx: RenderContext): string[] {
  const s = strings[ctx.locale];
  const l = ctx.brand.legal;
  return [
    s.automated,
    `${l.company} · ${l.address}`,
    ...(l.vatNumber ? [`${s.vat} ${l.vatNumber}`] : []),
    `${s.imprint}: ${l.imprintUrl}`,
    `${s.privacy}: ${l.privacyUrl}`,
  ];
}

function footerHtml(ctx: RenderContext): string {
  const s = strings[ctx.locale];
  const l = ctx.brand.legal;
  const links = [
    [s.imprint, safeUrl(l.imprintUrl)],
    [s.privacy, safeUrl(l.privacyUrl)],
  ] as const;
  return html`<p style="margin:0 0 8px;">${s.automated}</p>
    <p style="margin:0 0 8px;">
      ${l.company} · ${l.address}${l.vatNumber ? raw(html` · ${s.vat} ${l.vatNumber}`) : ''}
    </p>
    <p style="margin:0;">
      ${raw(
        links
          .map(([label, url]) =>
            url
              ? html`<a href="${url}" style="color:#71717a;">${label}</a>`
              : html`<span>${label}</span>`,
          )
          .join(' · '),
      )}
    </p>`;
}

export function layout(ctx: RenderContext, title: string, body: string): string {
  const s = strings[ctx.locale];
  return html`<!doctype html>
    <html lang="${s.lang}">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width" />
        <title>${title}</title>
      </head>
      <body
        style="margin:0;padding:0;background:#f4f4f5;font-family:Helvetica,Arial,sans-serif;color:#18181b;"
      >
        <table
          role="presentation"
          width="100%"
          cellspacing="0"
          cellpadding="0"
          style="background:#f4f4f5;"
        >
          <tr>
            <td align="center" style="padding:24px 12px;">
              <table
                role="presentation"
                width="600"
                cellspacing="0"
                cellpadding="0"
                style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;"
              >
                <tr>
                  <td style="padding:24px 32px 8px;font-size:20px;font-weight:bold;">
                    ${ctx.brand.name}
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 32px 24px;font-size:15px;line-height:1.5;">
                    ${raw(body)}
                  </td>
                </tr>
                <tr>
                  <td
                    style="padding:16px 32px 24px;font-size:12px;line-height:1.5;color:#71717a;border-top:1px solid #e4e4e7;"
                  >
                    ${raw(footerHtml(ctx))}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html> `;
}

export function addressHtml(a: Address): string {
  return addressLines(a).map(escapeHtml).join('<br>');
}
