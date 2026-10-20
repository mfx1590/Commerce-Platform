// The data-export notice (#499): the copy of the customer's data is ready to download, signed in, until a date.
//
// What is NOT in this mail, by decision (manager 2026-10-18): no download link, no token, no export id —
// nothing that would let whoever reads the mailbox fetch the bundle. The one link is the brand's `/account`
// page, where the Privacy section lists the export behind the customer's own sign-in.
import { formatDateTime, raw, tpl } from '../format.js';
import type { ExportReadyData, RenderContext, RenderedContent } from '../types.js';
import { footerLines, layout, safeUrl } from './layout.js';
import { strings } from './strings.js';

export function accountUrl(websiteUrl: string): string | null {
  return safeUrl(`${websiteUrl.replace(/\/$/, '')}/account`);
}

export function renderExportReady(data: ExportReadyData, ctx: RenderContext): RenderedContent {
  const s = strings[ctx.locale];
  const subject = s.exportSubject(ctx.brand.name);
  const greeting = s.greeting(data.firstName);
  const until = formatDateTime(data.expiresAt, ctx.locale, ctx.timeZone);
  const url = accountUrl(ctx.brand.websiteUrl);

  const text = [
    greeting,
    '',
    s.exportIntro(ctx.brand.name),
    s.exportUntil(until),
    ...(url ? ['', s.exportAccountLine(url)] : []),
    '',
    s.help(ctx.brand.supportEmail),
    '',
    ...footerLines(ctx, s.exportAutomated),
    '',
  ].join('\n');

  const body = tpl`<p>${greeting}</p>
    <p>${s.exportIntro(ctx.brand.name)} ${s.exportUntil(until)}</p>
    ${
      url
        ? raw(
            tpl`<p>
              <a
                href="${url}"
                style="display:inline-block;padding:10px 18px;background:#18181b;color:#ffffff;text-decoration:none;border-radius:6px;"
                >${s.exportButton}</a
              >
            </p>`,
          )
        : ''
    }
    <p>${s.help(ctx.brand.supportEmail)}</p>`;

  return { subject, text, html: layout(ctx, subject, body, s.exportAutomated) };
}
