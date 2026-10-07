// The order confirmation (#360): what was ordered, what it cost, where it goes.
import { formatDate, formatMinor, tpl, raw } from '../format.js';
import type { OrderConfirmationData, RenderContext, RenderedContent } from '../types.js';
import { addressHtml, addressLines, firstName, footerLines, layout } from './layout.js';
import { strings } from './strings.js';

const CELL = 'padding:6px 0;border-bottom:1px solid #e4e4e7;vertical-align:top;';

export function renderOrderConfirmation(
  data: OrderConfirmationData,
  ctx: RenderContext,
): RenderedContent {
  const s = strings[ctx.locale];
  const money = (minor: number): string => formatMinor(minor, data.currency, ctx.locale);
  const subject = s.orderSubject(ctx.brand.name, data.displayId);
  const greeting = s.greeting(firstName(data.shippingAddress));
  const placed = formatDate(data.placedAt, ctx.locale, ctx.timeZone);

  const totals: [string, string][] = [
    [s.subtotal, money(data.totals.subtotalMinor)],
    ...(data.totals.discountMinor > 0
      ? [
          [s.discount(data.promotionCodes), `−${money(data.totals.discountMinor)}`] as [
            string,
            string,
          ],
        ]
      : []),
    [s.shipping(data.shippingMethod?.name ?? null), money(data.totals.shippingMinor)],
    [s.tax, money(data.totals.taxMinor)],
    [s.total, money(data.totals.totalMinor)],
  ];

  const lineLabel = (l: OrderConfirmationData['lines'][number]): string =>
    l.variantTitle && l.variantTitle !== l.title ? `${l.title} (${l.variantTitle})` : l.title;

  const text = [
    greeting,
    '',
    s.orderIntro,
    '',
    `${s.orderNumber}: #${data.displayId}`,
    `${s.placedOn}: ${placed}`,
    '',
    ...data.lines.map((l) => `${l.quantity} × ${lineLabel(l)} — ${money(l.totalMinor)}`),
    '',
    ...totals.map(([k, v]) => `${k}: ${v}`),
    '',
    `${s.deliveryAddress}:`,
    ...addressLines(data.shippingAddress),
    '',
    s.questions(ctx.brand.supportEmail),
    '',
    ...footerLines(ctx),
    '',
  ].join('\n');

  const body = tpl`<p>${greeting}</p>
    <p>${s.orderIntro}</p>
    <p>
      <strong>${s.orderNumber}:</strong> #${data.displayId}<br /><strong>${s.placedOn}:</strong>
      ${placed}
    </p>
    <table
      role="presentation"
      width="100%"
      cellspacing="0"
      cellpadding="0"
      style="border-collapse:collapse;"
    >
      <thead>
        <tr>
          <th align="left" style="${CELL}font-weight:bold;">${s.item}</th>
          <th align="right" style="${CELL}font-weight:bold;">${s.quantity}</th>
          <th align="right" style="${CELL}font-weight:bold;">${s.amount}</th>
        </tr>
      </thead>
      <tbody>
        ${raw(
          data.lines
            .map(
              (l) =>
                tpl`<tr>
                  <td style="${CELL}">
                    ${l.title}${
                      l.variantTitle && l.variantTitle !== l.title
                        ? raw(tpl`<br /><span style="color:#71717a;">${l.variantTitle}</span>`)
                        : ''
                    }
                  </td>
                  <td align="right" style="${CELL}">${l.quantity}</td>
                  <td align="right" style="${CELL}">${money(l.totalMinor)}</td>
                </tr>`,
            )
            .join('\n'),
        )}
      </tbody>
    </table>
    <table
      role="presentation"
      width="100%"
      cellspacing="0"
      cellpadding="0"
      style="border-collapse:collapse;margin-top:8px;"
    >
      ${raw(
        totals
          .map(
            ([k, v], i) =>
              tpl`<tr>
                <td style="padding:4px 0;${i === totals.length - 1 ? 'font-weight:bold;' : ''}">
                  ${k}
                </td>
                <td
                  align="right"
                  style="padding:4px 0;${i === totals.length - 1 ? 'font-weight:bold;' : ''}"
                >
                  ${v}
                </td>
              </tr>`,
          )
          .join('\n'),
      )}
    </table>
    <p><strong>${s.deliveryAddress}</strong><br />${raw(addressHtml(data.shippingAddress))}</p>
    <p>${s.questions(ctx.brand.supportEmail)}</p>`;

  return { subject, text, html: layout(ctx, subject, body) };
}
